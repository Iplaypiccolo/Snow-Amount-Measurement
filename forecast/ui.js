/* ============================================================
   forecast/ui.js — "기관별 24시간 예보" 탭
   - 기상청 단기예보(5km 격자)의 24시간 예상 적설(cm)·강수량(mm)을 지사 관할 노선도 위에 보여 줍니다.
     값은 서버가 3시간마다(기준일자를 만든 뒤 확정 전까지) 모은 격자별 24시간 합(forecast_cells)입니다.
   - 단계: 전체 = 고속도로 노선만(본부 색) / 본부 = 그 본부 지사들의 격자(지사 색) / 지사 = 그 지사 격자마다 24시간 적설·강수 값
   - 장비 지원의 지사별 요청·편성에서 예상 적설·강수를 누르면 이 탭의 그 지사로 바로 옵니다(window.ForecastUI.openBranch).
   - 서버 읽기: branch_forecast(지사 59줄) 한 번 + 본부를 열 때 forecast_grid(그 본부 지사들의 격자, 수 KB)
   ============================================================ */
(function () {
  'use strict';
  var G = window.GridCore, JC = window.JurisCore;
  var S = { inited: false, map: null, lines: null, cells: null, hq: 'ALL', focus: null, state: null, bf: {}, grid: {}, meta: null, loading: false, pendingFocus: null };

  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function p2(n) { return String(n).padStart(2, '0'); }
  function fmtHour(iso) { var d = new Date(iso); return isNaN(d) ? '-' : (d.getMonth() + 1) + '/' + d.getDate() + ' ' + p2(d.getHours()) + '시'; }
  function num(v) { return v == null ? '-' : (Math.round(v * 10) / 10).toFixed(1); }
  var STALE = 12 * 3600e3;                                 // 발표 후 12시간이 지난 예보는 쓰지 않음(장비 지원 화면과 같음)
  // 24시간 예상 적설(cm) → 칸 색
  var SCALE = [[20, '#c0392b', '20 이상'], [10, '#8e44ad', '10~20'], [5, '#2e5fb8', '5~10'], [1, '#5b9be0', '1~5'], [0.1, '#a9cdf2', '1 미만'], [0, '#eef3f8', '0']];
  function snowColor(v) { if (v == null) return '#d8d6cc'; for (var i = 0; i < SCALE.length; i++) if (v >= SCALE[i][0]) return SCALE[i][1]; return '#eef3f8'; }

  function st() { return S.state; }
  function bname(id) { var b = st().branches[id]; return b ? b.name : id; }
  function hqOf(id) { var b = st().branches[id]; return b ? b.hq : null; }
  function branchesOf(hq) { return st().order.filter(function (id) { return st().branches[id].hq === hq; }); }
  function bval(id) { var f = S.bf[id]; if (!f || Date.now() - Date.parse(f.issued_at) > STALE) return null; return f; }

  /* ---------- 뼈대 ---------- */
  function buildShell() {
    $('view-forecast').innerHTML =
      '<div class="jr-wrap">' +
      '<div class="jr-side">' +
        '<div class="jr-head"><b>기관별 24시간 예보</b></div>' +
        '<div class="jr-note">기상청 단기예보(5km 격자)의 <b>24시간 예상 적설·강수량</b>입니다. 본부를 누르면 그 본부 지사들의 격자, 지사를 누르면 격자마다 값이 보입니다. 지사 값 = 지사 격자 중 가장 큰 값.</div>' +
        '<div id="fc-meta" class="fc-meta"></div>' +
        '<div id="fc-tree" class="jr-tree"></div>' +
      '</div>' +
      '<div class="jr-mapbox"><div id="fmap"></div>' +
        '<div class="jr-legend fc-legend" id="fc-legend"></div>' +
      '</div></div>';
  }

  /* ---------- 서버 ---------- */
  function loadOverview() {
    return SSAuth.rest('branch_forecast?select=branch_id,issued_at,max_snow_24h,max_pcp_24h,worst_nx,worst_ny,detail').then(function (r) {
      S.bf = {}; if (!r.ok) return;
      r.json.forEach(function (x) { S.bf[x.branch_id] = x; });
      var latest = r.json.reduce(function (a, x) { return !a || x.issued_at > a.issued_at ? x : a; }, null);
      S.meta = latest ? { tmfc: latest.issued_at, start: latest.detail && latest.detail.start_at, end: latest.detail && latest.detail.end_at } : null;
    }).catch(function () {});
  }
  function loadGrid(hq) {
    if (S.grid[hq]) return Promise.resolve(S.grid[hq]);
    var ids = st().order.filter(function (id) { return st().branches[id].hq === hq && !JC.isPrivate(hq); });
    if (!ids.length) return Promise.resolve(null);
    return SSAuth.authed('/rest/v1/rpc/forecast_grid', { method: 'POST', body: { p_branches: ids } }).then(function (r) {
      if (!r.ok || !r.json) return null;
      S.grid[hq] = r.json; return r.json;
    }).catch(function () { return null; });
  }

  /* ---------- 지도 ---------- */
  function lineColor(owner) {
    if (!owner) return '#9a9a9a';
    if (S.focus) return owner === S.focus ? '#FFC400' : '#b4b0a1';
    if (S.hq !== 'ALL' && hqOf(owner) !== S.hq) return '#c9c6b8';
    return JC.colorOf(st(), owner, S.hq);
  }
  function drawLines() {
    S.lines.clearLayers();
    window.JURIS.doc.sections.forEach(function (sec) {
      var o = st().owner[sec.id];
      L.polyline(sec.coords.map(function (c) { return [c[1], c[0]]; }), { weight: S.focus && o === S.focus ? 5 : 3, opacity: 0.85, interactive: false, color: lineColor(o) }).addTo(S.lines);
    });
  }
  function drawCells() {
    S.cells.clearLayers();
    if (S.hq === 'ALL') return;
    var g = S.grid[S.hq]; if (!g || !g.cells) return;
    var fresh = g.tmfc && Date.now() - Date.parse(g.tmfc) <= STALE;
    g.cells.forEach(function (c) {
      var nx = c[0], ny = c[1], bs = c[2] || [], snow = fresh ? c[3] : null, pcp = fresh ? c[4] : null;
      var mine = S.focus ? bs.indexOf(S.focus) >= 0 : true;
      if (S.focus && !mine) return;                                  // 지사를 고르면 그 지사 격자만
      var col = S.focus ? snowColor(snow) : JC.colorOf(st(), bs[0], S.hq);
      var poly = L.polygon(G.cellCorners(nx, ny), { weight: S.focus ? 1.5 : 1, color: S.focus ? '#33424f' : col, fillColor: col, fillOpacity: S.focus ? 0.7 : 0.28, opacity: 0.9 });
      poly.bindTooltip('<b>격자 ' + nx + ',' + ny + '</b><br>' + bs.map(function (b) { return esc(bname(b)); }).join(', ') +
        (S.focus ? '<br>24시간 예상 적설 <b>' + num(snow) + 'cm</b> · 강수 <b>' + num(pcp) + 'mm</b>' : ''), { sticky: true, className: 'gr-tip' });
      poly.on('click', function () { if (!S.focus && bs.length) focusBranch(bs[0]); });
      poly.addTo(S.cells);
      if (S.focus) {                                                 // 지사: 격자마다 값(적설 / 강수)
        L.tooltip({ permanent: true, direction: 'center', className: 'fc-label', interactive: false })
          .setLatLng(G.cellCenter(nx, ny)).setContent('<b>' + num(snow) + '</b><span>' + num(pcp) + '</span>').addTo(S.cells);
      }
    });
  }
  function fitTo() {
    if (S.hq === 'ALL') { S.map.setView([36.4, 127.9], 7); return; }
    var g = S.grid[S.hq]; if (!g || !g.cells || !g.cells.length) return;
    var pts = g.cells.filter(function (c) { return !S.focus || (c[2] || []).indexOf(S.focus) >= 0; }).map(function (c) { return G.cellCenter(c[0], c[1]); });
    if (pts.length) S.map.fitBounds(L.latLngBounds(pts), { padding: [40, 40], maxZoom: S.focus ? 11 : 9 });
  }
  function ensureMap() {
    if (S.map) { setTimeout(function () { S.map.invalidateSize(); }, 50); return; }
    S.map = L.map('fmap', { zoomControl: true }).setView([36.4, 127.9], 7);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '&copy; OpenStreetMap contributors' }).addTo(S.map);
    S.lines = L.layerGroup().addTo(S.map); S.cells = L.layerGroup().addTo(S.map);
    setTimeout(function () { S.map.invalidateSize(); }, 50);
  }

  /* ---------- 옆 목록 ---------- */
  function renderMeta() {
    var m = S.meta, fresh = m && Date.now() - Date.parse(m.tmfc) <= STALE;
    $('fc-meta').innerHTML = m ? '<b>' + esc(fmtHour(m.tmfc)) + ' 발표 기준</b>' + (m.start ? ' · ' + esc(fmtHour(m.start)) + ' ~ ' + esc(fmtHour(m.end)) + ' (24시간 합)' : '') +
        (fresh ? '' : '<div class="fc-stale">발표 후 12시간이 지나 값을 쓰지 않습니다. 기준일자를 만들면(확정 전까지) 3시간마다 새로 받습니다.</div>')
      : '<span class="fc-stale">아직 받은 예보가 없습니다. 기준일자를 만들면 받기 시작합니다.</span>';
  }
  function cellPair(f) { return f ? '<span class="fc-v s">' + num(f.max_snow_24h) + '<i>cm</i></span><span class="fc-v p">' + num(f.max_pcp_24h) + '<i>mm</i></span>' : '<span class="fc-v s">-</span><span class="fc-v p">-</span>'; }
  function hqMax(hq) {
    var s = null, p = null;
    branchesOf(hq).forEach(function (id) { var f = bval(id); if (!f) return; if (s == null || f.max_snow_24h > s) s = f.max_snow_24h; if (p == null || f.max_pcp_24h > p) p = f.max_pcp_24h; });
    return s == null && p == null ? null : { max_snow_24h: s, max_pcp_24h: p };
  }
  function renderTree() {
    var html = '<div class="fc-cols"><span></span><span>적설</span><span>강수</span></div>' + st().hqs.filter(function (h) { return !JC.isPrivate(h); }).map(function (hq) {
      var ids = branchesOf(hq); if (!ids.length) return '';
      var open = S.hq === hq;
      return '<div class="jr-hq' + (open ? ' open' : '') + '"><div class="jr-hqname jr-hqpick fc-row' + (open ? ' on' : '') + '" data-fchq="' + esc(hq) + '">' +
        '<span class="chev">▶</span><span class="hn">' + esc(hq) + ' 본부</span>' + cellPair(hqMax(hq)) + '</div>' +
        (open ? ids.map(function (id) {
          return '<div class="jr-br fc-row' + (S.focus === id ? ' on' : '') + '" data-fcbr="' + esc(id) + '"><i style="background:' + JC.colorOf(st(), id, hq) + '"></i><span class="n">' + esc(bname(id)) + '</span>' + cellPair(bval(id)) + '</div>' +
            (S.focus === id ? detailHtml(id) : '');
        }).join('') : '') + '</div>';
    }).join('');
    $('fc-tree').innerHTML = html;
  }
  function detailHtml(id) {
    var g = S.grid[S.hq]; if (!g || !g.cells) return '<div class="fc-detail muted">격자를 불러오는 중…</div>';
    var fresh = g.tmfc && Date.now() - Date.parse(g.tmfc) <= STALE;
    var rows = g.cells.filter(function (c) { return (c[2] || []).indexOf(id) >= 0; })
      .map(function (c) { return { nx: c[0], ny: c[1], s: fresh ? c[3] : null, p: fresh ? c[4] : null }; })
      .sort(function (a, b) { return (b.s || 0) - (a.s || 0) || (b.p || 0) - (a.p || 0); });
    return '<div class="fc-detail"><table><thead><tr><th>격자</th><th>적설(cm)</th><th>강수(mm)</th></tr></thead><tbody>' +
      rows.map(function (r) { return '<tr data-cell="' + r.nx + ',' + r.ny + '"><td>' + r.nx + ',' + r.ny + '</td><td>' + num(r.s) + '</td><td>' + num(r.p) + '</td></tr>'; }).join('') +
      '</tbody></table></div>';
  }
  function renderLegend() {
    $('fc-legend').innerHTML = S.focus ? '<b>24시간 예상 적설(cm)</b> ' + SCALE.slice().reverse().map(function (x) { return '<span class="sw" style="background:' + x[1] + '"></span>' + esc(x[2]); }).join(' ') + ' · 칸 위 숫자: 위 = 적설(cm), 아래 = 강수(mm)'
      : S.hq === 'ALL' ? '고속도로 노선(본부 색) — 본부를 누르면 격자가 보입니다' : '지사 격자(지사 색) — 지사를 누르면 격자마다 값이 보입니다';
  }
  function render() { drawLines(); drawCells(); renderMeta(); renderTree(); renderLegend(); }

  /* ---------- 단계 이동 ---------- */
  function setHq(hq) {
    S.hq = hq; S.focus = null; render(); fitTo();
    if (hq !== 'ALL' && !S.grid[hq]) loadGrid(hq).then(function () { if (S.hq === hq) { render(); fitTo(); } });
  }
  function focusBranch(id) {
    var hq = hqOf(id); if (!hq) return;
    if (S.focus === id) { S.focus = null; render(); fitTo(); return; }
    S.hq = hq; S.focus = id; render();
    loadGrid(hq).then(function () { if (S.focus === id) { render(); fitTo(); } });
  }

  function bind() {
    $('view-forecast').addEventListener('click', function (e) {
      var t = e.target, h = t.closest && t.closest('[data-fchq]'); if (h) { setHq(S.hq === h.dataset.fchq ? 'ALL' : h.dataset.fchq); return; }
      var b = t.closest && t.closest('[data-fcbr]'); if (b) { focusBranch(b.dataset.fcbr); return; }
      var c = t.closest && t.closest('[data-cell]'); if (c && S.map) { var k = c.dataset.cell.split(','); S.map.setView(G.cellCenter(+k[0], +k[1]), Math.max(S.map.getZoom(), 11)); }
    });
  }

  function init() {
    var root = $('view-forecast'); if (!root) return;
    if (!G || !JC || !window.JURIS || !window.JURIS.doc) { root.innerHTML = '<div class="jr-empty" style="padding:30px">노선 자료를 불러오지 못했습니다.</div>'; return; }
    S.state = JC.resolve(window.JURIS.doc, window.JURIS.session || window.JURIS.committed || []);
    buildShell(); bind(); S.inited = true;
  }
  function show() {
    if (!S.inited) return;
    S.state = JC.resolve(window.JURIS.doc, window.JURIS.session || window.JURIS.committed || []);    // 관할을 바꿨으면 반영
    ensureMap(); S.grid = {};
    loadOverview().then(function () {
      var id = S.pendingFocus; S.pendingFocus = null;
      if (id && st().branches[id]) { S.hq = 'ALL'; S.focus = null; focusBranch(id); } else { render(); fitTo(); }
    });
    render();
  }
  // 다른 화면(장비 지원)에서 그 지사로 바로 오기
  function openBranch(id) { S.pendingFocus = id; }
  window.ForecastUI = { init: init, show: show, openBranch: openBranch, _state: function () { return S; } };
})();
