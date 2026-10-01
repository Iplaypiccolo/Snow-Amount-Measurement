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
  var S = { inited: false, admin: false, selected: {}, last: null, pending: [], focus: null, map: null, polys: {}, roads: null, search: '', view: null, secMap: null };

  function J() { return window.JURIS; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function $(id) { return document.getElementById(id); }
  function base() { return J().session || J().committed; }
  function events() { return base().concat(S.pending); }
  function round1(x) { return Math.round(x * 10) / 10; }
  function fmt(v) { return v == null ? '-' : v + 'cm'; }

  /* ---------- 색: 본부마다 색상(hue), 같은 본부 안에서는 밝기를 번갈아 ---------- */
  function colorOf(id) {
    var st = S.view.state, b = st.branches[id];
    if (!b) return '#999';
    var hqI = st.hqs.indexOf(b.hq), idx = 0;
    for (var i = 0; i < st.order.length; i++) { var o = st.branches[st.order[i]]; if (o.hq === b.hq) { if (o.id === id) break; idx++; } }
    var light = [36, 50, 26, 58][idx % 4];
    return 'hsl(' + Math.round(hqI * 360 / st.hqs.length + 8) + ',72%,' + light + '%)';
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
        '<div class="jr-legend">점선 = 변경 대기 · 굵은 분홍 = 선택한 구간 <label><input type="checkbox" id="jr-roads" checked> 배경 도로</label></div>' +
      '</div></div>' +
      '<div id="jr-modal" class="jr-modal" style="display:none"></div>';
    $('jr-note').innerHTML = '지도에서 구간을 누르면 소속 정보가 보입니다. 변경하려면 <b>관리자 모드</b>를 켜세요. 이 모드는 화면 편의 기능이며, 실제 반영은 저장 파일을 저장소에 올릴 수 있는 사람만 할 수 있습니다.';
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
      var p = L.polyline(sec.coords.map(function (c) { return [c[1], c[0]]; }), { weight: 4, opacity: 0.95 }).addTo(S.map);
      p.bindPopup(function () { return infoHtml(sec); });
      p.on('click', function (e) { onSectionClick(sec, e.originalEvent); });
      S.polys[sec.id] = p;
    });
    S.map.on('popupopen', function (e) {          // 닫기(X)가 href="#" 라서 상위 프레임으로 이동하는 문제 방지
      var btn = e.popup && e.popup._closeButton;
      if (btn) { btn.removeAttribute('href'); L.DomEvent.off(btn, 'click'); L.DomEvent.on(btn, 'click', function (ev) { L.DomEvent.preventDefault(ev); S.map.closePopup(e.popup); }); }
    });
    setTimeout(function () { S.map.invalidateSize(); }, 50);
  }

  function infoHtml(sec) {
    var st = S.view.state, o = st.branches[st.owner[sec.id]];
    return '<b>' + esc(sec.route) + '</b><br>' + esc(sec['from']) + ' → ' + esc(sec.to) + ' · ' + sec.km + 'km<br>' +
      '소속: <b>' + esc(o ? o.name : '-') + '</b> 지사 (' + esc(o ? o.hq : '-') + ')';
  }

  /* ---------- 지도 스타일 ---------- */
  function restyle() {
    var st = S.view.state, committed = C.resolve(J().doc, base()).owner;
    J().doc.sections.forEach(function (sec) {
      var p = S.polys[sec.id]; if (!p) return;
      var own = st.owner[sec.id], sel = !!S.selected[sec.id], dim = S.focus && own !== S.focus;
      p.setStyle({
        color: sel ? '#ff00aa' : colorOf(own), weight: sel ? 8 : (S.focus && own === S.focus ? 6 : 4),
        opacity: dim ? 0.22 : 0.95, dashArray: own !== committed[sec.id] ? '7,7' : null
      });
      if (sel) p.bringToFront();
    });
  }

  /* ---------- 구간 선택 ---------- */
  function onSectionClick(sec, ev) {
    if (!S.admin) return;                       // 보기 모드: 팝업만
    if (S.map) S.map.closePopup();
    if (ev && ev.shiftKey && S.last && S.last.chain === sec.chain) {       // Shift+클릭: 같은 노선 줄에서 범위 선택
      var lo = Math.min(S.last.order, sec.order), hi = Math.max(S.last.order, sec.order);
      J().doc.sections.forEach(function (s) { if (s.chain === sec.chain && s.order >= lo && s.order <= hi) S.selected[s.id] = true; });
    } else {
      if (S.selected[sec.id]) delete S.selected[sec.id]; else S.selected[sec.id] = true;
    }
    S.last = sec; afterChange(false);
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
    var prev = $('jr-dest') ? $('jr-dest').value : '';
    bar.innerHTML = '<b>' + sel.length + '개 구간 · ' + km + 'km 선택</b> → 이동할 지사 <select id="jr-dest">' + opts + '</select>' +
      '<button id="jr-move" class="jr-btn jr-primary">이동 대기에 추가</button><button id="jr-clear" class="jr-btn">선택 해제</button>';
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
    $('jr-tree').innerHTML = html || '<div class="jr-empty">검색 결과가 없습니다.</div>';
  }

  function branchDetail(id) {
    var st = S.view.state, secs = J().doc.sections.filter(function (s) { return st.owner[s.id] === id; });
    var h = '<div class="jr-detail">';
    if (S.admin) {
      h += '<div class="jr-row">본부 변경: <select id="jr-hq">' + st.hqs.map(function (hq) { return '<option' + (hq === st.branches[id].hq ? ' selected' : '') + '>' + esc(hq) + '</option>'; }).join('') + '</select>' +
        '<button class="jr-btn" id="jr-selall">이 지사 구간 전체 선택</button></div>';
    }
    if (!secs.length) return h + '<div class="jr-empty">관할 구간이 없습니다. 지도에서 구간을 골라 이 지사로 옮기세요.</div></div>';
    h += secs.map(function (s) {
      return '<div class="jr-sec" data-sid="' + s.id + '">' + (S.admin ? '<input type="checkbox" data-sid="' + s.id + '"' + (S.selected[s.id] ? ' checked' : '') + '> ' : '') +
        '<span>' + esc(s.route) + '</span> ' + esc(s['from']) + ' → ' + esc(s.to) + ' <em>' + s.km + 'km</em></div>';
    }).join('');
    return h + '</div>';
  }

  /* ---------- 변경 대기 / 저장 ---------- */
  function describe(ev) {
    var st = S.view.state, nm = function (id) { return st.branches[id] ? st.branches[id].name : id; };
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
    modal('<h3>저장 파일을 내려받았습니다</h3><p><b>jurisdiction_changes.json</b> 을 저장소의 <code>data/jurisdiction_changes.json</code> 에 덮어쓰고 커밋하면 모든 사용자에게 적용됩니다.</p>' +
      '<p>되돌리려면 이전 커밋의 같은 파일로 되돌리면 됩니다.</p><div class="jr-row"><button class="jr-btn jr-primary" id="jr-close">확인</button></div>');
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

  function addMove() {
    var sel = selectedList(), to = $('jr-dest').value; if (!sel.length || !to) return;
    var st = S.view.state, from = []; sel.forEach(function (s) { var o = st.owner[s.id]; if (o !== to && from.indexOf(o) < 0) from.push(o); });
    if (!from.length) { window.alert('선택한 구간이 이미 그 지사 소속입니다.'); return; }
    S.pending.push({ t: 'move', sections: sel.map(function (s) { return s.id; }), to: to, from: from, km: round1(sel.reduce(function (a, s) { return a + s.km; }, 0)) });
    S.selected = {}; S.last = null; afterChange(true);
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
    restyle(); renderTree(); renderPending(); renderSelBar();
  }

  function focusBranch(id) {
    S.focus = S.focus === id ? null : id;
    afterChange(false);
    if (S.focus) {
      var pts = []; J().doc.sections.forEach(function (s) { if (S.view.state.owner[s.id] === S.focus) s.coords.forEach(function (c) { pts.push([c[1], c[0]]); }); });
      if (pts.length) S.map.fitBounds(L.latLngBounds(pts), { padding: [40, 40], maxZoom: 11 });
    }
  }

  function bind() {
    $('jr-admin').addEventListener('change', function (e) {
      S.admin = e.target.checked; if (!S.admin) { S.selected = {}; S.last = null; }
      document.getElementById('view-jurisdiction').classList.toggle('jr-is-admin', S.admin);
      afterChange(false);
    });
    $('jr-search').addEventListener('input', function (e) { S.search = e.target.value; renderTree(); });
    $('jr-add').addEventListener('click', addBranchDialog);
    $('jr-roads').addEventListener('change', function (e) { if (e.target.checked) S.roads.addTo(S.map); else S.map.removeLayer(S.roads); });
    document.getElementById('view-jurisdiction').addEventListener('click', function (e) {
      var t = e.target;
      var br = t.closest && t.closest('.jr-br'); if (br) { focusBranch(br.dataset.id); return; }
      var sec = t.closest && t.closest('.jr-sec');
      if (sec && t.tagName === 'INPUT') { if (t.checked) S.selected[sec.dataset.sid] = true; else delete S.selected[sec.dataset.sid]; afterChange(false); return; }
      if (sec) { var p = S.polys[sec.dataset.sid]; if (p) S.map.fitBounds(p.getBounds(), { padding: [60, 60], maxZoom: 13 }); return; }
      var id = t.id;
      if (id === 'jr-move') addMove();
      else if (id === 'jr-clear') { S.selected = {}; S.last = null; afterChange(false); }
      else if (id === 'jr-selall') { J().doc.sections.forEach(function (s) { if (S.view.state.owner[s.id] === S.focus) S.selected[s.id] = true; }); afterChange(false); }
      else if (id === 'jr-preview') preview();
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
  window.JurisdictionUI = { init: init, show: show, _state: function () { return S; } };
})();
