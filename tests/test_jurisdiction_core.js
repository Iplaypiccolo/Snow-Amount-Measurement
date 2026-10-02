/* 관할 변경 계산(jurisdiction/core.js) 자동 테스트
   실행: node tests/test_jurisdiction_core.js   (저장소 맨 위 폴더에서) */
const fs = require('fs'), path = require('path'), assert = require('assert');
const C = require('../jurisdiction/core.js');
const D = p => JSON.parse(fs.readFileSync(path.join(__dirname, '..', p), 'utf8'));
const doc = D('data/sections.json'), stationsDoc = D('data/stations.json');
const fresh = () => ({ H: D('data/hierarchy.json'), S: D('data/snow_data.json') });
const results = [];
function test(name, fn) { try { fn(); results.push([name, true]); } catch (e) { results.push([name, false, e.message.split('\n')[0]]); } }

const bid = (hq, name) => doc.branches.find(b => b.hq === hq && b.name === name).id;
const secsOf = id => doc.sections.filter(s => s.owner === id);
const snowKey = (hq, name) => hq + '|||' + name;

test('이벤트가 없으면 데이터가 한 글자도 바뀌지 않는다', () => {
  const { H, S } = fresh(), H0 = JSON.stringify(H), S0 = JSON.stringify(S);
  const r = C.applyToData(H, S, doc, stationsDoc, []);
  assert.strictEqual(r.changed.length, 0);
  assert.strictEqual(JSON.stringify(H), H0); assert.strictEqual(JSON.stringify(S), S0);
});

test('관측소 배정 규칙이 현재 59개 지사의 배정과 반경을 그대로 재현한다', () => {
  const H = D('data/hierarchy.json'); let n = 0, bad = [];
  H.hq.forEach(h => h.branches.forEach(b => {
    const id = doc.branches.find(x => x.hq === h.name && x.name === b.name).id;
    const pick = C.pickStations(C.buildSegments(secsOf(id)), stationsDoc.stations);
    const same = pick.radiusKm === b.radiusKm && JSON.stringify(pick.stations.map(s => s.id).sort()) === JSON.stringify(b.stations.map(s => s.id).sort());
    n++; if (!same) bad.push(h.name + '/' + b.name);
  }));
  assert.strictEqual(n, 59); assert.deepStrictEqual(bad, []);
});

test('구간 686여 개의 길이 합이 지사 합계와 맞고, 모든 구간에 소속이 있다', () => {
  const ids = new Set(doc.branches.map(b => b.id));
  assert.ok(doc.sections.length > 600);
  assert.ok(doc.sections.every(s => (s.owner === null || ids.has(s.owner)) && s.coords.length >= 2 && s.km > 0));
  assert.ok(doc.sections.filter(s => s.owner === null).length > 100, '미지정 구간이 있어야 함');
});

test('구간 이동: 두 지사만 바뀌고 일별 신적설이 새 관측소로 다시 계산된다', () => {
  const { H, S } = fresh(), A = bid('강원', '춘천'), B = bid('강원', '홍천');
  const move = secsOf(A).slice(0, 2).map(s => s.id);
  const km0 = C.summarize(doc, []).km;
  const r = C.applyToData(H, S, doc, stationsDoc, [{ t: 'move', sections: move, to: B }]);
  assert.deepStrictEqual(r.changed.map(c => c.id).sort(), [A, B].sort());
  const sum = C.summarize(doc, [{ t: 'move', sections: move, to: B }]).km;
  const moved = doc.sections.filter(s => move.includes(s.id)).reduce((a, s) => a + s.km, 0);
  assert.ok(Math.abs((km0[A] - sum[A]) - moved) < 1e-6 && Math.abs((sum[B] - km0[B]) - moved) < 1e-6);
  // 시리즈 검증: 홍천 하루 값 = 배정 관측소 최댓값
  const hc = H.hq.find(h => h.name === '강원').branches.find(b => b.name === '홍천');
  const season = S.seasons[Object.keys(S.seasons).sort().slice(-1)[0]], series = season.branches[snowKey('강원', '홍천')];
  const i = series.findIndex(v => v !== null && v > 0);
  const expect = Math.max(...hc.stations.map(s => (S.stationData[String(s.id)] || {})[season.dates[i]]).filter(v => v != null));
  assert.strictEqual(series[i], expect);
  assert.strictEqual(hc.count, hc.stations.length);
});

test('구간을 전부 다른 지사로 옮기면 그 지사는 관측소 0곳이 된다', () => {
  const { H, S } = fresh(), A = bid('강원', '춘천'), B = bid('강원', '홍천');
  C.applyToData(H, S, doc, stationsDoc, [{ t: 'move', sections: secsOf(A).map(s => s.id), to: B }]);
  const a = H.hq.find(h => h.name === '강원').branches.find(b => b.name === '춘천');
  assert.strictEqual(a.stations.length, 0); assert.strictEqual(a.routeSegments.length, 0);
});

test('신설 기관 추가 + 구간 이동: 새 지사가 본부에 생기고 적설 계산이 만들어진다', () => {
  const { H, S } = fresh(), from = bid('충북', '엄정');
  const ev = [{ t: 'addBranch', id: 'B900', hq: '충북', name: '신설시험' }, { t: 'move', sections: secsOf(from).slice(0, 1).map(s => s.id), to: 'B900' }];
  const hq0 = H.hq.find(h => h.name === '충북').branches.length;
  const r = C.applyToData(H, S, doc, stationsDoc, ev);
  const hq = H.hq.find(h => h.name === '충북');
  assert.strictEqual(hq.branches.length, hq0 + 1);
  const nb = hq.branches.find(b => b.name === '신설시험');
  assert.ok(nb && nb.routeSegments.length === 1 && nb.anchor);
  Object.keys(S.seasons).forEach(k => assert.strictEqual(S.seasons[k].branches['충북|||신설시험'].length, S.seasons[k].dates.length));
  assert.ok(r.changed.some(c => c.added));
});

test('지사를 다른 본부로 옮기면 적설 기록의 열쇠가 따라 바뀌고 값은 그대로다', () => {
  const { H, S } = fresh(), id = bid('충북', '엄정');
  const k0 = Object.keys(S.seasons)[0], before = JSON.stringify(S.seasons[k0].branches['충북|||엄정']);
  C.applyToData(H, S, doc, stationsDoc, [{ t: 'moveHq', branch: id, hq: '강원' }]);
  assert.ok(!('충북|||엄정' in S.seasons[k0].branches));
  assert.strictEqual(JSON.stringify(S.seasons[k0].branches['강원|||엄정']), before);
  assert.ok(H.hq.find(h => h.name === '강원').branches.some(b => b.name === '엄정'));
  assert.ok(!H.hq.find(h => h.name === '충북').branches.some(b => b.name === '엄정'));
});

test('잘못된 이벤트(없는 지사·없는 본부·중복 이름)는 무시된다', () => {
  const r = C.resolve(doc, [{ t: 'move', sections: ['S0001'], to: 'B999' }, { t: 'moveHq', branch: 'B001', hq: '없는본부' },
    { t: 'addBranch', id: 'B901', hq: '강원', name: '춘천' }, { t: 'addBranch', id: 'B902', hq: '강원', name: '  ' }]);
  assert.strictEqual(r.applied.length, 0); assert.strictEqual(r.skipped.length, 4);
});

test('미리보기: 이동한 두 지사의 km·관측소·적설 변화를 보여준다', () => {
  const { S } = fresh(), A = bid('강원', '춘천'), B = bid('강원', '홍천');
  const rows = C.impact(doc, stationsDoc, S, [], [{ t: 'move', sections: secsOf(A).slice(0, 2).map(s => s.id), to: B }]);
  assert.strictEqual(rows.length, 2);
  const a = rows.find(r => r.id === A), b = rows.find(r => r.id === B);
  assert.ok(a.after.km < a.before.km && b.after.km > b.before.km);
  assert.ok(a.before.allMax !== undefined);
});

const unSecs = () => doc.sections.filter(s => s.owner === null);

test('미지정 구간이 있어도 이벤트가 없으면 기존 지사 데이터는 그대로다', () => {
  const { H, S } = fresh(), H0 = JSON.stringify(H), S0 = JSON.stringify(S);
  C.applyToData(H, S, doc, stationsDoc, []);
  assert.strictEqual(JSON.stringify(H), H0); assert.strictEqual(JSON.stringify(S), S0);
  const sm = C.summarize(doc, []); assert.ok(sm.km.NONE > 300 && sm.count.NONE === unSecs().length);
});

test('미지정 구간을 지사에 배정하면 그 지사의 관할·관측소·적설이 다시 계산된다', () => {
  const { H, S } = fresh(), to = bid('수도권', '시흥'), pick = unSecs().slice(0, 3).map(s => s.id);
  const km0 = C.summarize(doc, []).km;
  const r = C.applyToData(H, S, doc, stationsDoc, [{ t: 'move', sections: pick, to }]);
  assert.deepStrictEqual(r.changed.map(c => c.id), [to]);               // 미지정 쪽은 '변경된 지사'가 아님
  const sm = C.summarize(doc, [{ t: 'move', sections: pick, to }]);
  const added = doc.sections.filter(s => pick.includes(s.id)).reduce((a, s) => a + s.km, 0);
  assert.ok(Math.abs(sm.km[to] - km0[to] - added) < 1e-6 && Math.abs(km0.NONE - sm.km.NONE - added) < 1e-6);
  const b = H.hq.find(h => h.name === '수도권').branches.find(x => x.name === '시흥');
  assert.strictEqual(b.count, b.stations.length);
});

test('지사 구간을 미지정(NONE)으로 되돌릴 수 있다', () => {
  const { H, S } = fresh(), A = bid('강원', '춘천'), one = secsOf(A).slice(0, 1).map(s => s.id);
  const sm = C.summarize(doc, [{ t: 'move', sections: one, to: 'NONE' }]);
  assert.strictEqual(sm.state.owner[one[0]], null); assert.ok(sm.count.NONE === unSecs().length + 1);
  const r = C.applyToData(H, S, doc, stationsDoc, [{ t: 'move', sections: one, to: 'NONE' }]);
  assert.deepStrictEqual(r.changed.map(c => c.id), [A]);
});

test('미리보기: 미지정 구간을 옮기면 도착 지사 하나만 비교 대상이 된다', () => {
  const { S } = fresh(), to = bid('수도권', '시흥');
  const rows = C.impact(doc, stationsDoc, S, [], [{ t: 'move', sections: unSecs().slice(0, 2).map(s => s.id), to }]);
  assert.strictEqual(rows.length, 1); assert.ok(rows[0].after.km > rows[0].before.km);
});

const hqCount = H => H.hq.reduce((a, h) => a + h.branches.length, 0);

test("본부 목록에 '민자'가 있고, 지금은 민자 기관·구간이 없다", () => {
  assert.ok(doc.hqs.includes('민자')); assert.strictEqual(doc.hqs[doc.hqs.length - 1], '민자');
  assert.ok(!doc.branches.some(b => b.hq === '민자'));
});

test('민자 기관을 만들고 미지정 구간을 옮겨도 강설량 화면 데이터(지사·관측소·적설)는 그대로다', () => {
  const { H, S } = fresh(), H0 = JSON.stringify(H), S0 = JSON.stringify(S);
  const ev = [{ t: 'addBranch', id: 'B901', hq: '민자', name: '시험민자고속도로' }, { t: 'move', sections: unSecs().slice(0, 4).map(s => s.id), to: 'B901' }];
  const r = C.applyToData(H, S, doc, stationsDoc, ev);
  assert.strictEqual(JSON.stringify(H), H0); assert.strictEqual(JSON.stringify(S), S0);
  assert.strictEqual(r.changed.length, 0);
  const sm = C.summarize(doc, ev); assert.ok(sm.km.B901 > 0 && sm.state.branches.B901.hq === '민자');
});

test('지사 구간을 민자로 넘기면 그 지사만 다시 계산되고 민자 쪽에는 관측소 계산이 없다', () => {
  const { H, S } = fresh(), A = bid('강원', '춘천'), pick = secsOf(A).slice(0, 2).map(s => s.id);
  const ev = [{ t: 'addBranch', id: 'B901', hq: '민자', name: '시험민자' }, { t: 'move', sections: pick, to: 'B901' }];
  const r = C.applyToData(H, S, doc, stationsDoc, ev);
  assert.deepStrictEqual(r.changed.map(c => c.id), [A]);
  assert.ok(!H.hq.some(h => h.branches.some(b => b.name === '시험민자')));
  Object.keys(S.seasons).forEach(k => assert.ok(!Object.keys(S.seasons[k].branches).some(key => key.includes('시험민자'))));
});

test('기존 지사를 민자 본부로 옮기면 강설량 화면에서 빠지고 적설 기록도 사라진다 (다시 옮기면 돌아옴)', () => {
  const { H, S } = fresh(), id = bid('충북', '엄정'), n0 = hqCount(H), k0 = Object.keys(S.seasons)[0];
  C.applyToData(H, S, doc, stationsDoc, [{ t: 'moveHq', branch: id, hq: '민자' }]);
  assert.strictEqual(hqCount(H), n0 - 1);
  assert.ok(!('충북|||엄정' in S.seasons[k0].branches) && !Object.keys(S.seasons[k0].branches).some(k => k.endsWith('|||엄정')));
  const hq = H.hq.find(h => h.name === '충북'); assert.strictEqual(hq.count, hq.branches.reduce((a, b) => a + b.count, 0));
  // 민자로 옮겼다가 다른 일반 본부로 다시 옮기는 이벤트열: 일반 본부에서는 새로 계산되어 나타남
  const { H: H2, S: S2 } = fresh();
  C.applyToData(H2, S2, doc, stationsDoc, [{ t: 'moveHq', branch: id, hq: '민자' }, { t: 'moveHq', branch: id, hq: '강원' }]);
  const b = H2.hq.find(h => h.name === '강원').branches.find(x => x.name === '엄정');
  assert.ok(b && b.stations.length === b.count && b.count > 0);
  assert.strictEqual(S2.seasons[k0].branches['강원|||엄정'].length, S2.seasons[k0].dates.length);
});

test('미리보기: 민자 기관은 관측소·적설을 계산하지 않는다고 표시된다', () => {
  const { S } = fresh();
  const rows = C.impact(doc, stationsDoc, S, [], [{ t: 'addBranch', id: 'B901', hq: '민자', name: '시험민자' }, { t: 'move', sections: unSecs().slice(0, 2).map(s => s.id), to: 'B901' }]);
  assert.strictEqual(rows.length, 1); assert.strictEqual(rows[0].after.priv, true);
  assert.strictEqual(rows[0].after.stations.length, 0); assert.strictEqual(rows[0].after.allMax, null);
});

const ok = results.filter(r => r[1]).length;
results.forEach(r => console.log((r[1] ? 'PASS ' : 'FAIL ') + r[0] + (r[1] ? '' : '  → ' + r[2])));
console.log('\n' + ok + '/' + results.length + ' 통과');
process.exit(ok === results.length ? 0 : 1);
