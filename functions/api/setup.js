// 첫 관리자 만들기: 계정이 하나도 없고, 관리자가 정해 둔 SETUP_TOKEN 을 아는 사람만 한 번 할 수 있습니다.
import { json, fail, readJson, sameOrigin, clientIp } from '../_lib/http.js';
import { audit, hashPassword, newId, nowIso, passwordProblem, sha256Hex } from '../_lib/auth.js';

const USERNAME_RE = /^[a-z0-9._-]{3,32}$/;
const count = async (env) => (await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first()).n;

export async function onRequestGet({ env }) {
  return json({ needed: (await count(env)) === 0 && !!env.SETUP_TOKEN });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!sameOrigin(request)) return fail(403, 'bad_origin', '허용되지 않은 요청입니다.');
  if (!env.SETUP_TOKEN || (await count(env)) > 0) return fail(404, 'not_found', '이미 설정이 끝났습니다.');
  const body = await readJson(request);
  if (!body) return fail(400, 'bad_request', '요청 형식이 올바르지 않습니다.');
  const username = String(body.username || '').trim().toLowerCase();
  // 토큰은 해시끼리 비교해서 길이·내용에 따른 응답 시간 차이가 없게 합니다
  if ((await sha256Hex(String(body.token || ''))) !== (await sha256Hex(String(env.SETUP_TOKEN)))) {
    await audit(env, { kind: '설정실패', target: 'setup', ip: clientIp(request) });
    return fail(403, 'bad_token', '설정 코드가 올바르지 않습니다.');
  }
  if (!USERNAME_RE.test(username)) return fail(400, 'bad_username', '아이디는 영문 소문자·숫자·. _ - 로 3~32자여야 합니다.');
  const problem = passwordProblem(body.password, username);
  if (problem) return fail(400, 'bad_password', problem);
  const id = newId();
  await env.DB.prepare('INSERT INTO users (id, username, display_name, role, branch, password_hash, must_change, disabled, created_at, created_by) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .bind(id, username, String(body.display_name || '관리자').slice(0, 40), 'admin', null, await hashPassword(body.password, env), 0, 0, nowIso(), 'setup').run();
  await audit(env, { username, kind: '계정생성', target: `${username} (admin, 최초 설정)`, ip: clientIp(request) });
  return json({ ok: true, message: '첫 관리자 계정을 만들었습니다. 이제 로그인하세요. (설정 코드는 Cloudflare에서 삭제하세요)' });
}
