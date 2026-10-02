// ============================================================
// account-admin — 계정 발급·초기화·비활성화 (관리자 전용)
//  * 순수 로직만 들어 있고, DB·Auth 는 deps 로 주입받습니다 → Cloudflare/Supabase 없이 Node 로 시험 가능 (tests/test_account_admin.mjs)
//  * 인증: ① 관리자 로그인 토큰(JWT) 또는 ② 일회용 시작 토큰(x-bootstrap-token, 15분 안에 한 번만) — ②는 최초 대량 발급용
//  * 임시 비밀번호는 16자 무작위. 시작 토큰으로 호출하면 비밀번호를 응답에 싣지 않고 비공개 저장소(credentials)의 CSV 파일에만 넣습니다.
// ============================================================
export const EMAIL_DOMAIN = 'snow-support.invalid';
export const USERNAME_RE = /^[a-z0-9._-]{3,32}$/;
export const ROLES = ['admin', 'branch', 'equip'];
// 프로젝트의 비밀번호 규칙(소문자·대문자·숫자·기호를 각각 1개 이상)을 항상 만족하도록, 종류별로 하나씩 넣고 나머지를 채웁니다.
// 헷갈리는 글자(0 O 1 l I)와 CSV·엑셀에서 문제가 되는 기호(쉼표 따옴표 역슬래시 괄호 등)는 뺍니다.
const LOWER = 'abcdefghijkmnpqrstuvwxyz', UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ', DIGIT = '23456789', SYMBOL = '!#$%&*+-=?@';
const ALL = LOWER + UPPER + DIGIT + SYMBOL;
const MAX_USERS = 100, MAX_BODY = 65536, CONCURRENCY = 6;

/* ---------- 비밀번호 규칙: 프로젝트(Supabase Auth) 설정과 같고, 약한 패턴을 더 막음. admin/admin.js 의 화면 검사와 똑같이 맞춰져 있음(tests 가 비교) ---------- */
export const PW_SYMBOLS = ['!', '@', '#', '$', '%', '^', '&', '*', '(', ')', '_', '+', '-', '=', '[', ']', '{', '}', ';', "'", '\\', ':', '"', '|', '<', '>', '?', ',', '.', '/', '`', '~'].join('');   // Supabase Auth 가 "기호"로 인정하는 글자
const hasRun = (pw) => {                           // abcd / 1234 / dcba / 4321 처럼 이어지는 글자 4개 이상
  const c = [...pw.toLowerCase()].map((x) => x.codePointAt(0));
  for (let i = 0; i + 3 < c.length; i++) {
    const d = c[i + 1] - c[i];
    if ((d === 1 || d === -1) && c[i + 2] - c[i + 1] === d && c[i + 3] - c[i + 2] === d) return true;
  }
  return false;
};
export function passwordProblems(pw, username) {
  if (typeof pw !== 'string' || !pw) return ['비밀번호를 입력하세요'];
  const p = [], low = pw.toLowerCase(), u = String(username || '').toLowerCase(), core = u.replace(/^ex/, '');
  if ([...pw].length < 12) p.push('12자 이상');
  if (new TextEncoder().encode(pw).length > 72) p.push('72바이트 이하(영문 72자)');
  if (!/[a-z]/.test(pw)) p.push('소문자 필요');
  if (!/[A-Z]/.test(pw)) p.push('대문자 필요');
  if (!/[0-9]/.test(pw)) p.push('숫자 필요');
  if (![...pw].some((c) => PW_SYMBOLS.includes(c))) p.push('기호 필요');
  if (/[\s\u0000-\u001f]/.test(pw)) p.push('공백·제어 문자 불가');
  if (u && low.includes(u)) p.push('아이디 포함 불가');
  else if (core.length >= 4 && low.includes(core)) p.push('지사 이름 포함 불가');
  if (/(.)\1{3,}/.test(pw)) p.push('같은 글자 4번 이상 반복 불가');
  if (hasRun(pw)) p.push('이어지는 글자(abcd·1234) 4개 이상 불가');
  return p;
}

export const emailOf = (username) => `${username}@${EMAIL_DOMAIN}`;

function randInt(randomBytes, n) {                 // 0..n-1, 치우침 없는 무작위(거절 추출)
  const limit = 256 - (256 % n);
  for (;;) for (const b of randomBytes(32)) if (b < limit) return b % n;
}
export function genPassword(randomBytes, len = 16) {
  const pick = (set) => set[randInt(randomBytes, set.length)];
  const chars = [pick(LOWER), pick(UPPER), pick(DIGIT), pick(SYMBOL)];
  while (chars.length < len) chars.push(pick(ALL));
  for (let i = chars.length - 1; i > 0; i--) { const j = randInt(randomBytes, i + 1); [chars[i], chars[j]] = [chars[j], chars[i]]; }   // 섞기
  if (SYMBOL.includes(chars[0])) { const k = chars.findIndex((c) => !SYMBOL.includes(c)); [chars[0], chars[k]] = [chars[k], chars[0]]; }       // 엑셀이 수식으로 읽지 않도록 첫 글자는 기호가 아니게
  return chars.join('');
}

export function toCsv(rows) {
  const esc = (v) => { const s = String(v ?? ''); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const head = ['아이디', '이름', '임시 비밀번호', '역할', '소속 지사 번호'];
  return '\uFEFF' + [head, ...rows.map((r) => [r.username, r.display_name, r.temp_password, r.role, r.branch_id || ''])].map((l) => l.map(esc).join(',')).join('\r\n') + '\r\n';
}

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-bootstrap-token', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
const fail = (status, error, message, extra = {}) => json(status, { ok: false, error, message, ...extra });
const ipOf = (req) => req.headers.get('cf-connecting-ip') || (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || null;

async function pool(items, n, fn) {          // 동시에 n 개씩 처리 (순서대로 결과 반환)
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
  return out;
}

async function authenticate(req, d) {
  const boot = req.headers.get('x-bootstrap-token');
  if (boot) {
    if (!(await d.store.consumeBootstrap(await d.sha256hex(boot), d.now()))) return { res: fail(403, 'bad_bootstrap', '시작 토큰이 올바르지 않거나 만료되었습니다.') };
    return { actor: { id: null, username: 'bootstrap', role: null, bootstrap: true } };
  }
  const m = /^Bearer (.+)$/.exec(req.headers.get('authorization') || '');
  if (!m) return { res: fail(401, 'not_logged_in', '로그인이 필요합니다.') };
  const u = await d.auth.getUser(m[1]);
  if (!u.id) return { res: fail(401, 'not_logged_in', '로그인이 필요합니다.') };
  const p = await d.store.getProfileById(u.id);
  if (!p || p.disabled || p.must_change || p.role !== 'admin') return { res: fail(403, 'forbidden', '관리자만 할 수 있는 작업입니다.') };
  return { actor: { id: u.id, username: p.username, role: p.role, bootstrap: false } };
}

const audit = (d, actor, req, rows) => d.store.insertAudit(rows.map((r) => ({ user_id: actor.id, username: actor.username, role: actor.role, tab: 'account-admin', ip: ipOf(req), ...r })));

// 비밀번호를 응답에 싣거나(관리자 화면) 비공개 CSV 파일에만 넣는다(시작 토큰)
async function deliver(d, actor, creds, label) {
  if (!actor.bootstrap) return { creds };
  const path = `${label}-${d.now().toISOString().replace(/[:.]/g, '-')}.csv`;
  const up = await d.store.uploadCsv(path, toCsv(creds));
  if (up && up.error) return { error: '임시 비밀번호 파일을 저장하지 못했습니다.' };
  return { file: `credentials/${path}` };
}

async function actCreate(req, d, actor, body) {
  const users = body.users;
  if (!Array.isArray(users) || users.length < 1 || users.length > MAX_USERS) return fail(400, 'bad_request', `계정은 1~${MAX_USERS}개씩 만들 수 있습니다.`);
  const errs = [], seen = new Set();
  const want = users.filter((u) => u && u.role === 'branch' && typeof u.branch_id === 'string').map((u) => u.branch_id);
  const branches = new Set(await d.store.branchIds(want));
  users.forEach((u, i) => {
    const e = (m) => errs.push({ index: i, username: u && u.username, error: m });
    if (!u || typeof u !== 'object') return e('형식 오류');
    if (!USERNAME_RE.test(u.username || '')) e('아이디는 영문 소문자·숫자·. _ - 로 3~32자');
    if (seen.has(u.username)) e('요청 안에서 아이디가 중복'); seen.add(u.username);
    if (typeof u.display_name !== 'string' || !u.display_name.trim() || u.display_name.length > 40 || /[\u0000-\u001f]/.test(u.display_name)) e('이름은 1~40자');
    if (!ROLES.includes(u.role)) e('역할은 admin / branch / equip');
    if (u.role === 'branch' && !branches.has(u.branch_id)) e('없는 지사 번호');
    if (u.role !== 'branch' && u.branch_id) e('지사 계정이 아니면 지사 번호를 넣을 수 없음');
  });
  if (errs.length) return fail(400, 'validation', '입력을 확인하세요.', { details: errs });
  const taken = await d.store.existingUsernames(users.map((u) => u.username));
  if (taken.length) return fail(409, 'exists', '이미 있는 아이디가 있습니다.', { details: taken });

  const results = await pool(users, CONCURRENCY, async (u) => {
    const pw = genPassword(d.random);
    const c = await d.auth.createUser({ email: emailOf(u.username), password: pw });
    if (!c.id) return { username: u.username, ok: false, error: 'auth_create_failed', detail: c.error && c.error.message };
    const ins = await d.store.insertProfile({ id: c.id, username: u.username, display_name: u.display_name.trim(), role: u.role, branch_id: u.role === 'branch' ? u.branch_id : null, must_change: true, disabled: false });
    if (ins && ins.error) { await d.auth.deleteUser(c.id); return { username: u.username, ok: false, error: 'profile_insert_failed', detail: ins.error.message }; }
    return { username: u.username, ok: true, user: u, temp_password: pw };
  });
  const ok = results.filter((r) => r.ok), failed = results.filter((r) => !r.ok).map(({ username, error, detail }) => ({ username, error, detail }));
  if (ok.length) await audit(d, actor, req, ok.map((r) => ({ kind: '계정생성', target: `${r.username} (${r.user.role}${r.user.branch_id ? ':' + r.user.branch_id : ''})` })));
  const creds = ok.map((r) => ({ username: r.username, display_name: r.user.display_name.trim(), role: r.user.role, branch_id: r.user.branch_id || null, temp_password: r.temp_password }));
  const dl = ok.length ? await deliver(d, actor, creds, 'accounts') : {};
  if (dl.error) return fail(500, 'delivery_failed', dl.error, { created: ok.map((r) => r.username), failed });
  return json(failed.length ? 207 : 201, { ok: failed.length === 0, created: ok.length, failed, ...dl,
    message: actor.bootstrap ? '임시 비밀번호는 비공개 저장소(credentials)의 파일에만 저장했습니다.' : '임시 비밀번호는 지금 한 번만 보입니다. 안전하게 전달하세요.' });
}

// 관리자 화면의 "비밀번호 일괄 설정"(엑셀표): 관리자가 지사·지원장비 계정의 비밀번호를 직접 정함. 비밀번호는 응답·기록 어디에도 남기지 않음.
async function actSetPasswords(req, d, actor, body) {
  if (actor.bootstrap) return fail(403, 'forbidden', '이 작업은 관리자 로그인으로만 할 수 있습니다.');
  const items = body.items;
  if (!Array.isArray(items) || items.length < 1 || items.length > MAX_USERS) return fail(400, 'bad_request', `비밀번호는 1~${MAX_USERS}개씩 설정할 수 있습니다.`);
  const requireChange = body.require_change !== false;              // 기본: 처음 로그인할 때 본인이 다시 바꾸게 함
  const errs = [], seen = new Map(), pwSeen = new Map();
  items.forEach((it, i) => {
    const e = (m) => errs.push({ index: i, username: it && it.username, error: m });
    if (!it || typeof it !== 'object' || typeof it.username !== 'string' || !USERNAME_RE.test(it.username)) return e('아이디 형식 오류');
    if (seen.has(it.username)) e('같은 아이디가 두 번 들어 있음'); seen.set(it.username, i);
    const prob = passwordProblems(it.password, it.username);
    if (prob.length) e(prob.join(', '));
    else if (pwSeen.has(it.password)) e('다른 계정과 같은 비밀번호 (계정마다 달라야 함)'); else pwSeen.set(it.password, i);
  });
  if (errs.length) return fail(400, 'validation', '입력을 확인하세요.', { details: errs });
  const results = await pool(items, CONCURRENCY, async (it) => {
    const t = await d.store.getProfileByUsername(it.username);
    if (!t) return { username: it.username, ok: false, error: '계정을 찾을 수 없음' };
    if (t.role === 'admin') return { username: it.username, ok: false, error: '관리자 계정은 이 방법으로 바꿀 수 없음(본인 비밀번호 변경 또는 초기화 사용)' };
    const up = await d.auth.updatePassword(t.id, it.password);       // 이 갱신이 must_change 를 해제하는 트리거를 건드리므로
    if (up && up.error) return { username: it.username, ok: false, error: '비밀번호 규칙에 맞지 않거나 저장하지 못함' };
    await d.store.updateProfile(t.id, { must_change: requireChange });   // 원하는 상태로 다시 지정 (순서 중요)
    await d.store.revokeSessions(t.id);                                  // 기존 로그인은 모두 끊음
    return { username: it.username, ok: true };
  });
  const okRows = results.filter((r) => r.ok), failed = results.filter((r) => !r.ok).map(({ username, error }) => ({ username, error }));
  if (okRows.length) await audit(d, actor, req, okRows.map((r) => ({ kind: '비밀번호설정', target: r.username, to_val: { require_change: requireChange } })));
  return json(failed.length ? 207 : 200, { ok: failed.length === 0, updated: okRows.length, failed, require_change: requireChange });
}

async function findTarget(d, username) {
  if (typeof username !== 'string' || !USERNAME_RE.test(username)) return null;
  return d.store.getProfileByUsername(username);
}

async function actReset(req, d, actor, body) {
  const t = await findTarget(d, body.username);
  if (!t) return fail(404, 'not_found', '계정을 찾을 수 없습니다.');
  const pw = genPassword(d.random);
  const up = await d.auth.updatePassword(t.id, pw);                 // 이 갱신이 must_change 를 해제하는 트리거를 건드리므로
  if (up && up.error) return fail(500, 'reset_failed', '비밀번호를 초기화하지 못했습니다.');
  await d.store.updateProfile(t.id, { must_change: true });         // 그 뒤에 다시 임시 상태로 되돌린다 (순서 중요)
  await d.store.revokeSessions(t.id);                               // 이 계정의 모든 로그인을 끊음
  await audit(d, actor, req, [{ kind: '비밀번호초기화', target: t.username }]);
  const dl = await deliver(d, actor, [{ username: t.username, display_name: t.display_name || t.username, role: t.role, branch_id: t.branch_id, temp_password: pw }], 'reset');
  if (dl.error) return fail(500, 'delivery_failed', dl.error);
  return json(200, { ok: true, username: t.username, ...dl });
}

async function actDisable(req, d, actor, body, disable) {
  const t = await findTarget(d, body.username);
  if (!t) return fail(404, 'not_found', '계정을 찾을 수 없습니다.');
  if (disable) {
    if (actor.id && t.id === actor.id) return fail(400, 'self', '본인 계정은 비활성화할 수 없습니다.');
    if (t.role === 'admin' && !t.disabled && (await d.store.countActiveAdmins()) <= 1) return fail(400, 'last_admin', '마지막 관리자는 비활성화할 수 없습니다.');
  }
  await d.store.updateProfile(t.id, { disabled: disable });
  await d.auth.setBan(t.id, disable);
  if (disable) await d.store.revokeSessions(t.id);
  await audit(d, actor, req, [{ kind: disable ? '계정비활성화' : '계정활성화', target: t.username }]);
  return json(200, { ok: true, username: t.username, disabled: disable });
}

export async function handle(req, d) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return fail(405, 'method_not_allowed', 'POST 만 지원합니다.');
  let body;
  try {
    const text = await req.text();
    if (text.length > MAX_BODY) return fail(413, 'too_large', '요청이 너무 큽니다.');
    body = JSON.parse(text);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('shape');
  } catch { return fail(400, 'bad_request', '요청 형식이 올바르지 않습니다.'); }
  const a = await authenticate(req, d);
  if (a.res) return a.res;
  try {
    if (body.action === 'create') return await actCreate(req, d, a.actor, body);
    if (body.action === 'reset') return await actReset(req, d, a.actor, body);
    if (body.action === 'set_passwords') return await actSetPasswords(req, d, a.actor, body);
    if (body.action === 'disable') return await actDisable(req, d, a.actor, body, true);
    if (body.action === 'enable') return await actDisable(req, d, a.actor, body, false);
    return fail(400, 'bad_action', '알 수 없는 작업입니다.');
  } catch (e) {
    console.error('account-admin error', e && e.message);
    return fail(500, 'server_error', '서버 오류가 발생했습니다.');
  }
}
