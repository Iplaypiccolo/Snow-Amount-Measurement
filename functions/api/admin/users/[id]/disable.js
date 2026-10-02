import { json, fail, sameOrigin, clientIp } from '../../../../_lib/http.js';
import { audit, destroyUserSessions, requireUser } from '../../../../_lib/auth.js';

export async function onRequestPost(context) {
  const { request, env, params } = context;
  if (!sameOrigin(request)) return fail(403, 'bad_origin', '허용되지 않은 요청입니다.');
  const { user, response } = await requireUser(context, { roles: ['admin'] });
  if (response) return response;
  const target = await env.DB.prepare('SELECT id, username, role, disabled FROM users WHERE id=?').bind(params.id).first();
  if (!target) return fail(404, 'not_found', '계정을 찾을 수 없습니다.');
  if (target.id === user.id) return fail(400, 'self', '본인 계정은 비활성화할 수 없습니다.');
  if (target.role === 'admin' && !target.disabled) {
    const n = (await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE role='admin' AND disabled=0").first()).n;
    if (n <= 1) return fail(400, 'last_admin', '마지막 관리자는 비활성화할 수 없습니다.');
  }
  await env.DB.prepare('UPDATE users SET disabled=1 WHERE id=?').bind(target.id).run();
  await destroyUserSessions(env, target.id);
  await audit(env, { username: user.username, kind: '계정비활성화', target: target.username, ip: clientIp(request) });
  return json({ ok: true });
}
