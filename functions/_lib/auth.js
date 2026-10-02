// 인증 핵심: 비밀번호 해시, 로그인 상태(세션), 로그인 시도 제한, 접속 기록
import { clientIp, fail, parseCookies, COOKIE_NAME } from './http.js';

const enc = new TextEncoder();
const MAX_PBKDF2 = 100000;                 // Cloudflare Workers 가 허용하는 최대 반복 횟수(그 이상은 오류)
export const SESSION_ABSOLUTE_MS = 10 * 3600 * 1000;   // 로그인 후 최대 10시간
export const SESSION_IDLE_MS = 2 * 3600 * 1000;        // 2시간 동안 아무 것도 안 하면 로그아웃
export const USER_FAIL_LIMIT = 5, USER_FAIL_WINDOW_MS = 15 * 60 * 1000;   // 같은 아이디로 15분 안에 5번 틀리면 잠깐 잠금
export const IP_FAIL_LIMIT = 30, IP_FAIL_WINDOW_MS = 10 * 60 * 1000;      // 같은 IP에서 10분 안에 30번 틀리면 잠깐 차단

export const nowIso = (ms = Date.now()) => new Date(ms).toISOString();
export const iterationsOf = (env) => Math.max(1000, Math.min(MAX_PBKDF2, Number(env.PBKDF2_ITERATIONS) || MAX_PBKDF2));

/* ---------- 바이트·인코딩 ---------- */
const b64 = (buf) => { let s = ''; new Uint8Array(buf).forEach((c) => { s += String.fromCharCode(c); }); return btoa(s); };
const unb64 = (str) => Uint8Array.from(atob(str), (c) => c.charCodeAt(0));
const b64url = (buf) => b64(buf).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export async function sha256Hex(text) {
  const d = await crypto.subtle.digest('SHA-256', enc.encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/* ---------- 비밀번호 ---------- */
async function derive(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256));
}
export async function hashPassword(password, env) {
  const salt = crypto.getRandomValues(new Uint8Array(16)), iterations = iterationsOf(env);
  return `pbkdf2-sha256$${iterations}$${b64(salt)}$${b64(await derive(password, salt, iterations))}`;
}
export async function verifyPassword(password, stored) {
  const p = String(stored).split('$');
  if (p.length !== 4 || p[0] !== 'pbkdf2-sha256') return false;
  const iterations = Math.min(MAX_PBKDF2, parseInt(p[1], 10) || 0);
  if (iterations < 1) return false;
  return timingSafeEqual(await derive(password, unb64(p[2]), iterations), unb64(p[3]));
}
// 없는 아이디로 시도해도 응답 시간이 같도록 가짜 해시를 한 번 계산
let dummy;
export async function burnTime(password, env) {
  if (!dummy) { dummy = await hashPassword('dummy-password', env); return; }   // 처음 한 번은 가짜 해시를 만드는 계산 1회, 이후는 확인 계산 1회 → 둘 다 계산량이 같음
  await verifyPassword(password, dummy);
}

export const PASSWORD_MIN = 12, PASSWORD_MAX = 128;
export function passwordProblem(pw, username) {
  if (typeof pw !== 'string') return '비밀번호를 입력하세요.';
  if (pw.length < PASSWORD_MIN) return `비밀번호는 ${PASSWORD_MIN}자 이상이어야 합니다.`;
  if (pw.length > PASSWORD_MAX) return `비밀번호는 ${PASSWORD_MAX}자 이하여야 합니다.`;
  if (username && pw.toLowerCase().includes(String(username).toLowerCase())) return '비밀번호에 아이디가 들어 있으면 안 됩니다.';
  if (/^(.)\1+$/.test(pw)) return '같은 글자만 반복한 비밀번호는 쓸 수 없습니다.';
  return null;
}
// 임시 비밀번호: 헷갈리는 글자(0 O 1 l I)를 뺀 16자, 치우침 없이 무작위
export function generatePassword(len = 16) {
  const A = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789', limit = 256 - (256 % A.length);
  let out = '';
  while (out.length < len) for (const b of crypto.getRandomValues(new Uint8Array(32))) { if (b < limit && out.length < len) out += A[b % A.length]; }
  return out;
}
export const newId = () => crypto.randomUUID();

/* ---------- 접속 기록 ---------- */
export async function audit(env, { username = null, kind, tab = null, target = null, from = null, to = null, ip = null }) {
  await env.DB.prepare('INSERT INTO audit_log (at, username, kind, tab, target, from_val, to_val, ip) VALUES (?,?,?,?,?,?,?,?)')
    .bind(nowIso(), username, kind, tab, target, from, to, ip).run();
}

/* ---------- 로그인 시도 제한 ---------- */
export async function throttleState(env, username, ip) {
  const now = Date.now();
  const ipFails = (await env.DB.prepare('SELECT COUNT(*) AS n FROM login_attempts WHERE ip=? AND ok=0 AND at>?').bind(ip, nowIso(now - IP_FAIL_WINDOW_MS)).first()).n;
  const userFails = (await env.DB.prepare('SELECT COUNT(*) AS n FROM login_attempts WHERE username=? AND ok=0 AND at>?').bind(username, nowIso(now - USER_FAIL_WINDOW_MS)).first()).n;
  return { blocked: ipFails >= IP_FAIL_LIMIT || userFails >= USER_FAIL_LIMIT, ipFails, userFails };
}
export async function recordAttempt(env, username, ip, ok) {
  await env.DB.prepare('INSERT INTO login_attempts (at, username, ip, ok) VALUES (?,?,?,?)').bind(nowIso(), String(username).slice(0, 64), ip, ok ? 1 : 0).run();
  if (ok) await env.DB.prepare('DELETE FROM login_attempts WHERE username=? AND ok=0').bind(String(username).slice(0, 64)).run();
  await env.DB.prepare('DELETE FROM login_attempts WHERE at<?').bind(nowIso(Date.now() - 2 * 86400000)).run();   // 오래된 기록 정리
}

/* ---------- 세션(로그인 상태) ---------- */
export async function createSession(env, userId, ip) {
  const token = b64url(crypto.getRandomValues(new Uint8Array(32))), now = Date.now();
  await env.DB.prepare('INSERT INTO sessions (token_hash, user_id, created_at, last_seen_at, expires_at, ip) VALUES (?,?,?,?,?,?)')
    .bind(await sha256Hex(token), userId, nowIso(now), nowIso(now), nowIso(now + SESSION_ABSOLUTE_MS), ip).run();
  return { token, maxAgeSec: Math.floor(SESSION_ABSOLUTE_MS / 1000) };
}
export const destroyUserSessions = (env, userId, exceptHash = null) =>
  (exceptHash
    ? env.DB.prepare('DELETE FROM sessions WHERE user_id=? AND token_hash<>?').bind(userId, exceptHash)
    : env.DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(userId)).run();

export async function currentUser(context) {
  const { request, env } = context;
  const token = parseCookies(request)[COOKIE_NAME];
  if (!token || token.length > 100) return null;
  const hash = await sha256Hex(token), now = Date.now();
  const row = await env.DB.prepare(
    `SELECT s.token_hash, s.last_seen_at, s.expires_at, u.id, u.username, u.display_name, u.role, u.branch, u.must_change, u.disabled
     FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`).bind(hash).first();
  if (!row) return null;
  if (row.disabled || Date.parse(row.expires_at) <= now || now - Date.parse(row.last_seen_at) > SESSION_IDLE_MS) {
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash=?').bind(hash).run();
    return null;
  }
  if (now - Date.parse(row.last_seen_at) > 60000) await env.DB.prepare('UPDATE sessions SET last_seen_at=? WHERE token_hash=?').bind(nowIso(now), hash).run();
  return { id: row.id, username: row.username, display_name: row.display_name, role: row.role, branch: row.branch, must_change: !!row.must_change, tokenHash: row.token_hash };
}

// 로그인한 사용자만 통과. { roles:['admin'] } 처럼 역할을 제한할 수 있고, 비밀번호를 바꿔야 하는 계정은 allowMustChange 가 아니면 막음
export async function requireUser(context, { roles = null, allowMustChange = false } = {}) {
  const user = await currentUser(context);
  if (!user) return { response: fail(401, 'not_logged_in', '로그인이 필요합니다.') };
  if (user.must_change && !allowMustChange) return { response: fail(403, 'password_change_required', '먼저 비밀번호를 바꿔 주세요.') };
  if (roles && !roles.includes(user.role)) {
    await audit(context.env, { username: user.username, kind: '권한거부', target: new URL(context.request.url).pathname, ip: clientIp(context.request) });
    return { response: fail(403, 'forbidden', '이 작업을 할 권한이 없습니다.') };
  }
  return { user };
}
