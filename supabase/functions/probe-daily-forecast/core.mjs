// 일별 예보 준비용 읽기 전용 점검. 기존 수집 토큰만 허용하며 DB에는 쓰지 않는다.
// 주소·구역·발표시각은 서버가 정한다. 임의 URL/인증키/과거기간을 입력받지 않는다.
import { gridStats } from '../collect-forecast/core.mjs';

const BASE = 'https://apihub.kma.go.kr/api/typ01/';
const KINDS = ['regions', 'land', 'temperature', 'SKY', 'TMN', 'TMX'];
const reply = (status, body) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
});

// 생산 직후의 미제공 자료를 피한다. 중기 06/18시, 단기 02/05/08/11/14/17/20/23시.
export function issue(now, mid = true) {
  const d = new Date(now - 90 * 60000 + 9 * 3600e3);
  const hours = mid ? [6, 18] : [2, 5, 8, 11, 14, 17, 20, 23];
  let h = hours.filter(h => h <= d.getUTCHours()).at(-1);
  if (h === undefined) { d.setUTCDate(d.getUTCDate() - 1); h = hours.at(-1); }
  d.setUTCHours(h, 0, 0, 0);
  return d.toISOString().replace(/[-T:]/g, '').slice(0, 10);
}

export function requestFor(kind, now) {
  if (!KINDS.includes(kind)) return null;
  if (kind === 'regions') return { path: 'url/fct_medm_reg.php', params: { tmfc: '0' } };
  if (kind === 'land' || kind === 'temperature') return {
    path: 'url/' + (kind === 'land' ? 'fct_afs_wl.php' : 'fct_afs_wc.php'),
    params: { reg: '', tmfc1: issue(now), tmfc2: issue(now), disp: '1', help: '1' },
  };
  const tmfc = issue(now, false), date = tmfc.slice(0, 8);
  const next = new Date(Date.UTC(+date.slice(0, 4), +date.slice(4, 6) - 1, +date.slice(6, 8) + 1));
  const day = next.toISOString().slice(0, 10).replace(/-/g, '');
  return { path: 'cgi-bin/url/nph-dfs_shrt_grd', params: {
    tmfc, tmef: day + (kind === 'TMN' ? '06' : kind === 'TMX' ? '15' : '12'), vars: kind,
  } };
}

export async function handle(req, deps) {
  if (req.method !== 'POST') return reply(405, { ok: false, error: 'post_required' });
  const token = req.headers.get('x-collector-token');
  try {
    if (!token || !(await deps.tokenOk(token))) return reply(401, { ok: false, error: 'unauthorized' });
  } catch { return reply(503, { ok: false, error: 'auth_unavailable' }); }
  let body;
  try {
    const text = await req.text();
    if (text.length > 1000) return reply(400, { ok: false, error: 'bad_request' });
    body = JSON.parse(text);
  } catch { return reply(400, { ok: false, error: 'bad_json' }); }
  const kind = body?.kind, spec = requestFor(kind, deps.now());
  if (!spec || Object.keys(body).some(k => k !== 'kind')) return reply(400, { ok: false, error: 'bad_request' });
  const key = String(deps.env('KMA_AUTH_KEY') || '').trim();
  if (!key) return reply(503, { ok: false, error: 'missing_kma_key' });
  const url = new URL(BASE + spec.path);
  for (const [k, v] of Object.entries(spec.params)) url.searchParams.set(k, v);
  url.searchParams.set('authKey', key);
  let r;
  try { r = await deps.fetchText(url.href); }
  catch { return reply(502, { ok: false, kind, error: 'upstream_unavailable' }); }
  // 기상청 오류가 요청 주소를 반사해도 키를 반환하지 않는다. 원본 오류/주소는 로그에도 쓰지 않는다.
  const formKey = new URLSearchParams({ authKey: key }).toString().slice('authKey='.length);
  const text = String(r.text || '').split(key).join('[redacted]').split(encodeURIComponent(key)).join('[redacted]').split(formKey).join('[redacted]');
  const out = { ok: r.status === 200, kind, status: r.status, params: spec.params, bytes: r.bytes };
  if (['SKY', 'TMN', 'TMX'].includes(kind)) {
    out.stats = gridStats(text);
    out.ok = out.ok && out.stats?.ok === true;
    if (!out.ok) out.text = text.slice(0, 800);
  } else {
    out.text = text.slice(0, 80000);
    out.truncated = text.length > 80000;
    out.rows = text.split(/\r?\n/).filter(s => s.trim() && !s.trim().startsWith('#')).length;
    out.ok = out.ok && out.rows > 0 && !/<html|<error|API\s*key|인증키|ERROR_MESSAGE/i.test(text);
  }
  return reply(200, out);
}
