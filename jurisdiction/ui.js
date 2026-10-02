/* ============================================================
   jurisdiction/ui.js — "기관별 관할 고속도로" 탭 화면
   - 지도에서 구간(IC/JC 사이)을 눌러 골라 다른 지사로 옮기고, 신설 기관 추가·지사의 본부 이동을 할 수 있습니다.
   - 변경은 "변경 대기"에 쌓이고, [변경 저장]을 누르면 data/jurisdiction_changes.json 파일을 내려받습니다.
     이 파일을 저장소에 커밋하면 모든 사용자에게 적용됩니다. (계산은 jurisdiction/core.js)
   - 관리자 모드는 화면 편의 기능입니다. 실제 반영 권한은 저장소에 쓸 수 있는 사람에게만 있습니다.
   ============================================================ */
(function () {
  'use strict';
  var C = window.JurisCore;
  var S = { inited: false, admin: false, selected: {}, last: null, clicked: null, pick: false, pending: [], focus: null, map: null, polys: {}, casing: null, ends: null, roads: null, search: '', view: null, secMap: null };

  function J() { return window.JURIS; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function $(id) { return document.getElementById(id); }
  function base() { return J().session || J().committed; }
  function events() { return base().concat(S.pending); }
  function round1(x) { return Math.round(x * 10) / 10; }
  function fmt(v) { return v == null ? '-' : v + 'cm'; }

  /* ---------- 색: 본부마다 색상(hue), 같은 본부 안에서는 밝기를 번갈아 ---------- */
  var NONE_COLOR = '#4a4a4a';           // 어느 지사에도 속하지 않은 고속도로: 진한 회색 점선
  function colorOf(id) {
    var st = S.view.state, b = st.branches[id];
    if (id == null || id === 'NONE') return NONE_COLOR;
    if (!b) return '#999';
    var hqI = st.hqs.indexOf(b.hq), idx = 0;
    for (var i = 0; i < st.order.length; i++) { var o = st.branches[st.order[i]]; if (o.hq === b.hq) { if (o.id === id) break; idx++; } }
    var light = [36, 50, 26, 58][idx % 4];
    return 'hsl(' + Math.round(hqI * 360 / st.hqs.length + 8) + ',72%,' + light + '%)';
  }

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
        '<div class="jr-head"><b>기관별 관할 고속도로</b>' +
        '<label class="jr-admin"><input type="checkbox" id="jr-admin"> 관리자 모드</label></div>' +
        '<div class="jr-note" id="jr-note"></div>' +
        '<div class="jr-tools"><input id="jr-search" placeholder="지사 검색 (예: 춘천)">' +
        '<button id="jr-add" class="jr-btn jr-admin-only">+ 신설 기관</button></div>' +
        '<div id="jr-tree" class="jr-tree"></div>' +
        '<div id="jr-pending" class="jr-pending"></div>' +
      '</div>' +
      '<div class="jr-mapbox"><div id="jmap"></div>' +
        '<div id="jr-selbar" class="jr-selbar" style="display:none"></div>' +
        '<div id="jr-savebar" class="jr-savebar" style="display:none"></div>' +
        '<div id="jr-pickbar" class="jr-pickbar" style="display:none">도착 지사로 삼을 구간을 지도에서 클릭하세요 <button id="jr-pickcancel" class="jr-btn">취소 (Esc)</button></div>' +
        '<div class="jr-legend">이중 테두리 = 선택·클릭한 구간 · 굵은 점선 = 변경 대기 · <b style="color:#4a4a4a">회색 점선 = 미지정(어느 지사에도 속하지 않음)</b> <label><input type="checkbox" id="jr-roads" checked> 배경 도로</label></div>' +
      '</div></div>' +
      '<div id="jr-modal" class="jr-modal" style="display:none"></div>';
    $('jr-note').innerHTML = '지도에서 구간을 누르면 테두리와 함께 소속 정보가 보입니다. 변경하려면 <b>관리자 모드</b>를 켜고 구간을 누르세요. 이 모드는 화면 편의 기능이며, 실제 반영은 저장 파일을 저장소에 올릴 수 있는 사람만 할 수 있습니다.';
  }

  function ensureMap() {
    if (S.map) { setTimeout(function () { S.map.invalidateSize(); }, 50); return; }
    S.map = L.map('jmap', { preferCanvas: true, zoomControl: true }).setView([36.4, 127.9], 7);
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
    });
    S.casing = L.layerGroup().addTo(S.map);          // 선택·클릭한 구간의 이중 테두리
    S.ends = L.layerGroup().addTo(S.map);            // 시점·종점 IC/JC 표시
    S.map.on('popupclose', function () { if (!S.admin && S.clicked) { S.clicked = null; restyle(); } });   // 보기 모드: 팝업을 닫으면 테두리도 해제
    S.map.on('popupopen', function (e) {          // 닫기(X)가 href="#" 라서 상위 프레임으로 이동하는 문제 방지
      var btn = e.popup && e.popup._closeButton;
      if (btn) { btn.removeAttribute('href'); L.DomEvent.off(btn, 'click'); L.DomEvent.on(btn, 'click', function (ev) { L.DomEvent.preventDefault(ev); S.map.closePopup(e.popup); }); }
    });
    setTimeout(function () { S.map.invalidateSize(); }, 50);
  }

  function infoHtml(sec) {
    var st = S.view.state, o = st.branches[st.owner[sec.id]];
    return '<b>' + esc(sec.route) + '</b><br>' + esc(sec['from']) + ' → ' + esc(sec.to) + ' · ' + sec.km + 'km<br>' +
      (o ? '소속: <b>' + esc(o.name) + '</b> 지사 (' + esc(o.hq) + ')' : '소속: <b>미지정</b> (어느 지사에도 속하지 않음)') +
      (S.admin ? '' : '<div style="margin-top:7px"><button class="jr-btn jr-popbtn" data-sid="' + sec.id + '">이 구간 옮기기 (관리자 모드 켜기)</button></div>');
  }

  /* ---------- 지도 스타일 ---------- */
  function latlngsOf(sec) { return sec.coords.map(function (c) { return [c[1], c[0]]; }); }

  function restyle() {
    var st = S.view.state, committed = C.resolve(J().doc, base()).owner, hl = {};
    Object.keys(S.selected).forEach(function (id) { hl[id] = true; });
    if (S.clicked) hl[S.clicked] = true;
    J().doc.sections.forEach(function (sec) {
      var p = S.polys[sec.id]; if (!p) return;
      var own = st.owner[sec.id], key = own || 'NONE', dim = S.focus && key !== S.focus && !hl[sec.id];
      p.setStyle({
        color: colorOf(own), weight: hl[sec.id] || (S.focus && key === S.focus) ? 6 : 4,
        opacity: dim ? 0.22 : 0.95,
        dashArray: own !== committed[sec.id] ? '7,7' : (own === null ? '2,8' : null),   // 점선 굵음=변경 대기, 점 모양=미지정
        lineCap: own === null ? 'round' : 'butt'
      });
    });
    // 이중 테두리: 가장 바깥(반대색 띠) → 테두리 → 구간 선 순서로 겹쳐 그림
    S.casing.clearLayers(); S.ends.clearLayers();
    var ids = Object.keys(hl).filter(function (id) { return S.polys[id]; }), outers = [], cases = [];
    ids.forEach(function (id) {
      var sec = S.secMap[id], cc = casingColors(colorOf(st.owner[id])), ll = latlngsOf(sec);
      outers.push(L.polyline(ll, { color: cc.outer, weight: 20, opacity: 0.7, interactive: false, lineCap: 'round' }).addTo(S.casing));
      cases.push(L.polyline(ll, { color: cc.casing, weight: 13, opacity: 1, interactive: false, lineCap: 'round' }).addTo(S.casing));
    });
    outers.forEach(function (l) { l.bringToFront(); });
    cases.forEach(function (l) { l.bringToFront(); });
    ids.forEach(function (id) { S.polys[id].bringToFront(); });
    var endId = S.clicked || (ids.length === 1 ? ids[0] : null);       // 시점·종점은 마지막으로 누른 구간(또는 1개 선택 시)만
    if (endId && S.secMap[endId]) addEnds(S.secMap[endId]);
  }

  function addEnds(sec) {
    var pts = [[sec.coords[0], 'start', sec['from']], [sec.coords[sec.coords.length - 1], 'end', sec.to]];
    pts.forEach(function (x) {
      var name = x[2] === '(IC 아님)' ? '구간 끝' : x[2], label = (x[1] === 'start' ? '시점 ' : '종점 ') + name;
      L.circleMarker([x[0][1], x[0][0]], { radius: 7, color: '#0b130e', weight: 3, fillColor: '#ffffff', fillOpacity: 1, interactive: false })
        .bindTooltip(esc(label), { permanent: true, direction: x[1] === 'start' ? 'top' : 'bottom', offset: [0, x[1] === 'start' ? -8 : 8], className: 'jr-endtip' })
        .addTo(S.ends);
    });
  }

  /* ---------- 구간 선택 ---------- */
  function onSectionClick(sec, ev) {
    if (!S.admin) { S.clicked = sec.id; restyle(); return; }       // 보기 모드: 팝업 + 테두리
    if (S.map) S.map.closePopup();
    if (S.pick) { pickDestination(sec); return; }                 // 도착 지사를 지도에서 찍는 중
    if (ev && ev.shiftKey && S.last && S.last.chain === sec.chain) {       // Shift+클릭: 같은 노선 줄에서 범위 선택
      var lo = Math.min(S.last.order, sec.order), hi = Math.max(S.last.order, sec.order);
      J().doc.sections.forEach(function (s) { if (s.chain === sec.chain && s.order >= lo && s.order <= hi) S.selected[s.id] = true; });
    } else {
      if (S.selected[sec.id]) delete S.selected[sec.id]; else S.selected[sec.id] = true;
    }
    S.clicked = S.selected[sec.id] ? sec.id : null;
    S.last = sec; afterChange(false);
  }

  function setAdmin(on) {
    S.admin = on; if (!on) { S.selected = {}; S.last = null; S.pick = false; S.clicked = null; }
    $('jr-admin').checked = on;
    $('view-jurisdiction').classList.toggle('jr-is-admin', on);
    afterChange(false);
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
    if (!S.admin || !sel.length) { bar.style.display = 'none'; return; }
    var st = S.view.state, km = round1(sel.reduce(function (a, s) { return a + s.km; }, 0));
    var opts = st.hqs.map(function (hq) {
      var o = st.order.filter(function (id) { return st.branches[id].hq === hq; }).map(function (id) { return '<option value="' + id + '">' + esc(st.branches[id].name) + '</option>'; }).join('');
      return o ? '<optgroup label="' + esc(hq) + '">' + o + '</optgroup>' : '';
    }).join('');
    opts += '<optgroup label="기타"><option value="NONE">미지정으로 되돌리기</option></optgroup>';
    var prev = $('jr-dest') ? $('jr-dest').value : '';
    bar.innerHTML = '<b>' + sel.length + '개 구간 · ' + km + 'km 선택</b> → 이동할 지사 <select id="jr-dest">' + opts + '</select>' +
      '<button id="jr-move" class="jr-btn jr-primary">이동 대기에 추가</button><button id="jr-pick" class="jr-btn">지도에서 도착 지사 고르기</button><button id="jr-clear" class="jr-btn">선택 해제</button>';
    if (prev) $('jr-dest').value = prev;
    bar.style.display = 'flex';
  }

  /* ---------- 지사 목록(트리) ---------- */
  function renderTree() {
    var st = S.view.state, km = S.view.km, cnt = S.view.count, q = S.search.trim();
    var html = st.hqs.map(function (hq) {
      var ids = st.order.filter(function (id) { return st.branches[id].hq === hq && (!q || st.branches[id].name.indexOf(q) >= 0); });
      if (!ids.length) return '';
      var total = round1(ids.reduce(function (a, id) { return a + (km[id] || 0); }, 0));
      return '<div class="jr-hq"><div class="jr-hqname">' + esc(hq) + ' <span>' + total + 'km</span></div>' + ids.map(function (id) {
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
    }
    if (S.admin && id === 'NONE') h += '<div class="jr-row"><button class="jr-btn" id="jr-selall">미지정 구간 전체 선택</button></div>';
    if (!secs.length) return h + '<div class="jr-empty">' + (id === 'NONE' ? '미지정 구간이 없습니다.' : '관할 구간이 없습니다. 지도에서 구간을 골라 이 지사로 옮기세요.') + '</div></div>';
    h += secs.map(function (s) {
      return '<div class="jr-sec" data-sid="' + s.id + '">' + (S.admin ? '<input type="checkbox" data-sid="' + s.id + '"' + (S.selected[s.id] ? ' checked' : '') + '> ' : '') +
        '<span>' + esc(s.route) + '</span> ' + esc(s['from']) + ' → ' + esc(s.to) + ' <em>' + s.km + 'km</em></div>';
    }).join('');
    return h + '</div>';
  }

  /* ---------- 변경 대기 / 저장 ---------- */
  function describe(ev) {
    var st = S.view.state, nm = function (id) { return id == null || id === 'NONE' ? '미지정' : (st.branches[id] ? st.branches[id].name : id); };
    if (ev.t === 'move') return ev.sections.length + '개 구간(' + (ev.km != null ? ev.km : '?') + 'km): ' + (ev.from || []).map(nm).join('·') + ' → <b>' + esc(nm(ev.to)) + '</b>';
    if (ev.t === 'addBranch') return '신설 기관: <b>' + esc(ev.name) + '</b> (' + esc(ev.hq) + ')';
    if (ev.t === 'moveHq') return '<b>' + esc(nm(ev.branch)) + '</b>: ' + esc(ev.fromHq || '?') + ' → ' + esc(ev.hq);
    return esc(ev.t);
  }

  function renderPending() {
    var box = $('jr-pending'), com = base();
    var h = '';
    if (J().session) h += '<div class="jr-warn">⚠ 이 브라우저에만 임시 적용된 변경이 있습니다. 저장 파일을 저장소에 올리면 모두에게 적용됩니다.</div>';
    if (S.pending.length) {
      h += '<div class="jr-ptitle">변경 대기 ' + S.pending.length + '건</div>' +
        S.pending.map(function (ev, i) { return '<div class="jr-ev">' + describe(ev) + '<button class="jr-x" data-ev="' + i + '" title="이 변경 취소">×</button></div>'; }).join('') +
        '<input id="jr-reason" class="jr-reason" placeholder="변경 사유 (선택)" value="' + esc(S.reason || '') + '">' +
        '<div class="jr-row"><button class="jr-btn" id="jr-preview">미리보기</button><button class="jr-btn jr-primary" id="jr-save">변경 저장(파일 받기)</button></div>' +
        '<div class="jr-row"><button class="jr-btn" id="jr-apply">이 브라우저에 바로 적용</button><button class="jr-btn" id="jr-cancel">모두 취소</button></div>';
    }
    if (com.length) h += '<details class="jr-hist"><summary>저장된 변경 이력 ' + com.length + '건</summary>' +
      com.slice().reverse().slice(0, 30).map(function (ev) { return '<div class="jr-ev old">' + (ev.at ? esc(String(ev.at).slice(0, 10)) + ' ' : '') + describe(ev) + (ev.note ? ' <em>' + esc(ev.note) + '</em>' : '') + '</div>'; }).join('') + '</details>';
    box.innerHTML = h;
    box.style.display = h ? 'block' : 'none';
  }

  function stampPending() {
    var now = new Date().toISOString(), reason = ($('jr-reason') && $('jr-reason').value || S.reason || '').trim();
    S.reason = reason;
    return S.pending.map(function (ev) { var c = JSON.parse(JSON.stringify(ev)); c.at = c.at || now; if (reason) c.note = reason; return c; });
  }

  function saveFile() {
    var data = { version: 1, events: base().concat(stampPending()) };
    var blob = new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' });
    var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'jurisdiction_changes.json'; a.click();
    var up = uploadUrl(location.hostname, location.pathname);
    modal('<h3>저장 파일을 내려받았습니다</h3>' +
      '<p class="jr-hint" style="color:#8a4b00">⚠ 아직 사이트에 반영된 것이 아닙니다. 아래 순서로 올려야 모든 사용자에게 적용됩니다.</p>' +
      '<ol style="line-height:1.7;font-size:13.5px;padding-left:20px"><li>내려받은 <b>jurisdiction_changes.json</b> 파일을 준비합니다. (다운로드 폴더)</li>' +
      '<li>GitHub 저장소의 <code>data</code> 폴더에 같은 이름으로 올립니다. 같은 이름이면 기존 파일이 바뀝니다.</li>' +
      '<li>화면 아래 <b>Commit changes</b>를 누르면 1~2분 뒤 사이트에 반영됩니다.</li></ol>' +
      '<p class="jr-hint">되돌리려면 GitHub에서 그 파일의 이전 커밋 내용으로 되돌리면 됩니다.</p>' +
      '<div class="jr-row">' + (up ? '<a class="jr-btn jr-primary" style="text-decoration:none" href="' + esc(up) + '" target="_blank" rel="noopener">GitHub에서 파일 올리기 ↗</a>' : '') +
      '<button class="jr-btn" id="jr-close">닫기</button></div>');
  }

  function applyHere() {
    if (!window.confirm('이 브라우저에 바로 적용하려면 페이지를 새로고침합니다.\n지금 업로드해 둔 신적설 데이터(저장하지 않은 것)가 사라질 수 있습니다. 계속할까요?')) return;
    try { sessionStorage.setItem('juris_session', JSON.stringify({ events: base().concat(stampPending()) })); } catch (e) { window.alert('이 브라우저에서는 임시 적용을 할 수 없습니다.'); return; }
    location.reload();
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
      var stn = (a ? a.stations.length : 0) + '곳 → ' + (b ? b.stations.length : 0) + '곳' + (b && b.radiusKm ? ' <span>(반경 ' + b.radiusKm + 'km)</span>' : '') +
        (r.added.length ? '<div class="p">+ ' + esc(r.added.join(', ')) + '</div>' : '') + (r.removed.length ? '<div class="m">− ' + esc(r.removed.join(', ')) + '</div>' : '');
      var zero = b && b.sections === 0 ? '<div class="m">관할 구간이 없어 적설을 계산할 수 없습니다.</div>' : '';
      return '<tr><td>' + name + zero + '</td><td>' + km + 'km</td><td>' + stn + '</td><td>' + fmt(a && a.latestMax) + ' → ' + fmt(b && b.latestMax) + '</td><td>' + fmt(a && a.allMax) + ' → ' + fmt(b && b.allMax) + '</td></tr>';
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
    restyle(); renderTree(); renderPending(); renderSelBar(); renderSaveBar();
  }

  /* ---------- 항상 보이는 저장 바 (관리자 모드): 지도 오른쪽 위 ---------- */
  function uploadUrl(host, path) {          // github.io 에서 열었을 때 data 폴더 업로드 화면 주소를 만들어 줌
    var m = /^([^.]+)\.github\.io$/.exec(host || ''), repo = (path || '').split('/')[1];
    return m && repo ? 'https://github.com/' + m[1] + '/' + repo + '/upload/main/data' : null;
  }
  function renderSaveBar() {
    var bar = $('jr-savebar'); if (!bar) return;
    if (!S.admin) { bar.style.display = 'none'; return; }
    var n = S.pending.length;
    bar.className = 'jr-savebar' + (n ? ' dirty' : '');
    bar.innerHTML = '<span class="st">' + (n ? '● 저장하지 않은 변경 ' + n + '건' : '변경 없음 — 구간을 눌러 지사를 옮기세요') + '</span>' +
      '<button class="jr-btn" id="jr-top-preview"' + (n ? '' : ' disabled') + '>미리보기</button>' +
      '<button class="jr-btn" id="jr-top-cancel"' + (n ? '' : ' disabled') + '>모두 취소</button>' +
      '<button class="jr-btn jr-primary" id="jr-top-save"' + (n ? '' : ' disabled') + ' title="변경 내용을 파일로 저장합니다">저장</button>';
    bar.style.display = 'flex';
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
    $('jr-admin').addEventListener('change', function (e) { setAdmin(e.target.checked); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && S.pick) setPick(false); });
    $('jr-search').addEventListener('input', function (e) { S.search = e.target.value; renderTree(); });
    $('jr-add').addEventListener('click', addBranchDialog);
    $('jr-roads').addEventListener('change', function (e) { if (e.target.checked) S.roads.addTo(S.map); else S.map.removeLayer(S.roads); });
    document.getElementById('view-jurisdiction').addEventListener('click', function (e) {
      var t = e.target;
      var pb = t.closest && t.closest('.jr-popbtn');                 // 팝업의 [이 구간 옮기기]: 관리자 모드로 바꾸고 그 구간을 선택
      if (pb) { var sid = pb.dataset.sid; S.map.closePopup(); setAdmin(true); S.selected[sid] = true; S.clicked = sid; S.last = S.secMap[sid]; afterChange(false); return; }
      var br = t.closest && t.closest('.jr-br'); if (br) { focusBranch(br.dataset.id); return; }
      var sec = t.closest && t.closest('.jr-sec');
      if (sec && t.tagName === 'INPUT') { if (t.checked) S.selected[sec.dataset.sid] = true; else delete S.selected[sec.dataset.sid]; afterChange(false); return; }
      if (sec) { var p = S.polys[sec.dataset.sid]; if (p) S.map.fitBounds(p.getBounds(), { padding: [60, 60], maxZoom: 13 }); return; }
      var id = t.id;
      if (id === 'jr-move') addMove();
      else if (id === 'jr-pick') setPick(true);
      else if (id === 'jr-pickcancel') setPick(false);
      else if (id === 'jr-clear') { S.selected = {}; S.last = null; S.clicked = null; afterChange(false); }
      else if (id === 'jr-selall') { J().doc.sections.forEach(function (s) { if ((S.view.state.owner[s.id] || 'NONE') === S.focus) S.selected[s.id] = true; }); afterChange(false); }
      else if (id === 'jr-preview' || id === 'jr-top-preview') preview();
      else if (id === 'jr-top-save') saveFile();
      else if (id === 'jr-top-cancel') { if (S.pending.length && window.confirm('변경 대기 ' + S.pending.length + '건을 모두 취소할까요?')) { S.pending = []; afterChange(true); } }
      else if (id === 'jr-save') saveFile();
      else if (id === 'jr-apply') applyHere();
      else if (id === 'jr-cancel') { S.pending = []; afterChange(true); }
      else if (id === 'jr-close') closeModal();
      else if (id === 'jr-newok') createBranch();
      else if (t.classList && t.classList.contains('jr-x')) cancelEvent(parseInt(t.dataset.ev, 10));
    });
    document.getElementById('view-jurisdiction').addEventListener('change', function (e) { if (e.target.id === 'jr-hq') changeHq(e.target.value); });
  }

  /* ---------- 바깥에서 쓰는 함수 ---------- */
  function init() {
    var root = $('view-jurisdiction'); if (!root) return;
    if (!J() || !J().doc) { root.innerHTML = '<div class="jr-empty" style="padding:30px">관할 구간 데이터(data/sections.json)를 불러오지 못했습니다.</div>'; return; }
    S.secMap = {}; J().doc.sections.forEach(function (s) { S.secMap[s.id] = s; });
    buildShell(); bind();
    S.view = C.summarize(J().doc, events());
    S.inited = true;
  }
  function show() {
    if (!S.inited) return;
    ensureMap(); afterChange(false);
  }
  window.JurisdictionUI = { init: init, show: show, _state: function () { return S; }, _casing: casingColors, _contrast: contrast, _uploadUrl: uploadUrl };
})();
