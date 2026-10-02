// 기상청 API 접속 시험: 정해진 주소를 한 번 호출해서 "성공했는지, 얼마나 걸렸는지, 응답이 어떤 모양인지"를 D1에 기록합니다.
// (실제 자료 저장은 이 기록으로 응답 형식을 확인한 뒤에 추가합니다)

const SECRET_PARAMS = /([?&](?:authKey|serviceKey|apikey|api_key|key)=)[^&#]*/gi;
export const maskUrl = (u) => String(u).replace(SECRET_PARAMS, '$1***');
const maskText = (t, key) => { let s = String(t); if (key) s = s.split(key).join('***'); return s.replace(SECRET_PARAMS, '$1***'); };

export function buildUrl(env) {
  const tpl = env.KMA_PROBE_URL;
  if (!tpl) throw new Error('KMA_PROBE_URL(시험할 기상청 주소)이 설정되지 않았습니다.');
  if (tpl.includes('{KEY}') && !env.KMA_KEY) throw new Error('KMA_KEY(인증키 비밀값)가 설정되지 않았습니다.');
  return tpl.split('{KEY}').join(encodeURIComponent(env.KMA_KEY || ''));
}

export async function runProbe(env, source = 'cron', fetchImpl = fetch) {
  const started = Date.now(), run = { started_at: new Date(started).toISOString(), source, ok: 0, http_status: null, ms: null, bytes: null, url_masked: null, snippet: null, error: null };
  try {
    const url = buildUrl(env);
    run.url_masked = maskUrl(url);
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(Number(env.KMA_TIMEOUT_MS) || 20000), headers: { 'User-Agent': 'snow-collector/1.0' } });
    const text = await res.text();
    run.http_status = res.status;
    run.bytes = text.length;
    run.snippet = maskText(text, env.KMA_KEY).slice(0, 400);
    run.ok = res.ok ? 1 : 0;
    if (!res.ok) run.error = `HTTP ${res.status}`;
  } catch (e) {
    run.error = maskText(e && e.message ? e.message : e, env.KMA_KEY).slice(0, 300);     // 타임아웃, 접속 거부 등
  }
  run.ms = Date.now() - started;
  await env.DB.prepare('INSERT INTO collector_runs (started_at, finished_at, source, ok, http_status, ms, bytes, url_masked, snippet, error) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .bind(run.started_at, new Date().toISOString(), run.source, run.ok, run.http_status, run.ms, run.bytes, run.url_masked, run.snippet, run.error).run();
  return run;
}
