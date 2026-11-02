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
    branches: new Set(['B001', 'B002', 'B003']), orgs: new Set(['서울경기', '충북', '전북', '대구경북']), hqs: new Set(['H01', 'H02']), boot: null, jwt: new Map(), failAuthFor: new Set(), failProfileFor: new Set(), uploadFails: false, seq: 0, ...over,
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
      async orgNames(names) { return names.filter((i) => w.orgs.has(i)); },
      async hqIds(ids) { return ids.filter((i) => w.hqs.has(i)); },
      async permissions() { return PERMS; },
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
const PERMS = [
  { key: 'juris.request', default_roles: ['branch'] }, { key: 'juris.edit', default_roles: [] }, { key: 'grid.edit', default_roles: [] },
  { key: 'req.edit.own', default_roles: ['branch'] }, { key: 'req.edit.hq', default_roles: ['hq'] }, { key: 'req.confirm', default_roles: [] },
  { key: 'equip.edit.own', default_roles: ['equip'] }, { key: 'equip.edit.all', default_roles: [] }, { key: 'log.view', default_roles: [] },
];
const EQ = (username, o = {}) => ({ username, display_name: '지원장비', role: 'equip', org: '서울경기', ...o });
const addAdmin = (w, name = 'admin-01', jwt = 'jwt-admin') => { const id = 'a-' + name; w.profiles.set(id, { id, username: name, display_name: '관리자', role: 'admin', branch_id: null, disabled: false, must_change: false }); w.jwt.set(jwt, id); return id; };
const call = (w, body, { jwt, boot, method = 'POST', raw } = {}) => {
  const h = new Headers({ 'x-forwarded-for': '203.0.113.5' }); if (jwt) h.set('authorization', 'Bearer ' + jwt); if (boot) h.set('x-bootstrap-token', boot);
  return handle(new Request('https://f.test/account-admin', { method, headers: h, body: method === 'POST' ? (raw ?? JSON.stringify(body)) : undefined }), w.deps);
};
const J = async (r) => ({ status: r.status, body: await r.json() });
const U = (username, o = {}) => ({ username, display_name: username + '지사', role: 'branch', branch_id: 'B001', ...o });

await test('비밀번호 생성(2026-11-02 간단하게): 8자, 소문자+숫자, 헷갈리는 글자(0 o 1 l i) 없음, 매번 다름', () => {
  const rb = (n) => crypto.getRandomValues(new Uint8Array(n)), set = new Set();
  for (let i = 0; i < 500; i++) {
    const p = genPassword(rb); assert.equal(p.length, 8);
    assert.match(p, /^[a-z2-9]{8}$/); assert.ok(/[a-z]/.test(p) && /[0-9]/.test(p), '글자·숫자 섞임: ' + p);
    assert.ok(!/[0o1li]/.test(p), '헷갈리는 글자: ' + p); assert.deepEqual(passwordProblems(p, 'exd03'), []); set.add(p);
  }
  assert.equal(set.size, 500);
});
const GOOD = (i) => `Snow#Ride-${2026 + i}k`;            // 규칙을 모두 만족하는 서로 다른 비밀번호

await test('비밀번호 규칙(2026-11-02 간단하게): 6자 이상이면 아무 글자, 공백·제어 문자·72바이트 초과만 거절', () => {
  const bad = (pw, u = 'exd03') => passwordProblems(pw, u).join('|');
  for (const ok of ['123456', 'abcdef', 'exd031', 'aaaaaa', 'Snow#Ride-2026k', '한글비번여섯', 'abcd1234']) assert.deepEqual(passwordProblems(ok, 'exd03'), [], ok);
  assert.match(bad('12345'), /6자 이상/); assert.match(bad('abc de'), /공백/); assert.match(bad('abc\tdef'), /공백/);
  assert.match(bad('A'.repeat(73)), /72/);
  assert.equal(passwordProblems('', 'x')[0], '비밀번호를 입력하세요'); assert.equal(passwordProblems(null, 'x')[0], '비밀번호를 입력하세요');
  assert.ok(PW_SYMBOLS.includes('!') && PW_SYMBOLS.includes('#') && !PW_SYMBOLS.includes('가'));
});

await test('일괄 설정: 관리자가 지사·장비 계정 비밀번호를 정하면 반영되고, 다음 로그인 때 변경 요구가 기본이며, 기존 로그인은 끊기고, 비밀번호는 응답·기록에 없다', async () => {
  const w = world(); addAdmin(w);
  await call(w, { action: 'create', users: [U('exchungju', { branch_id: 'B001' }), U('exwonju', { branch_id: 'B002' }), EQ('equip-01')] }, { jwt: 'jwt-admin' });
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
  const r = await J(await call(w, { action: 'set_passwords', items: [{ username: 'exa1', password: GOOD(1) }, { username: 'exb2', password: 'shrt' }, { username: 'exc3', password: GOOD(1) }, { username: 'exa1', password: GOOD(4) }, { username: 'NOT VALID', password: GOOD(5) }] }, { jwt: 'jwt-admin' }));
  assert.equal(r.status, 400); assert.equal(r.body.error, 'validation');
  const by = Object.fromEntries(r.body.details.map((d) => [d.index, d.error]));
  assert.match(by[1], /6자 이상/); assert.match(by[2], /같은 비밀번호/); assert.match(by[3], /같은 아이디/); assert.match(by[4], /아이디 형식/);
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


/* ---------- 역할·권한(2단계) ---------- */
await test('관리자 계정은 새로 만들 수 없다(관리자 로그인·시작 토큰 모두)', async () => {
  const w = world(); addAdmin(w); const tok = 'tk2'; w.boot = { hash: await hex(tok), expires_at: '2026-10-02T10:10:00Z' };
  const body = { action: 'create', users: [{ username: 'admin-03', display_name: '관리자3', role: 'admin' }] };
  for (const o of [{ jwt: 'jwt-admin' }, { boot: tok }]) {
    const r = await J(await call(w, body, o)); assert.equal(r.status, 400); assert.match(r.body.details[0].error, /관리자 계정은 여기서 만들 수 없음/);
  }
  assert.equal(w.users.size, 0);
});

await test('지원장비·지역본부·보기 전용 계정: 소속(출발 기관·본부)이 맞아야 하고, 권한을 안 주면 역할 기본 권한이 들어간다', async () => {
  const w = world(); addAdmin(w);
  const r = await J(await call(w, { action: 'create', users: [
    EQ('exseoulgigye', { sort: 10 }), { username: 'exgangwon', display_name: '강원본부', role: 'hq', hq_id: 'H02' }, { username: 'exviewer', display_name: '보기', role: 'viewer' }, U('exchungju', { branch_id: 'B002' }),
  ] }, { jwt: 'jwt-admin' }));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const P = (u) => [...w.profiles.values()].find((p) => p.username === u);
  assert.deepEqual([P('exseoulgigye').org, P('exseoulgigye').hq_id, P('exseoulgigye').branch_id, P('exseoulgigye').sort], ['서울경기', null, null, 10]);
  assert.deepEqual(P('exseoulgigye').perms, ['equip.edit.own']);
  assert.deepEqual([P('exgangwon').hq_id, P('exgangwon').org], ['H02', null]); assert.deepEqual(P('exgangwon').perms, ['req.edit.hq']);
  assert.deepEqual(P('exviewer').perms, []); assert.deepEqual(P('exchungju').perms, ['juris.request', 'req.edit.own']);
  assert.equal(r.body.creds.find((c) => c.username === 'exseoulgigye').org, '서울경기');
  assert.deepEqual(w.audit.find((a) => a.target.startsWith('exgangwon')).to_val, { perms: ['req.edit.hq'] });
});

await test('계정 만들 때 권한을 직접 고를 수 있고, 없는 권한·잘못된 소속·순서는 거절', async () => {
  const w = world(); addAdmin(w);
  const r = await J(await call(w, { action: 'create', users: [EQ('exchungbukgigye', { org: '충북', perms: ['equip.edit.own', 'log.view', 'log.view'] })] }, { jwt: 'jwt-admin' }));
  assert.equal(r.status, 201); assert.deepEqual([...w.profiles.values()].find((p) => p.username === 'exchungbukgigye').perms, ['equip.edit.own', 'log.view']);
  const bad = async (u) => { const x = await J(await call(w, { action: 'create', users: [u] }, { jwt: 'jwt-admin' })); assert.equal(x.status, 400, JSON.stringify(x.body)); return x.body.details.map((d) => d.error).join('|'); };
  assert.match(await bad(EQ('exa', { perms: ['root.all'] })), /없는 권한: root\.all/);
  assert.match(await bad(EQ('exa', { perms: 'equip.edit.own' })), /권한 목록 형식/);
  assert.match(await bad(EQ('exa', { org: '부산' })), /없는 출발 기관/);
  assert.match(await bad(EQ('exa', { org: undefined })), /없는 출발 기관/);
  assert.match(await bad({ username: 'exa', display_name: 'x', role: 'hq', hq_id: 'H99' }), /없는 본부/);
  assert.match(await bad({ username: 'exa', display_name: 'x', role: 'viewer', org: '충북' }), /출발 기관을 넣을 수 없음/);
  assert.match(await bad(U('exa', { hq_id: 'H01' })), /본부를 넣을 수 없음/);
  assert.match(await bad(EQ('exa', { sort: -1 })), /순서/); assert.match(await bad(EQ('exa', { sort: 1.5 })), /순서/);
  assert.match(await bad(EQ('exa', { display_name: '<b>x</b>' })), /이름/);
});

await test('계정 고치기(update): 이름·권한·순서를 여러 계정 한 번에, 이전 값·새 값이 기록되고 관리자 계정은 대상이 아니다', async () => {
  const w = world(); addAdmin(w); addAdmin(w, 'admin-02', 'jwt-a2');
  await call(w, { action: 'create', users: [U('exchungju'), EQ('exseoulgigye')] }, { jwt: 'jwt-admin' });
  w.audit.length = 0;
  const r = await J(await call(w, { action: 'update', items: [
    { username: 'exchungju', perms: ['juris.request', 'req.edit.own', 'grid.edit'], sort: 3 }, { username: 'exseoulgigye', display_name: ' 서울경기 지원장비 ' }, { username: 'admin-02', perms: [] }, { username: 'exnobody', sort: 1 },
  ] }, { jwt: 'jwt-admin' }));
  assert.equal(r.status, 207); assert.equal(r.body.updated, 2);
  const f = Object.fromEntries(r.body.failed.map((x) => [x.username, x.error])); assert.match(f['admin-02'], /관리자/); assert.match(f.exnobody, /찾을 수 없음/);
  const P = (u) => [...w.profiles.values()].find((p) => p.username === u);
  assert.deepEqual(P('exchungju').perms, ['juris.request', 'req.edit.own', 'grid.edit']); assert.equal(P('exchungju').sort, 3);
  assert.equal(P('exseoulgigye').display_name, '서울경기 지원장비'); assert.deepEqual(P('exseoulgigye').perms, ['equip.edit.own']);
  const a = w.audit.find((x) => x.target === 'exchungju'); assert.equal(a.kind, '계정수정');
  assert.deepEqual(a.from_val, { perms: ['juris.request', 'req.edit.own'], sort: null }); assert.deepEqual(a.to_val, { perms: ['juris.request', 'req.edit.own', 'grid.edit'], sort: 3 });
  // 검사: 하나라도 틀리면 아무것도 안 바꿈
  const bad = await J(await call(w, { action: 'update', items: [{ username: 'exchungju', perms: ['nope.x'] }, { username: 'exseoulgigye' }] }, { jwt: 'jwt-admin' }));
  assert.equal(bad.status, 400); assert.match(bad.body.details[0].error, /없는 권한/); assert.match(bad.body.details[1].error, /바꿀 항목이 없음/);
  assert.deepEqual(P('exchungju').perms, ['juris.request', 'req.edit.own', 'grid.edit']);
  // 권한 없는 사람·시작 토큰은 거절
  w.profiles.set('b1', { id: 'b1', username: 'exb', role: 'branch', branch_id: 'B001', perms: ['juris.request'], disabled: false, must_change: false }); w.jwt.set('jwt-b', 'b1');
  assert.equal((await call(w, { action: 'update', items: [{ username: 'exb', perms: ['juris.edit'] }] }, { jwt: 'jwt-b' })).status, 403);
  const tok = 'tu'; w.boot = { hash: await hex(tok), expires_at: '2026-10-02T10:10:00Z' };
  assert.equal((await call(w, { action: 'update', items: [{ username: 'exchungju', sort: 1 }] }, { boot: tok })).status, 403);
  assert.deepEqual(P('exb').perms, ['juris.request']);
});

const ok = results.filter((r) => r[1]).length;
results.forEach((r) => console.log((r[1] ? 'PASS ' : 'FAIL ') + r[0] + (r[1] ? '' : '  → ' + r[2])));
console.log('\n' + ok + '/' + results.length + ' 통과');
process.exit(ok === results.length ? 0 : 1);
