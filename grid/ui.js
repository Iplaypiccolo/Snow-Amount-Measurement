/* ============================================================
   grid/ui.js — "예보 격자 편입" 탭 화면
   - 지도에 기상청 5km 예보 격자를 보여주고, 관리자가 칸을 골라 기관에 편입/제외합니다.
   - 한 격자를 여러 기관이 함께 가질 수 있고, 예보 호출은 "편입된 격자의 합집합"을 한 번씩만 합니다.
   - 변경은 "변경 대기"에 쌓이고, [저장]을 누르면 data/grid_changes.json 파일을 내려받습니다. 저장소에 올리면 모두에게 적용됩니다.
   - 관리자 모드는 화면 편의 기능입니다. 실제 반영 권한은 저장소에 쓸 수 있는 사람에게만 있습니다. (계산: grid/core.js)
   ============================================================ */
(function () {
  'use strict';
  var G = window.GridCore, JC = window.JurisCore;
  var S = { inited: false, admin: false, map: null, rects: {}, lines: null, selected: {}, pending: [], focus: null, search: '', box: false,
            boxStart: null, boxRect: null, justBoxed: false, state: null, res: null, committedRes: null, ids: null, showRing: true, tip: null, hqView: 'ALL', target: 5 };

  function GR() { return window.GRID; }
  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function base() { return GR().committed; }
  function events() { return base().concat(S.pending); }
  function branchName(id) { var b = S.state.branches[id]; return b ? b.name : id; }
  function colorOf(id) {          // 전체 = 본부 색, 본부 = 그 본부 지사마다 다른 색, 지사 선택 = 그 지사만 노랑·나머지 회색(관측소 지도와 같음)
    if (S.focus && S.state.branches[S.focus]) return id === S.focus ? '#FFE400' : '#b4b0a1';
    return JC.colorOf(S.state, id, S.hqView);
  }           // 전체 = 본부 색, 본부 = 그 본부 지사마다 다른 색(관할 탭과 같음)
  function inView(id) { return S.hqView === 'ALL' || (S.state.branches[id] && S.state.branches[id].hq === S.hqView); }

  /* ---------- 상태 다시 계산 ---------- */
  function recompute() {
    var jev = (window.JURIS && (window.JURIS.session || window.JURIS.committed)) || [];
    S.state = JC.resolve(window.JURIS.doc, jev);
    S.ids = new Set(S.state.order.filter(function (id) { return !JC.isPrivate(S.state.branches[id].hq); }));   // 민자는 예보 대상 아님
    S.res = G.resolve(GR().baseline, events(), S.ids);
    S.committedRes = G.resolve(GR().baseline, base(), S.ids);
    S.sum = G.summarize(S.res.assign);
  }
  function cellBranches(k) { var set = S.res.assign.get(k); return set ? Array.from(set) : []; }
  function selectedKeys() { return Object.keys(S.selected); }

  /* ---------- 화면 뼈대 ---------- */
  function buildShell() {
    $('view-grid').innerHTML =
      '<div class="jr-wrap">' +
      '<div class="jr-side">' +
        '<div class="jr-head"><b>예보 격자 편입</b><span class="jr-role">관리자 전용</span></div>' +
        '<div class="jr-note">기상청 예보는 5km 격자 단위입니다. 칸을 눌러 기관에 편입하세요. 한 칸을 <b>여러 기관이 함께</b> 가질 수 있고, 예보 호출은 편입된 칸을 <b>한 번씩만</b> 합니다. 여러 건을 모아 오른쪽 위 <b>[저장]</b>을 누르면 한꺼번에 적용됩니다.</div>' +
        '<div id="gr-summary" class="gr-summary"></div>' +
        '<div class="jr-tools"><input id="gr-search" placeholder="기관 검색 (예: 춘천)"></div>' +
        '<div id="gr-tree" class="jr-tree"></div>' +
        '<div id="gr-pending" class="jr-pending"></div>' +
      '</div>' +
      '<div class="jr-mapbox"><div id="gmap"></div>' +
        '<div id="gr-savebar" class="jr-savebar" style="display:none"></div>' +
        '<div id="gr-tools" class="gr-tools" style="display:none"><button class="jr-btn" id="gr-box">▭ 영역 선택(드래그)</button><span class="hint">Shift+드래그도 됩니다</span></div>' +
        '<div id="gr-selbar" class="jr-selbar" style="display:none"></div>' +
        '<div class="jr-legend gr-legend"><span class="sw sw1"></span>기관 편입 <span class="sw sw2"></span>여러 기관 공유 <span class="sw sw0"></span>후보(편입 안 됨) <span class="sw sw3"></span>선택 <span class="sw sw4"></span>변경 대기' +
          ' <label><input type="checkbox" id="gr-ring" checked> 후보 칸</label> <label><input type="checkbox" id="gr-lines" checked> 고속도로</label></div>' +
      '</div></div><div id="gr-modal" class="jr-modal" style="display:none"></div>';
  }

  /* ---------- 지도 ---------- */
  function rectFor(k) {
    var c = G.unkey(k), r = L.polygon(G.cellCorners(c[0], c[1]), { weight: 1, bubblingMouseEvents: false });
    r.addTo(S.map);
    r.on('click', function () { onCellClick(k); });
    r.on('mouseover', function (e) { showTip(k, e.latlng); });
    r.on('mouseout', function () { if (S.tip) { S.map.closeTooltip(S.tip); S.tip = null; } });
    S.rects[k] = r; return r;
  }
  function ensureMap() {
    if (S.map) { setTimeout(function () { S.map.invalidateSize(); }, 50); return; }
    S.map = L.map('gmap', { renderer: L.canvas({ tolerance: 2 }), boxZoom: false, zoomControl: true }).setView([36.4, 127.9], 8);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '&copy; OpenStreetMap contributors' }).addTo(S.map);
    S.lines = L.layerGroup().addTo(S.map);
    window.JURIS.doc.sections.forEach(function (sec) {
      L.polyline(sec.coords.map(function (c) { return [c[1], c[0]]; }), { weight: 2, opacity: 0.75, interactive: false, color: colorOf(S.state.owner[sec.id]) }).addTo(S.lines);
    });
    S.res.cells.forEach(rectFor);
    bindBox();
    S.map.fitBounds(L.latLngBounds(Object.keys(S.rects).map(function (k) { var c = G.cellCenter.apply(null, G.unkey(k)); return c; })), { padding: [20, 20] });
    setTimeout(function () { S.map.invalidateSize(); }, 50);
  }

  function showTip(k, latlng) {
    var bs = cellBranches(k), c = G.unkey(k);
    var html = '<b>격자 ' + c[0] + ',' + c[1] + '</b><br>' + (bs.length ? '편입: ' + bs.map(function (b) { return esc(branchName(b)); }).join(', ') + (bs.length > 1 ? ' <em>(공유)</em>' : '') : '편입된 기관 없음');
    S.tip = L.tooltip({ sticky: true, direction: 'top', className: 'gr-tip' }).setLatLng(latlng).setContent(html); S.tip.addTo(S.map);
  }

  /* ---------- 칸 색칠 ---------- */
  function styleOf(k) {
    var bs = cellBranches(k), sel = !!S.selected[k], changed = bs.slice().sort().join() !== (S.committedRes.assign.get(k) ? Array.from(S.committedRes.assign.get(k)).sort().join() : '');
    var dim = S.focus && bs.indexOf(S.focus) < 0, hit = S.focus && bs.indexOf(S.focus) >= 0, st;
    if (!bs.length) st = { color: '#8a8a7a', weight: 1, dashArray: '3,3', fillColor: '#cfcfc0', fillOpacity: 0.12, opacity: 0.8 };
    else if (bs.length === 1) { var c1 = colorOf(bs[0]); st = { color: c1, weight: 1.5, dashArray: null, fillColor: c1, fillOpacity: 0.38, opacity: 0.9 }; }
    else st = { color: '#5b1a8f', weight: 3, dashArray: null, fillColor: colorOf(bs.filter(inView)[0] || bs[0]), fillOpacity: 0.45, opacity: 1 };
    if (changed) { st.color = '#d98a00'; st.weight = 3; st.dashArray = '6,4'; }
    if (sel) { st.color = '#ff00aa'; st.weight = 4; st.dashArray = null; st.fillOpacity = 0.6; }
    if (S.focus && !sel) { if (dim) { st.fillOpacity *= 0.3; st.opacity = 0.3; } else if (hit) st.fillOpacity = Math.min(0.7, st.fillOpacity + 0.2); }
    return st;
  }
  function restyle() {
    S.res.cells.forEach(function (k) { if (!S.rects[k]) rectFor(k); });
    Object.keys(S.rects).forEach(function (k) {
      var r = S.rects[k], isRing = !cellBranches(k).length && !S.res.cells.has(k);
      var bs = cellBranches(k);
      var show = S.selected[k] || (bs.length ? bs.some(inView) : S.showRing);         // 본부를 고르면 다른 본부에만 편입된 칸은 숨김(후보 칸은 그대로)
      if (!show) { if (S.map.hasLayer(r)) S.map.removeLayer(r); return; }
      if (!S.map.hasLayer(r)) r.addTo(S.map);
      r.setStyle(styleOf(k));
    });
    Object.keys(S.selected).forEach(function (k) { if (S.rects[k]) S.rects[k].bringToFront(); });
  }

  /* ---------- 선택 ---------- */
  function onCellClick(k) {
    if (S.justBoxed) return;
    if (!S.admin) { var c = G.unkey(k), bs = cellBranches(k); S.rects[k].bindPopup('<b>격자 ' + c[0] + ',' + c[1] + '</b><br>' + (bs.length ? '편입: ' + bs.map(function (b) { return esc(branchName(b)); }).join(', ') : '편입된 기관 없음') + '<br><span class="hint">변경하려면 관리자 모드를 켜세요.</span>').openPopup(); return; }
    if (S.selected[k]) delete S.selected[k]; else S.selected[k] = true;
    afterChange();
  }

  // 영역 선택: 지도 위에서 드래그. 칸(다각형)이 마우스 이벤트를 먼저 받아도 되도록 지도 컨테이너에서 직접 받습니다.
  function bindBox() {
    var m = S.map, el = m.getContainer();
    el.addEventListener('mousedown', function (e) {
      if (!S.admin || !(S.box || e.shiftKey) || e.button !== 0 || (e.target.closest && e.target.closest('.leaflet-control, .jr-selbar, .jr-savebar, .gr-tools'))) return;
      e.stopPropagation(); e.preventDefault();                      // 지도 이동·칸 클릭으로 넘어가지 않게
      S.boxStart = m.mouseEventToLatLng(e);
      S.boxRect = L.rectangle([S.boxStart, S.boxStart], { color: '#ff00aa', weight: 2, dashArray: '4,4', fillOpacity: 0.08, interactive: false }).addTo(m);
    }, true);
    document.addEventListener('mousemove', function (e) { if (S.boxStart && S.boxRect) S.boxRect.setBounds(L.latLngBounds(S.boxStart, m.mouseEventToLatLng(e))); });
    document.addEventListener('mouseup', function (e) {
      if (!S.boxStart) return;
      var b = L.latLngBounds(S.boxStart, m.mouseEventToLatLng(e)); S.boxStart = null; if (S.boxRect) { m.removeLayer(S.boxRect); S.boxRect = null; }
      if (b.getNorth() - b.getSouth() < 0.002 && b.getEast() - b.getWest() < 0.002) return;
      var keys = new Set(); Object.keys(S.rects).forEach(function (k) { if (S.showRing || cellBranches(k).length) keys.add(k); });
      G.cellsInBox(keys, b.getSouth(), b.getWest(), b.getNorth(), b.getEast()).forEach(function (c) { S.selected[G.key(c[0], c[1])] = true; });
      S.justBoxed = true; setTimeout(function () { S.justBoxed = false; }, 80);
      afterChange();
    });
  }
  function setBox(on) {
    S.box = on; $('gr-box').classList.toggle('jr-primary', on);
    if (S.map) S.map.getContainer().style.cursor = on ? 'crosshair' : '';
  }
  function setAdmin(on) {
    S.admin = on; if (!on) { S.selected = {}; setBox(false); }
    $('view-grid').classList.toggle('jr-is-admin', on); afterChange();
  }

  /* ---------- 요약 카드 ---------- */
  function renderSummary() {
    var b = G.budget(S.sum.union), cls = { ok: 'ok', warn: 'warn', over: 'over' }[b.level];
    $('gr-summary').innerHTML = '<div class="gr-big">호출 대상 격자 <b>' + S.sum.union + '칸</b> <span>(여러 기관 공유 ' + S.sum.shared + '칸)</span></div>' +
      '<div class="gr-sub">하루 호출 약 ' + b.daily.toLocaleString() + '건 · 수집 분할 ' + b.runs + '번(약 ' + b.minutes + '분)</div><div class="gr-badge ' + cls + '">' + esc(b.text) + '</div>' +
      '<details class="gr-per" id="gr-per-wrap"' + (S.perOpen ? ' open' : '') + '><summary>지사별 칸 수 (많은 순) — 쏠림 보기</summary>' +
      '<div class="gr-per-tools">지사당 목표 <input id="gr-target" type="number" min="1" max="99" value="' + S.target + '"> 칸</div><div id="gr-per"></div></details>';
    $('gr-per-wrap').addEventListener('toggle', function (e) { S.perOpen = e.target.open; });
    renderPerBranch();
  }
  // 지사별 칸 수: 막대 길이 = 칸 수, 목표를 넘으면 빨간색. 지금 보는 본부(전체면 모두) 기준. 목표대로 줄이면 호출 대상이 최대 몇 칸인지(공유 칸이 있으면 더 줄어듦)
  function renderPerBranch() {
    var box = $('gr-per'); if (!box) return;
    var per = S.sum.perBranch, st = S.state, T = S.target;
    var ids = st.order.filter(function (id) { return S.ids.has(id) && inView(id); }).sort(function (a, b) { return (per[b] || 0) - (per[a] || 0); });
    var max = ids.reduce(function (m, id) { return Math.max(m, per[id] || 0); }, 1), over = ids.filter(function (id) { return (per[id] || 0) > T; });
    var capped = ids.reduce(function (a, id) { return a + Math.min(per[id] || 0, T); }, 0), zero = ids.filter(function (id) { return !per[id]; }).length;
    box.innerHTML = '<div class="gr-per-sum">목표(' + T + '칸) 넘는 지사 <b>' + over.length + '곳</b>' + (zero ? ' · 편입 없음 ' + zero + '곳' : '') + ' · 목표대로면 호출 대상 최대 약 <b>' + capped + '칸</b></div>' +
      ids.map(function (id) {
        var n = per[id] || 0, b = st.branches[id];
        return '<div class="gr-per-row' + (n > T ? ' over' : '') + '" data-id="' + esc(id) + '"><span class="n">' + esc(b.name) + (S.hqView === 'ALL' ? ' <em>' + esc(b.hq) + '</em>' : '') + '</span>' +
          '<span class="bar"><i style="width:' + Math.round(n / max * 100) + '%;background:' + (n > T ? '#d0453a' : colorOf(id)) + '"></i></span><span class="k">' + n + '</span></div>';
      }).join('');
  }

  /* ---------- 기관 목록 ---------- */
  // 목록: 관측소 지도와 같은 방식 — 본부 줄만 보이고 누른 본부 하나만 펼쳐짐. 검색하면 맞는 기관이 있는 본부를 펼침
  function renderTree() {
    var q = S.search.trim(), per = S.sum.perBranch, st = S.state;
    var html = st.hqs.filter(function (h) { return !JC.isPrivate(h); }).map(function (hq) {
      var all = st.order.filter(function (id) { return st.branches[id].hq === hq && S.ids.has(id); });
      var ids = all.filter(function (id) { return !q || st.branches[id].name.indexOf(q) >= 0; });
      if (!all.length || (q && !ids.length)) return '';
      var open = q ? true : S.hqView === hq, total = all.reduce(function (a, id) { return a + (per[id] || 0); }, 0);
      return '<div class="jr-hq' + (open ? ' open' : '') + '"><div class="jr-hqname jr-hqpick' + (S.hqView === hq ? ' on' : '') + '" data-hqpick="' + esc(hq) + '" title="누르면 이 본부만 펼쳐 지사마다 다른 색으로 봅니다(다시 누르면 접고 전체)">' +
        '<span class="chev">▶</span><span class="hn">' + esc(hq) + ' 본부</span><span class="jr-cnt">' + all.length + '</span><span class="jr-km">' + total + '칸</span></div>' +
        (open ? ids.map(function (id) {
          var on = S.focus === id;
          return '<div class="jr-br' + (on ? ' on' : '') + '" data-id="' + id + '"><span class="chev">▶</span><i style="background:' + colorOf(id) + '"></i><span class="n">' + esc(st.branches[id].name) + (st.branches[id].added ? ' <em>신설</em>' : '') +
            '</span><span class="k">' + (per[id] || 0) + '칸</span></div>' + (on && S.admin ? '<div class="jr-detail"><button class="jr-btn" data-act="selbranch">이 기관 격자 전체 선택</button></div>' : '');
        }).join('') : '') + '</div>';
    }).join('');
    $('gr-tree').innerHTML = html || '<div class="jr-empty">검색 결과가 없습니다.</div>';
  }


  /* ---------- 선택 바 ---------- */
  function renderSelBar() {
    var bar = $('gr-selbar'), keys = selectedKeys();
    $('gr-tools').style.display = S.admin ? 'flex' : 'none';
    if (!S.admin || !keys.length) { bar.style.display = 'none'; return; }
    var assigned = keys.filter(function (k) { return cellBranches(k).length; }).length;
    var opts = S.state.hqs.filter(function (h) { return !JC.isPrivate(h); }).map(function (hq) {
      var o = S.state.order.filter(function (id) { return S.ids.has(id) && S.state.branches[id].hq === hq; }).map(function (id) { return '<option value="' + id + '">' + esc(S.state.branches[id].name) + '</option>'; }).join('');
      return o ? '<optgroup label="' + esc(hq) + '">' + o + '</optgroup>' : '';
    }).join('');
    var prev = $('gr-dest') ? $('gr-dest').value : '';
    bar.innerHTML = '<b>' + keys.length + '칸 선택</b><span class="hint">(편입된 칸 ' + assigned + ')</span>' +
      '<span class="gr-grp">편입할 기관 <select id="gr-dest">' + opts + '</select><button class="jr-btn jr-primary" data-act="add">편입 추가</button></span>' +
      '<span class="gr-grp"><button class="jr-btn" data-act="remove"' + (assigned ? '' : ' disabled title="선택한 칸 중 편입된 칸이 없습니다"') + '>편입 제외' + (assigned ? ' (' + assigned + '칸)' : '') + '</button></span>' +
      '<button class="jr-btn" data-act="clear">선택 해제</button>';
    if (prev) $('gr-dest').value = prev;
    bar.style.display = 'flex';
  }

  /* ---------- 변경 대기 / 저장 ---------- */
  function describe(ev) {
    return ev.t === 'add' ? '격자 ' + ev.cells.length + '칸에 <b>' + esc(branchName(ev.to)) + '</b> 편입' : '격자 ' + ev.cells.length + '칸에서 <b>' + esc(branchName(ev.from)) + '</b> 제외';
  }
  function renderPending() {          // 왼쪽 아래: 서버 연결 경고와 저장된 이력만 (변경 대기·저장 버튼은 오른쪽 위 한 곳에 모음)
    var box = $('gr-pending'), com = base(), h = '';
    if (serverDown()) h += '<div class="jr-warn">⚠ 서버에서 변경 이력을 불러오지 못해 예전 파일 기준으로 보고 있습니다. 새로고침해서 서버에 연결된 뒤에 저장하세요.</div>';
    if (com.length) h += '<details class="jr-hist"><summary>저장된 변경 이력 ' + com.length + '건</summary>' + com.slice().reverse().slice(0, 30).map(function (ev) { return '<div class="jr-ev old">' + (ev.at ? esc(String(ev.at).slice(0, 10)) + ' ' : '') + describe(ev) + (ev.note ? ' <em>' + esc(ev.note) + '</em>' : '') + '</div>'; }).join('') +
      (S.admin ? '<div class="jr-row"><button class="jr-btn" data-act="export" title="변경 이력 전체를 파일로 보관합니다">이력 파일로 내려받기(백업)</button></div>' : '') + '</details>';
    box.innerHTML = h; box.style.display = h ? 'block' : 'none';
  }
  function renderSaveBar() {          // 지도 오른쪽 위 "변경 대기" 패널: 변경 목록·사유·[미리보기][모두 취소][저장]은 여기에만 있음
    var bar = $('gr-savebar'); if (!S.admin) { bar.style.display = 'none'; return; }
    var n = S.pending.length, canSave = n && !S.saving && !serverDown();
    bar.className = 'jr-savebar' + (n ? ' dirty' : '');
    bar.innerHTML = '<div class="jr-sb-head"><span class="st">' + (n ? '● 변경 대기 ' + n + '건' : '변경 없음 — 칸을 눌러 기관에 편입하세요') + '</span>' +
      '<span class="jr-sb-btns"><button class="jr-btn" data-act="preview"' + (n ? '' : ' disabled') + '>미리보기</button><button class="jr-btn" data-act="cancel"' + (n && !S.saving ? '' : ' disabled') + '>모두 취소</button>' +
      '<button class="jr-btn jr-primary" data-act="save"' + (canSave ? '' : ' disabled') + ' title="변경 내용을 서버에 저장합니다">' + (S.saving ? '저장 중…' : '저장') + '</button></span></div>' +
      (n ? '<div class="jr-sb-list">' + S.pending.map(function (ev, i) { return '<div class="jr-ev"><span class="jr-evt">' + describe(ev) + '</span><button class="jr-x" data-ev="' + i + '" title="이 변경만 취소">×</button></div>'; }).join('') + '</div>' +
        '<input id="gr-reason" class="jr-reason" placeholder="변경 사유 (선택)" maxlength="200" value="' + esc(S.reason || '') + '">' : '');
    bar.style.display = 'block';
  }
  function stamped() {
    var now = new Date().toISOString(), reason = ($('gr-reason') && $('gr-reason').value || S.reason || '').trim(); S.reason = reason;
    return S.pending.map(function (ev) { var c = JSON.parse(JSON.stringify(ev)); delete c.n; c.at = c.at || now; if (reason) c.note = reason; return c; });
  }
  function modal(html) { var m = $('gr-modal'); m.innerHTML = '<div class="jr-dialog">' + html + '</div>'; m.style.display = 'flex'; }
  function toast(msg) {
    var el = $('jr-toast');
    if (!el) { el = document.createElement('div'); el.id = 'jr-toast'; el.className = 'jr-toast'; el.setAttribute('role', 'status'); document.body.appendChild(el); }
    el.textContent = msg; el.style.display = 'block'; clearTimeout(S.toastT); S.toastT = setTimeout(function () { el.style.display = 'none'; }, 4000);
  }
  function serverDown() { var e = window.EVENTS_SOURCE; return !!(e && /error/.test(e.grid || '')); }
  function downloadEvents(events, name) { SSEvents.download(name, SSEvents.exportJson(events)); }
  // 변경 저장: 서버(Supabase)에 한 번에 저장합니다. 모든 사용자에게 바로 적용되고, GitHub 에 올릴 필요가 없습니다.
  function saveChanges() {
    if (S.saving || !S.admin || !S.pending.length) return;
    if (serverDown()) { window.alert('서버에서 변경 이력을 불러오지 못한 상태입니다. 새로고침해서 서버에 연결된 뒤에 저장하세요.'); return; }
    var evs = stamped(), saved = false; S.saving = true; renderPending(); renderSaveBar();
    SSEvents.append('grid', evs).then(function (res) {
      if (!res.ok) {
        S.saving = false; renderPending(); renderSaveBar();
        modal('<h3>저장하지 못했습니다</h3><p class="jr-warn" style="font-size:13.5px">' + esc(res.message) + '</p><p style="font-size:13.5px;line-height:1.6">변경 대기는 그대로 남아 있습니다. 잠시 뒤 다시 [저장]을 누르거나, 급하면 <b>[파일로 받기]</b>로 내용을 보관해 두세요.</p>' +
          '<div class="jr-row"><button class="jr-btn jr-primary" data-act="retry">다시 저장</button><button class="jr-btn" data-act="tofile">파일로 받기</button><button class="jr-btn" data-act="close">닫기</button></div>');
        return;
      }
      saved = true;
      return SSEvents.load('grid').then(function (r) {
        GR().committed = r.source === 'server' && !r.error ? r.events : GR().committed.concat(evs);
        S.saving = false; S.pending = []; S.reason = ''; S.selected = {}; afterChange();
        toast(evs.length + '건 저장되었습니다.');
      });
    }).catch(function (e) {          // 예상하지 못한 오류: "저장 중"에 멈추지 않게 하고, 이미 저장됐으면 같은 내용을 다시 저장하지 않도록 대기를 비움
      if (window.console) console.error(e);
      S.saving = false;
      if (saved) { S.pending = []; S.reason = ''; }
      try { renderPending(); renderSaveBar(); } catch (e2) {}
      window.alert(saved ? '저장은 되었지만 화면을 다시 그리지 못했습니다. 새로고침(F5)해 주세요.' : '저장하지 못했습니다. 잠시 뒤에 다시 시도하세요.');
    });
  }
  function preview() {
    var im = G.impact(GR().baseline, S.ids, base(), events());
    var rows = im.branches.map(function (b) { return '<tr><td>' + esc(branchName(b.id)) + '</td><td>' + b.before + ' → ' + b.after + '칸</td></tr>'; }).join('') || '<tr><td colspan="2">바뀌는 기관이 없습니다.</td></tr>';
    var ba = im.budgetAfter;
    modal('<h3>변경 미리보기</h3><div class="jr-tablewrap"><table class="jr-table"><thead><tr><th>기관</th><th>편입 격자 수</th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
      '<table class="jr-table" style="margin-top:10px"><tbody><tr><th>호출 대상 격자(합집합)</th><td>' + im.union[0] + ' → <b>' + im.union[1] + '칸</b></td></tr>' +
      '<tr><th>여러 기관 공유 격자</th><td>' + im.shared[0] + ' → ' + im.shared[1] + '칸</td></tr>' +
      '<tr><th>하루 호출 / 수집 분할</th><td>' + im.budgetBefore.daily.toLocaleString() + '건 → <b>' + ba.daily.toLocaleString() + '건</b> · ' + ba.runs + '번(약 ' + ba.minutes + '분)</td></tr></tbody></table>' +
      '<div class="gr-badge ' + ba.level + '" style="margin-top:8px">' + esc(ba.text) + '</div><div class="jr-row"><button class="jr-btn jr-primary" data-act="close">닫기</button></div>');
  }

  /* ---------- 변경 만들기 ---------- */
  function applyAdd() {
    var dest = $('gr-dest').value, keys = selectedKeys(); if (!dest || !keys.length) return;
    var eff = keys.filter(function (k) { return cellBranches(k).indexOf(dest) < 0; });
    if (!eff.length) { window.alert('선택한 칸이 모두 이미 ' + branchName(dest) + ' 소속입니다.'); return; }
    S.pending.push({ t: 'add', cells: eff.map(G.unkey), to: dest }); S.selected = {}; afterChange();
  }

  // 편입 제외: 기관을 고르지 않아도 됩니다. 선택한 칸이 지금 속한 기관을 찾아서 거기서 뺍니다.
  // 한 칸을 여러 기관이 함께 가진 경우에만 "어느 기관에서 뺄지" 확인합니다. (기본은 모두 체크)
  function branchOrderIndex(id) { var i = S.state.order.indexOf(id); return i < 0 ? 9999 : i; }
  function applyRemove() {
    var keys = selectedKeys(), per = {}, shared = 0;
    keys.forEach(function (k) { var bs = cellBranches(k); if (bs.length > 1) shared++; bs.forEach(function (b) { (per[b] = per[b] || []).push(k); }); });
    var ids = Object.keys(per).sort(function (a, b) { return branchOrderIndex(a) - branchOrderIndex(b); });
    if (!ids.length) { window.alert('선택한 칸 중 편입된 칸이 없습니다.'); return; }
    if (!shared) { commitRemove(per, ids); return; }
    modal('<h3>어느 기관에서 제외할까요?</h3><p class="jr-hint">선택한 칸 중 <b>' + shared + '칸</b>은 여러 기관이 함께 편입하고 있습니다. 제외할 기관을 고르세요. (모두 체크하면 이 칸들은 어느 기관에도 속하지 않게 됩니다)</p>' +
      '<div class="gr-rmlist">' + ids.map(function (b) {
        return '<label class="gr-rm"><input type="checkbox" class="gr-rmchk" value="' + esc(b) + '" checked> <b>' + esc(branchName(b)) + '</b> <span>' + per[b].length + '칸</span></label>';
      }).join('') + '</div><div class="jr-row"><button class="jr-btn jr-primary" data-act="removeok">제외</button><button class="jr-btn" data-act="close">취소</button></div>');
  }
  function commitRemove(per, chosen) {
    chosen.forEach(function (b) { S.pending.push({ t: 'remove', cells: per[b].map(G.unkey), from: b }); });
    S.selected = {}; $('gr-modal').style.display = 'none'; afterChange();
  }
  function removeFromDialog() {
    var chosen = Array.prototype.map.call(document.querySelectorAll('#gr-modal .gr-rmchk:checked'), function (c) { return c.value; });
    if (!chosen.length) { window.alert('제외할 기관을 하나 이상 고르세요.'); return; }
    var per = {}; selectedKeys().forEach(function (k) { cellBranches(k).forEach(function (b) { if (chosen.indexOf(b) >= 0) (per[b] = per[b] || []).push(k); }); });
    commitRemove(per, chosen.filter(function (b) { return per[b]; }));
  }


  function setHqView(v) {
    S.hqView = v; if (S.focus && !inView(S.focus)) S.focus = null; afterChange();
    var pts = []; if (v !== 'ALL') S.res.assign.forEach(function (set, k) { if (Array.from(set).some(inView)) pts.push(G.cellCenter.apply(null, G.unkey(k))); });
    if (pts.length) S.map.fitBounds(L.latLngBounds(pts), { padding: [40, 40], maxZoom: 10 }); else if (v === 'ALL') S.map.setView([36.4, 127.9], 7);
  }
  function afterChange() { recompute(); restyle(); renderSummary(); renderTree(); renderPending(); renderSelBar(); renderSaveBar(); }
  function focusBranch(id) {
    S.focus = S.focus === id ? null : id;
    if (S.focus && S.state.branches[S.focus] && S.hqView !== S.state.branches[S.focus].hq) S.hqView = S.state.branches[S.focus].hq;   // 지사를 고르면 그 본부를 펼침
    afterChange();
    if (S.focus) {
      var pts = []; S.res.assign.forEach(function (set, k) { if (set.has(S.focus)) pts.push(G.cellCenter.apply(null, G.unkey(k))); });
      if (pts.length) S.map.fitBounds(L.latLngBounds(pts), { padding: [60, 60], maxZoom: 11 });
    }
  }

  function bind() {
    $('gr-search').addEventListener('input', function (e) { S.search = e.target.value; renderTree(); });
    $('gr-box').addEventListener('click', function () { setBox(!S.box); });
    $('gr-ring').addEventListener('change', function (e) { S.showRing = e.target.checked; restyle(); });
    $('gr-lines').addEventListener('change', function (e) { if (e.target.checked) S.lines.addTo(S.map); else S.map.removeLayer(S.lines); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && S.box) setBox(false); });
    $('view-grid').addEventListener('input', function (e) { if (e.target.id === 'gr-reason') S.reason = e.target.value; else if (e.target.id === 'gr-target') { var n = parseInt(e.target.value, 10); if (n >= 1 && n <= 99) { S.target = n; renderPerBranch(); } } });
    $('view-grid').addEventListener('click', function (e) {
      var t = e.target;
      var pick = t.closest && t.closest('[data-hqpick]'); if (pick) { var same = S.hqView === pick.dataset.hqpick; S.focus = null; setHqView(same ? 'ALL' : pick.dataset.hqpick); return; }   // 본부 줄: 펼치기/접기
      var br = t.closest && (t.closest('.jr-br') || t.closest('.gr-per-row')); if (br) { focusBranch(br.dataset.id); return; }
      var x = t.closest && t.closest('.jr-x'); if (x) { S.pending.splice(parseInt(x.dataset.ev, 10), 1); afterChange(); return; }
      var act = t.closest && t.closest('[data-act]'); act = act && act.dataset.act; if (!act) return;
      if (act === 'add') applyAdd();
      else if (act === 'remove') applyRemove();
      else if (act === 'removeok') removeFromDialog();
      else if (act === 'clear') { S.selected = {}; afterChange(); }
      else if (act === 'selbranch') { S.res.assign.forEach(function (set, k) { if (set.has(S.focus)) S.selected[k] = true; }); afterChange(); }
      else if (act === 'preview') preview();
      else if (act === 'save') saveChanges();
      else if (act === 'retry') { $('gr-modal').style.display = 'none'; saveChanges(); }
      else if (act === 'tofile') downloadEvents(base().concat(stamped()), 'grid_changes.json');
      else if (act === 'export') downloadEvents(base(), 'grid_changes_backup.json');
      else if (act === 'cancel') { if (S.pending.length && window.confirm('변경 대기 ' + S.pending.length + '건을 모두 취소할까요?')) { S.pending = []; afterChange(); } }
      else if (act === 'close') $('gr-modal').style.display = 'none';
    });
  }

  function init() {
    var root = $('view-grid'); if (!root) return;
    if (!window.JURIS || !window.JURIS.doc || !GR() || !GR().baseline) { root.innerHTML = '<div class="jr-empty" style="padding:30px">격자 데이터(data/grid_assign.json)를 불러오지 못했습니다.</div>'; return; }
    S.admin = !!(window.SS_ME && window.SS_ME.role === 'admin');        // 이 탭은 관리자에게만 보이며, 화면이 열려 있으면 바로 편집 가능
    buildShell(); bind(); recompute(); $('view-grid').classList.toggle('jr-is-admin', S.admin); S.inited = true;
  }
  function show() { if (!S.inited) return; ensureMap(); afterChange(); }
  window.GridUI = { setHqView: function (v) { setHqView(v); }, init: init, show: show, _state: function () { return S; } };
})();
