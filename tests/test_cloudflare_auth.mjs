/* Cloudflare 서버 코드(로그인·계정·접속기록·수집 시험) 자동 테스트
   실행: node --no-warnings tests/test_cloudflare_auth.mjs   (저장소 맨 위 폴더에서)
   Cloudflare 가 아니라 컴퓨터 안의 흉내(D1 = 내장 SQLite)로 시험합니다. */
import assert from 'node:assert/strict';
import { makeServer, cookieOf } from './_cf_harness.mjs';
import { runProbe, maskUrl } from '../workers/collector/src/probe.js';

const results = [];
async function test(name, fn) {
  try { await fn(); results.push([name, true]); } catch (e) { results.push([name, false, String(e.message).split('\n')[0] + ' @' + ((e.stack||'').split('\n').find(l=>l.includes('test_cloudflare_auth.mjs'))||'').trim().split(':').slice(-2).join(':')]); }
}
const TOKEN = 'setup-code-for-tests';
const PW = 'Correct-Horse-9!';
const fresh = async (extra = {}) => makeServer({ SETUP_TOKEN: TOKEN, ...extra });
async function bootstrap(s) {
  const r = await s.call('/api/setup', { method: 'POST', body: { token: TOKEN, username: 'admin1', password: PW, display_name: '관리자1' } });
  assert.equal(r.status, 200, r.text);
}
async function login(s, username, password, extra = {}) { return s.call('/api/login', { method: 'POST', body: { username, password }, ...extra }); }
async function adminSession(s) { await bootstrap(s); const r = await login(s, 'admin1', PW); assert.equal(r.status, 200); return cookieOf(r); }
async function makeUser(s, ck, body) { const r = await s.call('/api/admin/users', { method: 'POST', cookie: ck, body }); assert.equal(r.status, 201, r.text); return r.json; }

await test('첫 관리자 설정: 코드가 맞을 때만, 한 번만 된다', async () => {
  const s = await fresh();
  assert.equal((await s.call('/api/setup')).json.needed, true);
  assert.equal((await s.call('/api/setup', { method: 'POST', body: { token: 'wrong', username: 'admin1', password: PW } })).status, 403);
  assert.equal((await s.call('/api/setup', { method: 'POST', body: { token: TOKEN, username: 'admin1', password: 'short' } })).status, 400);
  assert.equal((await s.call('/api/setup', { method: 'POST', body: { token: TOKEN, username: 'Bad Name!', password: PW } })).status, 400);
  await bootstrap(s);
  assert.equal((await s.call('/api/setup')).json.needed, false);
  assert.equal((await s.call('/api/setup', { method: 'POST', body: { token: TOKEN, username: 'second', password: PW } })).status, 404);
  const noToken = await makeServer({});            // SETUP_TOKEN 이 없으면 설정 기능 자체가 꺼져 있음
  assert.equal((await noToken.call('/api/setup', { method: 'POST', body: { token: '', username: 'a', password: PW } })).status, 404);
});

await test('로그인: 쿠키는 HttpOnly·Secure·SameSite=Strict, DB에는 쿠키 값이 아닌 해시만 저장', async () => {
  const s = await fresh(); await bootstrap(s);
  const r = await login(s, 'ADMIN1', PW);                      // 아이디는 대소문자 구분 없음
  assert.equal(r.status, 200);
  const sc = r.headers.get('Set-Cookie');
  for (const part of ['__Host-sid=', 'HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/']) assert.ok(sc.includes(part), part + ' 없음: ' + sc);
  assert.ok(!sc.includes('Domain='));
  const token = cookieOf(r).split('=')[1];
  const rows = s.env.DB.raw.prepare('SELECT * FROM sessions').all();
  assert.equal(rows.length, 1); assert.notEqual(rows[0].token_hash, token); assert.equal(rows[0].token_hash.length, 64);
  assert.ok(!JSON.stringify(r.json).includes('password'));
});

await test('비밀번호는 원문이 아닌 해시로 저장되고, 응답·접속기록 어디에도 나오지 않는다', async () => {
  const s = await fresh(); const ck = await adminSession(s);
  const u = await makeUser(s, ck, { username: 'branch1', display_name: '대관령지사', role: 'branch', branch: '대관령' });
  const dump = JSON.stringify(s.env.DB.raw.prepare('SELECT * FROM users').all()) + JSON.stringify(s.env.DB.raw.prepare('SELECT * FROM audit_log').all());
  assert.ok(!dump.includes(PW) && !dump.includes(u.temp_password));
  assert.match(s.env.DB.raw.prepare("SELECT password_hash h FROM users WHERE username='admin1'").get().h, /^pbkdf2-sha256\$1000\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
  const list = await s.call('/api/admin/users', { cookie: ck });
  assert.ok(!list.text.includes('password_hash') && !list.text.includes('pbkdf2'));
});

await test('틀린 비밀번호와 없는 아이디는 같은 메시지, 접속실패가 기록된다', async () => {
  const s = await fresh(); await bootstrap(s);
  const a = await login(s, 'admin1', 'x'.repeat(14)), b = await login(s, 'nobody', 'x'.repeat(14));
  assert.equal(a.status, 401); assert.equal(b.status, 401); assert.equal(a.json.message, b.json.message); assert.equal(a.json.error, b.json.error);
  assert.equal(s.env.DB.raw.prepare("SELECT COUNT(*) n FROM audit_log WHERE kind='접속실패'").get().n, 2);
});

await test('같은 아이디로 5번 틀리면 잠기고, 맞는 비밀번호도 잠시 막힌다 (관리자가 초기화하면 풀림)', async () => {
  const s = await fresh(); const ck = await adminSession(s);
  const u = await makeUser(s, ck, { username: 'equip1', display_name: '지원장비', role: 'equip' });
  for (let i = 0; i < 5; i++) assert.equal((await login(s, 'equip1', 'wrong-password-' + i, { ip: '198.51.100.' + i })).status, 401);
  const locked = await login(s, 'equip1', u.temp_password, { ip: '198.51.100.99' });
  assert.equal(locked.status, 429);
  const reset = await s.call(`/api/admin/users/${s.env.DB.raw.prepare("SELECT id FROM users WHERE username='equip1'").get().id}/reset`, { method: 'POST', cookie: ck });
  assert.equal(reset.status, 200);
  assert.equal((await login(s, 'equip1', reset.json.temp_password)).status, 200);
});

await test('같은 IP에서 30번 틀리면 다른 아이디도 막힌다', async () => {
  const s = await fresh(); await bootstrap(s);
  for (let i = 0; i < 30; i++) await login(s, 'user' + i, 'wrong-password-xx');
  assert.equal((await login(s, 'admin1', PW)).status, 429);
  assert.equal((await login(s, 'admin1', PW, { ip: '198.51.100.50' })).status, 200);       // 다른 IP는 영향 없음
});

await test('너무 긴 비밀번호는 계산하지 않고 거절한다', async () => {
  const s = await fresh(); await bootstrap(s);
  assert.equal((await login(s, 'admin1', 'a'.repeat(500))).status, 401);          // 128자 초과: 해시 계산 없이 거절
  assert.equal((await login(s, 'admin1', 'a'.repeat(5000))).status, 400);         // 본문 자체가 너무 큼
  assert.equal(s.env.DB.raw.prepare('SELECT COUNT(*) n FROM login_attempts').get().n, 0);
});

await test('다른 사이트에서 보낸 요청(Origin 불일치·없음)은 거절한다', async () => {
  const s = await fresh(); await bootstrap(s);
  assert.equal((await login(s, 'admin1', PW, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await login(s, 'admin1', PW, { origin: null })).status, 403);
  assert.equal((await login(s, 'admin1', PW)).status, 200);
});

await test('내 정보: 로그인해야 볼 수 있고, 로그아웃하면 그 쿠키는 더 쓸 수 없다', async () => {
  const s = await fresh(); const ck = await adminSession(s);
  assert.equal((await s.call('/api/me')).status, 401);
  const me = await s.call('/api/me', { cookie: ck });
  assert.equal(me.status, 200); assert.equal(me.json.user.username, 'admin1'); assert.equal(me.json.user.role, 'admin');
  assert.ok(!('id' in me.json.user) && !('tokenHash' in me.json.user));
  const out = await s.call('/api/logout', { method: 'POST', cookie: ck });
  assert.ok(out.headers.get('Set-Cookie').includes('Max-Age=0'));
  assert.equal((await s.call('/api/me', { cookie: ck })).status, 401);
});

await test('로그인 유지 시간: 10시간이 지났거나 2시간 동안 가만히 있으면 로그아웃', async () => {
  const s = await fresh(); const ck = await adminSession(s);
  s.env.DB.raw.exec("UPDATE sessions SET last_seen_at='2000-01-01T00:00:00.000Z'");
  assert.equal((await s.call('/api/me', { cookie: ck })).status, 401);            // 오래 가만히 있음
  const ck2 = cookieOf(await login(s, 'admin1', PW));
  s.env.DB.raw.exec("UPDATE sessions SET expires_at='2000-01-01T00:00:00.000Z'");
  assert.equal((await s.call('/api/me', { cookie: ck2 })).status, 401);           // 10시간 경과
  assert.equal(s.env.DB.raw.prepare('SELECT COUNT(*) n FROM sessions').get().n, 0);
});

await test('권한: 관리자 전용 기능을 지사·지원장비 아이디는 쓸 수 없고, 시도는 기록된다', async () => {
  const s = await fresh(); const ck = await adminSession(s);
  const b = await makeUser(s, ck, { username: 'branch1', display_name: '지사', role: 'branch', branch: '대관령' });
  const e = await makeUser(s, ck, { username: 'equip1', display_name: '장비', role: 'equip' });
  for (const [name, user] of [['branch1', b], ['equip1', e]]) {
    const first = await login(s, name, user.temp_password); const ck2 = cookieOf(first);
    await s.call('/api/password', { method: 'POST', cookie: ck2, body: { current: user.temp_password, next: 'New-Password-123' } });
    const ck3 = cookieOf(await login(s, name, 'New-Password-123'));
    for (const path of ['/api/admin/users', '/api/admin/audit', '/api/admin/collector']) assert.equal((await s.call(path, { cookie: ck3 })).status, 403, name + ' ' + path);
    assert.equal((await s.call('/api/admin/users', { method: 'POST', cookie: ck3, body: { username: 'x'.repeat(5), display_name: 'x', role: 'admin' } })).status, 403);
  }
  assert.ok(s.env.DB.raw.prepare("SELECT COUNT(*) n FROM audit_log WHERE kind='권한거부'").get().n >= 6);
  for (const path of ['/api/admin/users', '/api/admin/audit']) assert.equal((await s.call(path)).status, 401);   // 로그인 안 함
});

await test('계정 만들기: 입력 검사, 중복 거절, 임시 비밀번호는 한 번만 보이고 첫 로그인 때 바꿔야 한다', async () => {
  const s = await fresh(); const ck = await adminSession(s);
  const bad = (body) => s.call('/api/admin/users', { method: 'POST', cookie: ck, body });
  assert.equal((await bad({ username: 'ab', display_name: 'x', role: 'equip' })).status, 400);
  assert.equal((await bad({ username: 'okname', display_name: '', role: 'equip' })).status, 400);
  assert.equal((await bad({ username: 'okname', display_name: 'x', role: 'superuser' })).status, 400);
  assert.equal((await bad({ username: 'okname', display_name: 'x', role: 'branch' })).status, 400);     // 지사 이름 필요
  const u = await makeUser(s, ck, { username: 'branch1', display_name: '대관령지사', role: 'branch', branch: '대관령' });
  assert.equal(u.temp_password.length, 16); assert.ok(!/[0OIl1]/.test(u.temp_password));
  assert.equal((await bad({ username: 'BRANCH1', display_name: 'x', role: 'equip' })).status, 409);
  const l = await login(s, 'branch1', u.temp_password); assert.equal(l.json.user.must_change, true);
  const c = cookieOf(l);
  assert.equal((await s.call('/api/admin/users', { cookie: c })).status, 403);                       // 바꾸기 전엔 다른 기능 불가
  assert.equal((await s.call('/api/me', { cookie: c })).status, 200);
});

await test('비밀번호 변경: 현재 비밀번호 확인, 규칙, 다른 기기 로그인 종료, 바꾼 뒤 정상 사용', async () => {
  const s = await fresh(); const ck = await adminSession(s);
  const ck2 = cookieOf(await login(s, 'admin1', PW));              // 다른 기기
  const change = (cur, next) => s.call('/api/password', { method: 'POST', cookie: ck, body: { current: cur, next } });
  assert.equal((await change('wrong-current-pw', 'Another-Pass-123')).status, 401);
  assert.equal((await change(PW, 'short')).status, 400);
  assert.equal((await change(PW, 'myadmin1-password-xx')).status, 400);                  // 아이디 포함
  assert.equal((await change(PW, PW)).status, 400);                                      // 같은 비밀번호
  assert.equal((await change(PW, 'Another-Pass-123')).status, 200);
  assert.equal((await s.call('/api/me', { cookie: ck })).status, 200);                    // 지금 기기는 유지
  assert.equal((await s.call('/api/me', { cookie: ck2 })).status, 401);                   // 다른 기기는 종료
  assert.equal((await login(s, 'admin1', PW)).status, 401);
  assert.equal((await login(s, 'admin1', 'Another-Pass-123')).status, 200);
});

await test('비활성화·초기화: 즉시 로그아웃, 자기 자신·마지막 관리자는 막는다', async () => {
  const s = await fresh(); const ck = await adminSession(s);
  const u = await makeUser(s, ck, { username: 'equip1', display_name: '장비', role: 'equip' });
  const uid = s.env.DB.raw.prepare("SELECT id FROM users WHERE username='equip1'").get().id;
  const adminId = s.env.DB.raw.prepare("SELECT id FROM users WHERE username='admin1'").get().id;
  await s.call('/api/password', { method: 'POST', cookie: cookieOf(await login(s, 'equip1', u.temp_password)), body: { current: u.temp_password, next: 'Equip-Pass-12345' } });
  const uck = cookieOf(await login(s, 'equip1', 'Equip-Pass-12345'));
  assert.equal((await s.call('/api/me', { cookie: uck })).status, 200);
  assert.equal((await s.call(`/api/admin/users/${uid}/disable`, { method: 'POST', cookie: ck })).status, 200);
  assert.equal((await s.call('/api/me', { cookie: uck })).status, 401);
  assert.equal((await login(s, 'equip1', 'Equip-Pass-12345')).status, 401);
  assert.equal((await s.call(`/api/admin/users/${uid}/enable`, { method: 'POST', cookie: ck })).status, 200);
  assert.equal((await login(s, 'equip1', 'Equip-Pass-12345')).status, 200);
  assert.equal((await s.call(`/api/admin/users/${adminId}/disable`, { method: 'POST', cookie: ck })).json.error, 'self');
  const second = await makeUser(s, ck, { username: 'admin2', display_name: '관리자2', role: 'admin' });
  const sid = s.env.DB.raw.prepare("SELECT id FROM users WHERE username='admin2'").get().id;
  const ck2 = cookieOf(await login(s, 'admin2', second.temp_password));
  await s.call('/api/password', { method: 'POST', cookie: ck2, body: { current: second.temp_password, next: 'Second-Pass-Word-1' } });
  const ck2b = cookieOf(await login(s, 'admin2', 'Second-Pass-Word-1'));
  assert.equal((await s.call(`/api/admin/users/${adminId}/disable`, { method: 'POST', cookie: ck2b })).status, 200);       // 관리자 2명이면 한 명은 가능
  assert.equal((await s.call(`/api/admin/users/${sid}/disable`, { method: 'POST', cookie: ck2b })).json.error, 'self');
  assert.equal((await s.call('/api/admin/users/nonexistent/reset', { method: 'POST', cookie: ck2b })).status, 404);
});

await test('접속 기록: 누가·언제·무엇을·IP가 남고, 목록은 관리자만 보며 걸러 볼 수 있다', async () => {
  const s = await fresh(); const ck = await adminSession(s);
  await login(s, 'ghost', 'x'.repeat(14), { ip: '198.51.100.9' });
  const a = await s.call('/api/admin/audit?limit=50', { cookie: ck });
  assert.equal(a.status, 200);
  const kinds = a.json.rows.map((r) => r.kind); for (const k of ['계정생성', '접속', '접속실패']) assert.ok(kinds.includes(k), k);
  const fail1 = a.json.rows.find((r) => r.kind === '접속실패'); assert.equal(fail1.ip, '198.51.100.9'); assert.equal(fail1.username, 'ghost'); assert.ok(Date.parse(fail1.at));
  assert.ok(a.json.rows[0].id > a.json.rows[a.json.rows.length - 1].id);                    // 최신순
  assert.equal((await s.call('/api/admin/audit?kind=' + encodeURIComponent('접속실패'), { cookie: ck })).json.rows.every((r) => r.kind === '접속실패'), true);
  assert.equal((await s.call('/api/admin/audit?limit=1', { cookie: ck })).json.rows.length, 1);
  // 고치거나 지우는 길이 없음
  for (const m of ['PUT', 'DELETE', 'PATCH']) assert.equal((await s.call('/api/admin/audit', { method: m, cookie: ck })).status, 404);
});

await test('(선택) 접속 기록 보호 규칙: 트리거를 적용하면 DB가 수정·삭제를 거부한다', async () => {
  const s = await fresh(); await bootstrap(s);
  const { readFileSync } = await import('node:fs');
  s.env.DB.raw.exec(readFileSync(new URL('../cloudflare/schema_append_only.sql', import.meta.url), 'utf8'));
  assert.throws(() => s.env.DB.raw.exec("UPDATE audit_log SET username='x'"), /append-only/);
  assert.throws(() => s.env.DB.raw.exec('DELETE FROM audit_log'), /append-only/);
  assert.equal((await login(s, 'admin1', PW)).status, 200);          // 추가는 계속 가능
});

await test('상태 확인: DB가 되면 ok, 안 되면 503 (내용 노출 없음)', async () => {
  const s = await fresh();
  assert.deepEqual((await s.call('/api/health')).json, { ok: true });
  s.env.DB = { prepare() { throw new Error('boom'); } };
  const r = await s.call('/api/health'); assert.equal(r.status, 503); assert.ok(!r.text.includes('boom'));
});

await test('응답 헤더: 캐시 금지, 형식 고정', async () => {
  const s = await fresh(); const r = await s.call('/api/setup');
  assert.equal(r.headers.get('Cache-Control'), 'no-store'); assert.equal(r.headers.get('X-Content-Type-Options'), 'nosniff');
});

/* ---------- 기상청 수집 시험 Worker ---------- */
const probeEnv = (extra = {}) => ({ DB: null, KMA_PROBE_URL: 'https://apihub.kma.go.kr/api/typ01/url/x.php?tmfc=0&authKey={KEY}', KMA_KEY: 'SUPER-SECRET-KEY', ...extra });
const lastRun = (db) => db.raw.prepare('SELECT * FROM collector_runs ORDER BY id DESC LIMIT 1').get();

await test('수집 시험: 성공하면 상태·소요시간·응답 앞부분을 기록하고, 인증키는 어디에도 남기지 않는다', async () => {
  const db = (await fresh()).env.DB;
  let seen;
  const r = await runProbe(probeEnv({ DB: db }), 'cron', async (url) => { seen = url; return new Response('REG_ID,TM_ST\nL1010000,2026... key=SUPER-SECRET-KEY', { status: 200 }); });
  assert.ok(seen.includes('authKey=SUPER-SECRET-KEY'));                  // 실제 호출에는 키가 들어감
  assert.equal(r.ok, 1);
  const row = lastRun(db);
  assert.equal(row.http_status, 200); assert.equal(row.source, 'cron'); assert.ok(row.ms >= 0 && row.bytes > 10);
  assert.ok(!JSON.stringify(row).includes('SUPER-SECRET-KEY'), '인증키가 기록에 남음'); assert.ok(row.url_masked.includes('authKey=***'));
  assert.ok(row.snippet.startsWith('REG_ID'));
});

await test('수집 시험: 오류·접속 불가·설정 누락도 기록되고 오류 문구에서도 키가 가려진다', async () => {
  const db = (await fresh()).env.DB;
  await runProbe(probeEnv({ DB: db }), 'cron', async () => new Response('denied', { status: 403 }));
  let row = lastRun(db); assert.equal(row.ok, 0); assert.equal(row.http_status, 403); assert.equal(row.error, 'HTTP 403');
  await runProbe(probeEnv({ DB: db }), 'manual', async () => { throw new Error('connect timeout to https://x?authKey=SUPER-SECRET-KEY'); });
  row = lastRun(db); assert.equal(row.ok, 0); assert.equal(row.source, 'manual'); assert.ok(row.error.includes('timeout') && !row.error.includes('SUPER-SECRET-KEY'));
  await runProbe(probeEnv({ DB: db, KMA_KEY: '' }), 'cron', async () => new Response('x'));
  assert.ok(lastRun(db).error.includes('KMA_KEY'));
  await runProbe(probeEnv({ DB: db, KMA_PROBE_URL: '' }), 'cron', async () => new Response('x'));
  assert.ok(lastRun(db).error.includes('KMA_PROBE_URL'));
  assert.equal(maskUrl('https://a/b?serviceKey=AbC%2B&x=1'), 'https://a/b?serviceKey=***&x=1');
});

await test('수집 상태: 관리자만 /api/admin/collector 로 최근 기록을 본다', async () => {
  const s = await fresh(); const ck = await adminSession(s);
  await runProbe(probeEnv({ DB: s.env.DB }), 'cron', async () => new Response('ok', { status: 200 }));
  const r = await s.call('/api/admin/collector', { cookie: ck });
  assert.equal(r.status, 200); assert.equal(r.json.runs.length, 1); assert.equal(r.json.runs[0].ok, 1);
  assert.ok(!r.text.includes('SUPER-SECRET-KEY'));
  assert.equal((await s.call('/api/admin/collector')).status, 401);
});

const ok = results.filter((r) => r[1]).length;
results.forEach((r) => console.log((r[1] ? 'PASS ' : 'FAIL ') + r[0] + (r[1] ? '' : '  → ' + r[2])));
console.log('\n' + ok + '/' + results.length + ' 통과');
process.exit(ok === results.length ? 0 : 1);
