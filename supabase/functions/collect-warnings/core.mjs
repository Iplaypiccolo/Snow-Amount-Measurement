// ============================================================
// collect-warnings — 기상청 API허브 특보현황을 받아 서버(warnings_active)에 넣는다
//  * 부르는 곳: pg_cron 이 10분마다(받을 필요가 있을 때만) private.kick_warnings() → pg_net (헤더 x-collector-token = 서버 안 전용 토큰)
//              또는 관리자 로그인 토큰(JWT)으로 직접(시험·급할 때)
//  * body {zones:true} 면 특보구역 목록(wrn_reg)도 다시 받음(매주 예약)
//  * body {raw:true} 면 기상청이 준 글(키 없음)과 줄 수 통계도 돌려줌 — 특보가 빠지지 않는지 확인용
//  * 기상청 키는 함수 비밀값 KMA_AUTH_KEY 에만 있다. 키가 들어간 주소는 오류·기록 어디에도 남기지 않는다.
//  * 받지 못하면(키 오류·시간 초과·형식 이상) 실패로 기록만 하고 지금 특보는 그대로 둔다(30분 넘게 실패하면 화면은 특보 없음)
//  * 순수 로직은 Node 로 시험: tests/test_collect_warnings.mjs
// ============================================================
export const NOW_URL = 'https://apihub.kma.go.kr/api/typ01/url/wrn_now_data_new.php?fe=f&tm=&disp=0&help=0&authKey=';
export const OLD_URL = 'https://apihub.kma.go.kr/api/typ01/url/wrn_now_data.php?fe=f&tm=&disp=0&help=0&authKey=';   // 새 주소 활용신청이 없을 때(같은 줄 모양, 기준시각 줄 없음)
export const REG_URL = 'https://apihub.kma.go.kr/api/typ01/url/wrn_reg.php?tmfc=0&authKey=';
const LEVELS = { '예비': '예비', '주의': '주의', '주의보': '주의', '경보': '경보' };

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });

// 'YYYYMMDDHHMM'(한국 시각) → ISO. 형식이 아니면 null
export function kst(s) {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(String(s || '').trim());
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00+09:00` : null;
}

// 밀리초 → 'YYYYMMDDHHMM'(한국 시각)
export const kstNow = (ms) => new Date(ms + 9 * 3600e3).toISOString().replace(/[-T:]/g, '').slice(0, 12);

// 특보현황 글 → { base, rows }. 형식이 맞지 않으면(키 오류 안내문 등) base 가 null
// 줄: REG_UP, REG_UP_KO, REG_ID, REG_KO, TM_FC, TM_EF, WRN, LVL, CMD, ED_TM,=
export function parseNow(text) {
  const out = { base: null, rows: [] };
  if (typeof text !== 'string') return out;
  for (const line of text.split(/\r?\n/)) {
    const b = /^#\s*기준시각\s*:\s*(\d{12})/.exec(line);
    if (b) { out.base = b[1]; continue; }
    if (!line.trim() || line[0] === '#') continue;
    const f = line.split(',').map((x) => x.trim());
    if (f.length < 9) continue;
    const [, , zone, , fc, ef, kind, lvl, cmd] = f, ed = (f[9] || '').replace(/=$/, '').trim();
    if (!/^L\d{7}$/.test(zone)) continue;                         // 육상 구역만(바다 S… 는 제외)
    const level = LEVELS[lvl]; if (!level || !kind) continue;
    if (/해제/.test(cmd) && !/예고/.test(cmd)) continue;          // 해제된 줄은 지금 특보가 아님
    out.rows.push({ zone, kind, level, tm_fc: kst(fc), tm_ef: kst(ef), cmd: cmd || null, ed_tm: ed || null });
  }
  return out;
}

// 특보구역 목록 → [{code, up, ko, name, sp, tm_st, tm_ed}]
// 줄: REG_ID TM_ST TM_ED REG_SP REG_UP REG_KO(칸 맞춤, 안에 빈칸 가능)  REG_NAME
export function parseReg(text) {
  const out = [];
  if (typeof text !== 'string') return out;
  for (const line of text.split(/\r?\n/)) {
    const m = /^([LS]\d{7})\s+(\d{12})\s+(\d{12})\s+(\d{8})\s+(\S+)\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    const [ko, name] = m[6].split(/\s{2,}/);
    out.push({ code: m[1], up: /^[LS]\d{7}$/.test(m[5]) ? m[5] : null, ko: ko.trim(), name: (name || '').trim() || null, sp: m[4], tm_st: kst(m[2]), tm_ed: kst(m[3]) });
  }
  return out;
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
  let body = {};
  try { body = await req.json(); } catch { body = {}; }
  const key = String(deps.env('KMA_AUTH_KEY') || '').trim();   // 붙여 넣을 때 섞인 빈칸·줄바꿈 제거
  const result = {};

  if (body && body.zones === true) {
    if (!key) result.zones = { ok: false, error: 'no_key' };
    else {
      const r = await deps.fetchText(REG_URL + encodeURIComponent(key));
      const zones = parseReg(r.text);
      if (zones.length < 50) result.zones = { ok: false, error: `zones_bad_response(http ${r.status})` };
      else { const { data, error } = await deps.store.ingestZones(zones); result.zones = error ? { ok: false, error: 'db' } : data; }
    }
  }

  const t0 = deps.now();
  let p;
  if (!key) p = { ok: false, error: 'KMA_AUTH_KEY 비밀값이 없음' };
  else {
    let r = await deps.fetchText(NOW_URL + encodeURIComponent(key)), src = 'new';
    if (r.status === 0 || r.status >= 500) { if (deps.sleep) await deps.sleep(3000); r = await deps.fetchText(NOW_URL + encodeURIComponent(key)); }   // 연결 실패·기상청 서버 오류는 3초 뒤 한 번 더
    if (r.status === 401 || r.status === 403) { r = await deps.fetchText(OLD_URL + encodeURIComponent(key)); src = 'old'; }   // 키에 새 주소 권한이 없으면 예전 주소
    const ms = deps.now() - t0;
    const parsed = parseNow(r.text);
    if (src === 'old' && r.status === 200 && !parsed.base && /^\s*#\s*START7777/m.test(r.text || '')) parsed.base = kstNow(deps.now());   // 예전 주소는 기준시각 줄이 없어 받은 시각으로
    const said = String(r.text || '').replace(/[0-9A-Za-z_-]{20,}/g, '…').replace(/\s+/g, ' ').trim().slice(0, 160);   // 기상청 안내문(키처럼 긴 글자는 가림)
    if (r.status !== 200) p = { ok: false, http: r.status, ms, error: r.status ? `기상청 응답 ${r.status}${said ? ': ' + said : ''}` : '기상청 연결 실패(시간 초과 등)' };
    else if (!parsed.base) p = { ok: false, http: r.status, ms, error: '기상청 응답 형식이 다름(키 확인 필요): ' + said };
    else p = { ok: true, http: r.status, ms, base: parsed.base, rows: parsed.rows, src };
    if (body && body.raw === true) {                 // 확인용: 받은 글 그대로(키는 주소에만 있어 글에는 없음)와 줄 종류별 개수
      const lines = String(r.text || '').split(/\r?\n/).filter((l) => l.trim() && l[0] !== '#');
      result.raw = { text: String(r.text || '').slice(0, 30000), lines: lines.length, land: lines.filter((l) => /^\s*\S*\s*,[^,]*,\s*L\d{7}/.test(l)).length, parsed: parsed.rows.length };
    }
  }
  const { data, error } = await deps.store.ingest(p);
  if (error) return json(500, { ok: false, error: 'db', ...result });
  return json(200, { ...data, base: p.base || null, rows: p.rows ? p.rows.length : 0, snow: p.rows ? p.rows.filter((x) => x.kind === '대설').length : 0, src: p.src, error: p.ok ? undefined : p.error, ...result });
}
