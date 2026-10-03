/* 적설 넣기 함수(supabase/functions/import-snow/core.mjs) 자동 테스트 — 메모장(txt) 읽기, 예전 파일 변환, 가짜 DB 로 권한·검사·넣기 흐름 확인
   실행: node tests/test_import_snow.mjs   (저장소 맨 위 폴더에서) */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { webcrypto as crypto } from 'node:crypto';
import { parseTxt, fromSnowJson, chunks, handle, ImportError, CHUNK_STATIONS } from '../supabase/functions/import-snow/core.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const results = [];
async function test(name, fn) { try { await fn(); results.push([name, true]); } catch (e) { results.push([name, false, String(e.message).split('\n')[0]]); } }
const code = (f) => { try { f(); } catch (e) { assert.ok(e instanceof ImportError, String(e)); return e.code; } return null; };

// 기상청 콘솔 스크립트가 만드는 모양(관측 줄: 시각,지점번호,…,7번째 칸이 적설)
const TXT = [
  '#### DATE 20251201 ####',
  '202512010900, 90, x, x, x, x, 3.5',
  '202512011000, 100, x, x, x, x, -99.9',
  '# 설명 줄',
  '#### DATE 20251202 ####',
  '202512021200, 90, x, x, x, x, 0.0',
  '깨진 줄',
  '202512021200, abc, x, x, x, x, 1',
].join('\r\n');

await test('메모장 읽기: 날짜 머리줄 아래 관측 줄을 관측소·날짜별로 모음(결측 -99.9 도 그대로 넘김 → DB 가 거름)', () => {
  const r = parseTxt(TXT);
  assert.deepEqual(r.data, { 90: { 20251201: 3.5, 20251202: 0 }, 100: { 20251201: -99.9 } });
  assert.equal(r.lines, 3); assert.deepEqual(r.dates, ['20251201', '20251202']);
});
await test('메모장 읽기: 빈 파일·관측 줄 없음은 거절', () => {
  assert.equal(code(() => parseTxt('')), 'empty');
  assert.equal(code(() => parseTxt('#### DATE 20251201 ####\n# 없음')), 'no_rows');
  assert.equal(code(() => parseTxt('202512010900, 90, x, x, x, x, 3.5')), 'no_rows');     // 날짜 머리줄 없이 온 줄은 쓰지 않음
});
await test('실제 예전 파일(snow_data.json): 관측소 680곳 · 값 439,875개, 기간 2017-11-15 ~ 2026-03-15', () => {
  const doc = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/snow_data.json'), 'utf8'));
  const r = fromSnowJson(doc);
  assert.equal(Object.keys(r.data).length, 680); assert.equal(r.lines, 439875); assert.deepEqual(r.dates, ['20171115', '20260315']);
  const cs = chunks(r.data); assert.equal(cs.length, Math.ceil(680 / CHUNK_STATIONS));
  assert.equal(cs.reduce((a, c) => a + Object.keys(c).length, 0), 680);
});
await test('예전 파일 검사: stationData 없음·이상한 번호·숫자 아닌 값 거절', () => {
  assert.equal(code(() => fromSnowJson({})), 'bad_file');
  assert.equal(code(() => fromSnowJson({ stationData: { abc: {} } })), 'bad_file');
  assert.equal(code(() => fromSnowJson({ stationData: { 90: { 20251201: '3' } } })), 'bad_file');
});

/* ---------- 가짜 서버로 흐름 확인 ---------- */
const sha = async (t) => Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t))).toString('hex');
function world() {
  const w = { db: {}, calls: [], uploads: [], snaps: 0, profiles: {}, users: {}, boot: null, fetched: [], file: null, failChunk: -1 };
  w.deps = {
    now: () => new Date('2026-10-04T00:00:00Z'), sha256hex: sha,
    async fetchText(u) { w.fetched.push(u); return w.file; },
    auth: { async getUser(jwt) { return { id: w.users[jwt] || null }; } },
    store: {
      async getProfileById(id) { return w.profiles[id] || null; },
      async consumeBootstrap(hash, now) { const b = w.boot; if (!b || b.hash !== hash) return false; w.boot = null; return Date.parse(b.expires_at) >= now.getTime(); },
      async importSnow(p, overwrite, dry) {              // DB 함수(admin_import_snow)와 같은 규칙을 흉내
        w.calls.push({ n: Object.keys(p).length, overwrite, dry }); if (w.calls.length - 1 === w.failChunk) return { error: { message: 'boom' } };
        const c = { new: 0, changed: 0, same: 0, skipped_missing: 0, skipped_out_of_season: 0, written: 0 };
        for (const [s, rec] of Object.entries(p)) for (const [d, v] of Object.entries(rec)) {
          if (v < 0) { c.skipped_missing++; continue; }
          const m = +d.slice(4, 6), day = +d.slice(6, 8);
          if (!((m === 11 && day >= 15) || m === 12 || m === 1 || m === 2 || (m === 3 && day <= 15))) { c.skipped_out_of_season++; continue; }
          const k = s + '|' + d, old = w.db[k];
          if (old === undefined) { c.new++; if (!dry) { w.db[k] = v; c.written++; } }
          else if (old !== v) { c.changed++; if (!dry && overwrite) { w.db[k] = v; c.written++; } }
          else c.same++;
        }
        return { counts: c };
      },
      async rebuildSnapshot() { w.snaps++; return { result: { seasons: 1, values: Object.keys(w.db).length } }; },
      async logUpload(row) { w.uploads.push(row); return {}; },
    },
  };
  return w;
}
const admin = (w) => { w.users['jwt-a'] = 'u-a'; w.profiles['u-a'] = { id: 'u-a', username: 'admin-01', role: 'admin', disabled: false, must_change: false }; };
async function call(w, body, o = {}) {
  const h = { 'content-type': 'application/json' }; if (o.jwt) h.authorization = 'Bearer ' + o.jwt; if (o.boot) h['x-bootstrap-token'] = o.boot;
  const r = await handle(new Request('https://x.test/functions/v1/import-snow', { method: o.method || 'POST', headers: h, body: (o.method === 'GET' || o.method === 'OPTIONS') ? undefined : (o.raw ?? JSON.stringify(body)) }), w.deps);
  return { status: r.status, j: r.status === 204 ? null : await r.json() };
}

await test('권한: 비로그인·지사·임시 비밀번호 관리자는 거절, DB 함수도 부르지 않음', async () => {
  const w = world();
  assert.equal((await call(w, { action: 'plan', txt: TXT })).status, 401);
  w.users['jwt-b'] = 'u-b'; w.profiles['u-b'] = { id: 'u-b', username: 'exchungju', role: 'branch', disabled: false, must_change: false };
  assert.equal((await call(w, { action: 'plan', txt: TXT }, { jwt: 'jwt-b' })).status, 403);
  w.users['jwt-t'] = 'u-t'; w.profiles['u-t'] = { id: 'u-t', username: 'admin-02', role: 'admin', disabled: false, must_change: true };
  assert.equal((await call(w, { action: 'plan', txt: TXT }, { jwt: 'jwt-t' })).status, 403);
  assert.equal(w.calls.length, 0);
});
await test('plan: 넣지 않고 개수만 셈(결측·시즌 밖 개수 포함), 요약본도 안 만듦', async () => {
  const w = world(); admin(w);
  const r = await call(w, { action: 'plan', txt: TXT }, { jwt: 'jwt-a' });
  assert.equal(r.status, 200, JSON.stringify(r.j)); assert.equal(r.j.counts.new, 2); assert.equal(r.j.counts.skipped_missing, 1); assert.equal(r.j.counts.written, 0);
  assert.equal(Object.keys(w.db).length, 0); assert.equal(w.snaps, 0); assert.ok(w.calls.every((c) => c.dry));
});
await test('load: 새 값만 넣고 요약본을 한 번 만들고 업로드 기록을 남김', async () => {
  const w = world(); admin(w);
  const r = await call(w, { action: 'load', txt: TXT }, { jwt: 'jwt-a' });
  assert.equal(r.status, 200); assert.equal(r.j.counts.written, 2); assert.deepEqual(w.db, { '90|20251201': 3.5, '90|20251202': 0 });
  assert.equal(w.snaps, 1); assert.equal(w.uploads.length, 1); assert.equal(w.uploads[0].date_from, '2025-12-01'); assert.match(w.uploads[0].note, /admin-01/);
});
await test('이미 있는 값이 다르면: 기본은 그대로 두고 plan 이 알려 줌, overwrite 일 때만 바꿈', async () => {
  const w = world(); admin(w); w.db['90|20251201'] = 9.9;
  const p = await call(w, { action: 'plan', txt: TXT }, { jwt: 'jwt-a' }); assert.equal(p.j.counts.changed, 1); assert.match(p.j.message, /overwrite/);
  await call(w, { action: 'load', txt: TXT }, { jwt: 'jwt-a' }); assert.equal(w.db['90|20251201'], 9.9, '덮어쓰지 않음');
  await call(w, { action: 'load', txt: TXT, overwrite: true }, { jwt: 'jwt-a' }); assert.equal(w.db['90|20251201'], 3.5, 'overwrite 면 바꿈');
});
await test('시즌 밖(4~10월, 11/1~14) 날짜는 넣지 않음', async () => {
  const w = world(); admin(w);
  const r = await call(w, { action: 'load', txt: '#### DATE 20251110 ####\n1,90,x,x,x,x,2\n#### DATE 20250410 ####\n1,90,x,x,x,x,2' }, { jwt: 'jwt-a' });
  assert.equal(r.j.counts.skipped_out_of_season, 2); assert.equal(Object.keys(w.db).length, 0);
});
await test('예전 파일(github): 커밋 번호로 읽고 관측소를 묶음으로 나눠 넣음', async () => {
  const w = world(); admin(w);
  w.file = fs.readFileSync(path.join(ROOT, 'data/snow_data.json'), 'utf8');
  const r = await call(w, { action: 'plan', source: 'github', ref: 'e73689a' }, { jwt: 'jwt-a' });
  assert.equal(r.status, 200); assert.equal(w.fetched[0], 'https://raw.githubusercontent.com/Iplaypiccolo/Snow-Amount-Measurement/e73689a/data/snow_data.json');
  assert.equal(w.calls.length, Math.ceil(680 / CHUNK_STATIONS)); assert.equal(r.j.summary.values, 439875);
  assert.equal(r.j.counts.skipped_missing, 2078, '결측(-99.9) 2,078개는 넣지 않음'); assert.equal(r.j.counts.new, 439875 - 2078);
});
await test('일회용 시작 토큰: 한 번만 통과', async () => {
  const w = world(); w.boot = { hash: await sha('tok-123'), expires_at: '2026-10-04T00:10:00Z' };
  assert.equal((await call(w, { action: 'plan', txt: TXT }, { boot: 'tok-123' })).status, 200);
  assert.equal((await call(w, { action: 'plan', txt: TXT }, { boot: 'tok-123' })).status, 403);
});
await test('DB 오류: 중간 묶음에서 실패하면 500 과 함께 알림, 요약본은 만들지 않음', async () => {
  const w = world(); admin(w); w.failChunk = 0;
  const r = await call(w, { action: 'load', txt: TXT }, { jwt: 'jwt-a' }); assert.equal(r.status, 500); assert.equal(r.j.error, 'import_failed'); assert.equal(w.snaps, 0);
});
await test('요청 검사: 알 수 없는 작업 · 자료 없음 · 이상한 ref · 깨진 요청 · GET', async () => {
  const w = world(); admin(w);
  assert.equal((await call(w, { action: 'drop', txt: TXT }, { jwt: 'jwt-a' })).status, 400);
  assert.equal((await call(w, { action: 'plan' }, { jwt: 'jwt-a' })).status, 400);
  for (const ref of ['../x', 'main/../../evil', 'https://evil.test', 'ZZZ']) assert.equal((await call(w, { action: 'plan', source: 'github', ref }, { jwt: 'jwt-a' })).status, 400, ref);
  assert.equal((await call(w, null, { jwt: 'jwt-a', raw: '{oops' })).status, 400); assert.equal((await call(w, null, { method: 'GET' })).status, 405); assert.equal((await call(w, null, { method: 'OPTIONS' })).status, 204);
  assert.equal(w.fetched.length, 0);
});

const ok = results.filter((r) => r[1]).length;
results.forEach((r) => console.log((r[1] ? 'PASS ' : 'FAIL ') + r[0] + (r[1] ? '' : '  → ' + r[2])));
console.log('\n' + ok + '/' + results.length + ' 통과'); process.exit(ok === results.length ? 0 : 1);
