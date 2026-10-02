// 내 비밀번호 바꾸기 (현재 비밀번호를 한 번 더 확인)
import { json, fail, readJson, sameOrigin, clientIp } from '../_lib/http.js';
import { audit, destroyUserSessions, hashPassword, passwordProblem, recordAttempt, requireUser, throttleState, verifyPassword } from '../_lib/auth.js';

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!sameOrigin(request)) return fail(403, 'bad_origin', '허용되지 않은 요청입니다.');
  const { user, response } = await requireUser(context, { allowMustChange: true });
  if (response) return response;
  const ip = clientIp(request), body = await readJson(request);
  if (!body || typeof body.current !== 'string' || typeof body.next !== 'string') return fail(400, 'bad_request', '현재 비밀번호와 새 비밀번호를 입력하세요.');
  if ((await throttleState(env, user.username, ip)).blocked) return fail(429, 'too_many_attempts', '시도가 너무 많습니다. 잠시 뒤에 다시 시도하세요.');
  const row = await env.DB.prepare('SELECT password_hash FROM users WHERE id=?').bind(user.id).first();
  if (!(await verifyPassword(body.current, row.password_hash))) {
    await recordAttempt(env, user.username, ip, false);
    await audit(env, { username: user.username, kind: '비밀번호변경실패', ip });
    return fail(401, 'bad_credentials', '현재 비밀번호가 올바르지 않습니다.');
  }
  const problem = passwordProblem(body.next, user.username) || (body.next === body.current ? '새 비밀번호는 현재 비밀번호와 달라야 합니다.' : null);
  if (problem) return fail(400, 'bad_password', problem);
  await env.DB.prepare('UPDATE users SET password_hash=?, must_change=0 WHERE id=?').bind(await hashPassword(body.next, env), user.id).run();
  await destroyUserSessions(env, user.id, user.tokenHash);      // 다른 기기의 로그인은 끊음
  await audit(env, { username: user.username, kind: '비밀번호변경', ip });
  return json({ ok: true });
}
