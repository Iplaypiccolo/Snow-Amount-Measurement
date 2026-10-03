// ============================================================
// import-snow — 일 신적설을 서버(snow_daily)에 넣고, 화면용 요약본(snapshots 'snow')을 다시 만든다 (관리자 전용)
//  * 자료 두 가지:
//      ① txt  : 기상청 API허브 콘솔 스크립트가 만든 메모장 파일 그대로("#### DATE YYYYMMDD ####" + 관측 줄). 앞으로 새 자료는 이것으로 넣는다.
//      ② github: 예전 파일 data/snow_data.json 의 stationData (처음 한 번 옮길 때만. 서버 안에서 GitHub 파일을 직접 읽음)
//  * 기상청 결측 표시(-99.9 등 음수)와 시즌(11.15~3.15) 밖 날짜는 DB 함수가 걸러 내고 개수만 알려 준다.
//  * action "plan" = 넣지 않고 새 값·바뀔 값·같은 값 개수만 셈, "load" = 실제로 넣고 요약본을 다시 만듦
//    overwrite=false(기본)면 이미 있는 값은 그대로 두고 새 값만 넣는다. 바뀔 값이 있으면 plan 결과를 사람이 보고 overwrite=true 로 다시 부른다.
//  * 인증: 관리자 로그인 토큰(JWT) 또는 일회용 시작 토큰(x-bootstrap-token, 한 번 쓰면 바로 지워짐)
//  * 순수 로직은 Node 로 시험: tests/test_import_snow.mjs
// ============================================================
export const REPO = 'Iplaypiccolo/Snow-Amount-Measurement';
const REF_RE = /^(main|[0-9a-f]{7,40})$/;
const MAX_BODY = 20 * 1024 * 1024, MAX_FILE = 20 * 1024 * 1024;
export const CHUNK_STATIONS = 80;          // DB 함수 한 번에 넘기는 관측소 수(값 약 5만 개)

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-bootstrap-token', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
const fail = (status, error, message, extra = {}) => json(status, { ok: false, error, message, ...extra });

export class ImportError extends Error { constructor(code, message) { super(message); this.code = code; } }
const bad = (code, msg) => { throw new ImportError(code, msg); };

/* ---------- 메모장(txt) 읽기: 화면의 예전 업로드(app.js parseSnowText)와 같은 규칙 ---------- */
// 돌려주는 값: { data: { 관측소번호: { YYYYMMDD: 값 } }, lines, dates:[처음, 끝] }
export function parseTxt(text) {
  if (typeof text !== 'string' || !text.trim()) bad('empty', '내용이 없습니다.');
  const data = {}; let date = null, lines = 0, first = null, last = null;
  for (const line of text.split(/\r?\n/)) {
    const m = /DATE (\d{8})/.exec(line);
    if (m) { date = m[1]; continue; }
    if (!line || line[0] === '#') continue;
    const p = line.split(',').map((s) => s.trim());
    if (p.length < 7 || !date) continue;
    const stn = parseInt(p[1], 10), v = parseFloat(p[6]);
    if (!Number.isInteger(stn) || !Number.isFinite(v)) continue;
    (data[stn] ||= {})[date] = v; lines++;
    if (!first || date < first) first = date; if (!last || date > last) last = date;
  }
  if (!lines) bad('no_rows', '관측 줄을 하나도 읽지 못했습니다. 기상청 콘솔 스크립트로 만든 파일인지 확인하세요.');
  return { data, lines, dates: [first, last] };
}

// 예전 파일(snow_data.json)에서 stationData 꺼내기
export function fromSnowJson(doc) {
  const sd = doc && doc.stationData;
  if (!sd || typeof sd !== 'object' || Array.isArray(sd)) bad('bad_file', 'snow_data.json 에 stationData 가 없습니다.');
  let n = 0, first = null, last = null;
  for (const [stn, rec] of Object.entries(sd)) {
    if (!/^\d{1,6}$/.test(stn) || !rec || typeof rec !== 'object') bad('bad_file', '관측소 번호가 올바르지 않습니다: ' + stn);
    for (const [d, v] of Object.entries(rec)) {
      if (!/^\d{8}$/.test(d) || typeof v !== 'number') bad('bad_file', `값이 올바르지 않습니다: ${stn} ${d}`);
      n++; if (!first || d < first) first = d; if (!last || d > last) last = d;
    }
  }
  return { data: sd, lines: n, dates: [first, last] };
}

// 관측소를 묶음으로 나눔(DB 함수 한 번에 너무 많이 보내지 않도록)
export function chunks(data, size = CHUNK_STATIONS) {
  const keys = Object.keys(data), out = [];
  for (let i = 0; i < keys.length; i += size) { const c = {}; keys.slice(i, i + size).forEach((k) => { c[k] = data[k]; }); out.push(c); }
  return out;
}
const SUM_KEYS = ['new', 'changed', 'same', 'skipped_missing', 'skipped_out_of_season', 'written'];
export function addCounts(a, b) { const o = { ...a }; SUM_KEYS.forEach((k) => { o[k] = (a[k] || 0) + (b[k] || 0); }); return o; }

/* ---------- 인증 ---------- */
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

/* ---------- 요청 처리 ---------- */
// body: { action: 'plan'|'load', overwrite?: boolean, txt?: string, source?: 'github', ref?: 'main'|커밋번호 }
export async function handle(req, d) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return fail(405, 'method_not_allowed', 'POST 만 지원합니다.');
  let body;
  try { const t = await req.text(); if (t.length > MAX_BODY) return fail(413, 'too_large', '요청이 너무 큽니다(20MB 이하).'); body = JSON.parse(t); if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('shape'); }
  catch { return fail(400, 'bad_request', '요청 형식이 올바르지 않습니다.'); }
  const a = await authenticate(req, d); if (a.res) return a.res;
  const action = body.action, overwrite = body.overwrite === true;
  if (action !== 'plan' && action !== 'load') return fail(400, 'bad_action', '알 수 없는 작업입니다.');
  try {
    let src, label;
    if (typeof body.txt === 'string') { src = parseTxt(body.txt); label = 'txt'; }
    else if (body.source === 'github') {
      const ref = body.ref == null ? 'main' : body.ref;
      if (typeof ref !== 'string' || !REF_RE.test(ref)) return fail(400, 'bad_ref', "ref 는 'main' 또는 커밋 번호여야 합니다.");
      const text = await d.fetchText(`https://raw.githubusercontent.com/${REPO}/${ref}/data/snow_data.json`);
      if (typeof text !== 'string' || text.length > MAX_FILE) return fail(502, 'fetch_failed', 'data/snow_data.json 을 불러오지 못했습니다.');
      let doc; try { doc = JSON.parse(text); } catch { return fail(502, 'fetch_failed', 'data/snow_data.json 이 올바른 JSON 이 아닙니다.'); }
      src = fromSnowJson(doc); label = 'github:' + ref;
    } else return fail(400, 'no_source', 'txt 또는 source:"github" 가 필요합니다.');

    let counts = {};
    for (const c of chunks(src.data)) {
      const r = await d.store.importSnow(c, overwrite, action === 'plan');
      if (r.error) return fail(500, 'import_failed', '데이터베이스에 넣는 중 오류가 났습니다.' + (action === 'load' ? ' 앞 묶음은 들어갔을 수 있으니 plan 으로 다시 확인하세요.' : ''), { detail: r.error.message, counts });
      counts = addCounts(counts, r.counts || {});
    }
    const summary = { source: label, stations: Object.keys(src.data).length, values: src.lines, dates: src.dates };
    if (action === 'plan') return json(200, { ok: true, action, summary, counts, message: counts.changed ? `이미 있는 값 중 ${counts.changed}개가 다릅니다. 바꾸려면 overwrite:true 로 넣으세요.` : '검사만 했습니다. 데이터베이스는 바뀌지 않았습니다.' });
    const snap = await d.store.rebuildSnapshot();
    if (snap.error) return fail(500, 'snapshot_failed', '값은 넣었지만 화면용 요약본을 만들지 못했습니다. 다시 load 하면 요약본을 다시 만듭니다.', { detail: snap.error.message, counts });
    await d.store.logUpload({ date_from: src.dates[0] ? src.dates[0].replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3') : null, date_to: src.dates[1] ? src.dates[1].replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3') : null,
      stations: summary.stations, rows_written: counts.written || 0, ok: true, note: `${label} by ${a.actor.username}${overwrite ? ' (덮어쓰기)' : ''}` });
    return json(200, { ok: true, action, summary, counts, snapshot: snap.result, message: `${counts.written || 0}개 값을 저장하고 요약본을 다시 만들었습니다.` });
  } catch (e) {
    if (e instanceof ImportError) return fail(422, e.code, e.message);
    console.error('import-snow error', e && e.message);
    return fail(500, 'server_error', '서버 오류가 발생했습니다.');
  }
}
