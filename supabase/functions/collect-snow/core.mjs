// ============================================================
// collect-snow — 일 신적설 자동 수집: 기상청 kma_snow1.php(sd=day)를 그날 00~23시 받아 관측소별 그날 최댓값을 서버에 넣는다
//  * 손으로 받던 콘솔 스크립트(데이터 출처 탭)와 같은 계산: 시각마다 "그날 0시부터의 신적설"을 받고, 관측소마다 가장 큰 값 = 일 신적설
//  * 부르는 곳: pg_cron(시즌에만 한국 01:10부터 30분마다 11:40까지 — 하루치를 다 받으면 그 뒤는 부르지 않음) → private.kick_snow() → pg_net (헤더 x-collector-token)
//    날짜를 정해 부를 수도 있음: { date:'YYYYMMDD', dry:true } (dry = 넣지 않고 기존 값과 비교만)
//  * 서버(snow_plan)가 이미 받은 시각을 알려 주면 남은 시각만 받음. 시각마다 snow_put(더 큰 값만 반영), 끝에 snow_finish(요약본 다시 만들기)
//  * 기상청이 가끔 응답이 늦거나 504(30초 시간 초과)를 줌: 정상 응답은 1초 안팎이라 15초 넘게 걸리면 끊고 1초 뒤 한 번 더.
//    함수 한 번은 약 115초 안에 끝냄(무료 플랜 최대 150초). 못 받은 시각은 다음 예약(30분마다, 11:40까지) 때 그 시각만.
//  * 기상청 키는 함수 비밀값 KMA_AUTH_KEY 에만. 키가 들어간 주소는 오류·기록에 남기지 않는다.
//  * 시험 호출 {"probe":"YYYYMMDD","sd":"day","mi":"00"}: 그날 00~23시(분 = mi)를 받아 저장하지 않고 요약만 돌려줌 — 값이 매시 바뀌는지(1시간 간격인지),
//    시각이 지나며 줄어드는 일이 있는지 확인용(2026-10-18). sd = day(일 신적설) / 3hr / 24h / tot(적설)
//    "raw":true,"hh":"06" 이면 그 한 시각의 원문 머리말·자료 몇 줄(어떤 칸이 오는지 확인용, 2026-10-19)
//  * 비교 {"compare":"YYYYMMDD"}: 기간 조회(kma_snow2) 하루치 한 번 ↔ 서버 snow_daily 그날 값(관측소별). 저장하지 않음(2026-10-19)
//  * 순수 로직은 Node 로 시험: tests/test_collect_snow.mjs
// ============================================================
export const SNOW_URL = 'https://apihub.kma.go.kr/api/typ01/url/kma_snow1.php';
export const CALL_MS = 15000;                                           // 기상청 한 번 기다리는 최대 시간(index.ts 가 끊음)
const BUDGET_MS = 115000, GAP_MS = 300, RETRY_MS = 1000, TRIES = 2;   // 무료 플랜 함수 한 번 최대 150초

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });

// 기상청 글 → { 관측소번호: 값 }. 줄 모양: "YYYYMMDDHHMI, 관측소, 이름, 경도, 위도, 종류, 신적설(cm),="
// 다른 시각의 줄은 버림. 관측 줄이 하나도 없으면 null(형식이 다르거나 오류 글)
export function parseSnow(text, tm) {
  if (typeof text !== 'string' || !text.includes('#START7777')) return null;
  const out = {}; let n = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line || line[0] === '#') continue;
    const p = line.split(',').map((s) => s.trim());
    if (p.length < 7 || p[0] !== tm) continue;
    const stn = p[1], v = Number(p[6]);
    if (!/^\d{1,6}$/.test(stn) || p[6] === '' || !Number.isFinite(v)) continue;
    out[stn] = v; n++;
  }
  return n ? out : null;
}

// 시험 호출 요약: byHour = 시각마다 { 관측소: 값 } 또는 null → 관측소 수, 시각마다 값이 바뀐 관측소 수(늘어남·줄어듦), 값이 가장 큰 관측소 6곳의 24시각 값
export function seriesStats(byHour) {
  const stns = new Set(); byHour.forEach((m) => m && Object.keys(m).forEach((k) => stns.add(k)));
  const up = Array(byHour.length).fill(0), down = Array(byHour.length).fill(0), series = {};
  for (const s of stns) {
    const v = byHour.map((m) => (m && s in m ? m[s] : null)); series[s] = v;
    for (let h = 1; h < v.length; h++) { if (v[h] == null || v[h - 1] == null || v[h] === v[h - 1]) continue; (v[h] > v[h - 1] ? up : down)[h]++; }
  }
  const peak = (s) => Math.max(...series[s].map((x) => (x == null ? -1 : x)));
  const top = [...stns].sort((a, b) => peak(b) - peak(a)).slice(0, 6).map((s) => [s, series[s]]);
  return { stations: stns.size, present: byHour.map((m) => (m ? Object.keys(m).length : null)), up, down, top };
}

// 기간 조회(kma_snow2) 글 → 줄마다 { tm, stn, tot, day, d01, h01 }. 칸: TM STN STN_KO LON LAT STN_SP SD_TOT SD_DAY SD_HR3 SD_D01 SD_H03 SD_H24 SD_H01(빈칸으로 나뉨, -999 = 자료 없음)
export function parseSnow2(text) {
  if (typeof text !== 'string' || !text.includes('#START7777')) return null;
  const out = [], v = (x) => { const n = Number(x); return Number.isFinite(n) && n > -90 ? n : null; };
  for (const line of text.split(/\r?\n/)) {
    if (!line || line[0] === '#') continue;
    const p = line.trim().split(/\s+/); if (p.length < 13 || !/^\d{12}$/.test(p[0]) || !/^\d{1,6}$/.test(p[1])) continue;
    const k = p.length - 7;                                              // 지점 이름에 빈칸이 있어도 뒤에서부터 셈
    out.push({ tm: p[0], stn: p[1], tot: v(p[k]), day: v(p[k + 1]), d01: v(p[k + 3]), h01: v(p[k + 6]) });
  }
  return out;
}
// 하루치(00~23시) 기간 조회 줄과 서버의 일자별 값(ours: { 관측소: 값 }) 비교 — 관측소마다 그날 SD_DAY 최댓값 / SD_D01 최댓값 / SD_H01 합을 각각 우리 값과
//   same(0.1cm 단위로 같음, zero = 둘 다 0) / diff / onlyOurs(우리만 값 있음, 기상청 그 칸 하루 내내 없음) / onlyOurs0(그중 우리 값 0) / onlyKma
export function compareDay(rows, ours) {
  const st = {};
  for (const r of rows) {
    const s = st[r.stn] || (st[r.stn] = { day: null, d01: null, h01: null });
    for (const f of ['day', 'd01']) if (r[f] != null) s[f] = s[f] == null ? r[f] : Math.max(s[f], r[f]);
    if (r.h01 != null) s.h01 = (s.h01 || 0) + r.h01;
  }
  const r1 = (x) => Math.round(x * 10) / 10, out = { stations: Object.keys(st).length, ours: Object.keys(ours).length };
  for (const f of ['day', 'd01', 'h01']) {
    const c = { same: 0, zero: 0, diff: 0, higher: 0, onlyOurs: 0, onlyOurs0: 0, onlyKma: 0 }, diffs = [];
    for (const stn of new Set([...Object.keys(st), ...Object.keys(ours)])) {
      const k = st[stn] ? st[stn][f] : null, o = ours[stn];
      if (o == null && k == null) continue;
      if (o == null) { c.onlyKma++; continue; }
      if (k == null) { if (o) c.onlyOurs++; else c.onlyOurs0++; continue; }
      if (r1(o) === r1(k)) { c.same++; if (!o) c.zero++; } else { c.diff++; if (k > o) c.higher++; diffs.push([stn, o, r1(k)]); }   // higher = 기상청 쪽이 큼
    }
    diffs.sort((a, b) => Math.abs(b[1] - b[2]) - Math.abs(a[1] - a[2]));
    out[f] = { ...c, top: diffs.slice(0, 6) };
  }
  return out;
}

async function allowed(req, deps) {
  const t = req.headers.get('x-collector-token');
  if (t) return { ok: await deps.store.tokenOk(t), admin: false };
  const jwt = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!jwt) return { ok: false };
  const u = await deps.auth.getUser(jwt);
  if (!u || !u.id) return { ok: false };
  const p = await deps.store.getProfileById(u.id);
  return { ok: !!(p && p.role === 'admin' && !p.disabled), admin: true };
}

export async function handle(req, deps) {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json(405, { ok: false, error: 'method' });
  const who = await allowed(req, deps);
  if (!who.ok) return json(401, { ok: false, error: 'unauthorized' });
  let body = {}; try { body = JSON.parse((await req.text()) || '{}') || {}; } catch { return json(400, { ok: false, error: 'bad_request' }); }
  const date = typeof body.date === 'string' && /^\d{8}$/.test(body.date) ? body.date : null;   // 지난 날짜 다시 받기·비교(서버 안 토큰 또는 관리자)
  const dry = body.dry === true;
  const key = String(deps.env('KMA_AUTH_KEY') || '').trim();
  if (!key) return json(200, { ok: false, error: 'no_key' });

  if (typeof body.compare === 'string' && /^\d{8}$/.test(body.compare)) {      // 비교(저장 없음): 그날 기간 조회 한 번 ↔ 서버의 일자별 값(2026-10-19)
    const d = body.compare, rows = [];
    for (const [a, z] of [['00', '05'], ['06', '11'], ['12', '17'], ['18', '23']]) {         // 한 번에 하루치는 커서(약 1.5MB) 6시간씩 네 번
      const r = await deps.fetchText(`${SNOW_URL.replace('kma_snow1.php', 'kma_snow2.php')}?tm=${d}${z}00&tm_st=${d}${a}00&snow=2&help=0&authKey=${encodeURIComponent(key)}`);
      const part = r.status === 200 ? parseSnow2(r.text) : null;
      if (!part) return json(200, { ok: false, compare: d, error: `${a}~${z}시 HTTP ${r.status}` });
      rows.push(...part); await deps.sleep(GAP_MS);
    }
    const { data: ours } = await deps.store.daily(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}`);
    return json(200, { ok: true, compare: d, lines: rows.length, ...compareDay(rows, ours || {}) });
  }
  if (typeof body.probe === 'string' && /^\d{8}$/.test(body.probe)) {          // 시험 호출: 저장 없이 요약만
    const sd = ['day', '3hr', '24h', 'tot'].includes(body.sd) ? body.sd : 'day', mi = /^[0-5]\d$/.test(body.mi || '') ? body.mi : '00';
    if (body.raw === true) {                                        // 원문 한 시각: 머리말(#)과 자료 몇 줄만(어떤 칸이 오는지 확인용, 키가 든 줄은 뺌)
      const hh = /^([01]\d|2[0-3])$/.test(body.hh || '') ? body.hh : '06', tm = body.probe + hh + mi;
      // api: snow1(시각 하나, 기본) / snow2(기간 — tm_st~tm, 칸이 더 많을 수 있음) / day(최심적설·최심신적설)
      const api = { snow1: 'kma_snow1.php', snow2: 'kma_snow2.php', day: 'kma_snow_day.php' }[body.api] || 'kma_snow1.php';
      const st = /^\d{12}$/.test(body.tm_st || '') ? `&tm_st=${body.tm_st}` : '', sn = /^[012]$/.test(String(body.snow ?? '')) ? `&snow=${body.snow}` : '', sp = /^\d{1,6}(:\d{1,6})*$/.test(body.stn || '') ? `&stn=${body.stn}` : '';
      const r = await deps.fetchText(`${SNOW_URL.replace('kma_snow1.php', api)}?sd=${sd}&tm=${tm}${st}${sn}${sp}&help=1&authKey=${encodeURIComponent(key)}`);
      const lines = (r.text || '').split(/\r?\n/).filter((l) => l && !/authKey/i.test(l));
      return json(200, { ok: true, probe: body.probe, api, sd, tm, status: r.status, head: lines.filter((l) => l[0] === '#').slice(0, 40), rows: lines.filter((l) => l[0] !== '#' && (!Array.isArray(body.pick) || body.pick.includes(l.trim().split(/[\s,]+/)[1]))).slice(0, 8) });   // pick = 이 관측소 줄만
    }
    const t0 = deps.now(), byHour = []; let lastErr = null;
    for (let h = 0; h < 24; h++) {
      const tm = body.probe + String(h).padStart(2, '0') + mi;
      if (deps.now() - t0 + CALL_MS > BUDGET_MS) { lastErr = 'budget'; break; }
      const r = await deps.fetchText(`${SNOW_URL}?sd=${sd}&tm=${tm}&help=0&authKey=${encodeURIComponent(key)}`);
      const vals = r.status === 200 ? parseSnow(r.text, tm) : null; if (!vals) lastErr = `${tm} ${r.status === 200 ? '형식' : 'HTTP ' + r.status}`;
      byHour.push(vals); await deps.sleep(GAP_MS);
    }
    return json(200, { ok: true, probe: body.probe, sd, mi, hours: byHour.length, error: lastErr, ...seriesStats(byHour) });
  }
  const { data: plan, error } = await deps.store.plan(date ? date.replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3') : null);
  if (error || !plan) return json(500, { ok: false, error: 'db' });
  if (!plan.in_season) return json(200, { ok: true, skipped: 'out_of_season', date: plan.date });
  const done = new Set(dry ? [] : plan.done || []);
  const hours = [...Array(24).keys()].filter((h) => !done.has(h));
  if (!hours.length) return json(200, { ok: true, done: true, date: plan.date });

  const t0 = deps.now(), iso = plan.date.replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3');
  let got = 0, written = 0, lastErr = null; const counts = { new: 0, higher: 0, same: 0, lower: 0 }, dayMax = {};
  for (const h of hours) {
    const tm = plan.date + String(h).padStart(2, '0') + '00';
    const url = `${SNOW_URL}?sd=day&tm=${tm}&help=0&authKey=${encodeURIComponent(key)}`;
    let vals = null, err = null;
    for (let i = 0; i < TRIES && !vals; i++) {
      if (deps.now() - t0 + CALL_MS > BUDGET_MS) { err = err || 'budget'; break; }   // 다음 요청이 시간 안에 못 끝날 수 있으면 멈춤
      if (i) await deps.sleep(RETRY_MS);
      const r = await deps.fetchText(url);
      if (r.status === 200) { vals = parseSnow(r.text, tm); if (!vals) err = `${tm} 형식`; }
      else err = `${tm} HTTP ${r.status}`;
      if (r.status === 401 || r.status === 403) break;               // 키·활용신청 문제는 다시 해도 같음
    }
    if (!vals) lastErr = err;
    if (err === 'budget') break;
    if (vals && dry) { got++; for (const [k, v] of Object.entries(vals)) if (!(k in dayMax) || v > dayMax[k]) dayMax[k] = v; }   // 비교: 그날 최댓값을 모아 끝에 한 번
    else if (vals) {
      const { data: c, error: e } = await deps.store.put(iso, h, vals, false);
      if (e || !c) { lastErr = `${tm} 저장 실패`; break; }
      got++; written += c.written || 0; for (const k of Object.keys(counts)) counts[k] += c[k] || 0;
    }
    await deps.sleep(GAP_MS);
  }
  const total = done.size + got;
  if (dry) {                                                         // 그날 최댓값 vs 서버에 있는 값(new = 서버에 없음, higher/lower = 서버 값보다 큼/작음)
    const { data: c } = got ? await deps.store.put(iso, 0, dayMax, true) : { data: null };
    return json(200, { ok: true, dry: true, date: plan.date, hours: got, stations: Object.keys(dayMax).length, counts: c || counts, error: lastErr });
  }
  const note = total === 24 ? `자동 수집(kma_snow1) ${plan.date} 24시각` : `자동 수집 ${plan.date} ${total}/24시각${lastErr ? ' — ' + lastErr : ''}`;
  await deps.store.finish(iso, total, written, note);
  return json(200, { ok: total === 24, date: plan.date, hours: total, fetched: got, written, counts, error: total === 24 ? null : lastErr });
}
