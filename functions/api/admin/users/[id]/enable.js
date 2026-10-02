import { json, fail, sameOrigin, clientIp } from '../../../../_lib/http.js';
import { audit, requireUser } from '../../../../_lib/auth.js';

export async function onRequestPost(context) {
  const { request, env, params } = context;
  if (!sameOrigin(request)) return fail(403, 'bad_origin', '허용되지 않은 요청입니다.');
  const { user, response } = await requireUser(context, { roles: ['admin'] });
  if (response) return response;
  const target = await env.DB.prepare('SELECT id, username FROM users WHERE id=?').bind(params.id).first();
  if (!target) return fail(404, 'not_found', '계정을 찾을 수 없습니다.');
  await env.DB.prepare('UPDATE users SET disabled=0 WHERE id=?').bind(target.id).run();
  await audit(env, { username: user.username, kind: '계정활성화', target: target.username, ip: clientIp(request) });
  return json({ ok: true });
}
