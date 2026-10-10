// ============================================================
// collect-forecast — 기상청 단기예보 격자(SNO = 1시간 신적설 cm, PCP = 1시간 강수량 mm, TMP = 기온 ℃, POP = 강수확률 %)를 1시간치씩 받아 지사 격자만 골라 서버에 넣는다
//  * 부르는 곳: pg_cron(발표 시각 15·25·35·45분, 받을 필요가 있을 때만) 또는 기준일자를 만들 때 → private.kick_forecast() → pg_net
//    (헤더 x-collector-token = 서버 안 전용 토큰). 관리자 로그인 토큰으로도 직접 부를 수 있음.
//  * 서버(forecast_plan)가 "가장 최근 발표분 · 받기 시작한 시각의 다음 정시부터 24시간" 중 아직 없는 [종류, 시각](적설 24 + 강수 24 = 48)을 알려 주면
//    한 시각씩 요청(요청 1번 = 전국 149×253 격자 1시간치, 약 340KB) → 지사 격자만 골라 forecast_put.
//    48개가 다 모이면 서버가 격자별 24시간 합(forecast_cells)과 지사별 최댓값(branch_forecast)을 만든다.
//  * 기상청이 자주 504(시간 초과)를 주므로 2초 뒤 최대 3번 다시. 요청 사이 0.5초. 120초가 넘으면 멈추고 다음 예약 때 이어서.
//  * 기상청 키는 함수 비밀값 KMA_AUTH_KEY 에만. 키가 들어간 주소는 오류·기록에 남기지 않는다.
//  * 받을 종류·순서는 서버(forecast_plan)가 정함: 적설·강수·기온 먼저, 강수확률은 그다음(마이그레이션 42). 이 함수는 목록대로 받기만 함
//  * 시험 호출 {"probe":"POP"}: 그 종류를 한 시각만 받아 요약(개수·최소·최대)만 돌려줌. 저장하지 않음 — 새 종류를 넣기 전에 기상청이 주는지 확인하는 용도
//  * 순수 로직은 Node 로 시험: tests/test_collect_forecast.mjs
// ============================================================
export const GRID_URL = 'https://apihub.kma.go.kr/api/typ01/cgi-bin/url/nph-dfs_shrt_grd';
export const NX = 149, NY = 253;
const BUDGET_MS = 120000, GAP_MS = 500, RETRY_MS = 2000, TRIES = 4;   // 무료 플랜 함수 한 번 최대 150초

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });

// ISO 시각 → 'YYYYMMDDHH'(한국 시각)
export const kstHour = (iso) => new Date(Date.parse(iso) + 9 * 3600e3).toISOString().replace(/[-T:]/g, '').slice(0, 10);

// 격자 글(쉼표·빈칸으로 나뉜 37,697개 값, 첫 줄 = 남쪽 ny=1) → 고른 격자 [[nx, ny]…] 순서의 값. 형식이 다르면 null
export function pickCells(text, cells) {
  if (typeof text !== 'string') return null;
  const v = text.split(/[\s,]+/); if (v.length && v[v.length - 1] === '') v.pop(); if (v.length && v[0] === '') v.shift();   // 앞뒤 빈칸·줄 끝 쉼표
  if (v.length !== NX * NY) return null;
  const out = new Array(cells.length);
  for (let k = 0; k < cells.length; k++) {
    const [nx, ny] = cells[k], x = Number(v[(ny - 1) * NX + (nx - 1)]);
    if (!Number.isFinite(x)) return null;
    out[k] = x;
  }
  return out;
}

// 격자 글 전체의 요약(시험 호출용): 값 개수, 없는 값(-90 이하)을 뺀 최소·최대, 서로 다른 값 몇 개
export const PROBE_VARS = ['SNO', 'PCP', 'TMP', 'POP', 'PTY'];
export function gridStats(text) {
  if (typeof text !== 'string') return null;
  const v = text.split(/[\s,]+/).filter((x) => x !== '').map(Number);
  if (v.length !== NX * NY || v.some((x) => !Number.isFinite(x))) return { n: v.length, ok: false };
  const good = v.filter((x) => x > -90), uniq = [...new Set(good)].sort((a, b) => a - b);
  return { n: v.length, ok: true, valid: good.length, min: good.length ? uniq[0] : null, max: good.length ? uniq[uniq.length - 1] : null, distinct: uniq.length, sample: uniq.slice(0, 12) };
}

async function allowed(req, deps) {
  const t = req.headers.get('x-collector-token');
  if (t) return await deps.store.tokenOk(t);
  const jwt = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!jwt) return false;
  const u = await deps.auth.getUser(jwt);
  if (!u || !u.id) return false;
  const p = await deps.store.getProfileById(u.id);
  return !!(p && p.role === 'admin' && !p.disabled);
}

export async function handle(req, deps) {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json(405, { ok: false, error: 'method' });
  if (!(await allowed(req, deps))) return json(401, { ok: false, error: 'unauthorized' });
  const key = String(deps.env('KMA_AUTH_KEY') || '').trim();
  if (!key) { await deps.store.fail('KMA_AUTH_KEY 비밀값이 없음'); return json(200, { ok: false, error: 'no_key' }); }

  let body = {}; try { body = (await req.json()) || {}; } catch (e) { body = {}; }
  if (body.probe) {                                   // 시험 호출: 한 시각만 받아 요약만(저장 안 함)
    const v = String(body.probe).toUpperCase();
    if (!PROBE_VARS.includes(v)) return json(400, { ok: false, error: 'bad_probe' });
    const { data: pl } = await deps.store.plan();
    if (!pl || !pl.tmfc) return json(500, { ok: false, error: 'db' });
    const ef = new Date(Date.parse(pl.tmfc) + 6 * 3600e3).toISOString();
    const r = await deps.fetchText(`${GRID_URL}?tmfc=${kstHour(pl.tmfc)}&tmef=${kstHour(ef)}&vars=${v}&authKey=${encodeURIComponent(key)}`);
    const stats = r.status === 200 ? gridStats(r.text) : null;
    const head = stats && stats.ok ? undefined : String(r.text || '').slice(0, 160).split(key).join('***');      // 격자가 아니면 기상청 안내문 앞부분(키는 가림)
    return json(200, { ok: r.status === 200 && !!(stats && stats.ok), probe: v, status: r.status, tmfc: kstHour(pl.tmfc), tmef: kstHour(ef), stats, head });
  }

  const { data: plan, error } = await deps.store.plan();
  if (error || !plan) return json(500, { ok: false, error: 'db' });
  if (plan.done) return json(200, { ok: true, done: true, tmfc: plan.tmfc });
  if (!plan.cells || !plan.cells.length) return json(200, { ok: false, error: 'no_cells' });

  const t0 = deps.now(), tmfc = kstHour(plan.tmfc);
  let put = 0, lastErr = null, done = false;
  for (const [v, tmef] of plan.missing) {
    if (deps.now() - t0 > BUDGET_MS) { lastErr = lastErr || '시간이 모자라 다음 예약 때 이어서'; break; }
    const url = `${GRID_URL}?tmfc=${tmfc}&tmef=${kstHour(tmef)}&vars=${v}&authKey=${encodeURIComponent(key)}`;
    let vals = null, status = 0;
    for (let i = 0; i < TRIES && !vals; i++) {
      if (i) await deps.sleep(RETRY_MS);
      const r = await deps.fetchText(url); status = r.status;
      vals = r.status === 200 ? pickCells(r.text, plan.cells) : null;
      if (r.status === 200 && !vals) { status = 'format'; break; }        // 형식이 다르면(키 오류 안내문 등) 다시 해도 같음
    }
    if (!vals) { lastErr = status === 'format' ? '기상청 격자 형식이 다름(키·주소 확인)' : `기상청 응답 ${status || '연결 실패'} (${v} ${kstHour(tmef)})`; break; }
    const { data: res, error: e2 } = await deps.store.put(plan.tmfc, v, tmef, vals);
    if (e2) { lastErr = 'DB 저장 실패'; break; }
    put++; done = !!(res && res.done);
    if (done) break;
    await deps.sleep(GAP_MS);
  }
  if (lastErr && !done) await deps.store.fail(lastErr);
  return json(200, { ok: !lastErr || done, done, tmfc, hours: put, missing: plan.missing.length - put, error: done ? undefined : lastErr || undefined });
}
