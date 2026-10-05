/* 예상 적설 받기 함수(supabase/functions/collect-forecast/core.mjs) 자동 테스트 — 격자 글에서 지사 격자 고르기, 가짜 DB 로 받기 흐름·다시 받기·시간 제한
   실행: node tests/test_collect_forecast.mjs   (저장소 맨 위 폴더에서) */
import assert from 'node:assert/strict';
import { pickCells, kstHour, handle, NX, NY, GRID_URL } from '../supabase/functions/collect-forecast/core.mjs';

const results = [];
async function test(name, fn) { try { await fn(); results.push([name, true]); } catch (e) { results.push([name, false, String(e.message).split('\n')[0]]); } }

// 격자 글: 값 = ny*1000 + nx 로 만들면 고른 값이 맞는지 바로 보임(-99 = 바다)
const grid = (f) => { const rows = []; for (let ny = 1; ny <= NY; ny++) { const r = []; for (let nx = 1; nx <= NX; nx++) r.push(f(nx, ny).toFixed(2).padStart(8)); rows.push(r.join(',') + ','); } return rows.join('\n') + '\n'; };
const G = grid((nx, ny) => ny * 1000 + nx);

await test('한국 시각 시(YYYYMMDDHH)', () => {
  assert.equal(kstHour('2026-10-04T23:00:00Z'), '2026100508'); assert.equal(kstHour('2026-10-05T08:00:00+09:00'), '2026100508');
});
await test('격자 고르기: 첫 줄 = 남쪽(ny=1), 줄마다 149칸', () => {
  assert.deepEqual(pickCells(G, [[1, 1], [149, 1], [60, 127], [149, 253]]), [1001, 1149, 127060, 253149]);
});
await test('격자 고르기: 개수가 다르거나 글이 아니면 null', () => {
  assert.equal(pickCells('{"error":"key"}', [[1, 1]]), null); assert.equal(pickCells(null, [[1, 1]]), null); assert.equal(pickCells(G.replace(/,\s*$/, ''), [[1, 1]]) === null, false);
});

function world(o = {}) {
  const hours = Array.from({ length: 24 }, (_, i) => new Date(Date.UTC(2026, 9, 5, 2 + i)).toISOString());
  const w = { key: 'K'.repeat(22), token: 'tok', fetched: [], puts: [], fails: [], clock: 0, slept: 0,
    plan: { done: false, tmfc: '2026-10-04T23:00:00+00:00', start_at: hours[0], cells: [[60, 127], [92, 131]], missing: hours.flatMap((h) => [['SNO', h], ['PCP', h]]) },
    resp: () => ({ status: 200, text: G }), ...o };
  w.deps = {
    now: () => w.clock, sleep: async (ms) => { w.slept += ms; w.clock += ms; }, env: (k) => (k === 'KMA_AUTH_KEY' ? w.key : ''),
    async fetchText(u) { w.fetched.push(u); w.clock += 300; return w.resp(u, w.fetched.length); },
    auth: { async getUser() { return { id: null }; } },
    store: {
      async tokenOk(t) { return t === w.token; }, async getProfileById() { return null; },
      async plan() { return { data: w.plan, error: null }; },
      async put(tmfc, v, tmef, vals) { w.puts.push([tmfc, tmef, vals, v]); return { data: { ok: true, done: w.puts.length === 48 }, error: null }; },
      async fail(n) { w.fails.push(n); },
    },
  };
  return w;
}
const call = async (w, h = { token: 'tok' }) => { const r = await handle(new Request('https://x/f', { method: 'POST', headers: h.token ? { 'x-collector-token': h.token } : {}, body: '{}' }), w.deps); return { status: r.status, j: await r.json() }; };

await test('권한: 토큰 없으면 401(기상청에 묻지 않음)', async () => {
  const w = world(); assert.equal((await call(w, {})).status, 401); assert.equal((await call(w, { token: 'x' })).status, 401); assert.equal(w.fetched.length, 0);
});
await test('정상: 적설·강수 24시각씩 48번 받아 지사 격자만 넣고 끝(발표·예보 시각은 한국 시각, 키는 주소에만)', async () => {
  const w = world(); const r = await call(w);
  assert.equal(w.fetched.length, 48); assert.equal(w.puts.length, 48); assert.equal(r.j.done, true);
  assert.ok(w.fetched[0].startsWith(GRID_URL + '?tmfc=2026100508&tmef=2026100511&vars=SNO&authKey=')); assert.ok(w.fetched[1].includes('&tmef=2026100511&vars=PCP&')); assert.equal(w.puts[1][3], 'PCP');
  assert.deepEqual(w.puts[0][2], [127060, 131092]); assert.ok(!JSON.stringify(r.j).includes(w.key)); assert.equal(w.fails.length, 0);
});
await test('504 는 2초 뒤 다시(최대 4번), 그래도 안 되면 멈추고 실패 기록(다음 예약 때 이어서)', async () => {
  const w = world({ resp: (u, n) => (n % 2 ? { status: 504, text: '' } : { status: 200, text: G }) });
  await call(w); assert.ok(w.puts.length >= 24); assert.equal(w.fetched.length, w.puts.length * 2);
  const w2 = world({ resp: () => ({ status: 504, text: '' }) }); const r2 = await call(w2);
  assert.equal(w2.fetched.length, 4); assert.equal(w2.puts.length, 0); assert.ok(w2.fails[0].includes('504')); assert.equal(r2.j.ok, false);
});
await test('형식이 다르면(키 오류 안내문 등) 다시 하지 않고 실패 기록', async () => {
  const w = world({ resp: () => ({ status: 200, text: '인증키 오류' }) }); await call(w);
  assert.equal(w.fetched.length, 1); assert.ok(w.fails[0].includes('형식')); assert.ok(!w.fails[0].includes(w.key));
});
await test('120초가 넘으면 멈추고 나머지는 다음 예약 때', async () => {
  const w = world(); w.deps.sleep = async (ms) => { w.clock += 10000; }; const r = await call(w);
  assert.ok(w.puts.length < 24 && w.puts.length > 0); assert.ok(r.j.missing > 0); assert.ok(w.fails[0].includes('다음 예약'));
});
await test('이미 다 받은 발표분이면 아무것도 받지 않음, 키 없으면 실패 기록', async () => {
  const w = world({ plan: { done: true, tmfc: 'x' } }); const r = await call(w); assert.equal(r.j.done, true); assert.equal(w.fetched.length, 0);
  const w2 = world({ key: '' }); await call(w2); assert.equal(w2.fetched.length, 0); assert.ok(w2.fails[0].includes('KMA_AUTH_KEY'));
});

const ok = results.filter((r) => r[1]).length;
results.forEach((r) => console.log((r[1] ? 'PASS ' : 'FAIL ') + r[0] + (r[1] ? '' : '  → ' + r[2])));
console.log('\n' + ok + '/' + results.length + ' 통과'); process.exit(ok === results.length ? 0 : 1);
