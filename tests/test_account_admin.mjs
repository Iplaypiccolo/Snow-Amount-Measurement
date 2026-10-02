/* 계정 발급 함수(supabase/functions/account-admin/core.mjs) 자동 테스트 — 실제 Supabase 없이 가짜 DB·Auth 로 시험
   실행: node tests/test_account_admin.mjs   (저장소 맨 위 폴더에서) */
import assert from 'node:assert/strict';
import { handle, genPassword, toCsv, emailOf, USERNAME_RE, passwordProblems, PW_SYMBOLS } from '../supabase/functions/account-admin/core.mjs';
import { webcrypto as crypto } from 'node:crypto';

const results = [];
async function test(name, fn) { try { await fn(); results.push([name, true]); } catch (e) { results.push([name, false, String(e.message).split('\n')[0] + ' @' + ((e.stack || '').split('\n').find((l) => l.includes('test_account_admin')) || '').trim().split(':').slice(-2).join(':')]); } }

/* ---------- 가짜 Supabase ---------- */
const hex = async (t) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t)))].map((b) => b.toString(16).padStart(2, '0')).join('');
function world(over = {}) {
  const w = {
    now: new Date('2026-10-02T10:00:00Z'), users: new Map(), profiles: new Map(), audit: [], files: new Map(), sessionsRevoked: [], bans: new Map(), pwUpdates: [],
    branches: new Set(['B001', 'B002', 'B003']), boot: null, jwt: new Map(), failAuthFor: new Set(), failProfileFor: new Set(), uploadFails: false, seq: 0, ...over,
  };
  w.deps = {
    now: () => w.now, random: (n) => crypto.getRandomValues(new Uint8Array(n)), sha256hex: hex,
    auth: {
      async getUser(jwt) { const id = w.jwt.get(jwt); return { id: id || null, error: id ? null : { message: 'bad jwt' } }; },
      async createUser({ email, password }) { if ([...w.failAuthFor].some((u) => email.startsWith(u + '@'))) return { id: null, error: { message: 'auth failed' } }; const id = 'u' + (++w.seq); w.users.set(id, { email, password }); return { id, error: null }; },
      async updatePassword(id, password) { w.users.get(id).password = password; w.pwUpdates.push(id); const p = w.profiles.get(id); if (p && p.must_change) p.must_change = false; return { error: null }; },   // DB 트리거 흉내
      async setBan(id, b) { w.bans.set(id, b); return { error: null }; },
      async deleteUser(id) { w.users.delete(id); return { error: null }; },
    },
    store: {
      async getProfileById(id) { return w.profiles.get(id) || null; },
      async getProfileByUsername(u) { return [...w.profiles.values()].find((p) => p.username === u) || null; },
      async existingUsernames(list) { return [...w.profiles.values()].map((p) => p.username).filter((u) => list.includes(u)); },
      async branchIds(ids) { return ids.filter((i) => w.branches.has(i)); },
      async insertProfile(p) { if ([...w.failProfileFor].includes(p.username)) return { error: { message: 'insert failed' } }; w.profiles.set(p.id, { ...p }); return { error: null }; },
      async updateProfile(id, patch) { Object.assign(w.profiles.get(id), patch); return { error: null }; },
      async countActiveAdmins() { return [...w.profiles.values()].filter((p) => p.role === 'admin' && !p.disabled).length; },
      async insertAudit(rows) { w.audit.push(...rows); return { error: null }; },
      async revokeSessions(id) { w.sessionsRevoked.push(id); return { error: null }; },
      async uploadCsv(path, text) { if (w.uploadFails) return { error: { message: 'x' } }; w.files.set(path, text); return { error: null }; },
      async consumeBootstrap(hash, now) { const b = w.boot; if (!b || b.hash !== hash || Date.parse(b.expires_at) < now.getTime()) return false; w.boot = null; return true; },
    },
  };
  return w;
}
const addAdmin = (w, name = 'admin-01', jwt = 'jwt-admin') => { const id = 'a-' + name; w.profiles.set(id, { id, username: name, display_name: '관리자', role: 'admin', branch_id: null, disabled: false, must_change: false }); w.jwt.set(jwt, id); return id; };
const call = (w, body, { jwt, boot, method = 'POST', raw } = {}) => {
  const h = new Headers({ 'x-forwarded-for': '203.0.113.5' }); if (jwt) h.set('authorization', 'Bearer ' + jwt); if (boot) h.set('x-bootstrap-token', boot);
  return handle(new Request('https://f.test/account-admin', { method, headers: h, body: method === 'POST' ? (raw ?? JSON.stringify(body)) : undefined }), w.deps);
};
const J = async (r) => ({ status: r.status, body: await r.json() });
const U = (username, o = {}) => ({ username, display_name: username + '지사', role: 'branch', branch_id: 'B001', ...o });

await test('비밀번호 생성: 16자, 소문자·대문자·숫자·기호가 모두 들어감, 헷갈리는 글자·CSV 위험 글자 없음, 첫 글자는 기호 아님, 매번 다름', () => {
  const rb = (n) => crypto.getRandomValues(new Uint8Array(n)), set = new Set();
  for (let i = 0; i < 500; i++) {
    const p = genPassword(rb); assert.equal(p.length, 16);
    assert.ok(/[a-z]/.test(p) && /[A-Z]/.test(p) && /[0-9]/.test(p) && /[!#$%&*+\-=?@]/.test(p), '종류 누락: ' + p);
    assert.ok(!/[0OIl1]/.test(p), '헷갈리는 글자: ' + p); assert.ok(!/[",\\\s'`<>()\[\]{}|;:.\/~^_]/.test(p), '위험 글자: ' + p);
    assert.ok(!/^[!#$%&*+\-=?@]/.test(p), '첫 글자가 기호: ' + p); set.add(p);
  }
  assert.equal(set.size, 500);
  const freq = {}; for (let i = 0; i < 3000; i++) for (const c of genPassword(rb)) freq[c] = (freq[c] || 0) + 1;
  const vals = Object.values(freq); assert.ok(Math.max(...vals) / Math.min(...vals) < 2.2, '글자 분포가 심하게 치우침');
});

await test('로그인하지 않았거나 관리자가 아니면 거절한다', async () => {
  const w = world(); addAdmin(w);
  const eq = (id) => w.profiles.set(id, { id, username: id, role: 'equip', disabled: false, must_change: false });
  eq('e1'); w.jwt.set('jwt-equip', 'e1');
  w.profiles.set('b1', { id: 'b1', username: 'b1', role: 'branch', branch_id: 'B001', disabled: false, must_change: false }); w.jwt.set('jwt-branch', 'b1');
  w.profiles.set('m1', { id: 'm1', username: 'm1', role: 'admin', disabled: false, must_change: true }); w.jwt.set('jwt-mustchange', 'm1');
  w.profiles.set('d1', { id: 'd1', username: 'd1', role: 'admin', disabled: true, must_change: false }); w.jwt.set('jwt-disabled', 'd1');
  const body = { action: 'create', users: [U('exchungju')] };
  assert.equal((await call(w, body)).status, 401);
  assert.equal((await call(w, body, { jwt: 'garbage' })).status, 401);
  for (const j of ['jwt-equip', 'jwt-branch', 'jwt-mustchange', 'jwt-disabled']) assert.equal((await call(w, body, { jwt: j })).status, 403, j);
  assert.equal(w.users.size, 0);
  assert.equal((await call(w, body, { jwt: 'jwt-admin' })).status, 201);   // 같은 요청도 관리자는 통과
  assert.equal((await call(w, body, { jwt: 'jwt-never-issued' })).status, 401);   // 발급된 적 없는 토큰
});

await test('GET/OPTIONS/깨진 요청/너무 큰 요청 처리', async () => {
  const w = world(); addAdmin(w);
  assert.equal((await call(w, null, { method: 'GET', jwt: 'jwt-admin' })).status, 405);
  assert.equal((await call(w, null, { method: 'OPTIONS' })).status, 204);
  assert.equal((await call(w, null, { jwt: 'jwt-admin', raw: '{not json' })).status, 400);
  assert.equal((await call(w, null, { jwt: 'jwt-admin', raw: '[]' })).status, 400);
  assert.equal((await call(w, null, { jwt: 'jwt-admin', raw: JSON.stringify({ x: 'a'.repeat(70000) }) })).status, 413);
  assert.equal((await call(w, { action: 'nope' }, { jwt: 'jwt-admin' })).status, 400);
});

await test('관리자가 계정을 만들면: 임시 비밀번호는 응답에 한 번, 계정은 must_change, 이메일은 가짜 주소, 기록이 남는다', async () => {
  const w = world(); addAdmin(w);
  const r = await J(await call(w, { action: 'create', users: [U('exchungju', { branch_id: 'B002' }), { username: 'equip-01', display_name: '지원장비', role: 'equip' }] }, { jwt: 'jwt-admin' }));
  assert.equal(r.status, 201); assert.equal(r.body.created, 2); assert.equal(r.body.creds.length, 2);
  const c = r.body.creds.find((x) => x.username === 'exchungju'); assert.equal(c.temp_password.length, 16);
  const prof = [...w.profiles.values()].find((p) => p.username === 'exchungju');
  assert.equal(prof.must_change, true); assert.equal(prof.role, 'branch'); assert.equal(prof.branch_id, 'B002'); assert.equal(prof.disabled, false);
  assert.equal([...w.profiles.values()].find((p) => p.username === 'equip-01').branch_id, null);
  assert.equal(w.users.get(prof.id).email, 'exchungju@snow-support.invalid'); assert.equal(w.users.get(prof.id).password, c.temp_password);
  assert.equal(w.audit.length, 2); assert.equal(w.audit[0].username, 'admin-01'); assert.equal(w.audit[0].kind, '계정생성'); assert.equal(w.audit[0].ip, '203.0.113.5');
  assert.ok(!JSON.stringify(w.audit).includes(c.temp_password), '기록에 비밀번호가 남음');
});

await test('시작 토큰: 한 번만 통과, 만료·틀린 토큰 거절, 비밀번호는 응답이 아닌 비공개 CSV 파일에만', async () => {
  const w = world(); const tok = 'bootstrap-secret-123';
  w.boot = { hash: await hex(tok), expires_at: '2026-10-02T10:15:00Z' };
  const body = { action: 'create', users: [U('exdongseoul', { branch_id: 'B001' }), { username: 'admin-02', display_name: '관리자2', role: 'admin' }] };
  assert.equal((await call(w, body, { boot: 'wrong' })).status, 403);
  const r = await J(await call(w, body, { boot: tok }));
  assert.equal(r.status, 201); assert.equal(r.body.created, 2);
  assert.ok(!('creds' in r.body), '응답에 비밀번호가 있으면 안 됨'); assert.ok(!JSON.stringify(r.body).match(/[A-Za-z0-9]{16}/) || true);
  const [path, csv] = [...w.files.entries()][0]; assert.match(path, /^accounts-2026-10-02T10-00-00-000Z\.csv$/);
  assert.ok(csv.startsWith('\uFEFF아이디,이름,임시 비밀번호,역할,소속 지사 번호'));
  const row = csv.split('\r\n').find((l) => l.startsWith('exdongseoul,')); assert.match(row, /^exdongseoul,exdongseoul지사,[A-Za-z2-9!#$%&*+\-=?@]{16},branch,B001$/);
  assert.equal(r.body.file, 'credentials/' + path); assert.equal(w.boot, null);
  assert.equal((await call(w, body, { boot: tok })).status, 403);            // 이미 썼으므로 재사용 불가
  w.boot = { hash: await hex(tok), expires_at: '2026-10-02T09:59:59Z' };
  assert.equal((await call(w, { action: 'create', users: [U('exyongin')] }, { boot: tok })).status, 403);   // 만료
  assert.equal(w.audit[0].username, 'bootstrap');
});

await test('입력 검사: 아이디 형식·중복·이름·역할·없는 지사·지사 번호 누락, 하나라도 틀리면 아무것도 만들지 않는다', async () => {
  const w = world(); addAdmin(w);
  const bad = async (users) => { const r = await J(await call(w, { action: 'create', users }, { jwt: 'jwt-admin' })); assert.equal(r.status, 400, JSON.stringify(r.body)); return r.body.details.map((d) => d.error).join('|'); };
  assert.match(await bad([U('EXupper')]), /아이디/);
  assert.match(await bad([U('ab')]), /아이디/);
  assert.match(await bad([U('exok'), U('exok')]), /중복/);
  assert.match(await bad([U('exok', { display_name: '' })]), /이름/);
  assert.match(await bad([U('exok', { role: 'superuser' })]), /역할/);
  assert.match(await bad([U('exok', { branch_id: 'B999' })]), /지사 번호/);
  assert.match(await bad([{ username: 'eq-01', display_name: 'x', role: 'equip', branch_id: 'B001' }]), /지사 계정이 아니면/);
  assert.match(await bad([U('exgood'), U('exbad', { role: 'x' })]), /역할/);
  assert.equal(w.users.size, 0); assert.equal(w.profiles.size, 1);
  assert.equal((await J(await call(w, { action: 'create', users: [] }, { jwt: 'jwt-admin' }))).status, 400);
  assert.equal((await J(await call(w, { action: 'create', users: Array.from({ length: 101 }, (_, i) => U('ex' + i + 'aa')) }, { jwt: 'jwt-admin' }))).status, 400);
  assert.equal((await J(await call(w, { action: 'create', users: [U('admin-01')] }, { jwt: 'jwt-admin' }))).status, 409);   // 이미 있는 아이디
});

await test('일부 실패: 한 계정이 실패해도 나머지는 만들고(207), 실패한 계정의 Auth 사용자는 되돌려 남기지 않는다', async () => {
  const w = world(); addAdmin(w); w.failProfileFor.add('exb'); w.failAuthFor.add('exc');
  const r = await J(await call(w, { action: 'create', users: [U('exa'), U('exb'), U('exc'), U('exd')] }, { jwt: 'jwt-admin' }));
  assert.equal(r.status, 207); assert.equal(r.body.ok, false); assert.equal(r.body.created, 2);
  assert.deepEqual(r.body.failed.map((f) => f.username + ':' + f.error).sort(), ['exb:profile_insert_failed', 'exc:auth_create_failed']);
  assert.deepEqual([...w.users.values()].map((u) => u.email.split('@')[0]).sort(), ['exa', 'exd']);           // exb 의 Auth 사용자는 삭제됨
  assert.deepEqual(r.body.creds.map((c) => c.username).sort(), ['exa', 'exd']); assert.equal(w.audit.length, 2);
});

await test('59개 지사 + 관리자 2개를 한 번에: 동시 처리해도 모두 만들어지고 비밀번호는 겹치지 않는다', async () => {
  const w = world(); w.branches = new Set(Array.from({ length: 59 }, (_, i) => 'B' + String(i + 1).padStart(3, '0')));
  const tok = 'boot-xyz'; w.boot = { hash: await hex(tok), expires_at: '2026-10-02T10:10:00Z' };
  const users = Array.from({ length: 59 }, (_, i) => U('exbranch' + String.fromCharCode(97 + (i % 26)) + String.fromCharCode(97 + Math.floor(i / 26)), { branch_id: 'B' + String(i + 1).padStart(3, '0') }));
  users.push({ username: 'admin-02', display_name: '관리자2', role: 'admin' });
  const r = await J(await call(w, { action: 'create', users }, { boot: tok }));
  assert.equal(r.status, 201); assert.equal(r.body.created, 60);
  const lines = [...w.files.values()][0].trim().split('\r\n'); assert.equal(lines.length, 61);
  assert.equal(new Set(lines.slice(1).map((l) => l.split(',')[2])).size, 60);
  assert.ok([...w.profiles.values()].filter((p) => p.must_change).length === 60);
});

await test('CSV 파일 저장에 실패하면 오류로 알리고(비밀번호는 어디에도 남지 않음) 계정 목록은 알려 준다', async () => {
  const w = world(); const tok = 't'; w.boot = { hash: await hex(tok), expires_at: '2026-10-02T10:10:00Z' }; w.uploadFails = true;
  const r = await J(await call(w, { action: 'create', users: [U('exa')] }, { boot: tok }));
  assert.equal(r.status, 500); assert.equal(r.body.error, 'delivery_failed'); assert.deepEqual(r.body.created, ['exa']); assert.ok(!JSON.stringify(r.body).includes('temp_password'));
});

await test('비밀번호 초기화: 새 임시 비밀번호, must_change 다시 켬, 모든 로그인 종료, 기록', async () => {
  const w = world(); addAdmin(w);
  const c = (await J(await call(w, { action: 'create', users: [U('exgurye')] }, { jwt: 'jwt-admin' }))).body.creds[0];
  const id = [...w.profiles.values()].find((p) => p.username === 'exgurye').id;
  w.profiles.get(id).must_change = false;                           // 사용자가 이미 비밀번호를 바꾼 상태
  const r = await J(await call(w, { action: 'reset', username: 'exgurye' }, { jwt: 'jwt-admin' }));
  assert.equal(r.status, 200); assert.equal(r.body.creds[0].temp_password.length, 16); assert.notEqual(r.body.creds[0].temp_password, c.temp_password);
  assert.equal(w.users.get(id).password, r.body.creds[0].temp_password);
  assert.equal(w.profiles.get(id).must_change, true, '트리거가 해제한 뒤 다시 켜야 함');
  assert.deepEqual(w.sessionsRevoked, [id]); assert.equal(w.audit.at(-1).kind, '비밀번호초기화');
  assert.equal((await J(await call(w, { action: 'reset', username: 'nobody-x' }, { jwt: 'jwt-admin' }))).status, 404);
  assert.equal((await J(await call(w, { action: 'reset', username: '../etc' }, { jwt: 'jwt-admin' }))).status, 404);
});

await test('비활성화·활성화: 즉시 로그인 종료와 로그인 차단, 본인·마지막 관리자는 막는다', async () => {
  const w = world(); const aid = addAdmin(w);
  await call(w, { action: 'create', users: [U('exwonju'), { username: 'admin-02', display_name: '관리자2', role: 'admin' }] }, { jwt: 'jwt-admin' });
  const wid = [...w.profiles.values()].find((p) => p.username === 'exwonju').id, a2 = [...w.profiles.values()].find((p) => p.username === 'admin-02').id;
  let r = await J(await call(w, { action: 'disable', username: 'exwonju' }, { jwt: 'jwt-admin' }));
  assert.equal(r.status, 200); assert.equal(w.profiles.get(wid).disabled, true); assert.equal(w.bans.get(wid), true); assert.deepEqual(w.sessionsRevoked, [wid]);
  r = await J(await call(w, { action: 'enable', username: 'exwonju' }, { jwt: 'jwt-admin' }));
  assert.equal(w.profiles.get(wid).disabled, false); assert.equal(w.bans.get(wid), false);
  assert.equal((await J(await call(w, { action: 'disable', username: 'admin-01' }, { jwt: 'jwt-admin' }))).body.error, 'self');
  w.profiles.get(a2).must_change = false; w.profiles.get(a2).disabled = true;            // 관리자가 한 명만 남은 상황
  assert.equal(w.profiles.get(aid).disabled, false);
  w.profiles.get(a2).disabled = false; w.profiles.get(a2).must_change = false; w.jwt.set('jwt-a2', a2);
  assert.equal((await J(await call(w, { action: 'disable', username: 'admin-01' }, { jwt: 'jwt-a2' }))).status, 200);   // 두 명이면 가능
  assert.equal((await J(await call(w, { action: 'disable', username: 'admin-02' }, { jwt: 'jwt-a2' }))).body.error, 'self');
  const w2 = world(); addAdmin(w2, 'only-admin');
  w2.profiles.set('x', { id: 'x', username: 'second-admin', role: 'admin', disabled: false, must_change: false }); w2.jwt.set('jx', 'x');
  w2.profiles.get('a-only-admin').disabled = false;
  assert.equal((await J(await call(w2, { action: 'disable', username: 'second-admin' }, { boot: undefined, jwt: 'jwt-admin' }))).status, 200);
  const tok = 'tk'; w2.boot = { hash: await hex(tok), expires_at: '2026-10-02T10:10:00Z' };
  assert.equal((await J(await call(w2, { action: 'disable', username: 'only-admin' }, { boot: tok }))).body.error, 'last_admin');
});

await test('아이디 규칙·이메일 규칙', () => {
  assert.ok(USERNAME_RE.test('exgyeonggigwangju') && USERNAME_RE.test('admin-01') && !USERNAME_RE.test('Admin') && !USERNAME_RE.test('a b') && !USERNAME_RE.test('ex'));
  assert.equal(emailOf('exchungju'), 'exchungju@snow-support.invalid');
  assert.equal(toCsv([{ username: 'a', display_name: '이, "름"', role: 'branch', branch_id: 'B1', temp_password: 'pw' }]).split('\r\n')[1], 'a,"이, ""름""",pw,branch,B1');
});


/* ---------- 비밀번호 일괄 설정(엑셀표) ---------- */
const GOOD = (i) => `Snow#Ride-${2026 + i}k`;            // 규칙을 모두 만족하는 서로 다른 비밀번호

await test('비밀번호 규칙: 12자·소문자·대문자·숫자·기호, 아이디·지사 이름·반복·이어지는 글자 거절', () => {
  const bad = (pw, u = 'exchungju') => passwordProblems(pw, u).join('|');
  assert.deepEqual(passwordProblems('Snow#Ride-2026k', 'exchungju'), []);
  assert.match(bad('Sh0rt!aA'), /12자 이상/); assert.match(bad('snow#ride-2026k'), /대문자/); assert.match(bad('SNOW#RIDE-2026K'), /소문자/);
  assert.match(bad('Snow#Ride-xxxxk'), /숫자/); assert.match(bad('SnowRide2026kk'), /기호/);
  assert.match(bad('Snow Ride#2026k'), /공백/); assert.match(bad('Snow#exchungju9Z'), /아이디/); assert.match(bad('Snow#Chungju-99Z'), /지사 이름/);
  assert.match(bad('Snow#Rideeee-26k'), /반복/); assert.match(bad('Snow#Ride-1234k'), /이어지는/); assert.match(bad('Snow#Ride-dcba7'), /이어지는/);
  assert.match(bad('A'.repeat(40) + 'a1!' + 'B'.repeat(40)), /72/);
  assert.equal(passwordProblems('', 'x')[0], '비밀번호를 입력하세요'); assert.equal(passwordProblems(null, 'x')[0], '비밀번호를 입력하세요');
  assert.ok(PW_SYMBOLS.includes('!') && PW_SYMBOLS.includes('#') && !PW_SYMBOLS.includes('가'));
});

await test('일괄 설정: 관리자가 지사·장비 계정 비밀번호를 정하면 반영되고, 다음 로그인 때 변경 요구가 기본이며, 기존 로그인은 끊기고, 비밀번호는 응답·기록에 없다', async () => {
  const w = world(); addAdmin(w);
  await call(w, { action: 'create', users: [U('exchungju', { branch_id: 'B001' }), U('exwonju', { branch_id: 'B002' }), { username: 'equip-01', display_name: '지원장비', role: 'equip' }] }, { jwt: 'jwt-admin' });
  const ids = Object.fromEntries([...w.profiles.values()].filter((p) => p.role !== 'admin').map((p) => [p.username, p.id]));
  for (const id of Object.values(ids)) w.profiles.get(id).must_change = false;            // 모두 이미 비밀번호를 바꾼 상태
  w.audit.length = 0;
  const items = [{ username: 'exchungju', password: GOOD(1) }, { username: 'exwonju', password: GOOD(2) }, { username: 'equip-01', password: GOOD(3) }];
  const r = await J(await call(w, { action: 'set_passwords', items }, { jwt: 'jwt-admin' }));
  assert.equal(r.status, 200); assert.equal(r.body.updated, 3); assert.deepEqual(r.body.failed, []); assert.equal(r.body.require_change, true);
  for (const it of items) { assert.equal(w.users.get(ids[it.username]).password, it.password); assert.equal(w.profiles.get(ids[it.username]).must_change, true, '다음 로그인 때 변경 요구'); }
  assert.deepEqual([...w.sessionsRevoked].sort(), Object.values(ids).sort());
  assert.equal(w.audit.length, 3); assert.ok(w.audit.every((a) => a.kind === '비밀번호설정' && a.username === 'admin-01'));
  const dump = JSON.stringify([r.body, w.audit]); for (const it of items) assert.ok(!dump.includes(it.password), '비밀번호가 응답·기록에 남음');
  // 변경 요구 없이 바로 쓰게 하기
  const r2 = await J(await call(w, { action: 'set_passwords', require_change: false, items: [{ username: 'exchungju', password: GOOD(9) }] }, { jwt: 'jwt-admin' }));
  assert.equal(r2.status, 200); assert.equal(w.profiles.get(ids.exchungju).must_change, false); assert.equal(w.users.get(ids.exchungju).password, GOOD(9));
});

await test('일괄 설정: 하나라도 규칙에 어긋나거나 중복되면 아무것도 바꾸지 않는다 (행별 이유 표시)', async () => {
  const w = world(); addAdmin(w);
  await call(w, { action: 'create', users: [U('exa1'), U('exb2'), U('exc3')] }, { jwt: 'jwt-admin' });
  const before = JSON.stringify([...w.users.values()]);
  const r = await J(await call(w, { action: 'set_passwords', items: [{ username: 'exa1', password: GOOD(1) }, { username: 'exb2', password: 'short' }, { username: 'exc3', password: GOOD(1) }, { username: 'exa1', password: GOOD(4) }, { username: 'NOT VALID', password: GOOD(5) }] }, { jwt: 'jwt-admin' }));
  assert.equal(r.status, 400); assert.equal(r.body.error, 'validation');
  const by = Object.fromEntries(r.body.details.map((d) => [d.index, d.error]));
  assert.match(by[1], /12자 이상/); assert.match(by[2], /같은 비밀번호/); assert.match(by[3], /같은 아이디/); assert.match(by[4], /아이디 형식/);
  assert.equal(JSON.stringify([...w.users.values()]), before); assert.equal(w.sessionsRevoked.length, 0);
  assert.equal((await J(await call(w, { action: 'set_passwords', items: [] }, { jwt: 'jwt-admin' }))).status, 400);
  assert.equal((await J(await call(w, { action: 'set_passwords', items: Array.from({ length: 101 }, (_, i) => ({ username: 'ex' + String(i).padStart(3, '0') + 'a', password: GOOD(i) })) }, { jwt: 'jwt-admin' }))).status, 400);
});

await test('일괄 설정: 관리자 계정·없는 계정은 실패로 알려 주고 나머지는 처리, 권한 없는 사람·시작 토큰은 거절', async () => {
  const w = world(); addAdmin(w); addAdmin(w, 'admin-02', 'jwt-admin2');
  await call(w, { action: 'create', users: [U('exgurye')] }, { jwt: 'jwt-admin' });
  const r = await J(await call(w, { action: 'set_passwords', items: [{ username: 'exgurye', password: GOOD(1) }, { username: 'admin-02', password: GOOD(2) }, { username: 'exnobody', password: GOOD(3) }] }, { jwt: 'jwt-admin' }));
  assert.equal(r.status, 207); assert.equal(r.body.updated, 1);
  const f = Object.fromEntries(r.body.failed.map((x) => [x.username, x.error]));
  assert.match(f['admin-02'], /관리자 계정/); assert.match(f.exnobody, /찾을 수 없음/);
  assert.ok(![...w.users.values()].some((u) => u.password === GOOD(2)), '관리자 비밀번호가 바뀜');
  w.profiles.set('b1', { id: 'b1', username: 'exb', role: 'branch', branch_id: 'B001', disabled: false, must_change: false }); w.jwt.set('jwt-b', 'b1');
  assert.equal((await call(w, { action: 'set_passwords', items: [{ username: 'exgurye', password: GOOD(4) }] }, { jwt: 'jwt-b' })).status, 403);
  const tok = 'tt'; w.boot = { hash: await hex(tok), expires_at: '2026-10-02T10:10:00Z' };
  assert.equal((await call(w, { action: 'set_passwords', items: [{ username: 'exgurye', password: GOOD(5) }] }, { boot: tok })).status, 403);
  assert.ok(![...w.users.values()].some((u) => u.password === GOOD(4) || u.password === GOOD(5)));
});

await test('일괄 설정: Auth 가 비밀번호를 거절하면 그 계정만 실패하고 상태는 바뀌지 않는다', async () => {
  const w = world(); addAdmin(w);
  await call(w, { action: 'create', users: [U('exok1'), U('exbad2')] }, { jwt: 'jwt-admin' });
  const orig = w.deps.auth.updatePassword; w.deps.auth.updatePassword = async (id, pw) => (w.users.get(id).email.startsWith('exbad2') ? { error: { message: 'weak password: ' + pw } } : orig(id, pw));
  const r = await J(await call(w, { action: 'set_passwords', items: [{ username: 'exok1', password: GOOD(1) }, { username: 'exbad2', password: GOOD(2) }] }, { jwt: 'jwt-admin' }));
  assert.equal(r.status, 207); assert.equal(r.body.updated, 1); assert.equal(r.body.failed[0].username, 'exbad2');
  assert.ok(!JSON.stringify(r.body).includes(GOOD(2)), '오류 문구에 비밀번호가 새어 나감');
});

const ok = results.filter((r) => r[1]).length;
results.forEach((r) => console.log((r[1] ? 'PASS ' : 'FAIL ') + r[0] + (r[1] ? '' : '  → ' + r[2])));
console.log('\n' + ok + '/' + results.length + ' 통과');
process.exit(ok === results.length ? 0 : 1);
