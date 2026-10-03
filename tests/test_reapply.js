/* 관할 변경을 새로고침 없이 다시 적용하는 계산(JurisCore.reapply)의 자동 테스트 — 실제 data/*.json 사용
   핵심: "처음 열 때 이벤트를 적용한 결과"와 "다른 상태에서 시작해 나중에 다시 적용한 결과"가 똑같아야 한다.
   실행: node tests/test_reapply.js   (저장소 맨 위 폴더에서) */
const fs = require('fs'), path = require('path'), assert = require('assert');
const C = require('../jurisdiction/core.js');
const R = (n) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', n + '.json'), 'utf8'));
const H0 = R('hierarchy'), S0 = R('snow_data'), doc = R('sections'), st = R('stations');
const clone = (x) => JSON.parse(JSON.stringify(x));
const results = [];
function test(name, fn) { try { fn(); results.push([name, true]); } catch (e) { results.push([name, false, String(e.message).split('\n')[0]]); } }
const bid = (hq, name) => doc.branches.find((b) => b.hq === hq && b.name === name).id;
const secs = (hq, name) => doc.sections.filter((s) => s.owner === bid(hq, name)).map((s) => s.id);
const freshBoot = (events) => { const H = clone(H0), S = clone(S0); C.applyToData(H, S, doc, st, events); return { H, S }; };
const seriesOf = (S) => JSON.stringify(Object.keys(S.seasons).sort().map((k) => [k, Object.keys(S.seasons[k].branches).sort().map((b) => [b, S.seasons[k].branches[b]])]));
// 독립적으로 계산한 기대값: 지사 하루 값 = 배정 관측소들의 그날 최댓값
const expectSeries = (H, S) => { const out = {}; Object.keys(S.seasons).forEach((k) => { out[k] = {}; H.hq.forEach((h) => h.branches.forEach((b) => { out[k][h.name + '|||' + b.name] = S.seasons[k].dates.map((d) => { let m = null; b.stations.forEach((s) => { const v = (S.stationData[String(s.id)] || {})[d]; if (v != null && (m === null || v > m)) m = v; }); return m; }); })); }); return out; };

const E_MOVE = [{ t: 'move', sections: secs('강원', '춘천').slice(0, 3), to: bid('강원', '홍천'), from: [bid('강원', '춘천')], km: 1 }];
const E_ALL = [
  { t: 'move', sections: secs('강원', '춘천'), to: bid('강원', '홍천'), from: [bid('강원', '춘천')], km: 1 },
  { t: 'addBranch', id: 'B900', hq: '강원', name: '신설시험' },
  { t: 'move', sections: secs('충북', '충주').slice(0, 4), to: 'B900', from: [bid('충북', '충주')], km: 1 },
  { t: 'moveHq', branch: bid('충북', '엄정'), hq: '강원', fromHq: '충북' },
  { t: 'move', sections: secs('광주전남', '구례').slice(0, 2), to: 'NONE', from: [bid('광주전남', '구례')], km: 1 },
  { t: 'move', sections: doc.sections.filter((s) => s.owner === null).slice(0, 3).map((s) => s.id), to: bid('수도권', '시흥'), from: [null], km: 1 },
];

test('기본: 이벤트가 없으면 전부 다시 계산해도 원래 지사별 신적설(531개 시리즈)과 정확히 같다', () => {
  const H = clone(H0), S = clone(S0); C.rebuildAllSeries(H, S); assert.equal(seriesOf(S), seriesOf(S0));
});

test('처음부터 적용한 결과 = 열린 뒤에 다시 적용한 결과 (이동 3개 구간)', () => {
  const a = freshBoot(E_MOVE), S = clone(S0), H = clone(H0); C.applyToData(H, S, doc, st, []);          // 처음 열 때: 이력 없음
  const r = C.reapply(H0, S, doc, st, E_MOVE);                                                          // 열려 있는 동안 저장 → 다시 적용
  assert.deepStrictEqual(r.H, a.H); assert.equal(seriesOf(S), seriesOf(a.S));
});

test('복합 변경(이동·신설·신설로 이동·본부 이동·미지정으로·미지정에서 배정)도 똑같다', () => {
  const a = freshBoot(E_ALL), S = clone(S0), H = clone(H0); C.applyToData(H, S, doc, st, E_ALL.slice(0, 2));      // 일부만 적용된 상태에서 시작
  const r = C.reapply(H0, S, doc, st, E_ALL);
  assert.deepStrictEqual(r.H, a.H); assert.equal(seriesOf(S), seriesOf(a.S));
  assert.ok(r.H.hq.find((h) => h.name === '강원').branches.some((b) => b.name === '신설시험'), '신설 기관이 강원 아래에 있어야 함');
  assert.equal((r.H.hq.find((h) => h.name === '강원').branches.find((b) => b.name === '춘천') || { routeSegments: [1] }).routeSegments.length, 0, '춘천 관할이 비어야 함');
});

test('여러 번 이어서 저장해도 같다: 이벤트를 하나씩 쌓으며 매번 다시 적용 = 한 번에 적용', () => {
  const S = clone(S0), H = clone(H0); C.applyToData(H, S, doc, st, []); let cur = H;
  for (let i = 1; i <= E_ALL.length; i++) cur = C.reapply(H0, S, doc, st, E_ALL.slice(0, i)).H;
  const a = freshBoot(E_ALL); assert.deepStrictEqual(cur, a.H); assert.equal(seriesOf(S), seriesOf(a.S));
});

test('되돌려도 같다: 이동했다가 반대로 되돌리면 원래 값(저장된 처음 자료)으로 돌아간다', () => {
  const to = bid('강원', '홍천'), from = bid('강원', '춘천'), ids = secs('강원', '춘천'), ev = [{ t: 'move', sections: ids, to, from: [from], km: 1 }, { t: 'move', sections: ids, to: from, from: [to], km: 1 }];
  const S = clone(S0), H = clone(H0); C.applyToData(H, S, doc, st, []); const r = C.reapply(H0, S, doc, st, ev);
  const nb = (hq, name) => r.H.hq.find((h) => h.name === hq).branches.find((b) => b.name === name);
  assert.deepStrictEqual(nb('강원', '춘천').routeSegments, H0.hq.find((h) => h.name === '강원').branches.find((b) => b.name === '춘천').routeSegments);
  assert.equal(JSON.stringify(nb('강원', '홍천').stations.map((s) => s.id)), JSON.stringify(H0.hq.find((h) => h.name === '강원').branches.find((b) => b.name === '홍천').stations.map((s) => s.id)));
  assert.equal(seriesOf(S), seriesOf(S0));
});

test('업로드해 둔 저장 안 된 신적설 자료는 유지되고, 새 관할로 계산된다', () => {
  const S = clone(S0), H = clone(H0); C.applyToData(H, S, doc, st, []);
  const label = Object.keys(S.seasons).sort().slice(-1)[0], newDate = '2099-01-15', stns = H.hq[0].branches[0].stations.concat(H.hq[2].branches[0].stations);
  S.seasons[label].dates.push(newDate); Object.keys(S.seasons[label].branches).forEach((k) => S.seasons[label].branches[k].push(null));      // 업로드가 날짜를 추가한 모양
  stns.forEach((s, i) => { S.stationData[String(s.id)] = S.stationData[String(s.id)] || {}; S.stationData[String(s.id)][newDate] = 5 + i; });
  const r = C.reapply(H0, S, doc, st, E_ALL), exp = expectSeries(r.H, S);
  Object.keys(S.seasons).forEach((k) => Object.keys(exp[k]).forEach((key) => assert.deepStrictEqual(S.seasons[k].branches[key], exp[k][key], k + ' ' + key)));
  assert.ok(S.seasons[label].branches['수도권|||' + H0.hq[0].branches[0].name].slice(-1)[0] != null, '업로드한 날짜 값이 지사에 반영되어야 함');
  assert.equal(S.stationData[String(stns[0].id)][newDate], 5, '업로드한 관측소 원자료는 그대로');
});

test('다시 적용해도 원본(처음 지사 목록)은 바뀌지 않고, 쓰지 않는 지사 시리즈는 남지 않는다', () => {
  const before = JSON.stringify(H0), S = clone(S0), H = clone(H0); C.applyToData(H, S, doc, st, []);
  const r = C.reapply(H0, S, doc, st, [{ t: 'move', sections: doc.sections.filter((s) => s.owner === bid('충북', '충주')).map((s) => s.id), to: bid('충북', '제천'), from: [bid('충북', '충주')], km: 1 }, { t: 'moveHq', branch: bid('충북', '엄정'), hq: '민자', fromHq: '충북' }]);
  assert.equal(JSON.stringify(H0), before, '원본 변경됨');
  const valid = new Set(); r.H.hq.forEach((h) => h.branches.forEach((b) => valid.add(h.name + '|||' + b.name)));
  Object.keys(S.seasons).forEach((k) => Object.keys(S.seasons[k].branches).forEach((key) => assert.ok(valid.has(key), '남은 시리즈 ' + key)));
  assert.ok(!valid.has('충북|||엄정'), '민자로 옮긴 지사는 강설량 화면에서 빠져야 함');
});

const ok = results.filter((r) => r[1]).length;
results.forEach((r) => console.log((r[1] ? 'PASS ' : 'FAIL ') + r[0] + (r[1] ? '' : '  → ' + r[2])));
console.log('\n' + ok + '/' + results.length + ' 통과'); process.exit(ok === results.length ? 0 : 1);
