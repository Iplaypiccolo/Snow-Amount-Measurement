// 관리자 전용: 계정 목록 / 새 계정 만들기 (임시 비밀번호는 만들 때 한 번만 보여줌)
import { json, fail, readJson, sameOrigin, clientIp } from '../../_lib/http.js';
import { audit, generatePassword, hashPassword, newId, nowIso, requireUser } from '../../_lib/auth.js';

const USERNAME_RE = /^[a-z0-9._-]{3,32}$/, ROLES = ['admin', 'branch', 'equip'];

export async function onRequestGet(context) {
  const { response } = await requireUser(context, { roles: ['admin'] });
  if (response) return response;
  const { results } = await context.env.DB.prepare(
    'SELECT id, username, display_name, role, branch, must_change, disabled, created_at, created_by, last_login_at FROM users ORDER BY created_at').all();
  return json({ ok: true, users: results });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!sameOrigin(request)) return fail(403, 'bad_origin', '허용되지 않은 요청입니다.');
  const { user, response } = await requireUser(context, { roles: ['admin'] });
  if (response) return response;
  const b = await readJson(request);
  if (!b) return fail(400, 'bad_request', '요청 형식이 올바르지 않습니다.');
  const username = String(b.username || '').trim().toLowerCase(), display = String(b.display_name || '').trim();
  const role = b.role, branch = b.branch ? String(b.branch).trim() : null;
  if (!USERNAME_RE.test(username)) return fail(400, 'bad_username', '아이디는 영문 소문자·숫자·. _ - 로 3~32자여야 합니다.');
  if (!display || display.length > 40 || /[\u0000-\u001f]/.test(display)) return fail(400, 'bad_name', '표시 이름은 1~40자로 입력하세요.');
  if (!ROLES.includes(role)) return fail(400, 'bad_role', '역할은 관리자, 피지원지사, 지원장비 중 하나여야 합니다.');
  if (role === 'branch' && (!branch || branch.length > 40)) return fail(400, 'bad_branch', '피지원지사 계정은 소속 지사 이름이 필요합니다.');
  if (await env.DB.prepare('SELECT 1 AS x FROM users WHERE username=?').bind(username).first()) return fail(409, 'exists', '이미 있는 아이디입니다.');
  const temp = generatePassword();
  await env.DB.prepare('INSERT INTO users (id, username, display_name, role, branch, password_hash, must_change, disabled, created_at, created_by) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .bind(newId(), username, display, role, role === 'branch' ? branch : null, await hashPassword(temp, env), 1, 0, nowIso(), user.username).run();
  await audit(env, { username: user.username, kind: '계정생성', target: `${username} (${role}${role === 'branch' ? ':' + branch : ''})`, ip: clientIp(request) });
  return json({ ok: true, username, temp_password: temp, message: '임시 비밀번호는 지금 한 번만 보입니다. 사용자에게 안전하게 전달하세요. 첫 로그인 때 새 비밀번호로 바꾸게 됩니다.' }, 201);
}
