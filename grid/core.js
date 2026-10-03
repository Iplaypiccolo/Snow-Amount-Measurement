/* ============================================================
   grid/core.js — 예보 격자 편입 계산 (화면 없이 계산만 하는 부분)
   - 기상청 동네예보 5km 격자(nx, ny) ↔ 위도·경도 변환 (기상청 공식 람베르트 투영식)
   - 기본 편입(data/grid_assign.json)에 변경 이벤트(data/grid_changes.json)를 적용
   - 호출 대상 격자(편입된 격자의 합집합), 하루 호출량, 무료 Worker 분할 횟수 계산
   브라우저에서는 window.GridCore, Node(테스트)에서는 require() 로 씁니다.

   변경 이벤트 2종 (events 배열에 순서대로 쌓임)
     { t:'add',    cells:[[nx,ny],...], to:'B012'   }   격자들에 기관을 편입 (이미 있으면 그대로)
     { t:'remove', cells:[[nx,ny],...], from:'B012' }   격자들에서 기관을 제외
   한 격자에는 기관을 여러 곳 넣을 수 있습니다.
   ============================================================ */
(function (root) {
  'use strict';

  /* ---------- 격자 ↔ 위경도 (기상청 공식 변환식) ---------- */
  var RE = 6371.00877, GRID = 5.0, SLAT1 = 30, SLAT2 = 60, OLON = 126, OLAT = 38, XO = 43, YO = 136;
  var D = Math.PI / 180, re = RE / GRID, s1 = SLAT1 * D, s2 = SLAT2 * D, olon = OLON * D, olat = OLAT * D;
  var sn = Math.log(Math.cos(s1) / Math.cos(s2)) / Math.log(Math.tan(Math.PI * 0.25 + s2 * 0.5) / Math.tan(Math.PI * 0.25 + s1 * 0.5));
  var sf = Math.pow(Math.tan(Math.PI * 0.25 + s1 * 0.5), sn) * Math.cos(s1) / sn;
  var ro = re * sf / Math.pow(Math.tan(Math.PI * 0.25 + olat * 0.5), sn);
  var NX_MAX = 149, NY_MAX = 253;

  function toGrid(lat, lon) {
    var ra = re * sf / Math.pow(Math.tan(Math.PI * 0.25 + lat * D * 0.5), sn);
    var th = lon * D - olon;
    if (th > Math.PI) th -= 2 * Math.PI; if (th < -Math.PI) th += 2 * Math.PI;
    th *= sn;
    return [Math.floor(ra * Math.sin(th) + XO + 0.5), Math.floor(ro - ra * Math.cos(th) + YO + 0.5)];
  }
  // 격자 좌표(소수 가능) → [위도, 경도]. 정수 nx,ny 는 그 칸의 "중심"입니다.
  function fromGrid(x, y) {
    var xn = x - XO, yn = ro - y + YO, ra = Math.sqrt(xn * xn + yn * yn);
    if (sn < 0) ra = -ra;
    var alat = 2 * Math.atan(Math.pow(re * sf / ra, 1 / sn)) - Math.PI * 0.5, th;
    if (Math.abs(xn) <= 0) th = 0;
    else if (Math.abs(yn) <= 0) th = xn < 0 ? -Math.PI * 0.5 : Math.PI * 0.5;
    else th = Math.atan2(xn, yn);
    return [alat / D, (th / sn + olon) / D];
  }
  function cellCenter(nx, ny) { return fromGrid(nx, ny); }
  // 칸의 네 모서리 [위도, 경도] (남서→남동→북동→북서)
  function cellCorners(nx, ny) {
    return [fromGrid(nx - 0.5, ny - 0.5), fromGrid(nx + 0.5, ny - 0.5), fromGrid(nx + 0.5, ny + 0.5), fromGrid(nx - 0.5, ny + 0.5)];
  }
  var key = function (nx, ny) { return nx + ',' + ny; };
  var unkey = function (k) { var p = k.split(','); return [+p[0], +p[1]]; };
  var validCell = function (c) { return Array.isArray(c) && c.length === 2 && c[0] % 1 === 0 && c[1] % 1 === 0 && c[0] >= 1 && c[0] <= NX_MAX && c[1] >= 1 && c[1] <= NY_MAX; };

  /* ---------- 기본 편입 + 이벤트 적용 ---------- */
  // 돌려주는 값: { assign: Map("nx,ny" → Set(기관 id)), cells: 화면에 보일 모든 격자 키, applied, skipped }
  function resolve(baseline, events, validBranchIds) {
    var assign = new Map(), all = new Set();
    (baseline.cells || []).forEach(function (c) { assign.set(key(c[0], c[1]), new Set(c[2] || [])); all.add(key(c[0], c[1])); });
    (baseline.ring || []).forEach(function (c) { all.add(key(c[0], c[1])); if (!assign.has(key(c[0], c[1]))) assign.set(key(c[0], c[1]), new Set()); });
    var applied = [], skipped = [];
    var okBranch = function (id) { return !validBranchIds || validBranchIds.has(id); };
    (events || []).forEach(function (ev) {
      var changed = false;
      if (ev && (ev.t === 'add' || ev.t === 'remove') && Array.isArray(ev.cells)) {
        var b = ev.t === 'add' ? ev.to : ev.from;
        if (b && okBranch(b)) {
          ev.cells.forEach(function (c) {
            if (!validCell(c)) return;
            var k = key(c[0], c[1]), set = assign.get(k);
            if (ev.t === 'add') {
              if (!set) { set = new Set(); assign.set(k, set); all.add(k); }
              if (!set.has(b)) { set.add(b); changed = true; }
            } else if (set && set.has(b)) { set.delete(b); changed = true; }
          });
        }
      }
      (changed ? applied : skipped).push(ev);
    });
    return { assign: assign, cells: all, applied: applied, skipped: skipped };
  }

  /* ---------- 요약: 호출 대상(합집합), 기관별, 공유 ---------- */
  function summarize(assign) {
    var union = 0, shared = 0, pairs = 0, per = {};
    assign.forEach(function (set) {
      if (set.size > 0) union++;
      if (set.size > 1) shared++;
      pairs += set.size;
      set.forEach(function (b) { per[b] = (per[b] || 0) + 1; });
    });
    return { union: union, shared: shared, pairs: pairs, perBranch: per };
  }

  /* ---------- 호출량·예보 수집 분할 ----------
     예보 수집은 Supabase 서버 함수가 맡습니다(공식 한도: 한 번 실행에 CPU 2초·최대 150초·메모리 256MB). 한 번에 모든 칸을 처리하기엔 CPU 시간이 모자라므로
     여러 번에 나눠 수집합니다. 아래 두 숫자는 "추정값"입니다(예보 응답 하나를 읽는 데 약 10ms 로 가정) — 수집 함수를 만든 뒤 실제로 재서 고치세요. */
  var CELLS_PER_RUN = 100;         // 한 번 실행(CPU 2초 안)에 처리할 칸 수 — 추정값
  var RUN_INTERVAL_MIN = 5;        // 5분마다 한 묶음씩 — 추정값
  var FORECAST_CYCLE_MIN = 180;    // 단기예보는 3시간마다 발표
  var CALLS_PER_DAY_LIMIT = 10000; // 공공데이터포털 개발 계정 하루 한도(앞서 확인한 값)
  var UPDATES_PER_DAY = 8;
  function budget(unionCells) {
    var runs = Math.ceil(unionCells / CELLS_PER_RUN), minutes = runs * RUN_INTERVAL_MIN, daily = unionCells * UPDATES_PER_DAY;
    // 빨강: 3시간 안에 못 끝내거나 하루 한도를 넘음 / 노랑: 시간이 한도의 절반(90분)을 넘거나 하루 호출이 한도의 80%(8,000건)를 넘어 여유가 적음
    var level = (minutes > FORECAST_CYCLE_MIN || daily > CALLS_PER_DAY_LIMIT) ? 'over' : (minutes > FORECAST_CYCLE_MIN / 2 || daily > CALLS_PER_DAY_LIMIT * 0.8) ? 'warn' : 'ok';
    var text = level === 'over'
      ? (minutes > FORECAST_CYCLE_MIN ? '예보가 새로 나오는 3시간 안에 모든 칸을 다 읽지 못합니다. 격자를 줄이거나 수집 간격을 줄여야 합니다.' : '하루 호출 한도(공공데이터포털 개발 계정 10,000건)를 넘을 수 있습니다. 격자를 줄이세요.')
      : level === 'warn' ? (daily > CALLS_PER_DAY_LIMIT * 0.8 ? '가능하지만 하루 호출이 한도(10,000건)의 80%를 넘어 여유가 적습니다. 격자를 더 늘리면 한도를 넘을 수 있습니다.' : '가능하지만 수집에 시간이 오래 걸립니다(한 바퀴 약 ' + minutes + '분).') : '3시간 안에 모든 칸을 읽을 수 있고, 하루 호출도 한도 안입니다.';
    return { runs: runs, minutes: minutes, daily: daily, level: level, text: text };
  }

  /* ---------- 저장 전 비교: 기관별 격자 수, 합집합 ---------- */
  function impact(baseline, validIds, before, after) {
    var A = resolve(baseline, before, validIds), B = resolve(baseline, after, validIds);
    var sa = summarize(A.assign), sb = summarize(B.assign), ids = {};
    Object.keys(sa.perBranch).concat(Object.keys(sb.perBranch)).forEach(function (b) {
      if ((sa.perBranch[b] || 0) !== (sb.perBranch[b] || 0)) ids[b] = true;
    });
    return {
      branches: Object.keys(ids).sort().map(function (b) { return { id: b, before: sa.perBranch[b] || 0, after: sb.perBranch[b] || 0 }; }),
      union: [sa.union, sb.union], shared: [sa.shared, sb.shared], budgetBefore: budget(sa.union), budgetAfter: budget(sb.union)
    };
  }

  /* ---------- 사각형 안의 격자 찾기 (영역 선택용) ---------- */
  function cellsInBox(cellKeys, south, west, north, east) {
    var out = [];
    cellKeys.forEach(function (k) {
      var c = unkey(k), p = cellCenter(c[0], c[1]);
      if (p[0] >= south && p[0] <= north && p[1] >= west && p[1] <= east) out.push(c);
    });
    return out;
  }

  var api = {
    toGrid: toGrid, fromGrid: fromGrid, cellCenter: cellCenter, cellCorners: cellCorners, key: key, unkey: unkey, validCell: validCell,
    resolve: resolve, summarize: summarize, budget: budget, impact: impact, cellsInBox: cellsInBox,
    CELLS_PER_RUN: CELLS_PER_RUN, RUN_INTERVAL_MIN: RUN_INTERVAL_MIN, NX_MAX: NX_MAX, NY_MAX: NY_MAX
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GridCore = api;
})(typeof window !== 'undefined' ? window : this);
