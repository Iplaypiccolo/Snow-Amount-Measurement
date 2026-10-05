/* 시즌별 적설 요약본(마이그레이션 31) 읽기 자동 테스트 — auth/snow.js 를 가짜 서버로 부름
   - 처음에는 목록 + 가장 최근 시즌만 받음 / 최근 3시즌은 드롭다운, 그 이전은 older
   - 고른 시즌(loadSeason)·전체(loadAll)는 그때 받음(이미 받은 것은 다시 받지 않음)
   - 예전 모양(version 1: 한 줄에 모든 시즌)도 그대로 읽음
   실행: node tests/test_snow_split.js   (저장소 맨 위 폴더에서) */
const assert = require('assert');
const results = [];
async function test(name, fn) { try { await fn(); results.push([name, true]); } catch (e) { results.push([name, false, String(e.message).split('\n')[0]]); } }

const LABELS = [2019, 2020, 2021, 2022, 2023, 2024].map((y) => `${y}-11-15~${y + 1}-03-15`);
function season(y, v) { return { dates: [`${y}1115`, `${y}1116`], st: { '90': [v, null], '100': [0, v + 1] } }; }
function rowsV2() {
  const rows = { snow: { key: 'snow', built_at: 'i1', body: { version: 2, seasons: LABELS.map((l) => ({ label: l, days: 2, data_days: 2, stations: 2 })) } } };
  LABELS.forEach((l, i) => { rows['snow:' + l] = { key: 'snow:' + l, built_at: 'b' + i, body: season(2019 + i, i) }; });
  return rows;
}
function fakeAuth(rows, log) {
  return {
    rest(q) {
      log.push(q);
      const m = /^snapshots\?key=([^&]+)&select=(.+)$/.exec(q); if (!m) return Promise.resolve({ ok: false });
      const kf = decodeURIComponent(m[1]), cols = m[2].split(',');
      let list;
      if (kf === 'like.snow*') list = Object.values(rows);
      else if (kf.startsWith('in.(')) list = [...kf.matchAll(/"([^"]+)"/g)].map((x) => rows[x[1]]).filter(Boolean);
      else if (kf.startsWith('eq.')) list = rows[kf.slice(3)] ? [rows[kf.slice(3)]] : [];
      return Promise.resolve({ ok: true, json: list.map((r) => Object.fromEntries(cols.map((c) => [c, r[c]]))) });
    },
  };
}
global.window = {};                                  // auth/snow.js 가 window.SSAuth 를 씀(IndexedDB 는 없으면 그냥 매번 받음)
const SN = require('../auth/snow.js');

(async () => {
  await test('처음엔 목록 + 가장 최근 시즌만 받음, 최근 3시즌/지난 시즌 나눔', async () => {
    const log = []; window.SSAuth = fakeAuth(rowsV2(), log);
    const d = await SN.load();
    assert.deepEqual(Object.keys(d.seasons), [LABELS[5]]);
    assert.deepEqual(d.recent, LABELS.slice(3)); assert.deepEqual(d.older, LABELS.slice(0, 3));
    assert.equal(d.stationData['90']['20241115'], 5); assert.equal(d.stationData['100']['20241116'], 6);
    assert.equal(log.length, 3, log.join(' / '));
    assert.ok(log[0].includes('select=key,built_at') && !log.some((q) => q.includes(encodeURIComponent('"snow:' + LABELS[4] + '"'))), '다른 시즌은 받지 않음');
  });
  await test('고른 시즌만 더 받고, 이미 받은 시즌은 다시 받지 않음', async () => {
    const log = []; window.SSAuth = fakeAuth(rowsV2(), log);
    const d = await SN.load(); const n = log.length;
    await SN.loadSeason(d, LABELS[3]);
    assert.ok(d.seasons[LABELS[3]] && d.stationData['90']['20221115'] === 3);
    assert.equal(log.length, n + 1);
    await SN.loadSeason(d, LABELS[3]); await SN.loadSeason(d, LABELS[5]);
    assert.equal(log.length, n + 1, '다시 받지 않음');
    await assert.rejects(SN.loadSeason(d, '1999-11-15~2000-03-15'));
  });
  await test('loadAll: 남은 시즌을 한 번에', async () => {
    const log = []; window.SSAuth = fakeAuth(rowsV2(), log);
    const d = await SN.load(); const n = log.length;
    await SN.loadAll(d);
    assert.deepEqual(Object.keys(d.seasons).sort(), LABELS);
    assert.equal(log.length, n + 1, '요청 한 번');
  });
  await test('예전 모양(version 1)도 읽음: 모든 시즌이 들어 있고 최근 3시즌만 드롭다운', async () => {
    const seasons = {}; LABELS.forEach((l, i) => { seasons[l] = season(2019 + i, i); });
    const log = []; window.SSAuth = fakeAuth({ snow: { key: 'snow', built_at: 'x', body: { version: 1, seasons } } }, log);
    const d = await SN.load();
    assert.deepEqual(Object.keys(d.seasons).sort(), LABELS);
    assert.deepEqual(d.recent, LABELS.slice(3)); assert.equal(log.length, 2);
  });
  await test('자료가 아직 없으면 빈 자료', async () => {
    window.SSAuth = fakeAuth({}, []);
    const d = await SN.load();
    assert.deepEqual(d.seasons, {}); assert.deepEqual(d.recent, []); assert.deepEqual(d.older, []);
  });

  const ok = results.filter((r) => r[1]).length;
  results.forEach((r) => console.log((r[1] ? 'PASS ' : 'FAIL ') + r[0] + (r[1] ? '' : '  → ' + r[2])));
  console.log('\n' + ok + '/' + results.length + ' 통과'); process.exit(ok === results.length ? 0 : 1);
})();
