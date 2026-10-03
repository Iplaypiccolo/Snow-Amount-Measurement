/* 예보 격자 편입 계산(grid/core.js) 자동 테스트
   실행: node tests/test_grid_core.js   (저장소 맨 위 폴더에서) */
const fs = require('fs'), path = require('path'), assert = require('assert');
const G = require('../grid/core.js');
const D = p => JSON.parse(fs.readFileSync(path.join(__dirname, '..', p), 'utf8'));
const base = D('data/grid_assign.json'), sections = D('data/sections.json');
const ids = new Set(sections.branches.map(b => b.id));
const results = [];
function test(name, fn) { try { fn(); results.push([name, true]); } catch (e) { results.push([name, false, e.message.split('\n')[0]]); } }

test('격자 변환: 기상청 공식 예시값과 맞는다 (서울시청 = 60,127)', () => {
  assert.deepStrictEqual(G.toGrid(37.5665, 126.9780), [60, 127]);
  assert.deepStrictEqual(G.toGrid(35.1796, 129.0756), [98, 76]);   // 부산시청
});

test('격자 ↔ 위경도 왕복: 모든 기본 격자의 중심점이 같은 칸으로 돌아온다', () => {
  const all = base.cells.map(c => [c[0], c[1]]).concat(base.ring);
  all.forEach(([nx, ny]) => { const [lat, lon] = G.cellCenter(nx, ny); assert.deepStrictEqual(G.toGrid(lat, lon), [nx, ny], nx + ',' + ny); });
  assert.ok(all.length > 2000);
});

test('칸 모서리: 네 점이 약 5km 간격 사각형이고 중심을 감싼다', () => {
  const [lat, lon] = G.cellCenter(73, 127), cs = G.cellCorners(73, 127);
  const lats = cs.map(c => c[0]), lons = cs.map(c => c[1]);
  assert.ok(Math.min(...lats) < lat && lat < Math.max(...lats) && Math.min(...lons) < lon && lon < Math.max(...lons));
  const km = (a, b) => { const x = (b[1] - a[1]) * 111.32 * Math.cos(a[0] * Math.PI / 180), y = (b[0] - a[0]) * 110.57; return Math.hypot(x, y); };
  [km(cs[0], cs[1]), km(cs[1], cs[2]), km(cs[2], cs[3]), km(cs[3], cs[0])].forEach(d => assert.ok(Math.abs(d - 5) < 0.2, '변 길이 ' + d));
});

test('기본 편입 데이터: 고속도로 격자 1,072칸 중 934칸이 기관에 편입, 이웃 후보가 있고 잘못된 기관 번호가 없다', () => {
  assert.strictEqual(base.cells.length, 1072);
  assert.strictEqual(base.cells.filter(c => c[2].length > 0).length, 934);
  assert.ok(base.ring.length > 1000);
  base.cells.forEach(c => c[2].forEach(b => assert.ok(ids.has(b), '없는 기관 ' + b)));
  const keys = new Set(base.cells.map(c => G.key(c[0], c[1]))); base.ring.forEach(c => assert.ok(!keys.has(G.key(c[0], c[1])), '중복'));
  assert.ok(base.cells.some(c => c[2].length > 1), '여러 기관이 공유한 격자가 있어야 함');
});

test('기본 편입은 실제 구간 위치와 맞는다: 구간 위의 점은 그 구간 기관이 편입된 격자에 속한다', () => {
  const map = new Map(base.cells.map(c => [G.key(c[0], c[1]), new Set(c[2])]));
  let n = 0;
  sections.sections.filter(s => s.owner).slice(0, 200).forEach(s => s.coords.filter((_, i) => i % 7 === 0).forEach(([lon, lat]) => {
    const [nx, ny] = G.toGrid(lat, lon), set = map.get(G.key(nx, ny)); assert.ok(set && set.has(s.owner), s.id + ' ' + nx + ',' + ny); n++;
  }));
  assert.ok(n > 300);
});

test('이벤트 없음 → 기본 편입 그대로, 요약은 934칸', () => {
  const r = G.resolve(base, [], ids), s = G.summarize(r.assign);
  assert.strictEqual(s.union, 934); assert.ok(s.shared > 50); assert.strictEqual(r.applied.length, 0);
});

test('편입 추가: 같은 격자에 기관 여러 곳이 공존하고, 호출 대상(합집합)은 한 번만 센다', () => {
  const cell = base.ring[0], A = 'B001', B = 'B002';
  const r = G.resolve(base, [{ t: 'add', cells: [cell], to: A }, { t: 'add', cells: [cell], to: B }], ids);
  const set = r.assign.get(G.key(cell[0], cell[1])); assert.deepStrictEqual([...set].sort(), [A, B]);
  const s = G.summarize(r.assign); assert.strictEqual(s.union, 935); assert.ok(s.shared >= G.summarize(G.resolve(base, [], ids).assign).shared + 1);
  assert.strictEqual(s.pairs, G.summarize(G.resolve(base, [], ids).assign).pairs + 2);
});

test('편입 제외: 기관만 빠지고 격자는 남는다. 아무도 없으면 호출 대상에서 빠진다', () => {
  const c = base.cells.find(c => c[2].length === 1), cell = [c[0], c[1]], b = c[2][0];
  const r = G.resolve(base, [{ t: 'remove', cells: [cell], from: b }], ids);
  assert.strictEqual(r.assign.get(G.key(cell[0], cell[1])).size, 0);
  assert.strictEqual(G.summarize(r.assign).union, 933);
  assert.ok(r.cells.has(G.key(cell[0], cell[1])), '격자 자체는 후보로 남아야 함');
});

test('잘못된 이벤트는 무시: 없는 기관, 범위 밖 격자, 이미 있는 편입, 없는 편입 제외', () => {
  const c = base.cells.find(c => c[2].length > 0), has = [c[0], c[1]], b = c[2][0];
  const r = G.resolve(base, [
    { t: 'add', cells: [has], to: 'B999' }, { t: 'add', cells: [[0, 5], [500, 5], [3.5, 4]], to: 'B001' },
    { t: 'add', cells: [has], to: b }, { t: 'remove', cells: [base.ring[0]], from: 'B001' }, { t: 'oops' }, null], ids);
  assert.strictEqual(r.applied.length, 0); assert.strictEqual(r.skipped.length, 6);
  assert.strictEqual(G.summarize(r.assign).union, 934);
});

test('기본·후보 밖의 격자도 직접 추가할 수 있다 (범위 안이면)', () => {
  const r = G.resolve(base, [{ t: 'add', cells: [[10, 10]], to: 'B001' }], ids);
  assert.ok(r.assign.get('10,10').has('B001') && r.cells.has('10,10')); assert.strictEqual(G.summarize(r.assign).union, 935);
});

test('호출량 계산(서버 수집 기준 추정값: 한 번 100칸·5분 간격): 300칸 = 3번·15분·하루 2,400건, 934칸 = 10번·50분이라 3시간 안에 끝남, 하루 호출 한도는 1,250칸에서 넘음', () => {
  assert.deepStrictEqual(G.budget(300), { runs: 3, minutes: 15, daily: 2400, level: 'ok', text: G.budget(300).text });
  assert.strictEqual(G.budget(934).level, 'ok'); assert.strictEqual(G.budget(934).runs, 10); assert.strictEqual(G.budget(934).minutes, 50); assert.strictEqual(G.budget(934).daily, 7472);
  assert.ok(/3시간 안에 모든 칸을 읽을 수 있고/.test(G.budget(934).text) && !/Worker/.test(G.budget(934).text), '더 이상 무료 Worker 문구가 없어야 함');
  assert.strictEqual(G.budget(1000).level, 'ok'); assert.strictEqual(G.budget(1000).daily, 8000);            // 하루 8,000건(한도의 80%)까지는 초록
  assert.strictEqual(G.budget(1001).level, 'warn'); assert.ok(/80%/.test(G.budget(1001).text));            // 80% 넘으면 노랑
  assert.strictEqual(G.budget(1250).level, 'warn'); assert.strictEqual(G.budget(1251).level, 'over');      // 하루 10,000건 한도: 1,250칸 × 8 = 10,000
  assert.ok(/하루 호출 한도/.test(G.budget(1300).text));
  assert.strictEqual(G.budget(0).runs, 0);
  assert.strictEqual(G.budget(2000).level, 'over');
});

test('저장 전 비교: 바뀌는 기관만 나오고 합집합 전·후와 호출량 판정이 함께 나온다', () => {
  const cells = base.ring.slice(0, 3), ev = [{ t: 'add', cells, to: 'B005' }];
  const im = G.impact(base, ids, [], ev);
  assert.deepStrictEqual(im.branches.map(b => b.id), ['B005']); assert.strictEqual(im.branches[0].after - im.branches[0].before, 3);
  assert.deepStrictEqual(im.union, [934, 937]); assert.strictEqual(im.budgetAfter.daily, 937 * 8);
});

test('영역 선택: 사각형 안에 중심이 들어오는 격자만 고른다', () => {
  const all = new Set(base.cells.map(c => G.key(c[0], c[1])).concat(base.ring.map(c => G.key(c[0], c[1]))));
  const c0 = base.cells[100], [lat, lon] = G.cellCenter(c0[0], c0[1]), hit = G.cellsInBox(all, lat - 0.04, lon - 0.05, lat + 0.04, lon + 0.05);
  assert.ok(hit.length >= 1 && hit.length < 30 && hit.some(c => c[0] === c0[0] && c[1] === c0[1])); hit.forEach(c => { const p = G.cellCenter(c[0], c[1]); assert.ok(Math.abs(p[0] - lat) <= 0.04 && Math.abs(p[1] - lon) <= 0.05); });
  assert.strictEqual(G.cellsInBox(all, 0, 0, 1, 1).length, 0);
});

const ok = results.filter(r => r[1]).length;
results.forEach(r => console.log((r[1] ? 'PASS ' : 'FAIL ') + r[0] + (r[1] ? '' : '  → ' + r[2])));
console.log('\n' + ok + '/' + results.length + ' 통과');
process.exit(ok === results.length ? 0 : 1);
