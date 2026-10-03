/* 적설 요약본(서버 snapshots 'snow') → 화면 계산 자동 테스트 — 실제 data/snow_data.json 사용
   핵심: 서버에는 관측소별 원자료만 두고 지사별 값은 화면이 계산한다. 그 결과가 예전 파일에 들어 있던 지사별 값과 "정확히" 같아야 한다.
   - makeSnapshot 은 DB 함수 admin_rebuild_snow_snapshot 과 같은 규칙으로 요약본을 만든다(결측 -99.9 는 서버에 넣지 않으므로 뺀다).
   - tools/snow_checksum.js 와 같은 지문을 써서, 실제 서버 요약본과도 비교할 수 있다.
   실행: node tests/test_snow_snapshot.js   (저장소 맨 위 폴더에서) */
const fs = require('fs'), path = require('path'), assert = require('assert');
const C = require('../jurisdiction/core.js');
const SN = require('../auth/snow.js');
const R = (n) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', n + '.json'), 'utf8'));
const H0 = R('hierarchy'), F = R('snow_data'), doc = R('sections'), st = R('stations');
const clone = (x) => JSON.parse(JSON.stringify(x));
const results = [];
function test(name, fn) { try { fn(); results.push([name, true]); } catch (e) { results.push([name, false, String(e.message).split('\n')[0]]); } }

// DB 함수와 같은 규칙: 값이 있는 해(시즌)마다 11/15~3/15 전체 날짜, 그 시즌에 값이 하나라도 있는 관측소만 배열로
function ymd(d) { return d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0'); }
function makeSnapshot(stationData) {
  const rows = [];
  Object.keys(stationData).forEach((s) => Object.keys(stationData[s]).forEach((d) => { const v = stationData[s][d]; if (v >= 0) rows.push([s, d, v]); }));
  const yOf = (d) => { const y = +d.slice(0, 4), m = +d.slice(4, 6); return m >= 11 ? y : y - 1; };
  const seasons = {};
  [...new Set(rows.map((r) => yOf(r[1])))].forEach((y) => {
    const dates = []; for (let d = new Date(y, 10, 15); d <= new Date(y + 1, 2, 15); d.setDate(d.getDate() + 1)) dates.push(ymd(d));
    const idx = {}; dates.forEach((d, i) => { idx[d] = i; });
    const stObj = {};
    rows.filter((r) => yOf(r[1]) === y && idx[r[1]] != null).forEach(([s, d, v]) => { (stObj[s] ||= dates.map(() => null))[idx[d]] = v; });
    seasons[y + '-11-15~' + (y + 1) + '-03-15'] = { dates, st: stObj };
  });
  return { version: 1, seasons };
}

const snap = makeSnapshot(F.stationData);
const S = SN.fromSnapshot(snap);

test('시즌 9개와 날짜가 예전 파일과 같다(윤년 2월 29일 포함)', () => {
  assert.deepEqual(Object.keys(S.seasons).sort(), Object.keys(F.seasons).sort());
  Object.keys(F.seasons).forEach((k) => assert.deepEqual(S.seasons[k].dates, F.seasons[k].dates, k));
});
test('관측소 원자료: 결측(-99.9)만 빠지고 나머지 값은 모두 같다', () => {
  let n = 0, neg = 0;
  Object.keys(F.stationData).forEach((s) => Object.keys(F.stationData[s]).forEach((d) => {
    const v = F.stationData[s][d];
    if (v < 0) { neg++; assert.equal((S.stationData[s] || {})[d], undefined); } else { n++; assert.equal(S.stationData[s][d], v, s + ' ' + d); }
  }));
  assert.equal(neg, 2078); assert.equal(n, 437797);
  assert.equal(Object.values(S.stationData).reduce((a, r) => a + Object.keys(r).length, 0), 437797, '없던 값이 생기지 않음');
});
test('지사별 값(531개 시리즈)을 화면이 계산하면 예전 파일과 정확히 같다', () => {
  const H = clone(H0); C.rebuildAllSeries(H, S);
  let n = 0;
  Object.keys(F.seasons).forEach((k) => {
    assert.deepEqual(Object.keys(S.seasons[k].branches).sort(), Object.keys(F.seasons[k].branches).sort(), k);
    Object.keys(F.seasons[k].branches).forEach((b) => { assert.deepEqual(S.seasons[k].branches[b], F.seasons[k].branches[b], k + ' ' + b); n++; });
  });
  assert.equal(n, 531);
});
test('관할 변경이 있어도: 서버 요약본에서 시작한 결과 = 예전 파일에서 시작한 결과', () => {
  const ev = [{ t: 'addBranch', id: 'B900', hq: '강원', name: '신설시험' },
    { t: 'move', sections: doc.sections.filter((s) => s.owner === 'B014').slice(0, 3).map((s) => s.id), to: 'B900', from: ['B014'], km: 1 }];
  const a = C.reapply(clone(H0), clone(S), doc, st, ev), b = C.reapply(clone(H0), clone(F), doc, st, ev);
  assert.deepEqual(a.H, b.H);
});
test('빈 요약본(아직 자료 없음)도 오류 없이 빈 자료가 된다', () => {
  assert.deepEqual(SN.fromSnapshot(null), { seasons: {}, stationData: {} });
  assert.deepEqual(SN.fromSnapshot({ version: 1, seasons: {} }), { seasons: {}, stationData: {} });
});

module.exports = { makeSnapshot };
if (require.main === module) {
  const ok = results.filter((r) => r[1]).length;
  results.forEach((r) => console.log((r[1] ? 'PASS ' : 'FAIL ') + r[0] + (r[1] ? '' : '  → ' + r[2])));
  console.log('\n' + ok + '/' + results.length + ' 통과'); process.exit(ok === results.length ? 0 : 1);
}
