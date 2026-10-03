/* ============================================================
   jurisdiction/ui.js — "기관별 관할 고속도로" 탭 화면
   - 지도에서 구간(IC/JC 사이)을 눌러 골라 다른 지사로 옮기고, 신설 기관 추가·지사의 본부 이동을 할 수 있습니다.
   - 변경은 "변경 대기"에 쌓이고, [변경 저장]을 누르면 data/jurisdiction_changes.json 파일을 내려받습니다.
     이 파일을 저장소에 커밋하면 모든 사용자에게 적용됩니다. (계산은 jurisdiction/core.js)
   - 변경(이동·신설·본부 이동)은 관리자 아이디로 로그인했을 때만 할 수 있습니다(관리자 모드 체크박스는 없음). 지사 아이디는 구간을 골라 [구간 변경 요청]으로 관리자에게 부탁합니다.
   - 화면 제한은 편의 기능입니다. 실제 반영 권한은 저장소에 쓸 수 있는 사람에게만 있고, 변경 요청의 권한은 서버(DB)가 검사합니다.
   ============================================================ */
(function () {
  'use strict';
  var C = window.JurisCore;
  var S = { boxes: {}, lastMove: 0, inited: false, admin: false, canRequest: false, reqs: [], reqErr: '', show: {}, toastT: null, selected: {}, last: null, clicked: null, pick: false, pending: [], focus: null, map: null, polys: {}, casing: null, ends: null, roads: null, search: '', view: null, secMap: null };

  function J() { return window.JURIS; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function $(id) { return document.getElementById(id); }
  function base() { return J().session || J().committed; }
  function events() { return base().concat(S.pending); }
  function round1(x) { return Math.round(x * 10) / 10; }
  function fmt(v) { return v == null ? '-' : v + 'cm'; }

  /* ---------- 색: 본부마다 색상(hue), 같은 본부 안에서는 밝기를 번갈아 ---------- */
  var NONE_COLOR = '#3f3f3f';           // 어느 지사에도 속하지 않은 고속도로: 진한 회색 실선(밝은 지도에서 잘 보이도록 명도를 낮춤) + 흰 테두리 + 1px 더 굵게
  var NONE_EXTRA_W = 1;                  // 미지정 구간은 다른 구간보다 선을 1px 굵게
  var HALO_COLOR = '#ffffff';
  function colorOf(id) {
    var st = S.view.state, b = st.branches[id];
    if (id == null || id === 'NONE') return NONE_COLOR;
    if (!b) return '#999';
    var regular = st.hqs.filter(function (h) { return h !== C.PRIVATE_HQ; }), idx = 0;
    for (var i = 0; i < st.order.length; i++) { var o = st.branches[st.order[i]]; if (o.hq === b.hq) { if (o.id === id) break; idx++; } }
    var light = [36, 50, 26, 58][idx % 4];
    if (b.hq === C.PRIVATE_HQ) return 'hsl(278,48%,' + [38, 54, 28, 62][idx % 4] + '%)';        // 민자: 보라 계열 (일반 본부 색은 그대로)
    return 'hsl(' + Math.round(regular.indexOf(b.hq) * 360 / regular.length + 8) + ',72%,' + light + '%)';
  }

  /* ---------- 굵기: 지도를 확대할수록 굵어짐 (배경 지도의 도로도 확대하면 넓어지므로) ----------
     줌 7(전국)=4px, 9=7px, 11=9px, 13=11px, 15=14px, 17=16px */
  var BASE_Z = 5;
  function widthFor(zoom) { return Math.round(Math.max(3, Math.min(16, 2 + (zoom - BASE_Z) * 1.15))); }
  function curWidth() { return widthFor(S.map ? S.map.getZoom() : 7); }
  // 점선 무늬도 굵기에 비례해야 굵은 선에서도 보임 (변경 대기 = 긴 점선. 미지정 구간은 점선이 아니라 회색 실선)
  function dashFor(kind, w) { return kind === 'pending' ? Math.round(w * 1.6) + ',' + Math.round(w * 1.2) : null; }

  /* ---------- 테두리 색: 선 색의 밝기에 따라 반대로 ----------
     선이 밝으면 어두운 테두리, 선이 어두우면 흰 테두리. 지도 배경에서도 떨어져 보이도록
     가장 바깥에는 테두리와 반대 색의 얇은 띠를 한 겹 더 둡니다 (이중 테두리). */
  function toRgb(color) {
    var m = /hsl\((\d+),\s*(\d+)%,\s*(\d+)%\)/.exec(color);
    if (m) {
      var h = +m[1] / 360, sat = +m[2] / 100, l = +m[3] / 100;
      var q = l < 0.5 ? l * (1 + sat) : l + sat - l * sat, p = 2 * l - q;
      var f = function (t) { t = (t + 1) % 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p; };
      return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255];
    }
    var x = color.replace('#', ''); if (x.length === 3) x = x.replace(/(.)/g, '$1$1');
    return [parseInt(x.slice(0, 2), 16), parseInt(x.slice(2, 4), 16), parseInt(x.slice(4, 6), 16)];
  }
  function relLum(rgb) {
    var c = rgb.map(function (v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }
  function contrast(a, b) { var l1 = relLum(toRgb(a)), l2 = relLum(toRgb(b)), hi = Math.max(l1, l2), lo = Math.min(l1, l2); return (hi + 0.05) / (lo + 0.05); }
  function casingColors(lineColor) {
    var dark = '#0b130e', white = '#ffffff';
    // 선과의 대비가 더 큰 쪽(어두운색/흰색)을 테두리로, 나머지를 바깥 띠로 씁니다
    return contrast(lineColor, dark) >= contrast(lineColor, white) ? { casing: dark, outer: white } : { casing: white, outer: dark };
  }

  /* ---------- 화면 뼈대 ---------- */
  function buildShell() {
    var root = $('view-jurisdiction');
    root.innerHTML =
      '<div class="jr-wrap">' +
      '<div class="jr-side">' +
        '<div class="jr-head"><b>기관별 관할 고속도로</b><span class="jr-role" id="jr-role"></span></div>' +
        '<div class="jr-note" id="jr-note"></div>' +
        '<div class="jr-tools"><input id="jr-search" placeholder="지사 검색 (예: 춘천)">' +
        '<button id="jr-add" class="jr-btn jr-admin-only">+ 신설 기관</button></div>' +
        '<div id="jr-requests" class="jr-requests" style="display:none"></div>' +
        '<div id="jr-tree" class="jr-tree"></div>' +
        '<div id="jr-pending" class="jr-pending"></div>' +
      '</div>' +
      '<div class="jr-mapbox"><div id="jmap"></div>' +
        '<div id="jr-selbar" class="jr-selbar" style="display:none"></div>' +
        '<div id="jr-savebar" class="jr-savebar" style="display:none"></div>' +
        '<div id="jr-pickbar" class="jr-pickbar" style="display:none">도착 지사로 삼을 구간을 지도에서 클릭하세요 <button id="jr-pickcancel" class="jr-btn">취소 (Esc)</button></div>' +
        '<div class="jr-legend"><span>이중 테두리 = 선택한 구간</span><span>점선 = 변경 대기</span><span><b style="color:#3f3f3f">진한 회색 = 미지정</b></span> <label><input type="checkbox" id="jr-roads" checked> 배경 도로</label></div>' +
      '</div></div>' +
      '<div id="jr-modal" class="jr-modal" style="display:none"></div>';
    $('jr-role').textContent = S.admin ? '관리자' : S.canRequest ? '변경 요청 가능' : '보기 전용';
    $('jr-note').innerHTML = S.admin ? '구간을 눌러 선택하고(Shift+클릭: 범위) 다른 지사로 <b>이동 대기에 추가</b>하세요. 여러 건을 모아 오른쪽 위 <b>[저장]</b>을 누르면 한꺼번에 적용됩니다. 지사가 올린 <b>변경 요청</b>은 아래 목록에 나타납니다.'
      : S.canRequest ? '구간을 눌러 선택한 뒤 <b>[구간 변경 요청]</b>을 누르면 관리자에게 다른 기관으로 옮겨 달라고 요청할 수 있습니다. 관할 변경은 관리자만 할 수 있습니다.'
      : '지도에서 구간을 누르면 테두리와 함께 소속 정보가 보입니다. 관할 변경은 관리자만 할 수 있습니다.';
  }

  function ensureMap() {
    if (S.map) { setTimeout(function () { S.map.invalidateSize(); }, 50); return; }
    S.map = L.map('jmap', { renderer: L.canvas({ tolerance: 8 }), zoomControl: true }).setView([36.4, 127.9], 7);   // tolerance: 선에서 8px 떨어져도 눌림
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '&copy; OpenStreetMap contributors' }).addTo(S.map);
    S.roads = L.layerGroup().addTo(S.map);
    (window.ROADS_DATA || []).forEach(function (r) {
      L.polyline(r.coords.map(function (c) { return [c[1], c[0]]; }), { color: '#b9b5a5', weight: 1, opacity: 0.7, interactive: false }).addTo(S.roads);
    });
    J().doc.sections.forEach(function (sec) {
      var p = L.polyline(sec.coords.map(function (c) { return [c[1], c[0]]; }), { weight: 4, opacity: 0.95, bubblingMouseEvents: false }).addTo(S.map);
      p.bindPopup(function () { return infoHtml(sec); });
      p.on('click', function (e) { onSectionClick(sec, e.originalEvent); });
      S.polys[sec.id] = p;
      var lat = sec.coords.map(function (c) { return c[1]; }), lon = sec.coords.map(function (c) { return c[0]; });
      S.boxes[sec.id] = [Math.min.apply(null, lat), Math.min.apply(null, lon), Math.max.apply(null, lat), Math.max.apply(null, lon)];
    });
    // 선을 정확히 못 눌러도 가까운 구간(NEAR_PX 이내)을 눌린 것으로 처리
    S.map.on('click', function (e) {
      var hit = nearestSection(e.latlng, NEAR_PX); if (!hit) return;
      onSectionClick(hit, e.originalEvent);
      if (!selectMode()) S.polys[hit.id].openPopup(e.latlng);
    });
    S.map.on('mousemove', function (e) {          // 눌릴 만큼 가까우면 손 모양 커서
      var now = Date.now(); if (now - S.lastMove < 60) return; S.lastMove = now;
      var el = S.map.getContainer(); if (S.pick) { el.style.cursor = 'crosshair'; return; }
      el.style.cursor = nearestSection(e.latlng, NEAR_PX) ? 'pointer' : '';
    });
    S.map.on('zoomend', function () { restyle(); });          // 확대·축소에 맞춰 굵기 다시 칠함
    S.casing = L.layerGroup().addTo(S.map);          // 선택·클릭한 구간의 이중 테두리
    S.ends = L.layerGroup().addTo(S.map);            // 시점·종점 IC/JC 표시
    S.map.on('popupclose', function () { if (!selectMode() && S.clicked) { S.clicked = null; restyle(); } });   // 보기 모드: 팝업을 닫으면 테두리도 해제
    S.map.on('popupopen', function (e) {          // 닫기(X)가 href="#" 라서 상위 프레임으로 이동하는 문제 방지
      var btn = e.popup && e.popup._closeButton;
      if (btn) { btn.removeAttribute('href'); L.DomEvent.off(btn, 'click'); L.DomEvent.on(btn, 'click', function (ev) { L.DomEvent.preventDefault(ev); S.map.closePopup(e.popup); }); }
    });
    setTimeout(function () { S.map.invalidateSize(); }, 50);
  }

  // 지도 위 한 점에서 가장 가까운 구간 (화면 픽셀 거리 maxPx 이내). 선에 정확히 닿지 않아도 눌리게 하는 보정
  var NEAR_PX = 14;
  function nearestSection(latlng, maxPx) {
    var m = S.map, size = m.getSize(), b = m.getBounds();
    var padLat = maxPx * (b.getNorth() - b.getSouth()) / size.y, padLon = maxPx * (b.getEast() - b.getWest()) / size.x;
    var p = m.latLngToLayerPoint(latlng), best = null, bd = maxPx + 1;
    J().doc.sections.forEach(function (sec) {
      var bx = S.boxes[sec.id];
      if (latlng.lat < bx[0] - padLat || latlng.lat > bx[2] + padLat || latlng.lng < bx[1] - padLon || latlng.lng > bx[3] + padLon) return;
      var c = sec.coords, prev = m.latLngToLayerPoint([c[0][1], c[0][0]]);
      for (var i = 1; i < c.length; i++) {
        var cur = m.latLngToLayerPoint([c[i][1], c[i][0]]), d = L.LineUtil.pointToSegmentDistance(p, prev, cur);
        if (d < bd) { bd = d; best = sec; }
        prev = cur;
      }
    });
    return bd <= maxPx ? best : null;
  }

  function infoHtml(sec) {
    var st = S.view.state, o = st.branches[st.owner[sec.id]];
    return '<b>' + esc(sec.route) + '</b><br>' + esc(sec['from']) + ' → ' + esc(sec.to) + ' · ' + sec.km + 'km<br>' +
      (o ? '소속: <b>' + esc(o.name) + '</b> 지사 (' + esc(o.hq) + ')' : '소속: <b>미지정</b> (어느 지사에도 속하지 않음)');
  }

  /* ---------- 지도 스타일 ---------- */
  function latlngsOf(sec) { return sec.coords.map(function (c) { return [c[1], c[0]]; }); }

  function restyle() {
    var st = S.view.state, committed = C.resolve(J().doc, base()).owner, hl = {};
    Object.keys(S.selected).forEach(function (id) { hl[id] = true; });
    if (S.clicked) hl[S.clicked] = true;
    Object.keys(S.show).forEach(function (id) { hl[id] = true; });         // 요청 목록의 [지도에서 보기]로 표시한 구간
    var dimOf = function (sec) { var own = st.owner[sec.id], key = own || 'NONE'; return S.focus && key !== S.focus && !hl[sec.id]; };
    J().doc.sections.forEach(function (sec) {
      var p = S.polys[sec.id]; if (!p) return;
      var own = st.owner[sec.id], key = own || 'NONE', dim = S.focus && key !== S.focus && !hl[sec.id];
      var w = curWidth() + (hl[sec.id] || (S.focus && key === S.focus) ? 2 : 0) + (own === null ? NONE_EXTRA_W : 0);
      p.setStyle({
        color: colorOf(own), weight: w, opacity: dim ? 0.22 : 0.95,
        dashArray: own !== committed[sec.id] ? dashFor('pending', w) : null,   // 긴 점선=변경 대기 (미지정은 회색 실선)
        lineCap: own === null ? 'round' : 'butt'        // 미지정(진한 회색)은 구간 이음새가 끊겨 보이지 않도록 둥근 끝
      });
    });
    updateHalo(st, dimOf);
    // 이중 테두리: 가장 바깥(반대색 띠) → 테두리 → 구간 선 순서로 겹쳐 그림
    S.casing.clearLayers(); S.ends.clearLayers();
    var ids = Object.keys(hl).filter(function (id) { return S.polys[id]; }), outers = [], cases = [];
    ids.forEach(function (id) {
      var sec = S.secMap[id], cc = casingColors(colorOf(st.owner[id])), ll = latlngsOf(sec);
      var w = curWidth() + 2;
      outers.push(L.polyline(ll, { color: cc.outer, weight: w + 14, opacity: 0.7, interactive: false, lineCap: 'round' }).addTo(S.casing));
      cases.push(L.polyline(ll, { color: cc.casing, weight: w + 7, opacity: 1, interactive: false, lineCap: 'round' }).addTo(S.casing));
    });
    outers.forEach(function (l) { l.bringToFront(); });
    cases.forEach(function (l) { l.bringToFront(); });
    ids.forEach(function (id) { S.polys[id].bringToFront(); });
    var endId = S.clicked || (ids.length === 1 ? ids[0] : null);       // 시점·종점은 마지막으로 누른 구간(또는 1개 선택 시)만
    if (endId && S.secMap[endId]) addEnds(S.secMap[endId]);
  }

  // 미지정 구간 밑에 흰 테두리를 깔아 밝은 지도·배경 도로 위에서도 또렷하게 보이게 함 (소속이 바뀌면 다시 만들고, 확대·축소 때는 굵기만 바꿈)
  function updateHalo(st, dimOf) {
    var ids = J().doc.sections.filter(function (s) { return !st.owner[s.id]; }).map(function (s) { return s.id; }), sig = ids.join(',');
    var w = curWidth() + NONE_EXTRA_W + 5;
    if (!S.halo) { S.halo = L.layerGroup().addTo(S.map); S.haloPolys = {}; S.haloSig = ''; }
    if (sig !== S.haloSig) {
      S.halo.clearLayers(); S.haloPolys = {};
      ids.forEach(function (id) { var h = L.polyline(latlngsOf(S.secMap[id]), { color: HALO_COLOR, weight: w, opacity: 0.9, interactive: false, lineCap: 'round', lineJoin: 'round' }).addTo(S.halo); h.bringToBack(); S.haloPolys[id] = h; });
      S.haloSig = sig;
    }
    ids.forEach(function (id) { S.haloPolys[id].setStyle({ weight: w, opacity: dimOf(S.secMap[id]) ? 0.12 : 0.9 }); });
  }

  function addEnds(sec) {
    var pts = [[sec.coords[0], 'start', sec['from']], [sec.coords[sec.coords.length - 1], 'end', sec.to]];
    pts.forEach(function (x) {
      var name = x[2] === '(IC 아님)' ? '구간 끝' : x[2], label = (x[1] === 'start' ? '시점 ' : '종점 ') + name;
      L.circleMarker([x[0][1], x[0][0]], { radius: Math.max(7, Math.round(curWidth() * 0.8)), color: '#0b130e', weight: 3, fillColor: '#ffffff', fillOpacity: 1, interactive: false })
        .bindTooltip(esc(label), { permanent: true, direction: x[1] === 'start' ? 'top' : 'bottom', offset: [0, x[1] === 'start' ? -8 : 8], className: 'jr-endtip' })
        .addTo(S.ends);
    });
  }

  /* ---------- 구간 선택 ---------- */
  function selectMode() { return S.admin || S.canRequest; }      // 구간을 골라 선택할 수 있는 계정: 관리자(이동) · 지사(변경 요청)
  function onSectionClick(sec, ev) {
    S.show = {};
    if (!selectMode()) { S.clicked = sec.id; restyle(); return; }  // 보기 전용: 팝업 + 테두리
    if (S.map) S.map.closePopup();
    if (S.admin && S.pick) { pickDestination(sec); return; }       // 도착 지사를 지도에서 찍는 중(관리자)
    if (ev && ev.shiftKey && S.last && S.last.chain === sec.chain) {       // Shift+클릭: 같은 노선 줄에서 범위 선택
      var lo = Math.min(S.last.order, sec.order), hi = Math.max(S.last.order, sec.order);
      J().doc.sections.forEach(function (s) { if (s.chain === sec.chain && s.order >= lo && s.order <= hi) S.selected[s.id] = true; });
    } else {
      if (S.selected[sec.id]) delete S.selected[sec.id]; else S.selected[sec.id] = true;
    }
    S.clicked = S.selected[sec.id] ? sec.id : null;
    S.last = sec; afterChange(false);
  }

  function setPick(on) {
    S.pick = on;
    $('jr-pickbar').style.display = on ? 'flex' : 'none';
    if (S.map) S.map.getContainer().style.cursor = on ? 'crosshair' : '';
  }

  // 지도에서 클릭한 구간의 소속 지사를 도착 지사로 삼아 이동 대기에 추가
  function pickDestination(sec) {
    var st = S.view.state, to = st.owner[sec.id] || 'NONE', sel = selectedList().filter(function (s) { return (st.owner[s.id] || 'NONE') !== to; });
    if (!sel.length) { window.alert('선택한 구간이 이미 ' + (to === 'NONE' ? '미지정' : st.branches[to].name + ' 지사') + ' 소속입니다. 다른 지사의 구간을 눌러 주세요.'); return; }
    setPick(false); queueMove(sel, to);
  }

  function selectedList() { return J().doc.sections.filter(function (s) { return S.selected[s.id]; }); }

  function renderSelBar() {
    var bar = $('jr-selbar'), sel = selectedList();
    if (!selectMode() || !sel.length) { bar.style.display = 'none'; return; }
    var st = S.view.state, km = round1(sel.reduce(function (a, s) { return a + s.km; }, 0));
    if (!S.admin) {          // 지사: 이동은 못 하고 관리자에게 요청만 할 수 있음
      bar.innerHTML = '<b class="jr-selinfo">' + sel.length + '개 구간 · ' + km + 'km 선택</b><span class="jr-barhint">관할 변경은 관리자만 할 수 있어요</span>' +
        '<span class="jr-grp"><button id="jr-reqopen" class="jr-btn jr-primary">구간 변경 요청</button><button id="jr-clear" class="jr-btn">선택 해제</button></span>';
      bar.style.display = 'flex'; return;
    }
    var opts = st.hqs.map(function (hq) {
      var o = st.order.filter(function (id) { return st.branches[id].hq === hq; }).map(function (id) { return '<option value="' + id + '">' + esc(st.branches[id].name) + '</option>'; }).join('');
      return o ? '<optgroup label="' + esc(hq) + '">' + o + '</optgroup>' : '';
    }).join('');
    opts += '<optgroup label="기타"><option value="NONE">미지정으로 되돌리기</option></optgroup>';
    var prev = $('jr-dest') ? $('jr-dest').value : '';
    bar.innerHTML = '<b class="jr-selinfo">' + sel.length + '개 구간 · ' + km + 'km 선택</b>' +
      '<span class="jr-grp"><label class="jr-lbl">이동할 지사</label><select id="jr-dest">' + opts + '</select><button id="jr-move" class="jr-btn jr-primary">이동 대기에 추가</button></span>' +
      '<span class="jr-grp"><button id="jr-pick" class="jr-btn" title="도착 지사의 구간을 지도에서 직접 눌러 정합니다">지도에서 지사 고르기</button><button id="jr-clear" class="jr-btn">선택 해제</button></span>';
    if (prev) $('jr-dest').value = prev;
    bar.style.display = 'flex';
  }

  /* ---------- 지사 목록(트리) ---------- */
  function renderTree() {
    var st = S.view.state, km = S.view.km, cnt = S.view.count, q = S.search.trim();
    var html = st.hqs.map(function (hq) {
      var ids = st.order.filter(function (id) { return st.branches[id].hq === hq && (!q || st.branches[id].name.indexOf(q) >= 0); });
      if (!ids.length && !(hq === C.PRIVATE_HQ && !q)) return '';
      var total = round1(ids.reduce(function (a, id) { return a + (km[id] || 0); }, 0));
      return '<div class="jr-hq"><div class="jr-hqname">' + esc(hq) + ' <span>' + total + 'km</span>' + (hq === C.PRIVATE_HQ ? ' <em class="jr-priv">관측소·적설 계산 안 함</em>' : '') + '</div>' + ids.map(function (id) {
        var b = st.branches[id], on = S.focus === id;
        var row = '<div class="jr-br' + (on ? ' on' : '') + '" data-id="' + id + '"><i style="background:' + colorOf(id) + '"></i>' +
          '<span class="n">' + esc(b.name) + (b.added ? ' <em>신설</em>' : '') + '</span><span class="k">' + round1(km[id] || 0) + 'km · ' + (cnt[id] || 0) + '구간</span></div>';
        if (on) row += branchDetail(id);
        return row;
      }).join('') + '</div>';
    }).join('');
    if (!q || '미지정'.indexOf(q) >= 0) {                      // 어느 지사에도 속하지 않은 고속도로 (맨 위)
      var none = '<div class="jr-hq"><div class="jr-hqname">미지정 고속도로 <span>' + round1(km.NONE || 0) + 'km</span></div>' +
        '<div class="jr-br' + (S.focus === 'NONE' ? ' on' : '') + '" data-id="NONE"><i style="background:' + NONE_COLOR + '"></i>' +
        '<span class="n">어느 지사에도 속하지 않음</span><span class="k">' + (cnt.NONE || 0) + '구간</span></div>' + (S.focus === 'NONE' ? branchDetail('NONE') : '') + '</div>';
      html = none + html;
    }
    $('jr-tree').innerHTML = html || '<div class="jr-empty">검색 결과가 없습니다.</div>';
  }

  function branchDetail(id) {
    var st = S.view.state, secs = J().doc.sections.filter(function (s) { return (st.owner[s.id] || 'NONE') === id; });
    var h = '<div class="jr-detail">';
    if (S.admin && id !== 'NONE') {
      h += '<div class="jr-row">본부 변경: <select id="jr-hq">' + st.hqs.map(function (hq) { return '<option' + (hq === st.branches[id].hq ? ' selected' : '') + '>' + esc(hq) + '</option>'; }).join('') + '</select>' +
        '<button class="jr-btn" id="jr-selall">이 지사 구간 전체 선택</button></div>';
    } else if (selectMode() && id !== 'NONE') {
      h += '<div class="jr-row"><button class="jr-btn" id="jr-selall">이 지사 구간 전체 선택</button></div>';
    }
    if (selectMode() && id === 'NONE') h += '<div class="jr-row"><button class="jr-btn" id="jr-selall">미지정 구간 전체 선택</button></div>';
    if (!secs.length) return h + '<div class="jr-empty">' + (id === 'NONE' ? '미지정 구간이 없습니다.' : (S.admin ? '관할 구간이 없습니다. 지도에서 구간을 골라 이 지사로 옮기세요.' : '관할 구간이 없습니다.')) + '</div></div>';
    h += secs.map(function (s) {
      return '<div class="jr-sec' + (S.selected[s.id] ? ' sel' : '') + '" data-sid="' + s.id + '" title="' + (selectMode() ? '누르면 선택/해제하고 지도에 표시합니다 (Shift+클릭: 범위 선택)' : '누르면 지도에 표시합니다') + '">' + (selectMode() ? '<input type="checkbox" data-sid="' + s.id + '"' + (S.selected[s.id] ? ' checked' : '') + '> ' : '') +
        '<span>' + esc(s.route) + '</span> ' + esc(s['from']) + ' → ' + esc(s.to) + ' <em>' + s.km + 'km</em></div>';
    }).join('');
    return h + '</div>';
  }

  /* ---------- 변경 대기 / 저장 ---------- */
  function describe(ev) {
    var st = S.view.state, nm = function (id) { return id == null || id === 'NONE' ? '미지정' : (st.branches[id] ? st.branches[id].name : id); };
    if (ev.t === 'move') return ev.sections.length + '개 구간(' + (ev.km != null ? ev.km : '?') + 'km): ' + (ev.from || []).map(nm).join('·') + ' → <b>' + esc(nm(ev.to)) + '</b>' + (ev.req ? ' <em>요청 #' + esc(ev.req) + '</em>' : '');
    if (ev.t === 'addBranch') return '신설 기관: <b>' + esc(ev.name) + '</b> (' + esc(ev.hq) + ')';
    if (ev.t === 'moveHq') return '<b>' + esc(nm(ev.branch)) + '</b>: ' + esc(ev.fromHq || '?') + ' → ' + esc(ev.hq);
    return esc(ev.t);
  }

  function renderPending() {          // 왼쪽 아래: 서버 연결 경고와 저장된 변경 이력만 (변경 대기·저장 버튼은 오른쪽 위 한 곳에 모음)
    var box = $('jr-pending'), com = base(), h = '';
    if (serverDown()) h += '<div class="jr-warn">⚠ 서버에서 변경 이력을 불러오지 못해 예전 파일 기준으로 보고 있습니다. 새로고침해서 서버에 연결된 뒤에 저장하세요.</div>';
    if (com.length) h += '<details class="jr-hist"><summary>저장된 변경 이력 ' + com.length + '건</summary>' +
      com.slice().reverse().slice(0, 30).map(function (ev) { return '<div class="jr-ev old">' + (ev.at ? esc(String(ev.at).slice(0, 10)) + ' ' : '') + describe(ev) + (ev.note ? ' <em>' + esc(ev.note) + '</em>' : '') + '</div>'; }).join('') +
      (S.admin ? '<div class="jr-row"><button class="jr-btn" id="jr-export" title="변경 이력 전체를 파일로 보관합니다">이력 파일로 내려받기(백업)</button></div>' : '') + '</details>';
    box.innerHTML = h;
    box.style.display = h ? 'block' : 'none';
  }

  function stampPending() {
    var now = new Date().toISOString(), reason = ($('jr-reason') && $('jr-reason').value || S.reason || '').trim();
    S.reason = reason;
    return S.pending.map(function (ev) { var c = JSON.parse(JSON.stringify(ev)); c.at = c.at || now; if (reason) c.note = reason; return c; });
  }

  function serverDown() { var e = window.EVENTS_SOURCE; return !!(e && /error/.test(e.jurisdiction || '')); }
  function linkedRequestIds() { var ids = []; S.pending.forEach(function (ev) { if (ev.req && ids.indexOf(ev.req) < 0) ids.push(ev.req); }); return ids; }
  function downloadEvents(events, name) { SSEvents.download(name, SSEvents.exportJson(events)); }

  // 변경 저장: 서버(Supabase)에 한 번에 저장합니다. 모든 사용자에게 바로 적용되고, GitHub 에 올릴 필요가 없습니다.
  function saveChanges() {
    if (!S.admin || S.saving || !S.pending.length) return;
    if (serverDown()) { window.alert('서버에서 변경 이력을 불러오지 못한 상태입니다. 새로고침해서 서버에 연결된 뒤에 저장하세요.'); return; }
    var evs = stampPending(), reqIds = linkedRequestIds();
    S.saving = true; renderPending(); renderSaveBar();
    SSEvents.append('jurisdiction', evs).then(function (res) {
      if (!res.ok) { S.saving = false; renderPending(); renderSaveBar(); saveFailed(res.message, evs); return; }
      return SSEvents.load('jurisdiction').then(function (r) {
        // 저장은 성공했는데 다시 읽기만 실패한 경우에도 방금 저장한 내용을 화면에 반영해 둠
        J().committed = r.source === 'server' && !r.error ? r.events : J().committed.concat(evs);
        S.saving = false; S.pending = []; S.reason = ''; afterChange(true);
        if (window.reapplyJurisdiction) window.reapplyJurisdiction(J().committed);      // 새로고침 없이 강설량·관측소 지도 화면까지 새 관할로 바꿈
        if (reqIds.length) approveRequests(reqIds);
        toast(evs.length + '건 저장되었습니다.');
      });
    });
  }
  function saveFailed(message, evs) {
    modal('<h3>저장하지 못했습니다</h3><p class="jr-warn" style="font-size:13.5px">' + esc(message) + '</p>' +
      '<p style="font-size:13.5px;line-height:1.6">변경 대기는 그대로 남아 있습니다. 잠시 뒤 다시 [저장]을 누르거나, 급하면 아래 <b>[파일로 받기]</b>로 내용을 보관해 두세요.</p>' +
      '<div class="jr-row"><button class="jr-btn jr-primary" id="jr-retry">다시 저장</button><button class="jr-btn" id="jr-tofile">파일로 받기</button><button class="jr-btn" id="jr-close">닫기</button></div>');
  }
  function approveRequests(ids) {          // 이 변경에 연결된 지사 요청을 승인 처리
    if (!window.JurisRequests) return;
    JurisRequests.resolve(ids, 'approved', '관할 변경 저장 시 승인').then(function (r) {
      if (!r.ok) toast('요청 승인 처리에 실패했습니다: ' + r.message);
      loadRequests(); JurisRequests.check(true);
    });
  }

  /* ---------- 미리보기 ---------- */
  function preview() {
    var rows = C.impact(J().doc, J().stations, window.SNOW_DATA, base(), events());
    var warn = '';
    if (!J().stations || J().stations.complete === false) warn = '<div class="jr-warn">⚠ 관측소 목록이 일부(지사에 배정된 적이 있는 관측소)만 들어 있어, 새로 편입되는 지역의 관측소가 빠질 수 있습니다. 기상청 적설관측지점 전체 목록을 받으면 더 정확해집니다.</div>';
    var body = rows.map(function (r) {
      var a = r.before, b = r.after;
      var name = b ? esc(b.name) + ' <span>(' + esc(b.hq) + ')</span>' + (!a ? ' <em>신설</em>' : '') : esc(r.id);
      var km = a ? a.km + ' → ' + (b ? b.km : '-') : '신설 → ' + (b ? b.km : '-');
      var stn = (b && b.priv) ? '<span>민자 — 관측소·적설 계산 안 함</span>' + (a && !a.priv ? '<div class="m">− 이 지사의 관측소 배정이 없어집니다</div>' : '') :
        (a ? a.stations.length : 0) + '곳 → ' + (b ? b.stations.length : 0) + '곳' + (b && b.radiusKm ? ' <span>(반경 ' + b.radiusKm + 'km)</span>' : '') +
        (r.added.length ? '<div class="p">+ ' + esc(r.added.join(', ')) + '</div>' : '') + (r.removed.length ? '<div class="m">− ' + esc(r.removed.join(', ')) + '</div>' : '');
      var zero = b && b.sections === 0 && !b.priv ? '<div class="m">관할 구간이 없어 적설을 계산할 수 없습니다.</div>' : '';
      return '<tr><td>' + name + zero + '</td><td>' + km + 'km</td><td>' + stn + '</td><td>' + fmt(a && a.latestMax) + ' → ' + (b && b.priv ? '-' : fmt(b && b.latestMax)) + '</td><td>' + fmt(a && a.allMax) + ' → ' + (b && b.priv ? '-' : fmt(b && b.allMax)) + '</td></tr>';
    }).join('');
    modal('<h3>변경 미리보기</h3>' + warn + '<div class="jr-tablewrap"><table class="jr-table"><thead><tr><th>지사</th><th>관할 길이</th><th>관측소</th><th>최신 시즌 최대 신적설</th><th>전체 시즌 최대 신적설</th></tr></thead><tbody>' +
      (body || '<tr><td colspan="5">바뀌는 지사가 없습니다.</td></tr>') + '</tbody></table></div>' +
      '<p class="jr-hint">저장하면 이 지사들의 관측소 배정과 일별 신적설이 새 관할로 다시 계산됩니다.</p><div class="jr-row"><button class="jr-btn jr-primary" id="jr-close">닫기</button></div>');
  }

  function modal(html) { var m = $('jr-modal'); m.innerHTML = '<div class="jr-dialog">' + html + '</div>'; m.style.display = 'flex'; }
  function closeModal() { $('jr-modal').style.display = 'none'; }

  /* ---------- 변경 만들기 ---------- */
  function nextBranchId() {
    var max = 0; Object.keys(S.view.state.branches).forEach(function (id) { var n = parseInt(id.slice(1), 10); if (n > max) max = n; });
    return 'B' + String(max + 1).padStart(3, '0');
  }

  function queueMove(sel, to) {
    var st = S.view.state, from = []; sel.forEach(function (s) { var o = st.owner[s.id] || null; if ((o || 'NONE') !== to && from.indexOf(o) < 0) from.push(o); });
    if (!from.length) { window.alert('선택한 구간이 이미 그 지사 소속입니다.'); return; }
    S.pending.push({ t: 'move', sections: sel.map(function (s) { return s.id; }), to: to, from: from, km: round1(sel.reduce(function (a, s) { return a + s.km; }, 0)) });
    S.selected = {}; S.last = null; S.clicked = null; afterChange(true);
  }

  function addMove() {
    var sel = selectedList(), to = $('jr-dest').value; if (!sel.length || !to) return;
    queueMove(sel, to);
  }

  function addBranchDialog() {
    var st = S.view.state;
    modal('<h3>신설 기관 추가</h3><div class="jr-form"><label>기관 이름 <input id="jr-newname" placeholder="예: 새만금"></label>' +
      '<label>소속 본부 <select id="jr-newhq">' + st.hqs.map(function (h) { return '<option>' + esc(h) + '</option>'; }).join('') + '</select></label></div>' +
      '<p class="jr-hint">만든 뒤 지도에서 구간을 골라 이 기관으로 옮기면 관측소와 신적설이 계산됩니다.</p>' +
      '<div class="jr-row"><button class="jr-btn jr-primary" id="jr-newok">추가</button><button class="jr-btn" id="jr-close">취소</button></div>');
    $('jr-newname').focus();
  }

  function createBranch() {
    var name = $('jr-newname').value.trim(), hq = $('jr-newhq').value;
    if (!name) { window.alert('기관 이름을 입력하세요.'); return; }
    var dup = Object.keys(S.view.state.branches).some(function (id) { return S.view.state.branches[id].name === name; });
    if (dup) { window.alert('같은 이름의 기관이 이미 있습니다.'); return; }
    var id = nextBranchId();
    S.pending.push({ t: 'addBranch', id: id, hq: hq, name: name });
    S.focus = id; closeModal(); afterChange(true);
  }

  function changeHq(hq) {
    var id = S.focus, st = S.view.state; if (!id || st.branches[id].hq === hq) return;
    S.pending.push({ t: 'moveHq', branch: id, hq: hq, fromHq: st.branches[id].hq });
    afterChange(true);
  }

  function cancelEvent(i) {          // 취소 후, 앞선 변경에 기대던 변경(예: 신설 기관으로의 이동)도 함께 정리
    S.pending.splice(i, 1);
    var kept = [];
    S.pending.forEach(function (ev) { var r = C.resolve(J().doc, base().concat(kept, [ev])); if (r.applied.indexOf(ev) >= 0) kept.push(ev); });
    S.pending = kept; afterChange(true);
  }

  /* ---------- 화면 갱신 ---------- */
  function afterChange(recompute) {
    S.view = C.summarize(J().doc, events());
    if (recompute) { var st = S.view.state; if (S.focus && !st.branches[S.focus]) S.focus = null; }
    restyle(); renderTree(); renderPending(); renderSelBar(); renderSaveBar(); renderRequests();
  }

  /* ---------- 항상 보이는 저장 바 (관리자 모드): 지도 오른쪽 위 ---------- */
  function renderSaveBar() {          // 지도 오른쪽 위 "변경 대기" 패널: 변경 목록·사유·[미리보기][모두 취소][저장]은 여기에만 있음
    var bar = $('jr-savebar'); if (!bar) return;
    if (!S.admin) { bar.style.display = 'none'; return; }
    var n = S.pending.length, canSave = n && !S.saving && !serverDown();
    bar.className = 'jr-savebar' + (n ? ' dirty' : '');
    bar.innerHTML = '<div class="jr-sb-head"><span class="st">' + (n ? '● 변경 대기 ' + n + '건' : '변경 없음 — 구간을 눌러 지사를 옮기세요') + '</span>' +
      '<span class="jr-sb-btns"><button class="jr-btn" id="jr-top-preview"' + (n ? '' : ' disabled') + '>미리보기</button>' +
      '<button class="jr-btn" id="jr-top-cancel"' + (n && !S.saving ? '' : ' disabled') + '>모두 취소</button>' +
      '<button class="jr-btn jr-primary" id="jr-top-save"' + (canSave ? '' : ' disabled') + ' title="변경 내용을 서버에 저장합니다">' + (S.saving ? '저장 중…' : '저장') + '</button></span></div>' +
      (n ? '<div class="jr-sb-list">' + S.pending.map(function (ev, i) { return '<div class="jr-ev"><span class="jr-evt">' + describe(ev) + '</span><button class="jr-x" data-ev="' + i + '" title="이 변경만 취소">×</button></div>'; }).join('') + '</div>' +
        '<input id="jr-reason" class="jr-reason" placeholder="변경 사유 (선택)" maxlength="200" value="' + esc(S.reason || '') + '">' : '');
    bar.style.display = 'block';
  }

  // 왼쪽 목록에서 노선명(구간 행)을 누르면: 지도에서 그 구간을 누른 것과 똑같이 처리 (관리자·지사=선택, 보기 전용=테두리·팝업)
  function pickFromList(sec, ev) {
    var p = S.polys[sec.id]; if (!p) return;
    var bounds = p.getBounds();
    if (!S.map.getBounds().pad(-0.1).contains(bounds)) S.map.fitBounds(bounds, { padding: [70, 70], maxZoom: 13 });   // 이미 화면에 보이면 지도를 움직이지 않음
    onSectionClick(sec, ev);
    if (!selectMode()) p.openPopup(p.getCenter());
  }

  function focusBranch(id) {
    S.focus = S.focus === id ? null : id;
    afterChange(false);
    if (S.focus) {
      var pts = []; J().doc.sections.forEach(function (s) { if ((S.view.state.owner[s.id] || 'NONE') === S.focus) s.coords.forEach(function (c) { pts.push([c[1], c[0]]); }); });
      if (pts.length) S.map.fitBounds(L.latLngBounds(pts), { padding: [40, 40], maxZoom: 11 });
    }
  }

  function bind() {
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && S.pick) setPick(false); });
    $('jr-search').addEventListener('input', function (e) { S.search = e.target.value; renderTree(); });
    $('jr-add').addEventListener('click', function () { if (S.admin) addBranchDialog(); });
    $('jr-roads').addEventListener('change', function (e) { if (e.target.checked) S.roads.addTo(S.map); else S.map.removeLayer(S.roads); });
    document.getElementById('view-jurisdiction').addEventListener('click', function (e) {
      var t = e.target;
      var ra = t.closest && t.closest('[data-ra]');                  // 변경 요청 카드의 버튼
      if (ra) { var rq = findReq(ra.dataset.rid); if (rq) { var a = ra.dataset.ra; if (a === 'view') viewRequest(rq); else if (a === 'prep' && S.admin) prepareMove(rq); else if (a === 'reject' && S.admin) rejectRequest(rq); else if (a === 'cancel') cancelRequest(rq); } return; }
      var br = t.closest && t.closest('.jr-br'); if (br) { focusBranch(br.dataset.id); return; }
      var sec = t.closest && t.closest('.jr-sec');
      if (sec && t.tagName === 'INPUT') { if (t.checked) S.selected[sec.dataset.sid] = true; else delete S.selected[sec.dataset.sid]; afterChange(false); return; }
      if (sec) { pickFromList(S.secMap[sec.dataset.sid], e); return; }
      var id = t.id;
      if (id === 'jr-move' && S.admin) addMove();
      else if (id === 'jr-reqopen' && S.canRequest) openRequestDialog();
      else if (id === 'jr-req-send' && S.canRequest) sendRequest();
      else if (id === 'jr-reqdestok' && S.admin) { var rr = findReq(t.dataset.rid), dv = $('jr-reqdest').value; closeModal(); if (rr && dv) prepareMove(rr, dv); }
      else if (id === 'jr-pick' && S.admin) setPick(true);
      else if (id === 'jr-pickcancel') setPick(false);
      else if (id === 'jr-clear') { S.selected = {}; S.last = null; S.clicked = null; afterChange(false); }
      else if (id === 'jr-selall') { J().doc.sections.forEach(function (s) { if ((S.view.state.owner[s.id] || 'NONE') === S.focus) S.selected[s.id] = true; }); afterChange(false); }
      else if (id === 'jr-top-preview') preview();
      else if (id === 'jr-top-save' && S.admin) saveChanges();
      else if (id === 'jr-top-cancel') { if (S.pending.length && window.confirm('변경 대기 ' + S.pending.length + '건을 모두 취소할까요?')) { S.pending = []; afterChange(true); } }
      else if (id === 'jr-retry' && S.admin) { closeModal(); saveChanges(); }
      else if (id === 'jr-tofile' && S.admin) downloadEvents(base().concat(stampPending()), 'jurisdiction_changes.json');
      else if (id === 'jr-export' && S.admin) downloadEvents(base(), 'jurisdiction_changes_backup.json');
      else if (id === 'jr-close') closeModal();
      else if (id === 'jr-newok' && S.admin) createBranch();
      else if (t.classList && t.classList.contains('jr-x')) cancelEvent(parseInt(t.dataset.ev, 10));
    });
    document.getElementById('view-jurisdiction').addEventListener('change', function (e) { if (e.target.id === 'jr-hq' && S.admin) changeHq(e.target.value); });
    document.getElementById('view-jurisdiction').addEventListener('input', function (e) { if (e.target.id === 'jr-reason') S.reason = e.target.value; });
    document.getElementById('view-jurisdiction').addEventListener('toggle', function (e) { if (e.target.id === 'jr-reqdet') S.reqOpen = e.target.open; }, true);
  }


  /* ---------- 구간 변경 요청 (지사 → 관리자) ---------- */
  function toast(msg) {
    var el = $('jr-toast');
    if (!el) { el = document.createElement('div'); el.id = 'jr-toast'; el.className = 'jr-toast'; el.setAttribute('role', 'status'); document.body.appendChild(el); }
    el.textContent = msg; el.style.display = 'block'; clearTimeout(S.toastT); S.toastT = setTimeout(function () { el.style.display = 'none'; }, 6000);
  }
  function bname(id) { var b = S.view.state.branches[id]; return b ? b.name : (id || '-'); }
  function secSnap(s) { return { id: s.id, route: s.route, from: s['from'], to: s.to, km: s.km, owner: S.view.state.owner[s.id] || null }; }
  function fmtTime(iso) { var d = new Date(iso); if (isNaN(d)) return ''; function p2(n) { return ('0' + n).slice(-2); } return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes()); }
  var RSTAT = { pending: '대기 중', approved: '승인', rejected: '반려', cancelled: '취소' };

  function loadRequests() {
    if (!window.JurisRequests || !selectMode()) return Promise.resolve();
    return JurisRequests.list().then(function (rows) { S.reqs = rows; S.reqErr = ''; renderRequests(); })
      .catch(function () { S.reqErr = '요청 목록을 불러오지 못했습니다. 잠시 뒤에 다시 시도하세요.'; renderRequests(); });
  }
  function queued(id) { return S.pending.some(function (ev) { return ev.req === id; }); }
  function reqCard(r) {
    var secs = (r.snapshot && r.snapshot.length) ? r.snapshot : (r.section_ids || []).map(function (id) { return { id: id }; });
    var routes = [], from = [], km = round1(secs.reduce(function (a, x) { return a + (x.km || 0); }, 0));
    secs.forEach(function (x) { if (x.route && routes.indexOf(x.route) < 0) routes.push(x.route); var n = x.owner ? bname(x.owner) : '미지정'; if (x.route && from.indexOf(n) < 0) from.push(n); });
    var to = r.to_branch_id ? bname(r.to_branch_id) : '관리자가 정해 주세요';
    var who = S.admin ? '<b>' + esc(bname(r.branch_id)) + ' 지사</b> 요청' : '구간 변경 요청';
    var act = '';
    if (r.status === 'pending') {
      act = '<div class="jr-req-a"><button class="jr-btn" data-ra="view" data-rid="' + r.id + '">지도에서 보기</button>' + (S.admin
        ? (queued(r.id) ? '<span class="jr-pill approved">이동 준비됨</span>' : '<button class="jr-btn jr-primary" data-ra="prep" data-rid="' + r.id + '">이동 준비</button>') + '<button class="jr-btn" data-ra="reject" data-rid="' + r.id + '">반려</button>'
        : '<button class="jr-btn" data-ra="cancel" data-rid="' + r.id + '">요청 취소</button>') + '</div>';
    }
    return '<div class="jr-req" data-rid="' + r.id + '"><div class="jr-req-h">' + who + ' <span class="jr-pill ' + esc(r.status) + '">' + (RSTAT[r.status] || esc(r.status)) + '</span><span class="jr-req-t">#' + r.id + ' · ' + fmtTime(r.created_at) + '</span></div>' +
      '<div class="jr-req-b">구간 ' + secs.length + '개 (' + km + 'km) · ' + esc(routes.slice(0, 3).join(', ') + (routes.length > 3 ? ' 외 ' + (routes.length - 3) + '개 노선' : '')) + '<br>현재 ' + esc(from.join('·') || '-') + ' → <b>' + esc(to) + '</b></div>' +
      (r.reason ? '<div class="jr-req-r">사유: ' + esc(r.reason) + '</div>' : '') + (r.status !== 'pending' && r.resolution_note ? '<div class="jr-req-r">처리 의견: ' + esc(r.resolution_note) + '</div>' : '') + act + '</div>';
  }
  function renderRequests() {
    var box = $('jr-requests'); if (!box) return;
    if (!selectMode() || !window.JurisRequests) { box.style.display = 'none'; return; }
    var pend = S.reqs.filter(function (r) { return r.status === 'pending'; }), done = S.reqs.filter(function (r) { return r.status !== 'pending'; }).slice(0, 15);
    var h = '<details id="jr-reqdet"' + (S.reqOpen === false ? '' : ' open') + '><summary>' + (S.admin ? '변경 요청' : '내 변경 요청') + ' <span class="jr-cnt' + (pend.length ? ' hot' : '') + '">대기 ' + pend.length + '</span></summary>' +
      (S.reqErr ? '<div class="jr-warn">' + esc(S.reqErr) + '</div>' : '') +
      (pend.length ? pend.map(reqCard).join('') : '<div class="jr-empty">' + (S.admin ? '처리 대기 중인 요청이 없습니다.' : '보낸 요청이 없습니다. 구간을 선택해 [구간 변경 요청]을 누르세요.') + '</div>') +
      (done.length ? '<details class="jr-hist"><summary>처리된 요청 ' + done.length + '건</summary>' + done.map(reqCard).join('') + '</details>' : '') + '</details>';
    box.innerHTML = h; box.style.display = 'block';
  }
  function findReq(id) { return S.reqs.filter(function (r) { return String(r.id) === String(id); })[0]; }

  function viewRequest(r) {
    var ids = (r.section_ids || []).filter(function (id) { return S.polys[id]; });
    if (!ids.length) { toast('요청한 구간이 지금 자료에 없습니다.'); return; }
    S.show = {}; ids.forEach(function (id) { S.show[id] = true; });
    var pts = []; ids.forEach(function (id) { S.secMap[id].coords.forEach(function (c) { pts.push([c[1], c[0]]); }); });
    S.map.fitBounds(L.latLngBounds(pts), { padding: [70, 70], maxZoom: 13 }); restyle();
  }
  function pickDestDialog(r) {
    var st = S.view.state;
    modal('<h3>이동할 지사를 정하세요</h3><p class="jr-hint">' + esc(bname(r.branch_id)) + ' 지사가 도착 지사를 정하지 않고 관리자에게 맡겼습니다.</p>' +
      '<div class="jr-form"><label>도착 지사 <select id="jr-reqdest">' + destOptions(st) + '</select></label></div>' +
      '<div class="jr-row"><button class="jr-btn jr-primary" id="jr-reqdestok" data-rid="' + r.id + '">이동 준비</button><button class="jr-btn" id="jr-close">취소</button></div>');
  }
  function destOptions(st, withEmpty) {
    return (withEmpty ? '<option value="">관리자가 정해 주세요</option>' : '') + st.hqs.map(function (hq) {
      var o = st.order.filter(function (id) { return st.branches[id].hq === hq; }).map(function (id) { return '<option value="' + id + '">' + esc(st.branches[id].name) + '</option>'; }).join('');
      return o ? '<optgroup label="' + esc(hq) + '">' + o + '</optgroup>' : '';
    }).join('');
  }
  function prepareMove(r, to) {            // 요청대로 이동을 "변경 대기"에 추가 (저장하면 승인 처리됨)
    var st = S.view.state, secs = (r.section_ids || []).map(function (id) { return S.secMap[id]; }).filter(Boolean);
    if (!secs.length) { window.alert('요청한 구간이 지금 자료에 없습니다.'); return; }
    to = to || r.to_branch_id; if (!to) { pickDestDialog(r); return; }
    if (!st.branches[to]) { window.alert('요청한 도착 지사가 지금 목록에 없습니다. 반려하거나 다른 지사로 이동해 주세요.'); return; }
    var sel = secs.filter(function (s) { return (st.owner[s.id] || 'NONE') !== to; });
    if (!sel.length) {
      if (window.confirm('요청한 구간이 이미 ' + bname(to) + ' 지사 소속입니다. 이 요청을 승인 처리(완료)할까요?')) JurisRequests.resolve([r.id], 'approved', '이미 요청한 지사 소속임').then(function () { loadRequests(); JurisRequests.check(true); });
      return;
    }
    var from = []; sel.forEach(function (s) { var o = st.owner[s.id] || null; if (from.indexOf(o) < 0) from.push(o); });
    S.pending.push({ t: 'move', sections: sel.map(function (s) { return s.id; }), to: to, from: from, km: round1(sel.reduce(function (a, s) { return a + s.km; }, 0)), req: r.id });
    S.show = {}; afterChange(true); toast('변경 대기에 추가했습니다 (요청 #' + r.id + '). 아래 [변경 저장]을 누르면 반영되고 요청이 승인 처리됩니다.');
  }
  function rejectRequest(r) {
    var note = window.prompt(bname(r.branch_id) + ' 지사 요청 #' + r.id + '을 반려합니다.\n반려 사유를 입력하세요 (200자 이내, 비워도 됩니다)', '');
    if (note === null) return;
    JurisRequests.resolve([r.id], 'rejected', note).then(function (res) { toast(res.ok ? '요청 #' + r.id + '을 반려했습니다.' : res.message); loadRequests(); JurisRequests.check(true); });
  }
  function cancelRequest(r) {
    if (!window.confirm('요청 #' + r.id + '을 취소할까요?')) return;
    JurisRequests.cancel(r.id).then(function (res) { toast(res.ok ? '요청을 취소했습니다.' : res.message); loadRequests(); });
  }

  // 지사: 선택한 구간을 다른 기관으로 옮겨 달라는 요청 보내기
  function openRequestDialog() {
    var sel = selectedList(); if (!sel.length) return;
    var st = S.view.state, km = round1(sel.reduce(function (a, s) { return a + s.km; }, 0));
    var rows = sel.slice(0, 8).map(function (s) { var o = st.owner[s.id]; return '<tr><td>' + esc(s.route) + '</td><td>' + esc(s['from']) + ' → ' + esc(s.to) + '</td><td>' + s.km + 'km</td><td>' + (o ? esc(bname(o)) : '미지정') + '</td></tr>'; }).join('') +
      (sel.length > 8 ? '<tr><td colspan="4" class="jr-hint">… 외 ' + (sel.length - 8) + '개 구간</td></tr>' : '');
    modal('<h3>구간 변경 요청</h3><p class="jr-hint">선택한 구간을 다른 기관으로 옮겨 달라고 관리자에게 요청합니다. 관리자가 확인한 뒤 반영하며, 처리 결과는 "내 변경 요청"에서 볼 수 있습니다.</p>' +
      '<div class="jr-tablewrap"><table class="jr-table"><thead><tr><th>노선</th><th>구간</th><th>길이</th><th>현재 소속</th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
      '<div class="jr-form"><label>' + sel.length + '개 구간(' + km + 'km)을 옮길 기관 <select id="jr-req-to">' + destOptions(st, true) + '</select></label>' +
      '<label>사유 (선택, 200자 이내) <textarea id="jr-req-reason" maxlength="200" rows="3" placeholder="예: 이 구간은 실제로 ○○지사가 제설하고 있습니다"></textarea></label></div>' +
      '<div id="jr-req-msg"></div><div class="jr-row"><button class="jr-btn jr-primary" id="jr-req-send">요청 보내기</button><button class="jr-btn" id="jr-close">취소</button></div>');
  }
  function sendRequest() {
    var sel = selectedList(), btn = $('jr-req-send'), msg = $('jr-req-msg'); if (!sel.length) return;
    if (sel.length > 60) { msg.innerHTML = '<div class="jr-warn">한 번에 60개 구간까지 요청할 수 있습니다. 나누어 요청하세요.</div>'; return; }
    btn.disabled = true; btn.textContent = '보내는 중…';
    JurisRequests.create({ sections: sel.map(secSnap), to: $('jr-req-to').value, reason: $('jr-req-reason').value }).then(function (res) {
      if (!res.ok) { msg.innerHTML = '<div class="jr-warn">' + esc(res.message) + '</div>'; btn.disabled = false; btn.textContent = '요청 보내기'; return; }
      closeModal(); S.selected = {}; S.last = null; S.clicked = null; afterChange(false);
      toast('요청을 보냈습니다. 관리자가 로그인하면 알림창으로 안내됩니다.'); loadRequests();
    });
  }

  /* ---------- 바깥에서 쓰는 함수 ---------- */
  function init() {
    var root = $('view-jurisdiction'); if (!root) return;
    if (!J() || !J().doc) { root.innerHTML = '<div class="jr-empty" style="padding:30px">관할 구간 데이터(data/sections.json)를 불러오지 못했습니다.</div>'; return; }
    S.secMap = {}; J().doc.sections.forEach(function (s) { S.secMap[s.id] = s; });
    var me = window.SS_ME || null;            // 로그인한 사람 (첫 화면 로그인 잠금이 채움). 없으면 보기 전용
    S.admin = !!(me && me.role === 'admin'); S.canRequest = !!(me && me.role === 'branch');
    buildShell(); bind(); $('view-jurisdiction').classList.toggle('jr-is-admin', S.admin);
    S.view = C.summarize(J().doc, events());
    S.inited = true;
  }
  function show() {
    if (!S.inited) return;
    ensureMap(); afterChange(false); if (selectMode()) loadRequests();
  }
  function openRequests() { S.reqOpen = true; S.search = ''; var s = $('jr-search'); if (s) s.value = ''; return loadRequests().then(function () { var b = $('jr-requests'); if (b && b.scrollIntoView) b.scrollIntoView({ block: 'nearest' }); }); }
  window.JurisdictionUI = { init: init, show: show, openRequests: openRequests, refreshRequests: loadRequests, _state: function () { return S; }, _casing: casingColors, _contrast: contrast, _near: nearestSection, _width: widthFor, NEAR_PX: NEAR_PX };
})();
