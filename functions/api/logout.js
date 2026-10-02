import { json, fail, sameOrigin, clientIp, clearCookie } from '../_lib/http.js';
import { audit, currentUser } from '../_lib/auth.js';

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!sameOrigin(request)) return fail(403, 'bad_origin', '허용되지 않은 요청입니다.');
  const user = await currentUser(context);
  if (user) {
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash=?').bind(user.tokenHash).run();
    await audit(env, { username: user.username, kind: '로그아웃', ip: clientIp(request) });
  }
  return json({ ok: true }, 200, { 'Set-Cookie': clearCookie() });
}
