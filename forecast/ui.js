/* ============================================================
   forecast/ui.js — "기관별 24시간 예보" 탭
   - 기상청 단기예보(5km 격자)의 24시간 예상 적설(cm)·강수량(mm) 합과 최저기온(℃, 그 시각)을 지사 관할 노선도 위에 보여 줍니다.
     값은 서버가 매시 정각에 "다음 정시부터 24시간"으로 다시 계산한 격자별 값(forecast_cells)입니다(예보 자료는 3시간마다 새로 받음).
   - 단계: 전체 = 고속도로 노선만(본부 색) / 본부 = 그 본부 지사들의 격자(지사 색) / 지사 = 그 지사 격자마다 적설·강수·최저기온,
     격자에 마우스를 올리면 24시간 추이(적설·강수 막대, 기온 선 — 따로 세 그림). 격자를 누르면 그 그림이 지도 오른쪽 위에 고정되고
     그림에 마우스를 올리면 세로·가로 보조선과 "몇 시 · 값". 지도 아무 데나 누르면 닫힘. 추이는 지사를 열 때만 서버에서 받음
   - 장비 지원의 지사별 요청·편성에서 예상 적설·강수를 누르면 이 탭의 그 지사로 바로 옵니다(window.ForecastUI.openBranch).
   - 격자는 번호 대신 지명(시군구 읍면동, data/grid_names.json — tools/build_grid_names.py 가 만듦)으로 보이고 번호는 작게 곁들임
   - 서버 읽기: branch_forecast(지사 59줄) 한 번 + 본부를 열 때 forecast_grid(그 본부 지사들의 격자, 수 KB) + 지사를 열 때 그 지사 추이(약 10KB)
   ============================================================ */
(function () {
  'use strict';
  var G = window.GridCore, JC = window.JurisCore;
  var S = { inited: false, map: null, lines: null, cells: null, hq: 'ALL', focus: null, state: null, bf: {}, grid: {}, series: {}, pin: null, pinAt: 0, names: null, meta: null, loading: false, pendingFocus: null };

  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function p2(n) { return String(n).padStart(2, '0'); }
  function fmtHour(iso) { var d = new Date(iso); return isNaN(d) ? '-' : (d.getMonth() + 1) + '/' + d.getDate() + ' ' + p2(d.getHours()) + '시'; }
  function num(v) { return v == null ? '-' : (Math.round(v * 10) / 10).toFixed(1); }
  function tmp(v) { return v == null ? '-' : String(Math.round(v * 10) / 10); }                 // 기온(℃): -5, 1.5
  function hh(iso) { var d = iso ? new Date(iso) : null; return d && !isNaN(d) ? p2(d.getHours()) + '시' : '-'; }
  var STALE = 12 * 3600e3;                                 // 발표 후 12시간이 지난 예보는 쓰지 않음(장비 지원 화면과 같음)
  // 24시간 예상 적설(cm) → 칸 색
  var SCALE = [[20, '#c0392b', '20 이상'], [10, '#8e44ad', '10~20'], [5, '#2e5fb8', '5~10'], [1, '#5b9be0', '1~5'], [0.1, '#a9cdf2', '1 미만'], [0, '#eef3f8', '0']];
  function snowColor(v) { if (v == null) return '#d8d6cc'; for (var i = 0; i < SCALE.length; i++) if (v >= SCALE[i][0]) return SCALE[i][1]; return '#eef3f8'; }

  function st() { return S.state; }
  function bname(id) { var b = st().branches[id]; return b ? b.name : id; }
  function hqOf(id) { var b = st().branches[id]; return b ? b.hq : null; }
  function branchesOf(hq) { return st().order.filter(function (id) { return st().branches[id].hq === hq; }); }
  // 격자 지명(없으면 '격자 번호'). 번호는 작게 곁들일 때 cellNo
  function cellName(nx, ny) { var n = S.names && S.names[nx + ',' + ny]; return n || '격자 ' + nx + ',' + ny; }
  function cellNo(nx, ny) { return S.names && S.names[nx + ',' + ny] ? ' <small class="fc-no">' + nx + ',' + ny + '</small>' : ''; }
  function loadNames() {
    if (S.names) return Promise.resolve(S.names);
    return fetch('data/grid_names.json', { cache: 'no-cache' }).then(function (r) { return r.ok ? r.json() : {}; }).catch(function () { return {}; })
      .then(function (m) { S.names = m || {}; return S.names; });
  }
  function bval(id) { var f = S.bf[id]; if (!f || Date.now() - Date.parse(f.issued_at) > STALE) return null; return f; }

  /* ---------- 뼈대 ---------- */
  function buildShell() {
    $('view-forecast').innerHTML =
      '<div class="jr-wrap">' +
      '<div class="jr-side">' +
        '<div class="jr-head"><b>기관별 24시간 예보</b></div>' +
        '<div id="fc-meta" class="fc-meta"></div>' +
        '<div id="fc-tree" class="jr-tree"></div>' +
      '</div>' +
      '<div class="jr-mapbox"><div id="fmap"></div><div id="fc-pin" class="fc-pin" hidden></div>' +
        '<div class="jr-legend fc-legend" id="fc-legend"></div>' +
      '</div></div>';
  }

  /* ---------- 서버 ---------- */
  function loadOverview() {
    return SSAuth.rest('branch_forecast?select=branch_id,issued_at,max_snow_24h,max_pcp_24h,min_tmp,min_tmp_at,worst_nx,worst_ny,detail').then(function (r) {
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
  // 지사 하나의 격자별 24시간 추이 { "nx,ny": {s:[24], p:[24], t:[24]} }
  function loadSeries(id) {
    if (S.series[id]) return Promise.resolve(S.series[id]);
    return SSAuth.authed('/rest/v1/rpc/forecast_grid', { method: 'POST', body: { p_branches: [id], p_series: true } }).then(function (r) {
      if (!r.ok || !r.json || !r.json.cells) return null;
      var m = {}; r.json.cells.forEach(function (c) { if (c[7]) m[c[0] + ',' + c[1]] = c[7]; });
      m._start = r.json.start_at; S.series[id] = m; return m;
    }).catch(function () { return null; });
  }
  // 24시간 추이 그림 — 적설·강수·기온을 따로(위에서부터 적설 → 강수 → 기온). k = 's' | 'p' | 't', big = 고정 창(마우스로 값 보기)
  var CH = { s: { name: '적설', unit: 'cm', color: '#2e5fb8' }, p: { name: '강수', unit: 'mm', color: '#2f9d5f' }, t: { name: '기온', unit: '℃', color: '#c0392b' } };
  function hourLabel(start, i) { var d = start ? new Date(Date.parse(start) + i * 3600e3) : null; return d && !isNaN(d) ? p2(d.getHours()) + '시' : ''; }
  function chartGeom(k, vals, big) {
    var W = big ? 330 : 236, H = big ? 104 : 64, L0 = 30, R0 = 8, T0 = big ? 22 : 16, B0 = 16, n = vals.length || 24, cw = (W - L0 - R0) / n;
    var xs = vals.filter(function (v) { return v != null; }), lo, hi;
    if (k === 't') { lo = xs.length ? Math.min.apply(null, xs) : 0; hi = xs.length ? Math.max.apply(null, xs) : 1; if (hi - lo < 4) { var mid = (hi + lo) / 2; lo = mid - 2; hi = mid + 2; } }
    else { lo = 0; hi = Math.max(1, xs.length ? Math.max.apply(null, xs) : 0); }
    return { W: W, H: H, L0: L0, R0: R0, T0: T0, B0: B0, n: n, cw: cw, lo: lo, hi: hi,
      y: function (v) { return T0 + (H - T0 - B0) * (1 - (v - lo) / (hi - lo)); } };
  }
  function chartSvg(k, vals, start, big) {
    vals = vals || []; var c = CH[k], g = chartGeom(k, vals, big), body = '';
    var xs = vals.filter(function (v) { return v != null; });
    var head = k === 't' ? (xs.length ? '최저 ' + tmp(Math.min.apply(null, xs)) + '℃ (' + hourLabel(start, vals.indexOf(Math.min.apply(null, xs))) + ')' : '자료 없음')
      : '합 ' + num(xs.reduce(function (a, v) { return a + v; }, 0)) + c.unit;
    if (k === 't') {
      var pts = []; vals.forEach(function (v, i) { if (v != null) pts.push((g.L0 + (i + 0.5) * g.cw).toFixed(1) + ',' + g.y(v).toFixed(1)); });
      body = '<polyline points="' + pts.join(' ') + '" fill="none" stroke="' + c.color + '" stroke-width="1.8"/>';
    } else {
      vals.forEach(function (v, i) { if (!v) return; var y = g.y(v); body += '<rect x="' + (g.L0 + i * g.cw + 1).toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + Math.max(1, g.cw - 2).toFixed(1) + '" height="' + (g.H - g.B0 - y).toFixed(1) + '" fill="' + c.color + '"/>'; });
    }
    return '<svg class="fc-trend fc-ch-' + k + '" width="' + g.W + '" height="' + g.H + '" viewBox="0 0 ' + g.W + ' ' + g.H + '" data-k="' + k + '" data-vals="' + esc(JSON.stringify(vals)) + '" data-start="' + esc(start || '') + '"' + (big ? ' data-big="1"' : '') + '>' +
      '<text class="ttl" x="' + g.L0 + '" y="' + (g.T0 - 6) + '" fill="' + c.color + '">' + c.name + '(' + c.unit + ') · ' + esc(head) + '</text>' +
      '<line x1="' + g.L0 + '" y1="' + (g.H - g.B0) + '" x2="' + (g.W - g.R0) + '" y2="' + (g.H - g.B0) + '" stroke="#999" stroke-width="0.6"/>' + body +
      '<text x="' + (g.L0 - 3) + '" y="' + (g.T0 + 4) + '" text-anchor="end">' + (k === 't' ? tmp(g.hi) : num(g.hi)) + '</text>' +
      '<text x="' + (g.L0 - 3) + '" y="' + (g.H - g.B0) + '" text-anchor="end">' + (k === 't' ? tmp(g.lo) : '0') + '</text>' +
      [0, 6, 12, 18].map(function (h) { return '<text x="' + (g.L0 + h * g.cw).toFixed(1) + '" y="' + (g.H - 3) + '">' + hourLabel(start, h) + '</text>'; }).join('') +
      (big ? '<g class="xh" style="display:none"><line class="xv" stroke="#333" stroke-dasharray="3 2" stroke-width="0.8"/><line class="xz" stroke="#333" stroke-dasharray="3 2" stroke-width="0.8"/><circle class="xp" r="3" fill="' + c.color + '"/><text class="xt" text-anchor="end"></text></g>' : '') +
      '</svg>';
  }
  function trendBox(sr, start, big) {
    if (!sr) return '';
    return '<div class="fc-trend-box' + (big ? ' big' : '') + '">' + ['s', 'p', 't'].map(function (k) { return chartSvg(k, sr[k], start, big); }).join('') + '</div>';
  }
  // 고정 창의 그림에 마우스: 그 시각의 세로·가로 보조선과 "몇 시 · 값"
  function chartHover(svg, e) {
    var k = svg.dataset.k, vals = JSON.parse(svg.dataset.vals || '[]'), g = chartGeom(k, vals, true), xh = svg.querySelector('.xh'); if (!xh) return;
    var r = svg.getBoundingClientRect(), x = (e.clientX - r.left) * g.W / r.width;
    var i = Math.max(0, Math.min(g.n - 1, Math.floor((x - g.L0) / g.cw))), v = vals[i], cx = g.L0 + (i + 0.5) * g.cw;
    var yv = v == null ? null : (k === 't' ? g.y(v) : g.y(v || 0));
    var set = function (el, a) { Object.keys(a).forEach(function (n) { el.setAttribute(n, a[n]); }); };
    set(xh.querySelector('.xv'), { x1: cx, x2: cx, y1: g.T0, y2: g.H - g.B0 });
    var xz = xh.querySelector('.xz'), xp = xh.querySelector('.xp');
    if (yv == null) { xz.style.display = 'none'; xp.style.display = 'none'; }
    else { xz.style.display = ''; xp.style.display = ''; set(xz, { x1: g.L0, x2: g.W - g.R0, y1: yv, y2: yv }); set(xp, { cx: cx, cy: yv }); }
    var t = xh.querySelector('.xt'); set(t, { x: g.W - g.R0, y: g.T0 - 6 });
    t.textContent = hourLabel(svg.dataset.start, i) + ' · ' + (v == null ? '자료 없음' : (k === 't' ? tmp(v) : num(v)) + CH[k].unit);
    xh.style.display = '';
  }
  // 격자를 누르면 그 격자의 그림을 지도 오른쪽 위에 고정(지도 아무 데나 누르면 닫힘)
  function renderPin() {
    var box = $('fc-pin'); if (!box) return;
    var sr = S.pin && S.focus && S.series[S.focus] ? S.series[S.focus][S.pin] : null;
    if (!sr) { box.hidden = true; box.innerHTML = ''; return; }
    var k = S.pin.split(','), g = S.grid[S.hq], c = g && g.cells ? g.cells.filter(function (x) { return x[0] === +k[0] && x[1] === +k[1]; })[0] : null;
    box.innerHTML = '<div class="fc-pin-head"><b>' + esc(cellName(+k[0], +k[1])) + '</b>' + cellNo(+k[0], +k[1]) + ' <span class="fc-pin-br">' + (c ? esc((c[2] || []).map(bname).join(', ')) : '') + '</span>' +
      '<button type="button" class="fc-pin-x" aria-label="닫기">×</button></div>' + trendBox(sr, S.series[S.focus]._start, true) +
      '<div class="fc-pin-note">그림에 마우스를 올리면 시각별 값</div>';
    box.hidden = false;
  }
  function pinCell(key) { S.pin = key; S.pinAt = Date.now(); renderPin(); drawCells(); }
  function unpin() { if (!S.pin) return; S.pin = null; renderPin(); drawCells(); }

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
      var nx = c[0], ny = c[1], bs = c[2] || [], snow = fresh ? c[3] : null, pcp = fresh ? c[4] : null, tmin = fresh ? c[5] : null, tat = fresh ? c[6] : null;
      var mine = S.focus ? bs.indexOf(S.focus) >= 0 : true;
      if (S.focus && !mine) return;                                  // 지사를 고르면 그 지사 격자만
      var col = S.focus ? snowColor(snow) : JC.colorOf(st(), bs[0], S.hq);
      var key = nx + ',' + ny, pinned = S.focus && S.pin === key;
      var poly = L.polygon(G.cellCorners(nx, ny), { weight: pinned ? 4 : S.focus ? 1.5 : 1, color: pinned ? '#FFC400' : S.focus ? '#33424f' : col, fillColor: col, fillOpacity: S.focus ? 0.7 : 0.28, opacity: 0.9 });
      var sr = S.focus && fresh && S.series[S.focus] ? S.series[S.focus][key] : null;
      poly.bindTooltip('<b>' + esc(cellName(nx, ny)) + '</b>' + cellNo(nx, ny) + '<br>' + bs.map(function (b) { return esc(bname(b)); }).join(', ') +
        (S.focus ? '<br>24시간 적설 <b>' + num(snow) + 'cm</b> · 강수 <b>' + num(pcp) + 'mm</b><br>최저기온 <b>' + tmp(tmin) + '℃</b> (' + esc(hh(tat)) + ')' +
          (sr ? trendBox(sr, S.series[S.focus]._start, false) + '<div class="fc-trend-key">누르면 그림 고정</div>' : '') : ''),
        { sticky: true, opacity: 1, className: 'gr-tip' + (sr ? ' fc-tip' : '') });
      poly.on('click', function () {
        if (!S.focus) { if (bs.length) focusBranch(bs[0]); return; }
        if (sr) { poly.closeTooltip(); pinCell(key); }                         // 지사 격자: 그 격자 그림 고정
      });
      poly.addTo(S.cells);
      if (S.focus) {                                                 // 지사: 격자마다 값(적설 / 강수)
        L.tooltip({ permanent: true, direction: 'center', className: 'fc-label', interactive: false })
          .setLatLng(G.cellCenter(nx, ny)).setContent('<b>' + num(snow) + '</b><span>' + num(pcp) + '</span><em>' + tmp(tmin) + '°</em>').addTo(S.cells);
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
    S.map.on('click', function () { if (Date.now() - S.pinAt > 300) unpin(); });      // 지도 아무 데나 누르면 고정 그림 닫기(격자를 누른 그 순간은 제외)
    setTimeout(function () { S.map.invalidateSize(); }, 50);
  }

  /* ---------- 옆 목록 ---------- */
  function renderMeta() {
    var m = S.meta, fresh = m && Date.now() - Date.parse(m.tmfc) <= STALE;
    $('fc-meta').innerHTML = m ? '<b>' + esc(fmtHour(m.tmfc)) + ' 발표 기준</b>' + (m.start ? ' · ' + esc(fmtHour(m.start)) + ' ~ ' + esc(fmtHour(m.end)) + ' (24시간 합·최저)' : '') +
        (fresh ? '' : '<div class="fc-stale">예보 없음(발표 후 12시간 지남)</div>')
      : '<span class="fc-stale">예보 없음</span>';
  }
  function cellPair(f) {
    return f ? '<span class="fc-v s">' + num(f.max_snow_24h) + '<i>cm</i></span><span class="fc-v p">' + num(f.max_pcp_24h) + '<i>mm</i></span><span class="fc-v t">' + tmp(f.min_tmp) + '<i>℃</i></span>'
      : '<span class="fc-v s">-</span><span class="fc-v p">-</span><span class="fc-v t">-</span>';
  }
  function hqMax(hq) {               // 본부 줄: 적설·강수는 가장 큰 지사, 최저기온은 가장 추운 지사
    var s = null, p = null, t = null;
    branchesOf(hq).forEach(function (id) { var f = bval(id); if (!f) return; if (s == null || f.max_snow_24h > s) s = f.max_snow_24h; if (p == null || f.max_pcp_24h > p) p = f.max_pcp_24h;
      if (f.min_tmp != null && (t == null || f.min_tmp < t)) t = f.min_tmp; });
    return s == null && p == null ? null : { max_snow_24h: s, max_pcp_24h: p, min_tmp: t };
  }
  function renderTree() {
    var html = '<div class="fc-cols"><span></span><span>적설</span><span>강수</span><span>최저</span></div>' + st().hqs.filter(function (h) { return !JC.isPrivate(h); }).map(function (hq) {
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
      .map(function (c) { return { nx: c[0], ny: c[1], s: fresh ? c[3] : null, p: fresh ? c[4] : null, t: fresh ? c[5] : null, ta: fresh ? c[6] : null }; })
      .sort(function (a, b) { return (b.s || 0) - (a.s || 0) || (b.p || 0) - (a.p || 0); });
    return '<div class="fc-detail"><table><thead><tr><th>지명</th><th>적설(cm)</th><th>강수(mm)</th><th>최저(℃)</th><th>시각</th></tr></thead><tbody>' +
      rows.map(function (r) { return '<tr data-cell="' + r.nx + ',' + r.ny + '"><td>' + esc(cellName(r.nx, r.ny)) + cellNo(r.nx, r.ny) + '</td><td>' + num(r.s) + '</td><td>' + num(r.p) + '</td><td>' + tmp(r.t) + '</td><td>' + esc(hh(r.ta)) + '</td></tr>'; }).join('') +
      '</tbody></table></div>';
  }
  function renderLegend() {
    $('fc-legend').innerHTML = S.focus ? '<b>24시간 예상 적설(cm)</b> ' + SCALE.slice().reverse().map(function (x) { return '<span class="sw" style="background:' + x[1] + '"></span>' + esc(x[2]); }).join(' ') + ' · 칸 위 숫자: 위 = 적설(cm), 가운데 = 강수(mm), 아래 = 최저기온(℃) · 격자에 마우스를 올리면 24시간 추이'
      : '';
    $('fc-legend').style.display = S.focus ? '' : 'none';
  }
  function render() { drawLines(); drawCells(); renderMeta(); renderTree(); renderLegend(); renderPin(); }

  /* ---------- 단계 이동 ---------- */
  function setHq(hq) {
    S.hq = hq; S.focus = null; S.pin = null; render(); fitTo();
    if (hq !== 'ALL' && !S.grid[hq]) loadGrid(hq).then(function () { if (S.hq === hq) { render(); fitTo(); } });
  }
  function focusBranch(id) {
    var hq = hqOf(id); if (!hq) return;
    S.pin = null;
    if (S.focus === id) { S.focus = null; render(); fitTo(); return; }
    S.hq = hq; S.focus = id; render();
    Promise.all([loadGrid(hq), loadSeries(id)]).then(function () { if (S.focus === id) { render(); fitTo(); } });
  }

  function bind() {
    $('view-forecast').addEventListener('click', function (e) {
      var t = e.target, h = t.closest && t.closest('[data-fchq]'); if (h) { setHq(S.hq === h.dataset.fchq ? 'ALL' : h.dataset.fchq); return; }
      var b = t.closest && t.closest('[data-fcbr]'); if (b) { focusBranch(b.dataset.fcbr); return; }
      if (t.closest && t.closest('.fc-pin-x')) { unpin(); return; }
      var c = t.closest && t.closest('[data-cell]'); if (c && S.map) { var k = c.dataset.cell.split(','); S.map.setView(G.cellCenter(+k[0], +k[1]), Math.max(S.map.getZoom(), 11)); if (S.focus) pinCell(c.dataset.cell); }
    });
    // 고정 그림: 마우스 위치의 시각·값(보조선)
    $('view-forecast').addEventListener('mousemove', function (e) { var svg = e.target.closest && e.target.closest('#fc-pin svg[data-big]'); if (svg) chartHover(svg, e); });
    $('view-forecast').addEventListener('mouseout', function (e) {
      var svg = e.target.closest && e.target.closest('#fc-pin svg[data-big]'); if (!svg || (e.relatedTarget && svg.contains(e.relatedTarget))) return;
      var xh = svg.querySelector('.xh'); if (xh) xh.style.display = 'none';
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
    ensureMap(); S.grid = {}; S.series = {}; S.pin = null;
    Promise.all([loadOverview(), loadNames()]).then(function () {
      var id = S.pendingFocus; S.pendingFocus = null;
      if (id && st().branches[id]) { S.hq = 'ALL'; S.focus = null; focusBranch(id); } else { render(); fitTo(); }
    });
    render();
  }
  // 다른 화면(장비 지원)에서 그 지사로 바로 오기
  function openBranch(id) { S.pendingFocus = id; }
  window.ForecastUI = { init: init, show: show, openBranch: openBranch, _state: function () { return S; } };
})();
