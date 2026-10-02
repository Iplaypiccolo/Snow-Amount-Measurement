import { json, fail, readJson, sameOrigin, clientIp, sessionCookie } from '../_lib/http.js';
import { audit, burnTime, createSession, nowIso, recordAttempt, throttleState, verifyPassword, PASSWORD_MAX } from '../_lib/auth.js';

const GENERIC = '아이디 또는 비밀번호가 올바르지 않습니다.';

export async function onRequestPost(context) {
  const { request, env } = context;
  const ip = clientIp(request);
  if (!sameOrigin(request)) return fail(403, 'bad_origin', '허용되지 않은 요청입니다.');
  const body = await readJson(request);
  if (!body || typeof body.username !== 'string' || typeof body.password !== 'string') return fail(400, 'bad_request', '아이디와 비밀번호를 입력하세요.');
  const username = body.username.trim().toLowerCase().slice(0, 64);
  if (!body.password || body.password.length > PASSWORD_MAX) return fail(401, 'bad_credentials', GENERIC);   // 너무 긴 입력은 계산하지 않음

  const t = await throttleState(env, username, ip);
  if (t.blocked) {
    await audit(env, { username, kind: '접속제한', target: '로그인 시도 과다', ip });
    return fail(429, 'too_many_attempts', '로그인 시도가 너무 많습니다. 잠시(약 15분) 뒤에 다시 시도하세요.');
  }

  const user = await env.DB.prepare('SELECT * FROM users WHERE username = ?').bind(username).first();
  // 아이디가 없어도 있는 것처럼 같은 시간을 들여 계산 → 응답 시간으로 아이디 존재를 알 수 없게 함
  const ok = user ? await verifyPassword(body.password, user.password_hash) : (await burnTime(body.password, env), false);
  if (!ok || user.disabled) {
    await recordAttempt(env, username, ip, false);
    await audit(env, { username, kind: '접속실패', ip });
    return fail(401, 'bad_credentials', GENERIC);
  }

  await recordAttempt(env, username, ip, true);
  const { token, maxAgeSec } = await createSession(env, user.id, ip);
  await env.DB.prepare('UPDATE users SET last_login_at=? WHERE id=?').bind(nowIso(), user.id).run();
  await audit(env, { username, kind: '접속', ip });
  return json({ ok: true, user: { username: user.username, display_name: user.display_name, role: user.role, branch: user.branch, must_change: !!user.must_change } },
    200, { 'Set-Cookie': sessionCookie(token, maxAgeSec) });
}
