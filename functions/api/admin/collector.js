// 관리자 전용: 기상청 자료 수집 기록 (최근 30건)
import { json } from '../../_lib/http.js';
import { requireUser } from '../../_lib/auth.js';

export async function onRequestGet(context) {
  const { response } = await requireUser(context, { roles: ['admin'] });
  if (response) return response;
  const { results } = await context.env.DB.prepare(
    'SELECT id, started_at, finished_at, source, ok, http_status, ms, bytes, url_masked, snippet, error FROM collector_runs ORDER BY id DESC LIMIT 30').all();
  return json({ ok: true, runs: results });
}
