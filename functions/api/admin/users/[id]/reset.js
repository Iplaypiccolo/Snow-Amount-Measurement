import { json, fail, sameOrigin, clientIp } from '../../../../_lib/http.js';
import { audit, destroyUserSessions, generatePassword, hashPassword, requireUser } from '../../../../_lib/auth.js';

export async function onRequestPost(context) {
  const { request, env, params } = context;
  if (!sameOrigin(request)) return fail(403, 'bad_origin', '허용되지 않은 요청입니다.');
  const { user, response } = await requireUser(context, { roles: ['admin'] });
  if (response) return response;
  const target = await env.DB.prepare('SELECT id, username FROM users WHERE id=?').bind(params.id).first();
  if (!target) return fail(404, 'not_found', '계정을 찾을 수 없습니다.');
  const temp = generatePassword();
  await env.DB.prepare('UPDATE users SET password_hash=?, must_change=1 WHERE id=?').bind(await hashPassword(temp, env), target.id).run();
  await destroyUserSessions(env, target.id);                        // 그 계정의 모든 로그인을 끊음
  await env.DB.prepare('DELETE FROM login_attempts WHERE username=?').bind(target.username).run();   // 잠금도 풀어 줌
  await audit(env, { username: user.username, kind: '비밀번호초기화', target: target.username, ip: clientIp(request) });
  return json({ ok: true, username: target.username, temp_password: temp, message: '임시 비밀번호는 지금 한 번만 보입니다.' });
}
