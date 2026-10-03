// ============================================================
// import-reference — 기준정보 이전 (관리자 전용)
//  * GitHub 의 공개 자료(data/*.json)를 서버(Supabase) 안에서 직접 읽어 DB 표(구간·관측소·지사별 관측소·예보 격자 편입)로 옮긴다.
//    → 자료가 이 대화나 사용자의 PC 를 거치지 않는다.
//  * 인증: 관리자 로그인 토큰(JWT) 또는 일회용 시작 토큰(x-bootstrap-token) — account-admin 과 같은 방식
//  * 동작: action "plan" = 읽고 검사해서 요약만 돌려줌(DB 변경 없음), action "load" = 검사 통과 시 DB 함수가 한 번에 교체(전부 성공 또는 전부 취소)
//  * 순수 로직(build)은 Node 로 시험 가능: tests/test_import_reference.mjs
// ============================================================
export const REPO = 'Iplaypiccolo/Snow-Amount-Measurement';
const REF_RE = /^(main|[0-9a-f]{7,40})$/;
const FILES = ['sections', 'stations', 'hierarchy', 'grid_assign', 'jurisdiction_changes', 'grid_changes'];
const MAX_FILE = 5 * 1024 * 1024;

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-bootstrap-token', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
const fail = (status, error, message, extra = {}) => json(status, { ok: false, error, message, ...extra });

export class ImportError extends Error { constructor(code, message) { super(message); this.code = code; } }
const bad = (code, msg) => { throw new ImportError(code, msg); };
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

/* ---------- 변환·검사 (순수 함수) ---------- */
export function build(f) {
  const sec = f.sections, st = f.stations, hi = f.hierarchy, gr = f.grid_assign;
  if (!sec || !Array.isArray(sec.sections) || !Array.isArray(sec.branches) || !sec.sections.length) bad('sections', 'data/sections.json 형식이 올바르지 않습니다.');
  for (const [name, doc] of [['jurisdiction_changes', f.jurisdiction_changes], ['grid_changes', f.grid_changes]]) {
    if (!doc || !Array.isArray(doc.events)) bad(name, `data/${name}.json 형식이 올바르지 않습니다.`);
    if (doc.events.length) bad('events_not_empty', `data/${name}.json 에 저장된 변경 이력이 ${doc.events.length}건 있습니다. 변경 이력은 별도로 옮겨야 하므로 지금은 중단합니다.`);
  }
  const branchIds = new Set(sec.branches.map((b) => b.id));
  if (branchIds.size !== sec.branches.length) bad('branches', '지사 번호가 겹칩니다.');
  const byName = new Map(sec.branches.map((b) => [b.hq + '\u0000' + b.name, b.id]));

  const seen = new Set(), sections = [];
  for (const s of sec.sections) {
    if (typeof s.id !== 'string' || !/^S\d{4}$/.test(s.id) || seen.has(s.id)) bad('sections', `구간 번호가 올바르지 않거나 겹칩니다: ${s.id}`);
    seen.add(s.id);
    if (s.owner != null && !branchIds.has(s.owner)) bad('sections', `${s.id}: 없는 지사 번호 ${s.owner}`);
    if (!isNum(s.km) || s.km < 0 || !Number.isInteger(s.order) || typeof s.chain !== 'string') bad('sections', `${s.id}: 길이·순서·노선 묶음이 올바르지 않습니다.`);
    if (!Array.isArray(s.coords) || s.coords.length < 2 || s.coords.some((c) => !Array.isArray(c) || c.length < 2 || !isNum(c[0]) || !isNum(c[1]) || c[0] < 124 || c[0] > 132 || c[1] < 33 || c[1] > 39)) bad('sections', `${s.id}: 좌표가 올바르지 않거나 한국 범위를 벗어났습니다.`);
    sections.push({ id: s.id, route: s.route, from_name: s['from'], to_name: s.to, km: s.km, owner_id: s.owner == null ? null : s.owner, chain: s.chain, ord: s.order, coords: s.coords });
  }

  if (!st || !Array.isArray(st.stations)) bad('stations', 'data/stations.json 형식이 올바르지 않습니다.');
  const stations = new Map();
  for (const s of st.stations) {
    if (!Number.isInteger(s.id) || typeof s.name !== 'string' || !isNum(s.lat) || !isNum(s.lon)) bad('stations', `관측소 정보가 올바르지 않습니다: ${JSON.stringify(s).slice(0, 80)}`);
    if (stations.has(s.id)) bad('stations', `관측소 번호가 겹칩니다: ${s.id}`);
    stations.set(s.id, { id: s.id, name: s.name, addr: s.addr == null ? null : s.addr, lat: s.lat, lon: s.lon });
  }
  if (!hi || !Array.isArray(hi.hq)) bad('hierarchy', 'data/hierarchy.json 형식이 올바르지 않습니다.');
  const bs = [], pair = new Set();
  for (const h of hi.hq) for (const b of h.branches) {
    const id = byName.get(h.name + '\u0000' + b.name);
    if (!id) bad('hierarchy', `지사를 찾을 수 없습니다: ${h.name} ${b.name}`);
    for (const x of b.stations || []) {
      const have = stations.get(x.id);
      if (!have) stations.set(x.id, { id: x.id, name: x.name, addr: x.addr == null ? null : x.addr, lat: x.lat, lon: x.lon });
      else if (Math.abs(have.lat - x.lat) > 1e-9 || Math.abs(have.lon - x.lon) > 1e-9) bad('stations', `관측소 ${x.id} 의 좌표가 파일마다 다릅니다.`);
      if (!isNum(x.dist_km) || x.dist_km < 0) bad('hierarchy', `${b.name}: 관측소 ${x.id} 거리가 올바르지 않습니다.`);
      const k = id + ':' + x.id; if (pair.has(k)) bad('hierarchy', `지사-관측소가 겹칩니다: ${k}`); pair.add(k);
      bs.push({ branch_id: id, station_id: x.id, dist_km: x.dist_km, road: x.road == null ? null : x.road });
    }
  }
  if (!gr || !Array.isArray(gr.cells)) bad('grid_assign', 'data/grid_assign.json 형식이 올바르지 않습니다.');
  const grid = [], gp = new Set();
  for (const c of gr.cells) {
    if (!Array.isArray(c) || !Number.isInteger(c[0]) || !Number.isInteger(c[1]) || c[0] < 1 || c[0] > 149 || c[1] < 1 || c[1] > 253 || !Array.isArray(c[2])) bad('grid_assign', `격자 칸 정보가 올바르지 않습니다: ${JSON.stringify(c).slice(0, 60)}`);
    for (const b of c[2]) {
      if (!branchIds.has(b)) bad('grid_assign', `격자 ${c[0]},${c[1]}: 없는 지사 번호 ${b}`);
      const k = c[0] + ',' + c[1] + ',' + b; if (gp.has(k)) bad('grid_assign', `격자-지사가 겹칩니다: ${k}`); gp.add(k);
      grid.push({ nx: c[0], ny: c[1], branch_id: b });
    }
  }
  const stationRows = [...stations.values()].sort((a, b) => a.id - b.id);
  const km = sections.reduce((a, s) => a + s.km, 0);
  const summary = {
    sections: sections.length, sections_unassigned: sections.filter((s) => s.owner_id == null).length, section_points: sections.reduce((a, s) => a + s.coords.length, 0), section_km: Math.round(km * 1000) / 1000,
    stations: stationRows.length, branch_stations: bs.length, grid_assign: grid.length, grid_cells: new Set(grid.map((g) => g.nx + ',' + g.ny)).size,
  };
  return { payload: { stations: stationRows, sections, branch_stations: bs, grid_assign: grid }, summary };
}

/* ---------- 인증 (account-admin 과 같은 방식) ---------- */
async function authenticate(req, d) {
  const boot = req.headers.get('x-bootstrap-token');
  if (boot) {
    if (!(await d.store.consumeBootstrap(await d.sha256hex(boot), d.now()))) return { res: fail(403, 'bad_bootstrap', '시작 토큰이 올바르지 않거나 만료되었습니다.') };
    return { actor: { id: null, username: 'bootstrap', bootstrap: true } };
  }
  const m = /^Bearer (.+)$/.exec(req.headers.get('authorization') || '');
  if (!m) return { res: fail(401, 'not_logged_in', '로그인이 필요합니다.') };
  const u = await d.auth.getUser(m[1]);
  if (!u.id) return { res: fail(401, 'not_logged_in', '로그인이 필요합니다.') };
  const p = await d.store.getProfileById(u.id);
  if (!p || p.disabled || p.must_change || p.role !== 'admin') return { res: fail(403, 'forbidden', '관리자만 할 수 있는 작업입니다.') };
  return { actor: { id: u.id, username: p.username, bootstrap: false } };
}

export async function handle(req, d) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return fail(405, 'method_not_allowed', 'POST 만 지원합니다.');
  let body;
  try { const t = await req.text(); if (t.length > 4096) return fail(413, 'too_large', '요청이 너무 큽니다.'); body = JSON.parse(t); if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('shape'); }
  catch { return fail(400, 'bad_request', '요청 형식이 올바르지 않습니다.'); }
  const a = await authenticate(req, d); if (a.res) return a.res;
  const action = body.action, ref = body.ref == null ? 'main' : body.ref;
  if (action !== 'plan' && action !== 'load') return fail(400, 'bad_action', '알 수 없는 작업입니다.');
  if (typeof ref !== 'string' || !REF_RE.test(ref)) return fail(400, 'bad_ref', "ref 는 'main' 또는 커밋 번호(7~40자리 16진수)여야 합니다.");
  try {
    const files = {};
    for (const name of FILES) {
      const text = await d.fetchText(`https://raw.githubusercontent.com/${REPO}/${ref}/data/${name}.json`);
      if (typeof text !== 'string' || text.length > MAX_FILE) return fail(502, 'fetch_failed', `data/${name}.json 을 불러오지 못했습니다.`);
      try { files[name] = JSON.parse(text); } catch { return fail(502, 'fetch_failed', `data/${name}.json 이 올바른 JSON 이 아닙니다.`); }
    }
    const { payload, summary } = build(files);
    if (action === 'plan') return json(200, { ok: true, action, ref, summary, message: '검사만 했습니다. 데이터베이스는 바뀌지 않았습니다.' });
    const r = await d.store.importReference(payload);
    if (r.error) return fail(500, 'import_failed', '데이터베이스에 넣지 못했습니다. 아무것도 바뀌지 않았습니다.', { detail: r.error.message });
    const c = r.counts || {};
    const same = c.sections === summary.sections && c.stations === summary.stations && c.branch_stations === summary.branch_stations && c.grid_assign === summary.grid_assign;
    return json(same ? 200 : 500, { ok: same, action, ref, summary, counts: c, message: same ? '기준정보를 옮겼습니다.' : '넣은 개수가 검사한 개수와 다릅니다. 확인이 필요합니다.' });
  } catch (e) {
    if (e instanceof ImportError) return fail(422, e.code, e.message);
    console.error('import-reference error', e && e.message);
    return fail(500, 'server_error', '서버 오류가 발생했습니다.');
  }
}
