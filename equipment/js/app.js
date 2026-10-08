/* ============================================================
   app.js — 장비 지원 화면 전체 (권한, 이동 현황, 기관별 장비, 지사별 요청·편성, 로그 기록)
   불러오는 순서: auth/auth.js → sample-data.js → api.js → app.js
   - 자료는 서버(Supabase)에서 읽고 api.js 로 저장합니다. 주소에 ?sample=1 이면 샘플 자료로 시연합니다.
   - 권한은 계정의 세부 권한(perms)으로 판단합니다. 관리자는 모든 권한.
       equip.edit.own  자기 출발 기관 장비 추가·도공번호·지원 여부(기준일자별) / equip.edit.all  모든 장비 + 날짜별 경로 + 장비 삭제·숨기기 + 지원일 1 날짜 + 초기화
       req.edit.own    자기 지사 요청 / req.edit.hq  자기 본부 지사들 요청 / req.confirm  편성·확정·기준일자 만들기 / log.view  수정 기록
     ⚠ 화면의 권한 검사는 보기 좋게 정리하는 용도이고, 실제로 막는 것은 서버 규칙(RLS·트리거)입니다.
   - 경로는 (날짜, 장비)마다 한 줄로 서버에 남습니다. 다른 날짜를 확정해도 지난 날짜 경로는 지워지지 않습니다.
   - 특보: 서버가 10분마다 기상청에서 받아 둔 것(warning_status)을 자동 표시. 확정한 지사는 확정 순간 값을 서버가 남김(warn_* 열)
     24시 강설 [적설 | 강수]: 기상청 단기예보 격자의 1시간 신적설(cm)·1시간 강수량(mm) 24시간 합 중 지사 격자의 가장 큰 값(branch_forecast).
     확정하면 서버가 그 순간 값을 남김(fc_* 열). 값을 누르면 강설량 측정 → 기관별 24시간 예보의 그 지사로 이동. 확정한 지사 줄은 바탕이 노랑
     최저기온 [기온 | 시각]: 같은 예보의 1시간 기온 24시간 중 가장 낮은 값과 그 시각(지사 격자 중 가장 추운 곳, branch_forecast.min_tmp·min_tmp_at)
     [기상현황 직접입력]을 켜면 적설·강수·최저기온·대설특보(종류·발표·발효)를 지사가 직접 넣음(wx_* 열) — 자동 값 대신 보이고, 눌러도 예보로 가지 않음
     지사별 요청·편성은 대설특보(예비·주의보·경보)만: [종류 | 발표 | 발효] 세 칸. 다른 특보는 관리자 [특보구역 관리] 아래 종류별 탭에서만
   - 사람이 읽는 규칙 설명: docs/equipment-rules.md
   ============================================================ */
// 배포 직후 브라우저에 예전 index.html(최대 10분 저장)이 남아 있으면 새 app.js 와 화면 틀이 맞지 않아 탭이 비어 보임
// (GitHub Pages 는 ?v= 꼬리표와 관계없이 최신 파일을 줌). 판번호가 다르면 주소를 바꿔 한 번만 새로 받는다.
const UI_VERSION = "2026100801";
(() => {
  const m = document.querySelector('meta[name="ui-version"]');
  if ((m && m.content) === UI_VERSION) return;
  let first = true; try { const k = "eq_reload_" + UI_VERSION; first = !sessionStorage.getItem(k); sessionStorage.setItem(k, "1"); } catch (e) {}
  if (first) { const u = new URL(location.href); u.searchParams.set("_v", UI_VERSION); location.replace(u.href); throw new Error("화면 틀이 예전 판이라 새로 불러옵니다"); }
})();
const $ = id => document.getElementById(id);
function esc(v) {   // XSS 방지: 화면에 글자를 넣을 땐 항상 이 함수를 거칩니다
  return String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
const p2 = n => String(n).padStart(2, "0");
const TYPES = ["제설차", "제설기", "이동정비차"];
const STATUS = { "": ["wait", "미정"], O: ["go", "지원"], X: ["stop", "지원 불가"], M: ["fix", "정비중"] };     // 정비중도 지원 불가
const WD = "일월화수목금토";
const todayISO = () => { const t = new Date(); return `${t.getFullYear()}-${p2(t.getMonth() + 1)}-${p2(t.getDate())}`; };
function addDays(iso, n) { const [y, m, d] = iso.split("-").map(Number); const t = new Date(y, m - 1, d + n); return `${t.getFullYear()}-${p2(t.getMonth() + 1)}-${p2(t.getDate())}`; }
function fmtMD(iso) { const [y, m, d] = iso.split("-").map(Number); return `${m}/${d}(${WD[new Date(y, m - 1, d).getDay()]})`; }
function localInput(iso) { if (!iso) return null; const d = new Date(iso); return isNaN(d) ? null : `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}`; }
function fmtTime(local) { if (!local) return "미정"; const [d, t] = local.split("T"); const [, m, dd] = d.split("-").map(Number); return `${m}월 ${dd}일 ${t}`; }
function fmtShort(iso) { const d = new Date(iso); return `${d.getMonth() + 1}/${d.getDate()} ${p2(d.getHours())}:${p2(d.getMinutes())}`; }
const sameDay = iso => new Date(iso).toDateString() === new Date().toDateString();

/* ============================================================
   [1] 상태와 권한
   ============================================================ */
// 접속 아이디(데모): 정식 출시 전까지 유지(사용자 결정 2026-10-04). 서버에 연결된 화면에서는 "미리보기"이고 저장은 내 아이디로만.
const DEMO = [
  { id: "admin1", label: "관리자1", role: "admin", g: "관리자" }, { id: "admin2", label: "관리자2", role: "admin", g: "관리자" },
  { id: "hq-gw", label: "강원본부", role: "hq", hq: "강원", perms: ["req.edit.hq"], g: "지역본부" },
  { id: "br1", label: "대관령지사", role: "branch", branch: "대관령", perms: ["juris.request", "req.edit.own"], g: "피지원지사" },
  { id: "br2", label: "양양지사", role: "branch", branch: "양양", perms: ["juris.request", "req.edit.own"], g: "피지원지사" },
  { id: "br3", label: "엄정지사", role: "branch", branch: "엄정", perms: ["juris.request", "req.edit.own"], g: "피지원지사" },
  { id: "eq-sg", label: "서울경기 지원장비", role: "equip", org: "서울경기", perms: ["equip.edit.own"], g: "지원장비" },
  { id: "eq-cb", label: "충북 지원장비", role: "equip", org: "충북", perms: ["equip.edit.own"], g: "지원장비" },
  { id: "viewer", label: "보기 전용", role: "viewer", perms: [], g: "보기 전용" }
];
const S = {
  me: null, real: null, uid: "admin1", preview: false,
  hqs: [], branches: [], order: [], brById: {}, hqById: {}, vehicles: [], rounds: [], orgs: [], holdings: null,
  routes: new Map(), rmeta: new Map(), loaded: null, reqs: {}, audit: [],
  rstat: new Map(), stLoaded: new Set(), sdraft: new Map(), unhideOpen: false,   // rstat: "기준일자|장비" → 지원 여부 {status, off_from, updated_at} / sdraft: 고른 기준일자의 아직 확정 안 한 지원 여부(장비 → 값)
  draft: new Map(), vdraft: new Map(), rdraft: new Map(), revisedMode: false,   // revisedMode: 표 위 [최초 지원]/[수정본] — 고르는 지사 목록과 저장 구분          // 아직 확정·저장하지 않은 변경(경로 / 장비 / 지사 요청)
  date: todayISO(), day1: todayISO(), cols: 4, round: null,
  org: "전체", type: "전체", fleetOrg: "전체", bview: "req", closedHq: new Set(), extraStop: new Set(),   // bview: 지사별 요청·편성 보기 = req(요청 있는 지사만) / fixed(편성 확정된 지사만) / all
  logUser: "전체", logKind: "전체", logToday: false,
  warn: null, zdata: null, wtab: null, fc: {}                                      // warn: 지금 대설 특보(서버 요약) / zdata: 특보구역 관리 창 자료
};
// 장비 정렬 규칙(사용자 지정): ① 기관 서울경기 → 충북 → 전북 → 대구경북(S.orgs 순서) ② 종류 제설차 → 제설기 → 이동정비차(TYPES 순서) ③ 도공번호 숫자 순
const vehNo = v => { const m = /(\d+)$/.exec(v.plate || ""); return m ? +m[1] : 1e9; };
const vehCmp = (a, b) => (((S.orgs.indexOf(a.org) + 1) || 99) - ((S.orgs.indexOf(b.org) + 1) || 99)) || (((TYPES.indexOf(a.type) + 1) || 99) - ((TYPES.indexOf(b.type) + 1) || 99)) || (vehNo(a) - vehNo(b)) || String(a.id).localeCompare(String(b.id));
const sortVehicles = () => { S.vehicles.sort(vehCmp); };
const SOURCE_ORGS = () => [...S.orgs, "지역본부"];        // 이동 현황 지원기관 열. 지역본부 장비는 나중에 '지역본부' 탭에서 연동(지금은 0)
const can = p => !!S.me && (S.me.role === "admin" || (S.me.perms || []).includes(p));
const canVeh = v => can("equip.edit.all") || (can("equip.edit.own") && v.org === S.me.org);
const canAnyVeh = () => can("equip.edit.all") || can("equip.edit.own");
const canReq = b => can("req.confirm") || (can("req.edit.own") && S.me.branch_id === b.id) || (can("req.edit.hq") && b.hq_id === S.me.hq_id);
const canAnyReq = () => can("req.confirm") || can("req.edit.own") || can("req.edit.hq");
const bn = id => (S.brById[id] || {}).name || id;
const vehById = id => S.vehicles.find(v => v.id === id);
const plateOf = id => { const v = vehById(id); return v ? vval(v, "plate") : id; };
const curRound = () => S.rounds.find(r => r.id === S.round) || null;

/* ---------- 값: 서버 값 + 아직 확정하지 않은 변경 ---------- */
const rk = (date, vid) => date + "|" + vid;
// 경로 한 칸 = { stops: 들르는 지사들, revised: 수정본인지(아니면 최초 지원), times: 지사마다 도착 예상 시각 "HH:MM" 또는 null }
const EMPTY = { stops: [], revised: false, times: [] };
function normRec(r) {
  r = r || EMPTY; const seen = new Set(), stops = [], times = [];
  (r.stops || []).forEach((s, i) => { if (s && !seen.has(s)) { seen.add(s); stops.push(s); times.push((r.times || [])[i] || null); } });
  return stops.length ? { stops, revised: !!r.revised, times } : EMPTY;
}
const recOf = (date, vid) => { const k = rk(date, vid); return S.draft.has(k) ? S.draft.get(k) : (S.routes.get(k) || EMPTY); };
const routeOf = (date, vid) => recOf(date, vid).stops;
const vval = (v, f) => { const d = S.vdraft.get(v.id); return d && f in d ? d[f] : v[f]; };
/* ---------- 기준일자별 지원 여부(마이그레이션 38) ----------
   규칙: 어떤 날짜의 지원 여부는, 그 날짜를 기간 안에 둔 기준일자 중 시작일이 가장 늦은 것(govRound)이 정한다.
   - 경로는 (날짜, 장비) 한 줄을 모든 기준일자가 함께 씀. 지원 가능이 아닌 날의 경로는 지우지 않고 숨김(effRec) — 다시 지원 가능으로 하면 되살아남
   - 지원 불가 시작일(off_from): 그 날짜부터 지원 불가(지원 여부가 '지원'일 때만). 기준일자의 지원 불가 = 시작일부터 불가 */
const roundEnd = r => addDays(r.start_date, (r.days || 4) - 1);
const govRound = d => S.rounds.find(r => r.start_date <= d && d <= roundEnd(r)) || null;      // S.rounds 는 시작일이 늦은 순
const ST0 = { status: "", off_from: null };
const stOf = (rid, vid) => { const b = S.rstat.get(rid + "|" + vid) || ST0, d = rid === S.round ? S.sdraft.get(vid) : null; return d ? { ...b, ...d } : b; };
const availOn = (vid, d) => { const r = govRound(d); if (!r) return false; const x = stOf(r.id, vid); return x.status === "O" && (!x.off_from || d < x.off_from); };
const effRec = (d, vid) => availOn(vid, d) ? recOf(d, vid) : EMPTY;                       // 화면에 보이는 경로(지원 불가인 날은 없음)
// 연속지원: 전날 마지막으로 들른 지사 = 오늘 첫 번째 지사 → 오늘 그 지사의 도착 시각 대신 "연속지원"(사용자 결정 2026-10-08)
const isCont = (vid, d, stop) => { if (!stop) return false; const p = effRec(addDays(d, -1), vid).stops; return p.length > 0 && p[p.length - 1] === stop; };
// 숨긴 장비(hidden_after): 그 날짜보다 늦게 시작하는 기준일자부터 기관별 장비 목록에서 안 보임(이전 기준일자·이동 현황 기록은 그대로)
const shownIn = (v, r) => !v.hidden_after || (!!r && r.start_date <= v.hidden_after);
const REQ_DEF = { snow_cm: null, warning: false, req_truck: 0, req_blower: 0, assigned_truck: 0, assigned_blower: 0, arrive_at: null, reason: null, confirmed: false,
  wx_manual: false, wx_snow: null, wx_pcp: null, wx_tmin: null, wx_tmin_at: null, wx_level: null, wx_fc: null, wx_ef: null };
const rbase = (b, f) => { const r = S.reqs[b]; return r ? r[f] : REQ_DEF[f]; };
const rval = (b, f) => { const d = S.rdraft.get(b); return d && f in d ? d[f] : rbase(b, f); };
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const isManual = bid => !!rval(bid, "wx_manual");                       // 기상현황 직접입력을 켠 지사
const isConf = bid => !!(S.reqs[bid] && S.reqs[bid].confirmed);          // 저장된 확정(줄 바탕 노랑)
// 요청 있음 = 요청 제설차·제설기가 1대 이상(일괄 확정으로 줄만 생긴 지사는 아님). 편성 확정 = 확정했고 편성 대수가 1대 이상(저장된 것 기준)
const hasReq = bid => (+rval(bid, "req_truck") || 0) + (+rval(bid, "req_blower") || 0) > 0;
const isFixed = bid => isConf(bid) && (+rbase(bid, "assigned_truck") || 0) + (+rbase(bid, "assigned_blower") || 0) > 0;
const canEdit = b => canReq(b) && !isConf(b.id);                         // 확정한 줄은 [취소]하기 전까지 아무도 못 고침(서버도 막음, 마이그레이션 35)
const dis = bid => isConf(bid) ? " disabled" : "";                       // 확정한 줄의 입력칸 = 비활성(보이기만)
/* ---------- 특보 — 지사 관할 특보구역 중 가장 높은 단계. 확정한 지사는 확정 순간 값(서버가 고정), 자료가 없으면 특보 없음 ---------- */
const WLV = { "예비": ["w1", "예비특보"], "주의": ["w2", "대설주의보"], "경보": ["w3", "대설경보"] };
// 단계 + 종류 → 이름(대설은 예전 그대로: 예비특보·대설주의보·대설경보 / 다른 종류: 강풍 예비특보·강풍주의보·강풍경보)
const wlabel = (level, kind) => !level ? "특보 없음" : (!kind || kind === "대설") ? (WLV[level] || [0, level])[1] : kind + (level === "예비" ? " 예비특보" : level === "주의" ? "주의보" : "경보");
// 지사 특보(대설만): { level, kind, zones:[[코드, 이름, 단계, 종류, 발표, 발효]…], fc, ef, base, note, fixed, at } — fc·ef 는 가장 높은 단계 구역의 발표·발효 시각
function warnOf(bid) {
  const r = S.reqs[bid];
  if (isManual(bid)) return { level: rval(bid, "wx_level") || null, kind: "대설", fc: rval(bid, "wx_fc"), ef: rval(bid, "wx_ef"), zones: [], manual: true, fixed: isConf(bid) };
  const top = z => ({ kind: z.length ? z[0][3] || "대설" : null, fc: z.length ? z[0][4] || null : null, ef: z.length ? z[0][5] || null : null });
  if (r && r.confirmed) { const z = r.warn_zones || []; return r.warn_at ? { level: r.warn_level || null, ...top(z), zones: z, base: r.warn_base, note: r.warn_note, fixed: true, at: r.warn_at } : { none: true }; }
  const w = S.warn || {}, x = (w.branches || {})[bid], z = x ? x.zones : [];
  return { level: x ? x.level : null, ...top(z), zones: z, base: w.base, note: w.ok ? null : (w.note || "기상청 자료를 받지 못함"), fixed: false };
}
// 예비특보의 발효 시각은 기상청 약속 시각(시:분 → 때)
const EF_SLOT = { "02:59": "새벽(00~03시)", "05:59": "새벽(03~06시)", "08:59": "아침(06~09시)", "11:59": "오전(09~12시)", "14:59": "낮(12~15시)", "17:59": "늦은 오후(15~18시)",
  "20:59": "저녁(18~21시)", "23:59": "밤(21~24시)", "11:58": "오전(06~12시)", "17:58": "오후(12~18시)", "05:58": "새벽(00~06시)", "23:58": "밤(18~24시)", "14:58": "오후(12~18시)" };
function fmtWarnTime(iso, level, ef) {     // "10/5 04:00", 예비특보 발효는 "10/5 새벽(00~06시)"
  if (!iso) return "-";
  const d = new Date(iso); if (isNaN(d)) return "-";
  const hm = `${p2(d.getHours())}:${p2(d.getMinutes())}`, md = `${d.getMonth() + 1}/${d.getDate()}`;
  return ef && level === "예비" && EF_SLOT[hm] ? `${md} ${EF_SLOT[hm]}` : `${md} ${hm}`;
}
function warnBadge(bid) {
  const w = warnOf(bid);
  if (w.none) return `<span class="muted">-</span>`;
  const cls = (WLV[w.level] || ["w0"])[0];
  return `<span class="wb ${cls}" data-wb="${esc(bid)}">${esc(wlabel(w.level, "대설"))}</span>`;
}
// 직접입력 시각: 화면 "월일시분" 8자리(예 12241530) ↔ 서버 ISO. 연도는 기준일자에 가장 가까운 해
const mdhm = iso => { const d = iso ? new Date(iso) : null; return d && !isNaN(d) ? `${p2(d.getMonth() + 1)}${p2(d.getDate())}${p2(d.getHours())}${p2(d.getMinutes())}` : ""; };
function parseMdhm(t) {
  const m = /^(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(t); if (!m) return undefined;
  const [mo, dd, hh, mi] = m.slice(1).map(Number); if (mo < 1 || mo > 12 || dd < 1 || dd > 31 || hh > 23 || mi > 59) return undefined;
  const base = new Date(((curRound() || {}).start_date || todayISO()) + "T12:00");
  const c = [-1, 0, 1].map(k => new Date(base.getFullYear() + k, mo - 1, dd, hh, mi)).filter(d => d.getMonth() === mo - 1 && d.getDate() === dd);
  if (!c.length) return undefined;
  return c.sort((a, b) => Math.abs(a - base) - Math.abs(b - base))[0].toISOString();
}
// 직접입력 대설특보 발표·발효 시각: [시 ▾]:[분 ▾] (시 00~23, 분 10분 단위). 날짜는 기준일자, 시를 '--'로 두면 비움
function hmSelects(bid, f, label) {
  const v = rval(bid, f), d = v ? new Date(v) : null, ok = d && !isNaN(d), hh = ok ? p2(d.getHours()) : "", mm = ok ? p2(d.getMinutes()) : "00";
  const mins = MINS.includes(mm) ? MINS : [...MINS, mm].sort(), a = `data-wxt="${esc(bid)}" data-f="${f}"`;
  return `<span class="hm"><select class="ci" ${a} data-part="h" data-fk="wh:${esc(bid)}:${f}" aria-label="${esc(label)} 시"${dis(bid)}><option value=""${hh ? "" : " selected"}>--</option>` +
    HOURS.map(x => `<option${x === hh ? " selected" : ""}>${x}</option>`).join("") + `</select>:` +
    `<select class="ci" ${a} data-part="m" data-fk="wm:${esc(bid)}:${f}" aria-label="${esc(label)} 분"${hh && !isConf(bid) ? "" : " disabled"}>` +
    mins.map(x => `<option${x === mm ? " selected" : ""}>${x}</option>`).join("") + `</select></span>`;
}
// 지사 줄의 [종류 | 발표 | 발효] 세 칸. 직접입력이면 종류 = 선택, 발표·발효 = 시:분 선택
function warnCells(bid) {
  const w = warnOf(bid), dash = '<span class="muted">-</span>', b = S.brById[bid];
  if (w.manual && b && canReq(b)) {
    const lv = rval(bid, "wx_level") || "", inp = f => hmSelects(bid, f, `${b.name} 특보 ${f === "wx_fc" ? "발표" : "발효"}`);
    return `<td class="wxe" data-wcell="${esc(bid)}"><select class="ci" data-rq="${esc(bid)}" data-f="wx_level" data-fk="q:${esc(bid)}:wx_level" aria-label="${esc(b.name)} 특보 종류"${dis(bid)}>` +
      [["", "특보 없음"], ["예비", "예비특보"], ["주의", "대설주의보"], ["경보", "대설경보"]].map(([v, l]) => `<option value="${v}"${v === lv ? " selected" : ""}>${l}</option>`).join("") + `</select></td>` +
      `<td class="wt wxe" data-wfc="${esc(bid)}">${inp("wx_fc")}</td><td class="wt wxe" data-wef="${esc(bid)}">${inp("wx_ef")}</td>`;
  }
  const t = (v, ef) => w.none || !w.level || !v ? dash : esc(w.manual ? fmtHM(v) : fmtWarnTime(v, w.level, ef));
  return `<td class="" data-wcell="${esc(bid)}">${warnBadge(bid)}</td><td class="wt" data-wfc="${esc(bid)}">${t(w.fc)}</td><td class="wt" data-wef="${esc(bid)}">${t(w.ef, true)}</td>`;
}
const fmtBase = b => b && /^\d{12}$/.test(b) ? `${+b.slice(4, 6)}/${+b.slice(6, 8)} ${b.slice(8, 10)}:${b.slice(10, 12)}` : "-";
async function loadWarn() { const [r, f] = await Promise.all([Api.warnings(), Api.forecast()]); if (r.ok) S.warn = r.status; if (f.ok) S.fc = Object.fromEntries(f.rows.map(x => [x.branch_id, x])); }
/* ---------- 예상 적설 — 기상청 단기예보 24시간 신적설 합의 지사 최댓값(발표 후 12시간 안). 확정한 지사는 확정 순간 값 ---------- */
function fcOf(bid) {      // { snow, pcp, tmin, tmin_at, tmfc, start, end, nx, ny, pnx, pny, fixed, at, manual } 또는 { none } / null(예보 없음)
  const r = S.reqs[bid];
  if (isManual(bid)) return { snow: rval(bid, "wx_snow"), pcp: rval(bid, "wx_pcp"), tmin: rval(bid, "wx_tmin"), tmin_at: rval(bid, "wx_tmin_at"), manual: true, fixed: isConf(bid) };
  if (r && r.confirmed) return r.fc_at ? { snow: r.fc_snow, pcp: r.fc_pcp, tmin: r.fc_tmin, tmin_at: r.fc_tmin_at, tmfc: r.fc_tmfc, fixed: true, at: r.fc_at } : { none: true };
  const f = S.fc[bid];
  if (!f || Date.now() - Date.parse(f.issued_at) > 12 * 3600e3) return null;
  const d = f.detail || {};
  return { snow: f.max_snow_24h, pcp: f.max_pcp_24h, tmin: f.min_tmp, tmin_at: f.min_tmp_at, tmfc: f.issued_at, start: d.start_at, end: d.end_at, nx: f.worst_nx, ny: f.worst_ny, pnx: d.pcp_nx, pny: d.pcp_ny, fixed: false };
}
const fmtCm = v => v == null ? "-" : (Math.round(v * 10) / 10).toFixed(1);
const fmtTmp = v => v == null ? "-" : String(Math.round(v * 10) / 10);                        // 기온(℃): -5, 1.5
const fmtHM = iso => { const d = iso ? new Date(iso) : null; return d && !isNaN(d) ? `${p2(d.getHours())}:${p2(d.getMinutes())}` : "-"; };   // 직접입력 특보 시각(시:분)
const fmtAt = iso => { const d = iso ? new Date(iso) : null; return d && !isNaN(d) ? `${d.getMonth() + 1}/${d.getDate()} ${p2(d.getHours())}시` : "-"; };
// k = "snow"(적설 cm) / "pcp"(강수 mm) / "tmin"(최저기온 ℃) / "tmin_at"(그 시각). 값을 누르면 기관별 24시간 예보의 그 지사로.
// 직접입력이면 입력칸(고칠 수 없으면 값만, 누를 수 없음)
const WX_FIELD = { snow: "wx_snow", pcp: "wx_pcp", tmin: "wx_tmin", tmin_at: "wx_tmin_at" };
const fcText = (k, v) => k === "tmin_at" ? fmtAt(v) : k === "tmin" ? fmtTmp(v) : fmtCm(v);
function fcInner(bid, k = "snow") {
  const f = fcOf(bid), v = f && !f.none ? f[k] : null;
  if (f && f.manual) {
    const b = S.brById[bid], fld = WX_FIELD[k];
    if (b && canReq(b)) {
      if (k === "tmin_at") return `<button type="button" class="ci tpick${v ? "" : " empty"}" data-tpick="${esc(bid)}" aria-label="${esc(b.name)} 최저기온 시각 고르기"${dis(bid)}>${v ? esc(fmtAt(v)) : "시각 선택"}</button>`;   // 누르면 달력 + 시
      const rng = k === "tmin" ? 'min="-60" max="50"' : 'min="0" max="999"';
      return `<input class="ci num wxn" type="number" inputmode="decimal" step="0.1" ${rng} data-rq="${esc(bid)}" data-f="${fld}" data-fk="q:${esc(bid)}:${fld}" value="${esc(v ?? "")}" aria-label="${esc(b.name)} ${{ snow: "적설(cm)", pcp: "강수(mm)", tmin: "최저기온(℃)" }[k]}"${dis(bid)}>`;
    }
    return `<span class="fcm">${v == null ? "-" : esc(fcText(k, v))}</span>`;
  }
  if (!f) return `<span class="muted fcv" data-fb="${esc(bid)}" data-fk2="${k}" tabindex="0">-</span>`;
  if (f.none) return `<span class="muted">-</span>`;
  const cls = k === "snow" ? (v >= 5 ? " hi" : v > 0 ? " some" : "") : k === "pcp" ? (v >= 30 ? " hi" : v > 0 ? " wet" : "")
    : k === "tmin" ? (v != null && v <= -10 ? " cold2" : v != null && v <= 0 ? " cold" : "") : " at";
  return `<span class="fcv${cls}" data-fb="${esc(bid)}" data-fk2="${k}" tabindex="0" role="link">${v == null ? "-" : esc(fcText(k, v))}</span>`;
}
// 표 제목 옆 "몇 시 기준": 지금 예보(가장 최근 발표)
function fcBase() {
  const xs = Object.values(S.fc).filter(f => Date.now() - Date.parse(f.issued_at) <= 12 * 3600e3);
  if (!xs.length) return "예보 없음";
  const t = xs.reduce((a, f) => (f.issued_at > a ? f.issued_at : a), xs[0].issued_at);
  return `${fmtHour(t)} 발표 기준`;
}
function warnBase() {
  const w = S.warn; if (!w || !w.ok || !w.fetched_at) return "자료 없음";
  return `${fmtShort(w.fetched_at)} 기준`;
}
function openForecast(bid) {          // 강설량 측정 → 기관별 24시간 예보 → 그 지사
  try { if (window.top !== window && window.top.SSOpenForecast) return window.top.SSOpenForecast(bid); } catch (e) {}
  window.open("../#fc=" + encodeURIComponent(bid), "_top");
}
const fmtHour = iso => { const d = new Date(iso); return isNaN(d) ? "-" : `${d.getMonth() + 1}/${d.getDate()} ${p2(d.getHours())}시`; };
function paintWarn() {                // 자동 값만 새로 그림(직접입력 줄은 입력 중일 수 있어 그대로)
  document.querySelectorAll("[data-fcell]").forEach(td => { if (!isManual(td.dataset.fcell)) td.innerHTML = fcInner(td.dataset.fcell, "snow"); });
  document.querySelectorAll("[data-pcell]").forEach(td => { if (!isManual(td.dataset.pcell)) td.innerHTML = fcInner(td.dataset.pcell, "pcp"); });
  document.querySelectorAll("[data-tcell]").forEach(td => { if (!isManual(td.dataset.tcell)) td.innerHTML = fcInner(td.dataset.tcell, "tmin"); });
  document.querySelectorAll("[data-tacell]").forEach(td => { if (!isManual(td.dataset.tacell)) td.innerHTML = fcInner(td.dataset.tacell, "tmin_at"); });
  const fb = document.getElementById("fcBaseHead"); if (fb) fb.textContent = fcBase();
  const wb = document.getElementById("wBaseHead"); if (wb) wb.textContent = warnBase();
  document.querySelectorAll("tr[data-b]").forEach(tr => {
    const td = tr.querySelector("[data-wcell]"); if (!td || isManual(tr.dataset.b)) return;
    const t = document.createElement("tr"); t.innerHTML = warnCells(tr.dataset.b);
    [...t.children].forEach((n, i) => { const o = tr.querySelector(["[data-wcell]", "[data-wfc]", "[data-wef]"][i]); if (o) o.innerHTML = n.innerHTML; });
  });
}
function setRoute(date, vid, rec) {
  rec = normRec(rec); const k = rk(date, vid);
  if (same(rec, S.routes.get(k) || EMPTY)) S.draft.delete(k); else S.draft.set(k, rec);
}
function setVeh(vid, f, val) {
  const v = vehById(vid), d = { ...(S.vdraft.get(vid) || {}) };
  if (same(val, v[f])) delete d[f]; else d[f] = val;
  if (Object.keys(d).length) S.vdraft.set(vid, d); else S.vdraft.delete(vid);
}
function setStat(vid, patch) {           // 고른 기준일자의 지원 여부(지원/지원 불가/정비중/미정)·지원 불가 시작일
  const b = S.rstat.get(S.round + "|" + vid) || ST0, m = { status: b.status, off_from: b.off_from || null, ...(S.sdraft.get(vid) || {}), ...patch };
  if (m.status !== "O") m.off_from = null;
  if (m.status === b.status && (m.off_from || null) === (b.off_from || null)) S.sdraft.delete(vid); else S.sdraft.set(vid, { status: m.status, off_from: m.off_from || null });
  [...S.draft].forEach(([k, x]) => { const [d, v] = k.split("|"); if (v === vid && x.stops.length && !availOn(vid, d)) S.draft.delete(k); });   // 지원 불가가 된 날의 고친 경로는 버림(서버가 받지 않음)
}
function setReq(b, f, val) {
  const d = { ...(S.rdraft.get(b) || {}) };
  if (same(val, rbase(b, f))) delete d[f]; else d[f] = val;
  if (Object.keys(d).length) S.rdraft.set(b, d); else S.rdraft.delete(b);
}
const fleetDirty = () => S.draft.size > 0 || S.vdraft.size > 0 || S.sdraft.size > 0;
const branchDirty = () => S.rdraft.size > 0;

/* ============================================================
   [2] 불러오기
   ============================================================ */
function identityOf(d) {
  const br = d.branch ? S.branches.find(b => b.name === d.branch) : null, hq = d.hq ? S.hqs.find(h => h.name === d.hq) : null;
  return { label: d.label, username: d.label, role: d.role, perms: d.perms || [], branch_id: br ? br.id : null, org: d.org || null, hq_id: hq ? hq.id : br ? br.hq_id : null };
}
function windowDates() { return Array.from({ length: S.cols }, (_, i) => addDays(S.day1, i)); }
async function ensureRoutes() {          // 기관별 장비 칸(지원일 1~n)과 이동 현황 날짜 앞뒤 2주를 불러 둠
  const ds = [S.day1, addDays(S.day1, S.cols - 1), addDays(S.date, -14), addDays(S.date, 14)].sort();
  let from = ds[0], to = ds[3];
  if (S.loaded && from >= S.loaded[0] && to <= S.loaded[1]) return ensureStatus();
  if (S.loaded) { from = from < S.loaded[0] ? from : S.loaded[0]; to = to > S.loaded[1] ? to : S.loaded[1]; }
  const r = await Api.routes(from, to);
  if (!r.ok) return toast(r.message, true);
  [...S.routes.keys()].forEach(k => { const d = k.split("|")[0]; if (d >= from && d <= to) S.routes.delete(k); });
  r.rows.forEach(x => { S.routes.set(rk(x.date, x.vehicle_id), normRec(x)); if (x.confirmed_at) S.rmeta.set(rk(x.date, x.vehicle_id), x.confirmed_at); });
  S.loaded = [from, to];
  await ensureStatus();
}
async function ensureStatus() {          // 불러 둔 날짜 범위에 걸치는 기준일자(+ 고른 기준일자)의 지원 여부
  const [from, to] = S.loaded || [S.date, S.date];
  const ids = S.rounds.filter(r => r.id === S.round || (r.start_date <= to && roundEnd(r) >= from)).map(r => r.id).filter(id => !S.stLoaded.has(id));
  if (!ids.length) return;
  const r = await Api.statuses(ids);
  if (!r.ok) return toast(r.message, true);
  ids.forEach(id => S.stLoaded.add(id));
  r.rows.forEach(x => S.rstat.set(x.round_id + "|" + x.vehicle_id, { status: x.status || "", off_from: x.off_from || null, updated_at: x.updated_at || null }));
}
async function loadReqs() {
  S.reqs = {};
  if (!S.round) return;
  const r = await Api.requests(S.round);
  if (!r.ok) return toast(r.message, true);
  r.rows.forEach(x => { S.reqs[x.branch_id] = { ...x, arrive_at: localInput(x.arrive_at), reason: x.reason || null }; });
}
async function loadAudit() { const r = await Api.audit(); S.audit = r.ok ? r.rows : []; }
function pickRound() {      // 기준일자: 오늘 이전 것 중 가장 최근, 없으면 가장 이른 것
  const t = todayISO(), past = S.rounds.filter(r => r.start_date <= t);
  return (past[0] || S.rounds[S.rounds.length - 1] || {}).id || null;
}
async function boot() {
  const r = await Api.load(todayISO());
  if (!r.ok) {
    $("loading").innerHTML = `<b>${esc(r.message)}</b>` + (r.login ? `<p><a href="../" target="_top">첫 화면으로 가서 로그인하세요</a></p>` : `<p>새로고침(F5)해 보세요.</p>`);
    return;
  }
  S.hqs = r.hqs.slice().sort((a, b) => a.sort - b.sort); S.branches = r.branches; S.vehicles = r.vehicles.filter(v => v.active !== false);
  S.rounds = r.rounds.slice().sort((a, b) => b.start_date.localeCompare(a.start_date)); S.holdings = r.holdings;
  const OO = ["서울경기", "충북", "전북", "대구경북"];
  S.orgs = (r.orgs.length ? r.orgs : OO).slice().sort((a, b) => ((OO.indexOf(a) + 1) || 99) - ((OO.indexOf(b) + 1) || 99));
  sortVehicles();
  S.hqById = Object.fromEntries(S.hqs.map(h => [h.id, h])); S.brById = Object.fromEntries(S.branches.map(b => [b.id, b]));
  S.order = S.hqs.flatMap(h => S.branches.filter(b => b.hq_id === h.id));               // 본부(순서) → 지사(번호 순) = 강설량 화면과 같은 계층
  if (r.me) {
    S.real = { label: r.me.display_name, username: r.me.username, role: r.me.role, perms: r.me.perms || [], branch_id: r.me.branch_id, org: r.me.org, hq_id: r.me.hq_id || (S.brById[r.me.branch_id] || {}).hq_id || null };
    S.me = S.real; S.uid = "__me";
  } else { S.me = identityOf(DEMO[0]); S.uid = DEMO[0].id; }
  Api.setActor(S.me);
  S.round = pickRound(); const rr = curRound(); if (rr) S.day1 = rr.start_date;
  buildUserSel();
  await Promise.all([ensureRoutes(), loadReqs(), loadAudit(), loadWarn()]);
  $("loading").hidden = true; document.querySelector("main").hidden = false;
  try { refresh(); }
  catch (e) {          // 그리다가 오류가 나면 빈 탭 대신 알림(원인 찾기용)
    toast("화면을 그리다 오류가 났습니다. Ctrl+F5 로 새로고침해 보세요. (" + (e && e.message) + ")", true); throw e;
  }
}

/* ============================================================
   [3] 공통: 알림·말풍선(수정 기록)·안내
   ============================================================ */
let toastTimer;
function toast(msg, isErr) {
  const el = $("toast"); el.textContent = msg; el.className = "toast" + (isErr ? " err" : ""); el.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, 3500);
}
const TAB_LABEL = { vehicles: "장비", vehicle_routes: "경로", round_vehicle_status: "지원 여부", round_requests: "지사 요청", support_rounds: "기준일자", branch_zone_overrides: "특보구역" };
const FIELD = { fc_snow: "확정 예상 적설", fc_pcp: "확정 예상 강수", wx_manual: "기상현황 직접입력", wx_snow: "직접 적설", wx_pcp: "직접 강수", wx_tmin: "직접 최저기온", wx_tmin_at: "직접 최저기온 시각", fc_tmin: "확정 최저기온", wx_level: "직접 대설특보", wx_fc: "직접 특보 발표", wx_ef: "직접 특보 발효", plate: "도공번호", status: "지원 여부", stops: "경로", revised: "구분", times: "도착 예상", snow_cm: "예상 적설", warning: "특보", req_truck: "요청 제설차", req_blower: "요청 제설기",
  blower_s: "블로워 소", blower_l: "블로워 대", off_from: "지원 불가 시작일", hidden_after: "숨김", days: "기간(일)", assigned_truck: "편성 제설차", assigned_blower: "편성 제설기", arrive_at: "도착 요청", reason: "사유", confirmed: "확정", start_date: "기준일자", type: "장비", org: "기관", warn_level: "확정 특보", include: "특보구역" };
const HIDE = new Set(["fc_tmfc", "fc_at", "zone_code", "warn_zones", "warn_base", "warn_at", "warn_note", "updated_by", "updated_at", "confirmed_by", "confirmed_at", "created_by", "created_at", "round_id", "branch_id", "vehicle_id", "date", "id", "sort", "active", "name", "end_date"]);
function fmtField(f, v) {
  if (f === "warn_level" || f === "wx_level") return v ? (WLV[v] || [0, v])[1].replace("대설", "") || v : "특보 없음";
  if (f === "wx_manual") return v ? "켬" : "끔";
  if ((f === "wx_fc" || f === "wx_ef") && v) return fmtHM(v);
  if (f === "wx_tmin_at" && v) return fmtWarnTime(v);
  if (f === "include") return v == null ? "자동대로" : v ? "더함" : "뺌";
  if (v == null || v === "") return f === "stops" ? "(없음)" : f === "hidden_after" ? "숨기지 않음" : f === "off_from" ? "(없음)" : "(빈칸)";
  if (f === "stops") return v.length ? v.map(bn).join(" → ") : "(없음)";
  if (f === "revised") return v ? "수정본" : "최초 지원";
  if (f === "times") return v.some(Boolean) ? v.map(x => x || "-").join(" → ") : "(없음)";
  if (f === "status") return (STATUS[v] || STATUS[""])[1];
  if (f === "off_from" || f === "start_date") return fmtMD(v) + (f === "off_from" ? "부터" : "");
  if (f === "hidden_after") return fmtMD(addDays(v, 1)) + " 기준일자부터 숨김";
  if (f === "warning") return v ? "발효" : "없음";
  if (f === "confirmed") return v ? "확정" : "미확정";
  if (f === "arrive_at") return fmtTime(localInput(v));
  if (f === "snow_cm" || f === "fc_snow") return v + "cm";
  if (f === "fc_pcp") return v + "mm";
  return String(v);
}
// 칸 하나(target)의 오늘 수정 기록. field 를 주면 그 열이 바뀐 기록만
const histOf = (target, field) => S.audit.filter(a => a.target === target && sameDay(a.at) && (!field || (a.to_val && field in a.to_val) || (a.from_val && field in a.from_val)));
let HIST_TIP = false;     // 수정 기록 말풍선(밑줄 + 마우스를 올리면 기록): 지금은 꺼 둠(2026-10-07 사용자 요청). 다시 쓰려면 true — 코드·시험은 그대로 남아 있음
const hvA = (target, field = "") => HIST_TIP && can("log.view") && histOf(target, field).length ? ` data-hv="${esc(target)}" data-hf="${esc(field)}" tabindex="0"` : "";
const H = (target, field, html) => { const a = hvA(target, field); return a ? `<span${a}>${html}</span>` : html; };
const tip = $("tip");
function showTip(el) {
  const t = el.dataset.hv, f = el.dataset.hf || "stops", list = histOf(t, el.dataset.hf).slice(-3).reverse();
  if (!list.length) return;
  tip.innerHTML = `<b>이 칸의 오늘 수정 기록</b>` + list.map(h => `<div>${esc(p2(new Date(h.at).getHours()) + ":" + p2(new Date(h.at).getMinutes()))} · ${esc(h.username || "-")}<br>` +
    `${esc(fmtField(f, h.from_val ? h.from_val[f] : null))} → ${esc(fmtField(f, h.to_val ? h.to_val[f] : null))}</div>`).join("");
  placeTip(el);
}
function placeTip(el) {
  tip.hidden = false;
  const r = el.getBoundingClientRect();
  let top = r.bottom + 8; if (top + tip.offsetHeight > innerHeight - 8) top = Math.max(8, r.top - tip.offsetHeight - 8);
  tip.style.top = top + "px"; tip.style.left = Math.max(8, Math.min(r.left, innerWidth - tip.offsetWidth - 8)) + "px";
}
// 표 제목의 '○시 기준'(점선)에 마우스를 올리면 얼마마다 새로 받는지
const BASE_TIP = { fc: "매시 정각 업데이트 — 다음 정시부터 24시간으로 다시 계산(예보 자료는 단기예보 발표 02·05·08·11·14·17·20·23시 15분 뒤 새로 받음)", warn: "10분마다 업데이트 — 매시 01·11·21·31·41·51분" };
function showBaseTip(el) { tip.innerHTML = `<b>${esc(BASE_TIP[el.dataset.bt] || "")}</b>`; placeTip(el); }
const hideTip = () => { tip.hidden = true; };
["mouseover", "focusin"].forEach(ev => document.addEventListener(ev, e => { if (!e.target.closest) return; const bt = e.target.closest("[data-bt]"); if (bt) return showBaseTip(bt); const el = e.target.closest("[data-hv]"); if (el) showTip(el); }));
["mouseout", "focusout"].forEach(ev => document.addEventListener(ev, e => { if (e.target.closest && e.target.closest("[data-hv], [data-bt]")) hideTip(); }));
function banner(id) {           // 미리보기(다른 아이디 권한으로 보기) 중일 때만 짧게 알림
  const el = $(id); el.className = "perm"; el.hidden = !S.preview;
  el.innerHTML = S.preview ? `<b class="pv">미리보기: ${esc(S.me.label)} (저장 안 됨)</b>` : "";
}
function roundSel(id) {
  return `<label class="ctl">기준일자 <select class="ci" id="${id}" data-round>${S.rounds.length ? S.rounds.map(r => `<option value="${r.id}" ${r.id === S.round ? "selected" : ""}>${esc(fmtMD(r.start_date))} ${esc(r.start_date.slice(0, 4))}</option>`).join("") : '<option value="">(없음)</option>'}</select></label>`;
}

/* ============================================================
   [4] 이동 현황 (모두 보기만)
   ============================================================ */
const MOVE_TYPES = ["제설차", "제설기"];          // 이동 현황은 제설차·제설기만(이동정비차는 보이지 않음)
const movesOn = date => S.vehicles.filter(v => MOVE_TYPES.includes(v.type)).map(v => { const rec = effRec(date, v.id); return { v, rec, stops: rec.stops }; }).filter(m => m.stops.length);
function renderMatrix() {
  // 세로 = 본부 → 지사(그날 지원받는 지사만), 가로 = 지원기관마다 제설차·제설기. 본부 줄·합계는 장비 1대를 한 번만 셈(여러 지사를 들러도)
  const moves = movesOn(S.date), src = SOURCE_ORGS(), cols = [null, ...src],   // 합계 열을 맨 앞(지사 이름 바로 옆)에
     used = new Set(moves.flatMap(m => m.stops));
  const cnt = (org, ids, type) => moves.filter(m => (org == null || m.v.org === org) && m.v.type === type && (!ids || m.stops.some(s => ids.has(s)))).length;
  // 숫자를 누르면 아래 세부내역의 그 지사(본부)·지원기관·장비 종류 줄로 이동(jumpToDetail). sc = 줄 범위(본부 data-mh / 지사 data-mb / 합계 없음)
  const cells = (ids, sc = "") => cols.map(o => MOVE_TYPES.map((t, k) => { const n = o === "지역본부" ? 0 : cnt(o, ids, t);
    return `<td class="${k ? "c2" : "c1"}${o == null ? " tot" : ""}${n ? "" : " zero"}">${n ? `<button type="button" class="mnum" ${sc} data-mo="${o == null ? "" : esc(o)}" data-mt="${t}" title="아래 세부내역으로 이동">${n}</button>` : "·"}</td>`; }).join("")).join("");
  let body = "";
  S.hqs.forEach(h => {
    const brs = S.order.filter(b => b.hq_id === h.id && used.has(b.id)); if (!brs.length) return;
    brs.forEach((b, i) => { body += `<tr class="brrow${i === brs.length - 1 ? " grpend" : ""}">${i ? "" : `<th class="hqc" scope="rowgroup" rowspan="${brs.length}">${esc(h.name)}<span class="sub">본부</span></th>`}<th scope="row">${esc(b.name)}</th>${cells(new Set([b.id]), `data-mb="${esc(b.id)}"`)}</tr>`; });
  });
  $("matrix").innerHTML = `<thead><tr><th class="l" scope="col" rowspan="2" colspan="2">본부 · 피지원 지사</th>${cols.map(o => `<th scope="colgroup" colspan="2" class="orgh${o == null ? " tot" : ""}">${o == null ? "합계" : esc(o)}${o === "지역본부" ? '<span class="sub">연동 예정</span>' : ""}</th>`).join("")}</tr>` +
    `<tr>${cols.map(o => MOVE_TYPES.map((t, k) => `<th scope="col" class="${k ? "c2" : "c1"}${o == null ? " tot" : ""}">${t}</th>`).join("")).join("")}</tr></thead>` +
    `<tbody>${body || `<tr><td class="empty" colspan="${cols.length * 2 + 2}">${esc(fmtMD(S.date))}에 이동하는 장비가 없습니다.</td></tr>`}</tbody>` +
    `<tfoot><tr><th scope="row" colspan="2">합계</th>${cells(null, 'data-mall="1"')}</tr></tfoot>`;
  stickHead($("matrix"));
  const tr = moves.filter(m => m.v.type === "제설차").length, bl = moves.filter(m => m.v.type === "제설기").length;
  $("dateText").textContent = fmtMD(S.date); $("dateInput").value = S.date;      // 제목의 큰 날짜(누르면 달력)
  $("summaryNote").innerHTML = `<b>제설차 ${tr}대</b> · <b>제설기 ${bl}대</b>` + (moves.some(m => m.stops.length > 1) ? "" : "");
}
// 이동 현황 표의 숫자 → 아래 세부내역에서 그 줄(지사 카드·본부 묶음·해당 지원기관·장비 종류)로 스크롤하고 잠깐 색으로 표시
let flashTimer;
function jumpToDetail(d) {
  const find = () => d.mb ? document.querySelector(`#destList [data-bid="${CSS.escape(d.mb)}"]`) : d.mh ? document.querySelector(`#destList [data-hqb="${CSS.escape(d.mh)}"]`) : $("destList");
  const pick = () => { const sc = find(); return { sc, rows: sc ? [...sc.querySelectorAll(".vrow")].filter(r => (!d.mo || r.dataset.vo === d.mo) && (!d.mt || r.dataset.vt === d.mt)) : [] }; };
  let { sc: scope, rows } = pick();
  if (!rows.length && (S.org !== "전체" || S.type !== "전체")) { S.org = "전체"; S.type = "전체"; renderFilters(); renderDest(); ({ sc: scope, rows } = pick()); }   // 아래 필터 때문에 가려졌으면 필터를 풀고 다시
  if (!scope) return;
  const card = d.mb ? scope : (rows[0] || scope).closest(".dest") || scope;
  document.querySelectorAll("#destList .hl, #destList .hl-card").forEach(el => el.classList.remove("hl", "hl-card"));
  rows.forEach(r => r.classList.add("hl")); card.classList.add("hl-card");
  card.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
  clearTimeout(flashTimer); flashTimer = setTimeout(() => document.querySelectorAll("#destList .hl, #destList .hl-card").forEach(el => el.classList.remove("hl", "hl-card")), 2600);
}
function renderFilters() {
  const f = $("filters"); f.className = "filters two";
  f.innerHTML = `<div class="frow" role="group" aria-label="지원기관"><span class="flabel">지원기관</span><span class="chips">` +
    ["전체", ...SOURCE_ORGS()].map(o => `<button type="button" class="chip" data-org="${esc(o)}" aria-pressed="${S.org === o}">${o === "전체" ? "모든 기관" : esc(o)}</button>`).join("") + `</span></div>` +
    `<div class="frow" role="group" aria-label="장비 종류"><span class="flabel">장비</span><span class="chips">` +
    ["전체", ...MOVE_TYPES].map(t => `<button type="button" class="chip" data-type="${esc(t)}" aria-pressed="${S.type === t}">${t === "전체" ? "모든 장비" : esc(t)}</button>`).join("") + `</span></div>`;
  fitFilters();
}
// 지원기관 줄·장비 줄은 항상 두 줄. 화면이 좁아 한 줄에 안 들어가면 버튼 글자·여백을 같은 비율로 줄임(글자는 항상 가로, 최소 55%)
function fitFilters() {
  const f = $("filters"); if (!f || !f.offsetWidth) return;
  const rows = [...f.querySelectorAll(".frow")], over = () => Math.max(...rows.map(r => r.scrollWidth)) - (f.clientWidth - 2);
  let s = 1; f.style.setProperty("--s", s);
  for (let i = 0; i < 6 && over() > 0 && s > 0.55; i++) {          // 이름표는 그대로라 비율만으로는 모자랄 수 있어 다시 재며 줄임
    s = Math.max(0.55, s * (f.clientWidth - 2) / (f.clientWidth - 2 + over()) - 0.01); f.style.setProperty("--s", s.toFixed(3));
  }
}
addEventListener("resize", fitFilters);
if (window.ResizeObserver) new ResizeObserver(() => fitFilters()).observe($("filters"));   // 탭을 옮겨 다시 보일 때·iframe 크기가 바뀔 때도
const matches = v => (S.org === "전체" || v.org === S.org) && (S.type === "전체" || v.type === S.type);
function vehicleRow(v, stops, rec, bid) {
  const cont = !!(rec && bid && rec.stops[0] === bid && isCont(v.id, S.date, bid));   // 전날부터 이어서 지원(연속지원)
  const eta = rec && bid && !cont ? rec.times[rec.stops.indexOf(bid)] : null;   // 이 장비가 이 지사에 도착할 예상 시각(기관별 장비에서 입력)
  return `<button type="button" class="vrow" data-vid="${esc(v.id)}" data-vo="${esc(v.org)}" data-vt="${esc(v.type)}"><span class="plate">${esc(vval(v, "plate"))}</span><span class="vtype">${esc(v.type)}</span>
    <span class="status-wrap">${hasBlower(v) ? `<span class="tag blw-tag">블로워 ${esc(blowerText(v))}</span>` : ""}${cont ? `<span class="tag eta">연속지원</span>` : eta ? `<span class="tag eta">${esc(eta)} 도착 예상</span>` : ""}${stops.length > 1 ? `<span class="tag" title="${esc(stops.map(bn).join(" → "))}">${stops.length}곳 경유</span>` : ""}</span></button>`;
}
function renderDest() {
  const moves = movesOn(S.date), filtered = S.org !== "전체" || S.type !== "전체", out = [];
  S.hqs.forEach(h => {
    const cards = [];
    S.order.filter(b => b.hq_id === h.id).forEach(b => {
      const list = moves.filter(m => m.stops.includes(b.id) && matches(m.v)), arr = rval(b.id, "arrive_at");
      const arriveToday = arr && arr.slice(0, 10) === S.date && rval(b.id, "confirmed");
      if (!list.length && (filtered || !arriveToday)) return;       // 그날 이동도, 확정된 도착 요청도 없는 지사는 숨김
      const t = `round_requests:${S.round},${b.id}`, fc = fcOf(b.id), snow = fc && !fc.none ? fc.snow : null, why = rval(b.id, "reason");
      const etas = [...new Set(list.filter(m => !(m.rec.stops[0] === b.id && isCont(m.v.id, S.date, b.id))).map(m => m.rec.times[m.rec.stops.indexOf(b.id)]).filter(Boolean))].sort();   // 연속지원 장비는 도착 시각 계산에서 뺌
      cards.push(`<article class="dest" data-bid="${esc(b.id)}"><div class="dest-head">
        <h3 class="dest-name">${esc(b.name)}<span>${esc(h.name)}본부</span></h3>
        <div class="dest-time"><strong>${etas.length ? esc(fmtMD(S.date) + " " + etas[0]) : "미정"}</strong><small>도착 예상${etas.length > 1 ? " (가장 이른 장비, 장비마다 다름)" : ""}</small></div>
        <div class="dest-meta">${list.length ? "" : `<span class="tag req">도착 요청 ${esc(fmtTime(arr))}</span>`}${snow != null ? (fc.manual ? `<span class="tag snow">적설 ${esc(fmtCm(snow))}cm · 강수 ${esc(fmtCm(fc.pcp))}mm${fc.tmin != null ? ` · 최저 ${esc(fmtTmp(fc.tmin))}℃` : ""} (직접입력)</span>` : `<span class="tag snow" data-fb="${esc(b.id)}" tabindex="0">예상 적설 ${esc(fmtCm(snow))}cm · 강수 ${esc(fmtCm(fc.pcp))}mm${fc.tmin != null ? ` · 최저 ${esc(fmtTmp(fc.tmin))}℃` : ""}</span>`) : ""}${warnOf(b.id).level ? `<span class="tag wb ${WLV[warnOf(b.id).level][0]}" data-wb="${esc(b.id)}">${esc(wlabel(warnOf(b.id).level, "대설"))}</span>` : ""}
          ${why ? `<span class="tag">사유: ${H(t, "reason", esc(why))}</span>` : ""}</div></div>
        ${list.length ? list.map(m => vehicleRow(m.v, m.stops, m.rec, b.id)).join("") : `<div class="empty-state" style="border:0">조건에 맞는 장비가 없습니다.</div>`}</article>`);
    });
    if (cards.length) out.push(`<section class="hq-block" data-hqb="${esc(h.id)}"><h3 class="hq-head">${esc(h.name)}본부</h3><div class="hq-cards">` + cards.join("") + `</div></section>`);   // 본부 하나가 한 줄을 모두 쓰고, 그 안에서 지사 카드는 좌·우 2열
  });
  $("destList").innerHTML = out.length ? out.join("") : `<div class="empty-state">${esc(fmtMD(S.date))}에 이동하는 장비가 없습니다.</div>`;
}

/* ============================================================
   [5] 기관별 장비 — 도공번호·지원 여부·날짜별 경로. [확정]을 눌러야 서버에 날짜별로 저장
   ============================================================ */
// [최초 지원]에서 고를 수 있는 피지원 지사 = 고른 기준일자에서 편성 확정된 지사(확정 + 편성 1대 이상, 저장된 것 기준).
// 일괄 확정으로 편성 0대인 지사까지 확정돼도 여기에는 안 나옴. 모든 지사는 [수정본]에서만
const routeChoices = () => S.order.filter(b => isFixed(b.id));
// 요청은 있지만 아직 편성 확정 전인 지사: 목록에 회색(고를 수 없음)으로 보여서 "왜 없지?"를 바로 알게 함
const pendingChoices = () => S.order.filter(b => hasReq(b.id) && !isFixed(b.id));
const fleetRows = () => S.vehicles.filter(v => (S.fleetOrg === "전체" || v.org === S.fleetOrg) && shownIn(v, curRound()));
const nextRoundMin = () => S.rounds.length ? addDays(S.rounds[0].start_date, 1) : "2000-01-01";       // 새 기준일자는 마지막 기준일자보다 뒤
const hiddenNow = () => S.vehicles.filter(v => v.hidden_after && !shownIn(v, curRound()));          // 지금 고른 기준일자에서 숨겨진 장비(숨김 취소 목록)
const canRoute = () => can("equip.edit.all");                      // 날짜별 경로·장비 삭제·지원일 1·초기화 = 관리자(모든 장비 권한 equip.edit.all)만
const canAddVeh = () => can("equip.edit.all") || can("equip.edit.own"); // 장비 추가: 관리자(모든 기관) / 지원장비(자기 기관)
const NUM_RE = /^\d{1,5}$/;                                           // 도공번호 = 출발 기관 이름 + 숫자(예: 서울경기901). 입력은 숫자만
const plateNum = v => { const p = vval(v, "plate") || ""; return p.startsWith(v.org) ? p.slice(v.org.length) : ""; };
function renderFleet() {
  const choices = routeChoices(), r = curRound(), all = canRoute(), pend = pendingChoices();
  banner("perm-fleet", canAnyVeh(),
    all ? "도공번호·지원 여부(고른 기준일자)·지원일별 피지원 지사(하루 여러 곳은 ＋)를 고친 뒤 아래 [확정]을 눌러야 저장됩니다. 다른 기준일자가 맡은 날짜는 고칠 수 없습니다."
        : `${S.me.org || ""} 장비를 추가하고 도공번호·지원 여부(지원일 2부터는 '지원 불가'도)를 고칠 수 있습니다(지원일별 경로는 관리자). 고친 뒤 아래 [확정]을 눌러야 저장됩니다.`,
    "보기만 가능합니다.");
  $("fleetRound").innerHTML = roundSel("roundSelFleet") + (r ? "" : `<span class="hint">기준일자가 없습니다.</span>`);
  renderOrgGrid();
  const myOrgs = all ? S.orgs : S.orgs.filter(o => o === S.me.org);
  $("fleetFilters").innerHTML =
    `<div class="tb-row"><span class="tb-label">기관</span><span class="fgroup">${["전체", ...S.orgs].map(o => `<button type="button" class="chip" data-fo="${esc(o)}" aria-pressed="${S.fleetOrg === o}">${o === "전체" ? "모든 기관" : esc(o)}</button>`).join("")}</span>` +
    `<span class="tb-right"><label class="ctl">지원일 칸 <select class="ci" id="colsSel">${Array.from({ length: 9 }, (_, k) => k + 2).map(n => `<option value="${n}" ${n === S.cols ? "selected" : ""}>${n}개</option>`).join("")}</select></label>` +
    (all ? `<button type="button" class="btn" id="fleetReset">초기화</button>` : "") + `</span></div>` +
    (canAddVeh() && myOrgs.length || all ? `<div class="tb-row">` + (canAddVeh() && myOrgs.length ? `<span class="tb-label">장비 추가</span><select class="ci" id="nvOrg" aria-label="새 장비 기관">${myOrgs.map(o => `<option>${esc(o)}</option>`).join("")}</select>` +
      `<select class="ci" id="nvType" aria-label="새 장비 종류">${TYPES.map(t => `<option>${t}</option>`).join("")}</select>` +
      `<span class="pnum"><span class="pfx" id="nvPfx">${esc(myOrgs[0])}</span><input class="ci" id="nvPlate" inputmode="numeric" maxlength="5" placeholder="901" aria-label="새 장비 도공번호(숫자만)"></span><button type="button" class="btn" id="vehAdd">추가</button>` : "") +
      (all ? `<span class="tb-right mode" role="group" aria-label="지원 구분"><label><input type="checkbox" id="modeInit" ${S.revisedMode ? "" : "checked"}> 최초 지원</label>` +
        `<label><input type="checkbox" id="modeRev" ${S.revisedMode ? "checked" : ""}> 수정본</label></span>` : "") + `</div>` : "");
  const dates = windowDates(), head = dates.map((d, i) => `<th class="dayh">지원일 ${i + 1}<span class="sub">` +
    (i === 0 && all ? `<input class="ci" type="date" id="day1In" value="${esc(d)}"${r ? ` min="${esc(r.start_date)}"` : ""} aria-label="지원일 1 날짜(나머지 지원일은 하루씩 자동, 기준일자보다 앞은 안 됨)">` : esc(fmtMD(d))) + `</span></th>`).join("");
  const rows = fleetRows().map(v => fleetRowHtml(v, dates, choices, all)).join("");
  $("eqTable").innerHTML = `<thead><tr><th>도공번호</th><th>장비</th><th>블로워</th><th>지원 여부</th>${head}${canRoute() ? `<th class="unh">${unhideHead()}</th>` : ""}</tr></thead><tbody>${rows || `<tr><td colspan="${5 + dates.length}" class="empty">장비가 없습니다.${canAddVeh() ? " 위의 [장비 추가]로 넣으세요." : ""}</td></tr>`}</tbody>`;
  placeUnhide();
}
// 블로워(소·대) 체크: 제설기만 켜지고(둘 다 안 켤 수도 있음), 다른 장비·고칠 권한이 없는 줄은 꺼진 칸
const hasBlower = v => !!(vval(v, "blower_s") || vval(v, "blower_l"));
const blowerText = v => [vval(v, "blower_s") ? "소" : "", vval(v, "blower_l") ? "대" : ""].filter(Boolean).join("·");
function blowerCell(v, ed) {
  const on = ed && v.type === "제설기", box = (f, lab) => `<label class="bl${on ? "" : " off"}"><input type="checkbox" data-vb="${esc(v.id)}" data-bf="${f}" data-fk="vb:${esc(v.id)}:${f}"${vval(v, f) ? " checked" : ""}${on ? "" : " disabled"} aria-label="${esc(vval(v, "plate"))} 블로워 ${lab}"> ${lab}</label>`;
  return `<span class="blw">${box("blower_s", "소")}${box("blower_l", "대")}</span>`;
}
function fleetRowHtml(v, dates, choices, all) {
    const ed = canVeh(v), r = curRound(), st = r ? stOf(r.id, v.id).status : "", [cls, label] = STATUS[st] || STATUS[""], tv = "vehicles:" + v.id;
    // 지원 여부 = 고른 기준일자의 값(기준일자가 바뀌면 따로). 기준일자가 없으면 고칠 수 없음
    const statusCell = ed && r ? `<select class="ci" data-vs="${esc(v.id)}" data-fk="vs:${esc(v.id)}" aria-label="${esc(vval(v, "plate"))} 지원 여부"${S.sdraft.has(v.id) ? ' data-changed="1"' : ""}>${Object.keys(STATUS).map(s => `<option value="${s}" ${st === s ? "selected" : ""}>${STATUS[s][1]}</option>`).join("")}</select>`
      : r ? `<span class="status ${cls}">${label}</span>` : '<span class="muted">-</span>';
    const old = !plateNum(v) && vval(v, "plate");      // 예전 차량번호 형식이 남은 장비: 숫자를 새로 넣어야 함
    const plateCell = ed ? `<span class="pnum"${hvA(tv, "plate")}><span class="pfx">${esc(v.org)}</span><input class="ci" inputmode="numeric" maxlength="5" data-vp="${esc(v.id)}" data-fk="vp:${esc(v.id)}" value="${esc(plateNum(v))}" placeholder="901" aria-label="도공번호 숫자"${old ? `` : ""}></span>${old ? `<div class="muted sm">예전 번호 ${esc(old)}</div>` : ""}`
      : H(tv, "plate", `<span class="plate">${esc(vval(v, "plate"))}</span>`);
    const changed = S.vdraft.has(v.id) || S.sdraft.has(v.id) ? " changed" : "";
    return `<tr class="${changed}" data-vrow="${esc(v.id)}"><td>${plateCell}</td><td>${esc(v.type)}</td><td>${blowerCell(v, ed)}</td><td>${statusCell}</td>${dates.map(d => `<td data-cell="${esc(rk(d, v.id))}">${slotCell(v, d, canRoute(), choices)}</td>`).join("")}` +
      (canRoute() ? `<td class="vact"><button type="button" class="btn sm" data-vhide="${esc(v.id)}">숨기기</button><button type="button" class="btn sm danger" data-vdel="${esc(v.id)}">삭제</button></td>` : "") + `</tr>`;
}
function placeUnhide() {        // 숨김 취소 목록: 표가 가로로 스크롤되는 상자 안이라 잘리지 않게 화면 기준으로 버튼 아래에 띄움
  const b = $("unhideBtn"), pop = document.querySelector(".unhide-pop"); if (!b || !pop) return;
  const r = b.getBoundingClientRect(); pop.style.top = (r.bottom + 4) + "px"; pop.style.left = Math.max(8, Math.min(innerWidth - pop.offsetWidth - 8, r.right - pop.offsetWidth)) + "px";
}
addEventListener("scroll", () => { if (S.unhideOpen) placeUnhide(); }, true);
// 삭제 열 제목 칸의 [숨김 취소(N)]: 누르면 지금 숨겨진 장비 목록이 열리고 하나씩 취소(관리자만, 숨긴 장비가 없으면 안 보임)
function unhideHead() {
  const l = hiddenNow(); if (!l.length) { S.unhideOpen = false; return ""; }
  return `<button type="button" class="btn sm" id="unhideBtn" aria-expanded="${S.unhideOpen}">숨김 취소(${l.length})</button>` +
    (S.unhideOpen ? `<div class="unhide-pop" role="dialog" aria-label="숨긴 장비">${l.map(v => `<div class="uh-row"><span class="plate">${esc(v.plate)}</span><span class="muted">${esc(v.type)}</span><button type="button" class="btn sm" data-unhide="${esc(v.id)}">숨김 취소</button></div>`).join("")}</div>` : "");
}
function renderOrgGrid() {
  $("orgGrid").innerHTML = S.orgs.map(org => {
    const r = curRound(), sv = v => r ? stOf(r.id, v.id).status : "";            // 고른 기준일자의 지원 여부
    const l = S.vehicles.filter(v => v.org === org && shownIn(v, r)), c = s => l.filter(v => sv(v) === s).length, w = x => l.length ? x / l.length * 100 : 0;
    return `<div class="org"><h3>${esc(org)}</h3>
      <div class="bar" aria-hidden="true"><i class="b-go" style="width:${w(c("O"))}%"></i><i class="b-stop" style="width:${w(c("X") + c("M"))}%"></i></div>
      <dl><dt>지원</dt><dd>${c("O")}대</dd><dt>지원 불가</dt><dd>${c("X")}대</dd><dt>정비중</dt><dd>${c("M")}대</dd><dt>미정</dt><dd>${c("")}대</dd>
      ${TYPES.map(t => { const tl = l.filter(v => v.type === t); return `<dt>${t}</dt><dd>${tl.filter(v => sv(v) === "O").length} / ${tl.length}</dd>`; }).join("")}</dl></div>`;
  }).join("");
}
// 바뀐 장비 한 줄 / 칸 하나만 다시 그림. 그 칸에 있던 커서는 되살림
function keepFocus(fn) { const a = document.activeElement, fk = a && a.dataset && a.dataset.fk; fn(); if (fk) { const n = [...document.querySelectorAll("[data-fk]")].find(i => i.dataset.fk === fk); if (n && n !== document.activeElement) n.focus(); } }
function patchVehicle(vid) {
  const v = vehById(vid), tr = document.querySelector(`#eqTable tr[data-vrow="${CSS.escape(vid)}"]`);
  if (v && tr) keepFocus(() => { tr.outerHTML = fleetRowHtml(v, windowDates(), routeChoices(), can("equip.edit.all")); });
  renderOrgGrid(); afterAnyChange();
}
function patchCell(vid, d) {
  const v = vehById(vid), td = document.querySelector(`#eqTable td[data-cell="${CSS.escape(rk(d, vid))}"]`);
  if (v && td) keepFocus(() => { td.innerHTML = slotCell(v, d, canRoute(), routeChoices()); });
  afterAnyChange();
}
function afterAnyChange() { hideTip(); renderMatrix(); renderDest(); updateSavebars(); }   // 다른 탭(이동 현황)과 저장 바만 새로
// 도착 예상 시각: 직접 입력. 0730 / 730 / 7:30 → 07:30, 7 → 07:00, 빈칸 → 없음. 잘못된 값은 undefined
function normTime(x) {
  x = String(x || "").trim(); if (!x) return null;
  let h, m; const c = x.match(/^(\d{1,2}):(\d{1,2})$/);
  if (c) { h = +c[1]; m = +c[2]; }
  else if (/^\d{1,4}$/.test(x)) { if (x.length <= 2) { h = +x; m = 0; } else { h = +x.slice(0, -2); m = +x.slice(-2); } }
  else return undefined;
  return h <= 23 && m <= 59 ? p2(h) + ":" + p2(m) : undefined;
}
// 다른 기준일자가 맡은 날짜(또는 어느 기준일자에도 없는 날짜)의 칸: 고칠 수 없고, 마우스를 올리면 어느 기준일자에서 언제 고쳤는지
function lockedCell(v, d, g) {
  const rec = effRec(d, v.id), st = g ? stOf(g.id, v.id) : null;
  const at = [S.rmeta.get(rk(d, v.id)), st && st.updated_at].filter(Boolean).sort().pop();
  const tip = g ? `기준일자 ${fmtMD(g.start_date)}에서 수정${at ? " · " + fmtShort(at) : ""}` : "어느 기준일자 기간에도 들지 않는 날짜";
  const body = rec.stops.length ? rec.stops.map((x, j) => `<div class="sl-x slot-x"><span class="sl-n">${esc(bn(x))}</span> <small>${j === 0 && isCont(v.id, d, x) ? "연속지원" : esc(rec.times[j] || "")}</small></div>`).join("")
    : g && st.status ? `<span class="muted">${esc(availOn(v.id, d) ? "-" : st.status === "O" ? "지원 불가" : STATUS[st.status][1])}</span>` : '<span class="muted">-</span>';
  return `<div class="slot locked" title="${esc(tip)}" data-lock="${esc(g ? g.start_date : "")}">${body}</div>`;
}
// 지원 불가 시작일(off_from) 이후 칸. 시작일 칸에서는 [취소]로 되돌림(고칠 권한이 있을 때)
function offCell(v, d, st) {
  const first = d === st.off_from && canVeh(v);
  return `<div class="slot offday"><span class="status stop">지원 불가</span>${d === st.off_from ? `<small class="muted">이날부터</small>` : ""}` +
    (first ? ` <button type="button" class="btn sm" data-offclr="${esc(v.id)}" aria-label="${esc(vval(v, "plate"))} 지원 불가 취소">취소</button>` : "") + `</div>`;
}
function slotCell(v, d, ed, confirmed) {
  const g = govRound(d), cr = curRound();
  if (!g || !cr || g.id !== cr.id) return lockedCell(v, d, g);          // 고른 기준일자가 맡지 않은 날짜 = 고칠 수 없음
  const st = stOf(cr.id, v.id);
  if (st.status === "O" && st.off_from && d >= st.off_from) return offCell(v, d, st);
  const later = d > cr.start_date;                                     // 지원일 2부터는 '지원 불가(이날부터)'를 고를 수 있음
  const rec = effRec(d, v.id), stops = rec.stops, k = rk(d, v.id), t = `vehicle_routes:${d},${v.id}`, changed = S.draft.has(k), vid = esc(v.id);
  const cont = j => j === 0 && isCont(v.id, d, stops[0]);            // 전날 마지막 지사 = 오늘 첫 지사 → 시각 대신 "연속지원"(입력해 둔 시각은 그대로 남음)
  const tIn = (val, j, extra, dis) => !extra && cont(j) ? `<span class="cont">연속지원</span>` : `<input class="ci tm" data-rt="${vid}" data-rd="${d}" data-fk="${extra ? "tn" : "t"}:${d}:${vid}:${j}" value="${esc(val || "")}" placeholder="--:--" maxlength="5" inputmode="numeric" ${dis ? "disabled" : ""} aria-label="${esc(vval(v, "plate"))} ${esc(fmtMD(d))} 지사 ${j + 1} 도착 예상 시각">`;
  const offSel = later && canVeh(v) && st.status === "O" ? `<select class="ci offsel" data-off="${vid}" data-rd="${d}" data-fk="off:${d}:${vid}" aria-label="${esc(vval(v, "plate"))} ${esc(fmtMD(d))} 지원 여부"><option value="">지원</option><option value="1">지원 불가(이날부터)</option></select>` : "";
  if (!ed) {                     // 경로의 지사는 못 고침. 지원장비 계정은 자기 기관 장비의 도착 예상 시각과 지원 불가(지원일 2부터)만
    const timeEd = canVeh(v);
    if (!stops.length) return offSel ? `<div class="slot">${offSel}</div>` : `<span class="muted">-</span>`;
    return `<div class="slot${changed ? " changed" : ""}"${hvA(t)}>${stops.map((x, j) => `<div class="sl-x slot-x"><span class="sl-n">${esc(bn(x))}</span>${timeEd ? tIn(rec.times[j], j, false, false) : cont(j) ? ` <small>연속지원</small>` : rec.times[j] ? ` <small>${esc(rec.times[j])}</small>` : ""}</div>`).join("")}${offSel}</div>`;
  }
  // 표 위 [최초 지원] = 이 기준일자에 편성 확정된 지사만 / [수정본] = 모든 지사 (한 번에 적용)
  const choices = S.revisedMode ? S.order : confirmed, off = st.status !== "O", ids = new Set(choices.map(b => b.id)), pend = S.revisedMode ? [] : pendingChoices();
  const opts = (cur, j) => `<option value="">지사 선택</option>` + S.hqs.map(h => { const l = choices.filter(b => b.hq_id === h.id); return l.length ? `<optgroup label="${esc(h.name)}">${l.map(b => `<option value="${b.id}" ${cur === b.id ? "selected" : ""}>${esc(b.name)}</option>`).join("")}</optgroup>` : ""; }).join("") +
    (cur && !ids.has(cur) ? `<option value="${esc(cur)}" selected>${esc(bn(cur))} (편성 확정 전)</option>` : "") +
    (pend.length ? `<optgroup label="편성 확정 전(요청만) — 고를 수 없음">${pend.map(b => `<option disabled>${esc(b.name)}</option>`).join("")}</optgroup>` : "") +
    (later && j === 0 ? `<option value="__off">지원 불가(이날부터)</option>` : "") + `<option value="__del">지우기</option>`;
  const sel = (cur, j, extra) => `<select class="ci" data-rv="${vid}" data-rd="${d}" data-fk="${extra ? "rn" : "r"}:${d}:${vid}:${j}" ${off ? "disabled" : ""} aria-label="${esc(vval(v, "plate"))} ${esc(fmtMD(d))} 피지원 지사 ${j + 1}">${opts(cur, extra ? 1 : j)}</select>` +
    tIn(extra ? "" : rec.times[j], j, extra, off);
  const extra = S.extraStop.has(k), list = stops.length ? stops : [""];
  const plus = `<button type="button" class="btn sm" data-stop-add="${esc(k)}" ${off || !stops.length ? "disabled" : ""} aria-label="${esc(vval(v, "plate"))} ${esc(fmtMD(d))}에 들르는 지사 추가">＋</button>`;
  return `<div class="slot${changed ? " changed" : ""}"${hvA(t)}>${list.map((x, j) => `<div class="slot-x">${sel(x, j, false)}${j === list.length - 1 && !extra ? plus : ""}</div>`).join("")}${extra ? `<div class="slot-x">${sel("", list.length, true)}</div>` : ""}</div>`;
}
// 칸 안의 줄(지사 + 도착 예상 시각)을 모아 경로 기록으로. 지사를 고치면 구분 = 표 위 [최초 지원]/[수정본], 시각만 고치면 구분은 그대로
function readCell(vid, d, timeOnly) {
  const td = document.querySelector(`#eqTable td[data-cell="${CSS.escape(rk(d, vid))}"]`), rec = recOf(d, vid), stops = [], times = [];
  if (td) td.querySelectorAll(".slot-x").forEach((row, j) => { const s = row.querySelector("select[data-rv]"), tm = row.querySelector("input[data-rt]");
    const stop = s ? s.value : rec.stops[j];
    if (stop && stop !== "__del" && stop !== "__off") { stops.push(stop); times.push(tm ? normTime(tm.value) || null : rec.times[j] || null); } });
  return { stops, times, revised: timeOnly ? rec.revised : S.revisedMode };
}
async function confirmFleet() {
  if (S.preview) return toast("미리보기에서는 확정할 수 없습니다. '내 아이디'로 돌아오세요.", true);
  const vehicles = [...S.vdraft].map(([id, f]) => ({ id, ...f })), routes = [...S.draft].map(([k, x]) => { const [date, vehicle_id] = k.split("|");
    return { date, vehicle_id, stops: x.stops, revised: x.revised, times: x.times.some(Boolean) ? x.times : null }; });
  const status = [...S.sdraft].map(([vehicle_id, x]) => ({ vehicle_id, status: x.status, off_from: x.off_from || null }));
  if (!vehicles.length && !routes.length && !status.length) return;
  if ((routes.length || status.length) && !S.round) return toast("기준일자가 없어 지원 여부·경로를 확정할 수 없습니다. 지사별 요청·편성에서 기준일자를 먼저 만드세요.", true);
  const what = [routes.length ? `경로 ${routes.length}칸` : "", status.length ? `지원 여부 ${status.length}대` : "", vehicles.length ? `장비 ${vehicles.length}대(도공번호·블로워)` : ""].filter(Boolean).join(", ");
  if (!confirm(`${what} 변경을 확정할까요?\n지원 여부는 기준일자 ${fmtMD(curRound().start_date)} 것으로 저장되고, 경로는 날짜별로 남습니다.`)) return;
  busy("fleet", true);
  const r = await Api.saveFleet(vehicles, routes, S.round, status);
  busy("fleet", false);
  if (!r.ok) return toast(r.message, true);
  const now = new Date().toISOString();
  vehicles.forEach(p => Object.assign(vehById(p.id), p)); sortVehicles();
  status.forEach(x => S.rstat.set(S.round + "|" + x.vehicle_id, { status: x.status, off_from: x.off_from, updated_at: now }));
  routes.forEach(x => { const k = rk(x.date, x.vehicle_id); if (x.stops.length) { S.routes.set(k, normRec(x)); S.rmeta.set(k, now); } else S.routes.delete(k); });
  S.draft.clear(); S.vdraft.clear(); S.sdraft.clear(); S.extraStop.clear();
  await loadAudit(); refresh();
  toast(`확정했습니다 (${what})`);
}
function resetFleet() {          // 보이는 장비의 지원 여부(고른 기준일자)와, 고른 기준일자가 맡은 날짜의 경로를 비움(확정 전 되돌리기 가능)
  const vs = fleetRows().filter(canVeh), cr = curRound(), ds = windowDates().filter(d => cr && (govRound(d) || {}).id === cr.id);
  if (!vs.length || !canRoute() || !cr) return;
  if (!confirm(`보이는 장비 ${vs.length}대의 지원 여부와 ${ds.length ? `지원일 ${fmtMD(ds[0])} ~ ${fmtMD(ds[ds.length - 1])} 경로를` : "경로를"} 모두 비울까요?\n[확정]을 눌러야 서버에 반영되고, 그 전에는 [되돌리기]로 돌아갈 수 있습니다.`)) return;
  vs.forEach(v => { ds.forEach(d => setRoute(d, v.id, EMPTY)); setStat(v.id, { status: "" }); });
  S.extraStop.clear(); refresh(); toast("입력을 비웠습니다. [확정]을 눌러야 저장됩니다.");
}
async function addVehicle() {
  const num = $("nvPlate").value.replace(/\s/g, ""), org = $("nvOrg").value, plate = org + num;
  if (!NUM_RE.test(num)) return toast("도공번호는 숫자만 넣으세요 (예: 901 → " + org + "901)", true);
  if (S.vehicles.some(v => vval(v, "plate") === plate)) return toast("같은 도공번호가 이미 있습니다", true);
  if (!can("equip.edit.all") && org !== S.me.org) return toast("자기 기관 장비만 추가할 수 있습니다", true);
  if (S.preview) return toast("미리보기에서는 장비를 추가할 수 없습니다.", true);
  const seq = Math.max(0, ...S.vehicles.map(v => +v.id.slice(1) || 0)) + 1;
  const v = { id: "V" + String(seq).padStart(3, "0"), org, type: $("nvType").value, plate, sort: Math.max(0, ...S.vehicles.map(x => x.sort || 0)) + 10 };
  const r = await Api.addVehicle(v);
  if (!r.ok) return toast(r.message, true);
  S.vehicles.push(r.vehicle); sortVehicles(); await loadAudit(); refresh(); toast(`장비를 추가했습니다 (${plate})`);
}
async function deleteVehicle(id) {
  const v = vehById(id); if (!v || !canRoute()) return;       // 장비 삭제는 관리자(equip.edit.all)만. 경로 기록이 있는 장비는 서버가 거절(숨기기를 써야 함)
  if (S.preview) return toast("미리보기에서는 장비를 지울 수 없습니다.", true);
  if (!confirm(`${v.plate} (${v.org} ${v.type})를 지울까요?`)) return;
  const r = await Api.deleteVehicle(id);
  if (!r.ok) return toast(r.message, true);
  S.vehicles = S.vehicles.filter(x => x.id !== id); S.vdraft.delete(id); S.sdraft.delete(id);
  [...S.draft.keys()].filter(k => k.endsWith("|" + id)).forEach(k => S.draft.delete(k)); [...S.routes.keys()].filter(k => k.endsWith("|" + id)).forEach(k => S.routes.delete(k));
  [...S.rstat.keys()].filter(k => k.endsWith("|" + id)).forEach(k => S.rstat.delete(k));
  await loadAudit(); refresh(); toast("장비를 지웠습니다");
}
// 숨기기: 고른 기준일자부터 기관별 장비 목록에서 안 보임(hidden_after = 그 전날). 이전 기준일자·이동 현황 기록은 그대로. 관리자만
async function hideVehicle(id, show) {
  const v = vehById(id); if (!v || !canRoute()) return;
  if (S.preview) return toast("미리보기에서는 바꿀 수 없습니다.", true);
  const after = show ? null : addDays((curRound() || {}).start_date || todayISO(), -1);
  if (!show && !confirm(`${v.plate} 장비를 숨길까요?`)) return;
  const r = await Api.hideVehicle(id, after);
  if (!r.ok) return toast(r.message, true);
  v.hidden_after = after;
  if (!show) { S.vdraft.delete(id); S.sdraft.delete(id); [...S.draft.keys()].filter(k => k.endsWith("|" + id)).forEach(k => S.draft.delete(k)); }
  if (!hiddenNow().length) S.unhideOpen = false;
  await loadAudit(); refresh(); toast(show ? `${v.plate} 숨김을 취소했습니다` : `${v.plate} 장비를 숨겼습니다`);
}

/* ============================================================
   [6] 지사별 요청·편성 — 기준일자마다 지사별 요청, 편성 대수, 확정
   ============================================================ */
const HOURS = Array.from({ length: 24 }, (_, i) => p2(i)), MINS = ["00", "10", "20", "30", "40", "50"];
function arriveCell(b, ed, t) {          // ed = 입력칸을 보일지(고칠 권한). 확정한 줄이면 비활성
  const v = rval(b.id, "arrive_at"), lk = isConf(b.id);
  if (!ed) return v ? H(t, "arrive_at", esc(fmtTime(v))) : '<span class="muted">-</span>';
  const [d, tm] = v ? v.split("T") : ["", ""], [hh, mm] = tm ? tm.split(":") : ["", ""];
  const mins = MINS.includes(mm) || !mm ? MINS : [...MINS, mm].sort();
  // 시는 00~23, 분은 10분 단위 — 고르는 목록이라 위아래 끝에서 멈춤(무한히 돌지 않음)
  return `<span class="arr"${hvA(t, "arrive_at")}><input class="ci" type="date" data-arr="${b.id}" data-part="d" data-fk="ad:${b.id}" value="${esc(d)}" aria-label="${esc(b.name)} 도착 요청 날짜"${lk ? " disabled" : ""}>` +
    `<select class="ci" data-arr="${b.id}" data-part="h" data-fk="ah:${b.id}" ${d && !lk ? "" : "disabled"} aria-label="${esc(b.name)} 도착 시">${HOURS.map(x => `<option ${x === (hh || "00") ? "selected" : ""}>${x}</option>`).join("")}</select>시 ` +
    `<select class="ci" data-arr="${b.id}" data-part="m" data-fk="am:${b.id}" ${d && !lk ? "" : "disabled"} aria-label="${esc(b.name)} 도착 분">${mins.map(x => `<option ${x === (mm || "00") ? "selected" : ""}>${x}</option>`).join("")}</select>분</span>`;
}
const HQ_SUM_KEYS = ["req_truck", "req_blower", "assigned_truck", "assigned_blower", "confirmed"];
function hqSums(hid) {
  const rows = S.order.filter(b => b.hq_id === hid), sum = f => rows.reduce((a, b) => a + (+rval(b.id, f) || 0), 0);
  return { req_truck: sum("req_truck"), req_blower: sum("req_blower"), assigned_truck: sum("assigned_truck"), assigned_blower: sum("assigned_blower"), confirmed: rows.filter(b => rval(b.id, "confirmed")).length || "" };
}
function afterReq(id) {          // 지사 요청 칸을 고친 뒤: 그 줄 표시·최종 대수·본부 합계·도착 시각 칸 잠금만 고침(입력 중인 칸은 그대로)
  const b = S.brById[id], tr = document.querySelector(`#branchTable tr[data-b="${id}"]`);
  if (tr) {
    tr.classList.toggle("changed", S.rdraft.has(id)); tr.classList.add("active");
    const hasDate = !!rval(id, "arrive_at"); tr.querySelectorAll('[data-arr][data-part="h"], [data-arr][data-part="m"]').forEach(x => { x.disabled = !hasDate || isConf(id); });
  }
  const hr = b && document.querySelector(`#branchTable tr.hq[data-hq="${b.hq_id}"]`);
  if (hr) { const sm = hqSums(b.hq_id); HQ_SUM_KEYS.forEach(k => { const c = hr.querySelector(`[data-s="${k}"]`); if (c) c.textContent = sm[k]; }); }
  afterAnyChange();
}
// 제목 줄이 두 줄인 표: 스크롤해도 두 줄이 겹치지 않게, 둘째 줄은 첫 줄 높이만큼 아래에 붙임(높이는 화면 폭에 따라 달라서 매번 잼)
function stickHead(table) {
  if (!table || !table.tHead || !table.offsetParent) return;
  let top = 0;
  [...table.tHead.rows].forEach(tr => { [...tr.cells].forEach(th => { if (th.rowSpan <= 1 || tr.rowIndex === 0) th.style.top = (th.rowSpan > 1 ? 0 : top) + "px"; }); top += tr.getBoundingClientRect().height; });
}
addEventListener("resize", () => { stickHead($("branchTable")); stickHead($("matrix")); });
function renderBranch() {
  const m = S.me, r = curRound();
  banner("perm-branch", canAnyReq(),
    can("req.confirm") ? "모든 지사의 요청·편성·확정을 고칠 수 있습니다. 확정한 지사만 기관별 장비에서 피지원 지사로 고를 수 있습니다. 고친 뒤 아래 [저장]을 눌러 주세요."
      : can("req.edit.hq") ? `${(S.hqById[m.hq_id] || {}).name || ""}본부 지사들의 요청을 고칠 수 있습니다(편성·확정은 관리자). 고친 뒤 [저장]을 눌러 주세요.`
      : `${bn(m.branch_id)} 지사 행의 요청만 고칠 수 있습니다(편성·확정은 관리자). 고친 뒤 [저장]을 눌러 주세요.`,
    "보기만 가능합니다.");
  $("branchRound").innerHTML = roundSel("roundSelBranch") +
    (can("req.confirm") && r ? `<button type="button" class="btn danger" id="roundDel">기준일자 삭제</button>` : "") +
    (can("req.confirm") ? `<span class="sep"></span><label class="ctl">새 기준일자 <input class="ci" type="date" id="newRoundDate" value="${esc(nextRoundMin() > todayISO() ? nextRoundMin() : todayISO())}" min="${esc(nextRoundMin())}"></label><button type="button" class="btn" id="roundMake">만들기</button>` : "");
  $("branchCtl").innerHTML = r ? `<div class="tb-row"><span class="tb-label">보기</span><button type="button" class="chip" id="onlyActive" aria-pressed="${S.bview === "req"}">요청 있는 지사만</button>` +
    `<button type="button" class="chip" id="onlyFixed" aria-pressed="${S.bview === "fixed"}">편성 확정된 지사만</button>` +
    `<span class="tb-right"></span>` +
    (S.me.role === "admin" ? `<button type="button" class="btn sm" id="zoneMgr">특보구역 관리</button>` : "") + `</div>` : "";
  if (!r) { $("branchTable").innerHTML = `<tbody><tr><td class="empty">기준일자가 없습니다.</td></tr></tbody>`; return; }
  const conf = can("req.confirm");
  let h = `<thead><tr><th class="l" rowspan="2">지사</th><th colspan="2" class="fch">24시 강설 <small class="fcbase" id="fcBaseHead" data-bt="fc" tabindex="0">${esc(fcBase())}</small></th><th colspan="2" class="fch tmh">최저기온</th><th colspan="3" class="wh">대설특보 발표 <small class="fcbase" id="wBaseHead" data-bt="warn" tabindex="0">${esc(warnBase())}</small></th><th class="wxh" rowspan="2">기상현황<br>직접입력</th><th colspan="2">지사 요청</th><th colspan="2">편성</th><th>확정</th><th class="l" rowspan="2">도착 요청</th></tr>
    <tr><th class="fch">적설<small class="thsub">cm</small></th><th class="fch">강수<small class="thsub">mm</small></th><th class="fch tmh">기온<small class="thsub">℃</small></th><th class="fch tmh">시각</th><th class="wh">종류</th><th class="wh">발표</th><th class="wh">발효</th><th>제설차</th><th>제설기</th><th>제설차</th><th>제설기</th><th class="cf">${conf ? bulkCell(null) : ""}</th></tr></thead><tbody>`;
  const has = b => hasReq(b.id) || S.rdraft.has(b.id);                  // 요청 있음(입력 중 포함)
  const mine = b => (m.branch_id === b.id) || (can("req.edit.hq") && !can("req.confirm") && b.hq_id === m.hq_id);
  S.hqs.forEach(hq => {
    if (hq.is_private) return;                                   // 민자는 지사별 요청·편성에 나오지 않음
    const rows = S.order.filter(b => b.hq_id === hq.id), shown = rows.filter(b => S.bview === "all" || mine(b) || (S.bview === "req" ? has(b) : isFixed(b.id)));
    if (!shown.length) return;
    const closed = S.closedHq.has(hq.id), hsum = hqSums(hq.id);
    h += `<tr class="hq ${closed ? "closed" : ""}" data-hq="${hq.id}" tabindex="0"><td class="l">${esc(hq.name)}</td><td></td><td></td><td></td><td></td><td></td><td></td><td></td><td></td>
      ${HQ_SUM_KEYS.map(k => k === "confirmed" && conf ? `<td class="cf">${bulkCell(hq.id)}</td>` : `<td data-s="${k}">${hsum[k]}</td>`).join("")}<td></td></tr>`;
    if (closed) return;
    shown.forEach(b => {
      const ed = canReq(b), t = `round_requests:${S.round},${b.id}`, on = has(b), d0 = dis(b.id);      // ed = 입력칸을 보임, 확정한 줄이면 비활성(d0)
      const num = (f, lab, editable) => editable ? `<input class="ci num" type="number" inputmode="numeric" min="0" max="999" data-rq="${b.id}" data-f="${f}" data-fk="q:${b.id}:${f}" value="${esc(rval(b.id, f) ?? 0)}" aria-label="${esc(b.name)} ${lab}"${hvA(t, f)}${d0}>`
        : (on ? H(t, f, esc(rval(b.id, f) ?? 0)) : "-");
      const ok = rval(b.id, "confirmed");
      h += `<tr class="${on ? "active" : ""} ${m.branch_id === b.id ? "mine" : ""} ${S.rdraft.has(b.id) ? "changed" : ""} ${isConf(b.id) ? "locked" : ""}" data-b="${b.id}"><td class="l">${esc(b.name)}${m.branch_id === b.id ? ' <span class="tag">내 지사</span>' : ""}</td>
        <td class="${isManual(b.id) ? "wxe" : ""}" data-fcell="${b.id}">${fcInner(b.id, "snow")}</td><td class="${isManual(b.id) ? "wxe" : ""}" data-pcell="${b.id}">${fcInner(b.id, "pcp")}</td>
        <td class="${isManual(b.id) ? "wxe" : ""}" data-tcell="${b.id}">${fcInner(b.id, "tmin")}</td><td class="tat ${isManual(b.id) ? "wxe" : ""}" data-tacell="${b.id}">${fcInner(b.id, "tmin_at")}</td>
        ${warnCells(b.id)}
        <td class="wxm">${ed ? `<input type="checkbox" data-rq="${b.id}" data-f="wx_manual" data-fk="q:${b.id}:wx_manual"${isManual(b.id) ? " checked" : ""} aria-label="${esc(b.name)} 기상현황 직접입력"${hvA(t, "wx_manual")}${d0}>` : (isManual(b.id) ? H(t, "wx_manual", "✓") : '<span class="muted">-</span>')}</td>
        <td>${num("req_truck", "요청 제설차", ed)}</td><td>${num("req_blower", "요청 제설기", ed)}</td><td>${num("assigned_truck", "편성 제설차", ed && conf)}</td><td>${num("assigned_blower", "편성 제설기", ed && conf)}</td>
        <td class="cf">${conf ? H(t, "confirmed", ok ? `<span class="status go">확정됨</span> <button type="button" class="btn sm" data-unconfirm="${b.id}">취소</button>`
                                                     : `<button type="button" class="btn sm primary" data-confirm="${b.id}">확정</button>`)
                                 : (ok ? H(t, "confirmed", '<span class="status go">확정</span>') : '<span class="muted">-</span>')}</td>
        <td class="l">${arriveCell(b, ed, t)}</td>
</tr>`;
    });
  });
  $("branchTable").innerHTML = h + "</tbody>";
  stickHead($("branchTable"));
}
// 지사 줄 저장(바뀐 열만). extra 는 그 줄에 더할 값(확정 버튼: { confirmed: true/false })
async function saveBranchRows(ids, extra, msg) {
  if (S.preview) return toast("미리보기에서는 저장할 수 없습니다. '내 아이디'로 돌아오세요.", true);
  const list = ids.map(b => { const f = { ...(S.rdraft.get(b) || {}), ...(extra || {}) }, o = { branch_id: b };
    Object.entries(f).forEach(([k, v]) => { o[k] = k === "arrive_at" ? (v ? new Date(v).toISOString() : null) : k === "reason" ? (v || "") : v; }); return { o, f }; });
  if (!list.length) return;
  busy("branch", true);
  const r = await Api.saveRequests(S.round, list.map(x => x.o));
  busy("branch", false);
  if (!r.ok && r.code === "55000") {                    // 그사이 다른 화면(관리자)에서 확정됨 → 최신으로 다시 읽고, 그 지사 줄의 고친 값은 버림
    await loadReqs(); const done = ids.filter(isConf); done.forEach(id => S.rdraft.delete(id)); refresh();
    return toast(`${(done.length ? done : ids).map(bn).join(", ")} 지사는 이미 확정되어 고칠 수 없습니다. 확정이 취소된 뒤에 고쳐 주세요.`, true);
  }
  if (!r.ok) return toast(r.message, true);
  list.forEach(({ o, f }) => { S.reqs[o.branch_id] = { ...REQ_DEF, round_id: S.round, branch_id: o.branch_id, ...(S.reqs[o.branch_id] || {}), ...f }; S.rdraft.delete(o.branch_id); });
  if (extra && "confirmed" in extra) {                // 확정하면 서버가 그 순간 대설 특보·예보를 남김 → 다시 읽어 표시
    await loadReqs();
    if (extra.confirmed && ids.length === 1) { const f = fcOf(ids[0]); msg += ` (대설특보: ${wlabel(warnOf(ids[0]).level, "대설")}, 적설 ${f && f.snow != null ? fmtCm(f.snow) + "cm" : "없음"}·강수 ${f && f.pcp != null ? fmtCm(f.pcp) + "mm" : "없음"}·최저 ${f && f.tmin != null ? fmtTmp(f.tmin) + "℃" : "없음"})`; }
  }
  await loadAudit(); refresh(); toast(msg);
}
const saveBranch = () => saveBranchRows([...S.rdraft.keys()], null, `저장했습니다 (${S.rdraft.size}개 지사)`);
const scopeIds = hq => S.order.filter(b => !(S.hqById[b.hq_id] || {}).is_private && (!hq || b.hq_id === hq)).map(b => b.id);   // 일괄 확정·취소 대상(민자 제외, hq = 그 본부만)
function bulkCell(hq) {
  const ids = scopeIds(hq), all = ids.length && ids.every(id => rval(id, "confirmed")), any = ids.some(isConf), a = hq ? ` data-hq-scope="${esc(hq)}"` : "";
  return `<span class="bulk">${all ? '<span class="status go">모두 확정</span>' : `<button type="button" class="btn sm primary" ${hq ? `data-confirm-hq="${esc(hq)}"` : 'id="confirmAll"'}>일괄 확정</button>`}` +
    (any ? `<button type="button" class="btn sm" ${hq ? `data-unconfirm-hq="${esc(hq)}"` : 'id="unconfirmAll"'}>일괄 취소</button>` : "") + `</span>`;
}
function unconfirmAll(hq) {           // 확정된 지사를 모두 확정 취소(hq = 그 본부만)
  if (!can("req.confirm")) return;
  const hn = hq ? `${(S.hqById[hq] || {}).name || ""} 본부 ` : "", ids = scopeIds(hq).filter(isConf);
  if (!ids.length) return toast(`${hn || "모든 "}지사 중 확정된 지사가 없습니다`);
  if (!confirm(`${hn}${ids.length}개 지사의 확정을 취소할까요? 바로 저장됩니다.\n${ids.map(bn).join(", ")}\n기관별 장비 선택지에서 빠집니다(이미 넣은 경로는 그대로).`)) return;
  saveBranchRows(ids, { confirmed: false }, `${hn}${ids.length}개 지사의 확정을 취소했습니다`);
}
function confirmAll(hq) {             // 아직 확정 안 된 지사를 모두 확정(요청을 저장하지 않은 지사도 — 개별 [확정]과 같음). hq = 그 본부만
  if (!can("req.confirm")) return;
  const hn = hq ? `${(S.hqById[hq] || {}).name || ""} 본부 ` : "";
  const ids = S.order.filter(b => !(S.hqById[b.hq_id] || {}).is_private && (!hq || b.hq_id === hq) && !rval(b.id, "confirmed")).map(b => b.id);
  if (!ids.length) return toast(`${hn || "모든 "}지사가 이미 확정됐습니다`);
  if (!confirm(`${hn}${ids.length}개 지사를 확정할까요? 바로 저장됩니다.\n${ids.map(bn).join(", ")}\n이 지사 줄에서 고친 값도 함께 저장되고, 확정하면 [취소]하기 전까지 고칠 수 없습니다.`)) return;
  saveBranchRows(ids, { confirmed: true }, `${hn}${ids.length}개 지사를 확정했습니다`);
}
function confirmBranch(id, on) {
  const b = S.brById[id]; if (!b || !can("req.confirm")) return;
  const more = S.rdraft.has(id) ? "\n이 지사 줄에서 고친 값도 함께 저장됩니다." : "";
  if (!confirm(on ? `${b.name} 지사의 편성을 확정할까요? 바로 저장되고, 기관별 장비에서 이 지사를 고를 수 있습니다.\n확정하면 [취소]하기 전까지 이 줄은 고칠 수 없습니다.${more}` : `${b.name} 지사의 확정을 취소할까요? 기관별 장비 선택지에서 빠집니다(이미 넣은 경로는 그대로).${more}`)) return;
  saveBranchRows([id], { confirmed: on }, on ? `${b.name} 지사를 확정했습니다` : `${b.name} 지사 확정을 취소했습니다`);
}
async function makeRound() {
  const d = $("newRoundDate").value;
  if (!d) return toast("기준일자 날짜를 고르세요", true);
  if (S.preview) return toast("미리보기에서는 만들 수 없습니다.", true);
  if (S.rounds.some(r => r.start_date >= d)) return toast("새 기준일자는 마지막 기준일자보다 뒤 날짜여야 합니다", true);
  if (!confirm(`${d} 기준일자를 만들까요?\n장비 지원 여부는 이전 기준일자의 것을 그대로 이어받습니다(나중에 고칠 수 있음).`)) return;
  const r = await Api.createRound(d);
  if (!r.ok) return toast(r.message, true);
  S.rounds.push(r.round); S.rounds.sort((a, b) => b.start_date.localeCompare(a.start_date));
  await loadAudit(); await switchRound(r.round.id, true); toast("기준일자를 만들었습니다");
}
async function deleteRound() {
  const r = curRound(); if (!r) return;
  if (S.preview) return toast("미리보기에서는 지울 수 없습니다.", true);
  const n = Object.keys(S.reqs).length;
  if (S.rounds[0] && S.rounds[0].id !== r.id) return toast("가장 마지막 기준일자만 지울 수 있습니다", true);
  if ([...S.routes.keys()].some(k => { const d = k.split("|")[0]; return d >= r.start_date && d <= roundEnd(r); })) return toast("이 기준일자 기간에 경로가 있어 지울 수 없습니다. 경로를 먼저 비우세요.", true);
  if (!confirm(`기준일자 ${r.start_date}를 지울까요?\n이 기준일자의 지사 요청·편성 ${n}건과 장비 지원 여부도 함께 지워집니다(지운 내용은 수정 기록에 남음).`)) return;
  const res = await Api.deleteRound(r.id);
  if (!res.ok) return toast(res.message, true);
  S.rounds = S.rounds.filter(x => x.id !== r.id); S.stLoaded.delete(r.id); [...S.rstat.keys()].filter(k => k.startsWith(r.id + "|")).forEach(k => S.rstat.delete(k));
  await loadAudit(); await switchRound(pickRound(), true); toast("기준일자를 지웠습니다");
}
async function switchRound(id, force) {
  if (!force && (branchDirty() || fleetDirty()) && !confirm("확정·저장하지 않은 변경이 있습니다. 버리고 기준일자를 바꿀까요?")) { refresh(); return; }
  S.rdraft.clear(); S.draft.clear(); S.vdraft.clear(); S.sdraft.clear(); S.extraStop.clear(); S.unhideOpen = false; S.round = +id || null;   // 지원 여부·경로 변경은 기준일자마다 따로라 버림
  const r = curRound(); if (r) S.day1 = r.start_date;               // 기준일자를 고르면 지원일 1도 그 날짜로
  await Promise.all([loadReqs(), ensureRoutes(), loadWarn()]); refresh();
}

/* ============================================================
   [7] 로그 기록 (log.view 권한) — 서버의 접속·수정 기록 중 장비 지원 관련
   ============================================================ */
function describeTarget(a) {
  const [tab, rest = ""] = (a.target || "").split(":"), p = rest.split(",");
  if (tab === "vehicle_routes") return `${plateOf(p[1])} · ${fmtMD(p[0])}`;
  if (tab === "vehicles") return plateOf(p[0]);
  if (tab === "round_vehicle_status") { const r = S.rounds.find(x => x.id === +p[0]); return `${plateOf(p[1])} · 기준일자 ${r ? fmtMD(r.start_date) : p[0]}`; }
  if (tab === "round_requests") { const r = S.rounds.find(x => x.id === +p[0]); return `${bn(p[1])} · 기준일자 ${r ? fmtMD(r.start_date) : p[0]}`; }
  if (tab === "branch_zone_overrides") return `${bn(p[0])} · 특보구역 ${p[1]}`;
  if (tab === "support_rounds") { const r = S.rounds.find(x => x.id === +p[0]); return `기준일자 ${r ? r.start_date : p[0]}`; }
  return a.target || "-";
}
function describeChange(a) {
  const det = a.tab === "vehicle_routes" || a.tab === "branch_zone_overrides";
  if (a.kind === "추가" && !det) return "새로 만듦";
  if (a.kind === "삭제" && !det) return "지움";
  const keys = [...new Set([...Object.keys(a.from_val || {}), ...Object.keys(a.to_val || {})])].filter(k => !HIDE.has(k));
  return keys.map(k => `${FIELD[k] || k}: ${fmtField(k, a.from_val ? a.from_val[k] : null)} → ${fmtField(k, a.to_val ? a.to_val[k] : null)}`).join(" / ") || "-";
}
function renderLog() {
  const box = $("logTable");
  if (!can("log.view")) { box.innerHTML = ""; $("logFilters").innerHTML = ""; return; }
  const pm = $("perm-log"); pm.className = "perm can";
  pm.textContent = ""; pm.hidden = true;
  const users = [...new Set(S.audit.map(l => l.username || "-"))];
  $("logFilters").innerHTML = ["전체", "추가", "수정", "삭제"].map(k => `<button type="button" class="chip" data-lk="${k}" aria-pressed="${S.logKind === k}">${k === "전체" ? "모든 구분" : k}</button>`).join("") +
    `<select class="ci" id="logUser" aria-label="아이디로 거르기"><option value="전체">모든 아이디</option>${users.map(u => `<option ${S.logUser === u ? "selected" : ""}>${esc(u)}</option>`).join("")}</select>` +
    `<button type="button" class="chip" id="logToday" aria-pressed="${S.logToday}">오늘만</button>`;
  const rows = S.audit.filter(l => (S.logKind === "전체" || l.kind === S.logKind) && (S.logUser === "전체" || (l.username || "-") === S.logUser) && (!S.logToday || sameDay(l.at)))
    .slice().reverse().slice(0, 300).map(l => `<tr><td class="t">${esc(fmtShort(l.at))}</td><td>${esc(l.username || "-")}</td><td><span class="status ${l.kind === "삭제" ? "stop" : "go"}">${esc(l.kind)}</span></td>
      <td>${esc(TAB_LABEL[l.tab] || l.tab || "-")}</td><td>${esc(describeTarget(l))}</td><td>${esc(describeChange(l))}</td><td class="ip">${esc(l.ip || "-")}</td></tr>`).join("");
  box.innerHTML = `<thead><tr><th>일시</th><th>아이디</th><th>구분</th><th>표</th><th>대상</th><th>내용</th><th>IP</th></tr></thead><tbody>${rows || `<tr><td colspan="7" class="muted" style="text-align:center;padding:28px">조건에 맞는 기록이 없습니다.</td></tr>`}</tbody>`;
}

/* ============================================================
   [8] 장비 상세 — 날짜별 경로 기록 전체
   ============================================================ */
const sheet = $("sheet"), backdrop = $("backdrop");
let lastFocus = null;
async function openSheet(vid) {
  const v = vehById(vid); if (!v) return;
  const g = govRound(S.date), st = g ? stOf(g.id, v.id).status : "", [cls, label] = STATUS[st] || STATUS[""], rec = effRec(S.date, v.id), cur = rec.stops;   // 지원 여부 = 그 날짜를 맡은 기준일자의 값
  sheet.innerHTML = `<button type="button" class="sheet-close" id="sheetClose">닫기</button><span class="plate" style="font-size:18px">${esc(vval(v, "plate"))}</span>
    <h2 id="sheetTitle">${esc(v.org)} ${esc(v.type)}${hasBlower(v) ? ` · 블로워 ${esc(blowerText(v))}` : ""}</h2>${g ? `<span class="status ${cls}">${label}</span>` : ""}
    <section><h3>${esc(fmtMD(S.date))} 이동</h3><dl class="kv"><dt>지원기관</dt><dd>${esc(v.org)} 기계화부</dd>
      <dt>들르는 지사</dt><dd>${cur.length ? cur.map(x => esc(bn(x))).join(" → ") + "" : "-"}</dd>
      <dt>도착 예상</dt><dd>${cur.length ? cur.map((x, j) => `${esc(bn(x))} ${esc(j === 0 && isCont(v.id, S.date, x) ? "연속지원" : rec.times[j] ? fmtMD(S.date) + " " + rec.times[j] : "미정")}`).join("<br>") : "-"}</dd></dl></section>
    <section><h3>날짜별 경로 기록</h3><div id="vhist" class="muted">불러오는 중…</div></section>`;
  sheet.hidden = false; backdrop.hidden = false;
  if (!lastFocus) lastFocus = document.activeElement;
  $("sheetClose").focus(); $("sheetClose").onclick = closeSheet;
  const r = await Api.vehicleHistory(vid);
  if (sheet.hidden || !$("vhist")) return;
  $("vhist").className = "";
  $("vhist").innerHTML = !r.ok ? esc(r.message) : r.rows.length ? `<ol class="vhist">${r.rows.map(x => `<li class="${x.date === S.date ? "on" : ""}"><b>${esc(fmtMD(x.date))}</b> ${esc(x.date.slice(0, 4))} · ${esc(x.stops.map((s, j) => bn(s) + (x.times && x.times[j] ? " " + x.times[j] : "")).join(" → "))}</li>`).join("")}</ol>` : "확정된 경로 기록이 없습니다.";
}
/* ---------- 특보구역 관리(관리자) — 지사마다 대설 특보를 볼 기상청 특보구역. 자동 목록은 관할 고속도로가 지나는 시·군에서 계산 ---------- */
async function openZones(bid) {
  sheet.innerHTML = `<button type="button" class="sheet-close" id="sheetClose">닫기</button><h2 id="sheetTitle">특보구역 관리</h2>
    <label class="ctl">지사 <select class="ci" id="zbr">${S.order.map(b => `<option value="${b.id}">${esc((S.hqById[b.hq_id] || {}).name || "")} · ${esc(b.name)}</option>`).join("")}</select></label>
    <div id="zlist" class="muted">불러오는 중…</div><div id="wnow"></div>`;
  sheet.hidden = false; backdrop.hidden = false;
  if (!lastFocus) lastFocus = document.activeElement;
  $("sheetClose").focus(); $("sheetClose").onclick = closeSheet;
  if (bid) $("zbr").value = bid;
  const r = await Api.zoneData();
  if (!r.ok) { if ($("zlist")) $("zlist").textContent = r.message; return; }
  S.zdata = r; renderZones(); renderWarnNow();
}
// 지금 서버에 받아 둔 특보 전체(전국, 지사와 이어지지 않은 섬 등 포함) — 종류별 탭(대설 맨 앞, 종류가 5개 이상이면 두 줄)
// 탭 = 특보 이름 + 발표된 구역 수, 누르면 아래에 구역마다 단계·발표·발효 시각과 이어진 지사
const wlv2 = l => l === "예비" ? "예비특보" : l === "주의" ? "주의보" : l === "경보" ? "경보" : l;
function renderWarnNow() {
  const el = $("wnow"), d = S.zdata && S.zdata.active; if (!el || !d) return;
  const st = d.state || {}, rows = d.rows || [], by = {};
  rows.forEach(x => (by[x.kind] = by[x.kind] || []).push(x));
  const zc = k => new Set((by[k] || []).map(x => x.zone)).size;
  const kinds = ["대설", ...Object.keys(by).filter(k => k !== "대설").sort((a, b) => zc(b) - zc(a) || a.localeCompare(b, "ko"))];
  if (!kinds.includes(S.wtab)) S.wtab = kinds.find(k => zc(k)) || "대설";
  const tab = k => `<button type="button" class="chip wtab" role="tab" data-wtab="${esc(k)}" aria-selected="${k === S.wtab}" aria-pressed="${k === S.wtab}">${esc(k)} <b>${zc(k)}</b></button>`;
  const half = kinds.length > 4 ? Math.ceil(kinds.length / 2) : kinds.length;
  const list = (by[S.wtab] || []).slice().sort((a, b) => (WLV_RANK[b.level] || 0) - (WLV_RANK[a.level] || 0) || a.name.localeCompare(b.name, "ko"));
  el.innerHTML = `<h3>지금 받은 특보 (전국 ${rows.length}건)</h3>
    <p class="muted">${st.fetched_at ? `기상청에서 받은 시각 ${esc(fmtShort(st.fetched_at))}` : "아직 받지 못함"}${st.ok === false && st.note ? ` · 최근 실패: ${esc(st.note)}` : ""} ·
      ${d.needed ? "수집 중" : "수집 쉬는 중"}</p>
    <div class="wtabs" role="tablist"><div class="wtrow">${kinds.slice(0, half).map(tab).join("")}</div>${half < kinds.length ? `<div class="wtrow">${kinds.slice(half).map(tab).join("")}</div>` : ""}</div>` +
    (list.length ? `<table class="wlist"><thead><tr><th class="l">구역</th><th>단계</th><th>발표</th><th>발효</th><th class="l">이어진 지사</th></tr></thead><tbody>${list.map(x =>
      `<tr><td class="l">${esc(x.name)}</td><td><span class="wb ${(WLV[x.level] || ["w0"])[0]}">${esc(wlv2(x.level))}</span></td><td>${esc(fmtWarnTime(x.tm_fc, x.level))}</td><td>${esc(fmtWarnTime(x.tm_ef, x.level, true))}</td>
       <td class="l muted">${x.branches.length ? esc(x.branches.map(bn).join(", ")) : "없음"}</td></tr>`).join("")}</tbody></table>`
      : `<p class="muted">지금 발효·예정된 ${esc(S.wtab)} 특보가 없습니다.</p>`);
}
const WLV_RANK = { "예비": 1, "주의": 2, "경보": 3 };
function zoneLabel(code) {          // 시·도 · 구역 이름
  const zs = S.zdata.byCode, z = zs[code]; if (!z) return code;
  let u = zs[z.up_code]; while (u && !/02$/.test(u.sp || "") && zs[u.up_code]) u = zs[u.up_code];
  return (u && u.zone_code !== code && /02$/.test(u.sp || "") ? u.name + " · " : "") + z.name;
}
function renderZones() {
  const el = $("zlist"), d = S.zdata; if (!el || !d) return;
  if (!d.byCode) d.byCode = Object.fromEntries(d.zones.map(z => [z.zone_code, z]));
  const bid = $("zbr").value, cur = d.list[bid] || [], has = new Set(cur.map(z => z[0]));
  const out = d.overrides.filter(o => o.branch_id === bid && !o.include);
  const leaf = d.zones.filter(z => /1[34]$/.test(z.sp || "") && !has.has(z.zone_code)).map(z => [z.zone_code, zoneLabel(z.zone_code)]).sort((a, b) => a[1].localeCompare(b[1], "ko"));
  el.className = "";
  el.innerHTML = `<h3>들어간 구역 ${cur.length}곳</h3>` + (cur.length ? `<ul class="zlist">${cur.map(z => `<li><span>${esc(zoneLabel(z[0]))}</span><span class="tag">${z[2] === "manual" ? "더함" : "자동"}</span>
      <button type="button" class="btn sm" data-zset="${esc(z[0])}" data-zinc="${z[2] === "manual" ? "" : "0"}">빼기</button></li>`).join("")}</ul>` : `<p class="muted">없음 — 이 지사의 관할 고속도로가 없거나 모두 뺐습니다.</p>`) +
    (out.length ? `<h3>뺀 구역</h3><ul class="zlist">${out.map(o => `<li><span>${esc(zoneLabel(o.zone_code))}</span><button type="button" class="btn sm" data-zset="${esc(o.zone_code)}" data-zinc="">되살리기</button></li>`).join("")}</ul>` : "") +
    `<h3>구역 더하기</h3><div class="zadd"><select class="ci" id="zadd"><option value="">구역 고르기</option>${leaf.map(([c, n]) => `<option value="${esc(c)}">${esc(n)}</option>`).join("")}</select>
      <button type="button" class="btn sm primary" id="zaddBtn">더하기</button></div>`;
}
async function setZone(code, include) {   // include: true 더함 / false 자동에서 뺌 / null 손댄 것을 없앰(자동대로)
  const bid = $("zbr") && $("zbr").value; if (!bid || S.me.role !== "admin") return;
  if (S.preview) return toast("미리보기에서는 바꿀 수 없습니다.", true);
  const r = await Api.setZone(bid, code, include);
  if (!r.ok) return toast(r.message, true);
  const z = await Api.zoneData(); if (z.ok) { S.zdata = z; renderZones(); renderWarnNow(); }
  await Promise.all([loadWarn(), loadAudit()]); paintWarn(); renderLog(); if (!$("panel-move").hidden) renderDest(); toast(`${bn(bid)} 지사 특보구역을 바꿨습니다`);
}
function closeSheet() { sheet.hidden = true; backdrop.hidden = true; hideTip(); if (lastFocus) lastFocus.focus(); lastFocus = null; }
backdrop.onclick = closeSheet;
document.addEventListener("keydown", e => { if (e.key === "Escape" && TP.bid) tpClose(); });
document.addEventListener("keydown", e => { if (e.key === "Escape" && !sheet.hidden) closeSheet(); });

/* ============================================================
   [9] 저장 바·그리기
   ============================================================ */
function busy(t, on) { const bar = $("save-" + t); bar.classList.toggle("busy", on); bar.querySelectorAll("button").forEach(b => { b.disabled = on || b.disabled; }); }
function updateSavebars() {
  const fb = $("save-fleet"), bb = $("save-branch");
  fb.hidden = !canAnyVeh(); bb.hidden = !canAnyReq() || !S.round;
  const fd = fleetDirty(), bd = branchDirty();
  fb.classList.toggle("dirty", fd); bb.classList.toggle("dirty", bd);
  fb.querySelector(".save-state").textContent = fd ? `확정하지 않은 변경: 경로 ${S.draft.size}칸${S.sdraft.size ? ` · 지원 여부 ${S.sdraft.size}대` : ""}${S.vdraft.size ? ` · 장비 ${S.vdraft.size}대` : ""}` + (S.preview ? " (미리보기 — 확정 불가)" : "") : "변경 사항 없음";
  bb.querySelector(".save-state").textContent = bd ? `저장하지 않은 변경: ${S.rdraft.size}개 지사` + (S.preview ? " (미리보기 — 저장 불가)" : "") : "변경 사항 없음";
  fb.querySelector("[data-revert]").disabled = !fd; fb.querySelector("[data-save]").disabled = !fd || S.preview;
  bb.querySelector("[data-revert]").disabled = !bd; bb.querySelector("[data-save]").disabled = !bd || S.preview;
}
addEventListener("beforeunload", e => { if (fleetDirty() || branchDirty()) { e.preventDefault(); e.returnValue = ""; } });
function refresh() {
  hideTip();
  renderMatrix(); renderFilters(); renderDest(); renderFleet(); renderBranch(); renderLog(); updateSavebars();
  $("logTabBtn").hidden = !can("log.view");
  if (!can("log.view") && !$("panel-log").hidden) document.querySelector('[data-tab="move"]').click();
}
function refreshKeepFocus() {   // 값을 고친 뒤 화면을 다시 그리되, 커서 위치는 유지
  const a = document.activeElement, fk = a && a.dataset && a.dataset.fk;
  refresh();
  if (fk) { const n = [...document.querySelectorAll("[data-fk]")].find(i => i.dataset.fk === fk); if (n) n.focus(); }
}

/* ============================================================
   [10] 입력 처리 — 한 곳에서
   ============================================================ */
document.addEventListener("change", async e => {
  const t = e.target;
  if (t.id === "userSel") return switchUser(t.value);
  if (t.dataset.round !== undefined) return switchRound(t.value);
  if (t.id === "day1In") {                  // 지원일 1: 기준일자보다 앞 날짜는 안 됨
    if (!t.value) return; const r = curRound();
    if (r && t.value < r.start_date) { toast(`지원일은 기준일자(${fmtMD(r.start_date)})부터 고를 수 있습니다`, true); S.day1 = r.start_date; } else S.day1 = t.value;
    S.extraStop.clear(); await ensureRoutes(); return refresh();
  }
  if (t.id === "colsSel") { S.cols = Math.min(10, Math.max(2, +t.value)); await ensureRoutes(); return refresh(); }
  if (t.id === "logUser") { S.logUser = t.value; return renderLog(); }
  if (t.id === "zbr") return renderZones();
  if (t.dataset.rv) {                       // 경로 칸(관리자): 그 (날짜, 장비)의 지사 목록을 다시 모음
    const vid = t.dataset.rv, d = t.dataset.rd, v = vehById(vid); if (!v || !canRoute()) return refresh();
    if (t.value === "__off") { setStat(vid, { off_from: d }); return patchVehicle(vid); }          // 지원 불가(이날부터): 이날·뒷날 칸이 지원 불가로
    S.extraStop.delete(rk(d, vid)); setRoute(d, vid, readCell(vid, d)); return patchCell(vid, d);
  }
  if (t.dataset.rt) {                       // 도착 예상 시각(관리자, 또는 지원장비 = 자기 기관 장비의 정해진 경로)
    const vid = t.dataset.rt, d = t.dataset.rd, v = vehById(vid); if (!v || !(canRoute() || canVeh(v))) return refresh();
    const nt = normTime(t.value);
    if (nt === undefined) { toast("시각은 0730 또는 07:30 처럼 넣으세요 (00:00~23:59)", true); return patchCell(vid, d); }
    t.value = nt || ""; setRoute(d, vid, readCell(vid, d, true)); return patchCell(vid, d);
  }
  if (t.id === "modeInit" || t.id === "modeRev") {     // [최초 지원]/[수정본]: 둘 중 하나, 표 전체에 한 번에 적용
    S.revisedMode = t.id === "modeRev" ? t.checked : !t.checked; return renderFleet();
  }
  if (t.dataset.vs) {                       // 지원 여부(고른 기준일자): 지원이 아니면 그 기준일자가 맡은 날의 경로는 숨겨짐(지우지 않음 — 다시 지원으로 하면 보임)
    const v = vehById(t.dataset.vs); if (!v || !canVeh(v) || !S.round) return refresh();
    setStat(v.id, { status: t.value }); return patchVehicle(v.id);
  }
  if (t.dataset.off) {                      // 지원일 2부터의 '지원 불가(이날부터)'(지원장비 계정도)
    const v = vehById(t.dataset.off); if (!v || !canVeh(v) || !S.round) return refresh();
    if (t.value) setStat(v.id, { off_from: t.dataset.rd }); return patchVehicle(v.id);
  }
  if (t.dataset.vb) {                       // 블로워 소·대: 제설기만, 둘 다 꺼도 됨
    const v = vehById(t.dataset.vb); if (!v || !canVeh(v) || v.type !== "제설기") return refresh();
    setVeh(v.id, t.dataset.bf, t.checked); return patchVehicle(v.id);
  }
  if (t.id === "nvOrg") { $("nvPfx").textContent = t.value; return; }
  if (t.dataset.vp) {                       // 도공번호: 숫자만 받아 기관 이름을 붙임(예: 901 → 서울경기901), 중복 검사
    const v = vehById(t.dataset.vp), num = t.value.replace(/\s/g, ""); if (!v || !canVeh(v)) return refresh();
    if (!NUM_RE.test(num)) { toast("도공번호는 숫자만 넣으세요 (예: 901 → " + v.org + "901)", true); return refresh(); }
    const val = v.org + num;
    if (S.vehicles.some(x => x.id !== v.id && vval(x, "plate") === val)) { toast("같은 도공번호가 이미 있습니다", true); return refresh(); }
    setVeh(v.id, "plate", val); const tr = t.closest("tr"); if (tr) tr.classList.toggle("changed", S.vdraft.has(v.id)); return afterAnyChange();
  }
  if (t.dataset.arr) {                      // 도착 요청: 날짜 + 시(00~23) + 분(10분 단위)
    const b = S.brById[t.dataset.arr]; if (!b || !canEdit(b)) return refresh();
    const get = p => (document.querySelector(`[data-arr="${b.id}"][data-part="${p}"]`) || {}).value || "";
    const d = get("d"); setReq(b.id, "arrive_at", d ? `${d}T${get("h") || "00"}:${get("m") || "00"}` : null); return afterReq(b.id);
  }
  if (t.dataset.wxt) {                      // 직접입력 특보 발표·발효: 시·분 → 기준일자의 그 시각
    const b = S.brById[t.dataset.wxt], f = t.dataset.f; if (!b || !canEdit(b)) return refresh();
    const get = part => (document.querySelector(`[data-wxt="${b.id}"][data-f="${f}"][data-part="${part}"]`) || {}).value || "";
    const hh = get("h"), day = (curRound() || {}).start_date || todayISO();
    setReq(b.id, f, hh ? new Date(`${day}T${hh}:${get("m") || "00"}`).toISOString() : null);
    const m = document.querySelector(`[data-wxt="${b.id}"][data-f="${f}"][data-part="m"]`); if (m) m.disabled = !hh;
    return afterReq(b.id);
  }
  if (t.dataset.rq) {
    const b = S.brById[t.dataset.rq], f = t.dataset.f; if (!b || !canEdit(b) || (["assigned_truck", "assigned_blower", "confirmed"].includes(f) && !can("req.confirm"))) return refresh();
    let v;
    if (f === "wx_tmin_at") {                              // 최저기온 시각: 월일시분 8자리 → 시각. 비우면 지움
      const raw = t.value.replace(/\D/g, "");
      v = raw === "" ? null : parseMdhm(raw);
      if (v === undefined) { toast("시각은 월일시분 8자리 숫자로 넣으세요 (예: 12월 24일 15시 30분 → 12241530)", true); return refresh(); }
      setReq(b.id, f, v); return afterReq(b.id);
    }
    if (f === "wx_manual") { setReq(b.id, f, t.checked); afterReq(b.id); return renderBranch(); }   // 켜고 끄면 그 줄 칸 모양이 바뀜
    if (f === "wx_level") { setReq(b.id, f, t.value || null); return afterReq(b.id); }
    if (f === "wx_tmin") { setReq(b.id, f, t.value === "" ? null : Math.max(-60, Math.min(50, Math.round(+t.value * 10) / 10 || 0))); return afterReq(b.id); }
    if (f === "warning" || f === "confirmed") v = t.checked;
    else if (f === "snow_cm" || f === "wx_snow" || f === "wx_pcp") v = t.value === "" ? null : Math.max(0, Math.min(999, Math.round(+t.value * 10) / 10 || 0));
    else if (f === "reason") v = t.value.trim() || null;
    else v = t.value === "" ? 0 : Math.max(0, Math.min(999, Math.floor(+t.value) || 0));
    setReq(b.id, f, v); return afterReq(b.id);
  }
});
/* ---------- 최저기온 시각 고르기(기상현황 직접입력): 달력 + 시(분은 00) ---------- */
const TP = { bid: null, y: 0, m: 0, day: null, hh: "06" };
function tpOpen(btn) {
  const bid = btn.dataset.tpick, b = S.brById[bid]; if (!b || !canEdit(b)) return;
  const v = rval(bid, "wx_tmin_at"), d = v ? new Date(v) : null, base = d && !isNaN(d) ? d : new Date(((curRound() || {}).start_date || todayISO()) + "T00:00");
  Object.assign(TP, { bid, y: base.getFullYear(), m: base.getMonth(), day: d && !isNaN(d) ? localInput(v).slice(0, 10) : null, hh: d && !isNaN(d) ? p2(d.getHours()) : TP.hh });
  let pop = $("tpop"); if (!pop) { pop = document.createElement("div"); pop.id = "tpop"; pop.className = "tpop"; pop.setAttribute("role", "dialog"); document.body.appendChild(pop); }
  tpRender();
  const r = btn.getBoundingClientRect(), w = 248, h = pop.offsetHeight || 300;
  pop.style.left = Math.max(8, Math.min(innerWidth - w - 8, r.left)) + "px";
  pop.style.top = (r.bottom + h + 8 > innerHeight ? Math.max(8, r.top - h - 4) : r.bottom + 4) + "px";
}
function tpClose() { const pop = $("tpop"); if (pop) pop.hidden = true; TP.bid = null; }
function tpRender() {
  const pop = $("tpop"), first = new Date(TP.y, TP.m, 1), n = new Date(TP.y, TP.m + 1, 0).getDate(), lead = first.getDay();
  const ymd = d => `${TP.y}-${p2(TP.m + 1)}-${p2(d)}`, rd = (curRound() || {}).start_date;
  let cells = ""; for (let k = 0; k < lead; k++) cells += "<span></span>";
  for (let d = 1; d <= n; d++) { const id = ymd(d); cells += `<button type="button" data-tp-day="${id}" class="${id === TP.day ? "on" : ""}${id === rd ? " rd" : ""}${(lead + d - 1) % 7 === 0 ? " sun" : ""}">${d}</button>`; }
  pop.innerHTML = `<div class="tp-head"><button type="button" data-tp-nav="-1" aria-label="이전 달">‹</button><b>${TP.y}년 ${TP.m + 1}월</b><button type="button" data-tp-nav="1" aria-label="다음 달">›</button></div>` +
    `<div class="tp-week">${[..."일월화수목금토"].map(w => `<span>${w}</span>`).join("")}</div><div class="tp-days">${cells}</div>` +
    `<div class="tp-hour"><label>시 <select class="ci" data-tp-hour aria-label="시">${HOURS.map(x => `<option${x === TP.hh ? " selected" : ""}>${x}</option>`).join("")}</select> : 00</label>` +
    `<span class="tp-sel">${TP.day ? `${+TP.day.slice(5, 7)}/${+TP.day.slice(8)} ${TP.hh}시` : "날짜를 고르세요"}</span></div>` +
    `<div class="tp-btns"><button type="button" class="btn sm" data-tp-clear>지우기</button><button type="button" class="btn sm" data-tp-cancel>닫기</button><button type="button" class="btn sm primary" data-tp-ok${TP.day ? "" : " disabled"}>확인</button></div>`;
  pop.hidden = false;
}
function tpSet(val) {
  const bid = TP.bid; if (!bid) return; tpClose();
  setReq(bid, "wx_tmin_at", val);
  const td = document.querySelector(`#branchTable td[data-tacell="${bid}"]`); if (td) td.innerHTML = fcInner(bid, "tmin_at");
  afterReq(bid);
}
document.addEventListener("change", e => { if (e.target.matches && e.target.matches("[data-tp-hour]")) { TP.hh = e.target.value; tpRender(); } });
addEventListener("scroll", e => { if (TP.bid && !(e.target.closest && e.target.closest("#tpop"))) tpClose(); }, true);
document.addEventListener("click", e => {
  const c = sel => e.target.closest && e.target.closest(sel);
  let x;
  if ((x = c(".mnum"))) return jumpToDetail(x.dataset);
  if (c("#tpop")) {                          // 달력 안
    if ((x = c("[data-tp-nav]"))) { const d = new Date(TP.y, TP.m + +x.dataset.tpNav, 1); TP.y = d.getFullYear(); TP.m = d.getMonth(); return tpRender(); }
    if ((x = c("[data-tp-day]"))) { TP.day = x.dataset.tpDay; return tpRender(); }
    if (c("[data-tp-ok]")) return TP.day ? tpSet(new Date(`${TP.day}T${TP.hh}:00`).toISOString()) : null;
    if (c("[data-tp-clear]")) return tpSet(null);
    if (c("[data-tp-cancel]")) return tpClose();
    return;
  }
  if ((x = c("[data-tpick]"))) return TP.bid === x.dataset.tpick ? tpClose() : tpOpen(x);
  if (TP.bid) tpClose();                     // 바깥을 누르면 닫힘
  if ((x = c("[data-stop-add]"))) { S.extraStop.add(x.dataset.stopAdd); const [d, vid] = x.dataset.stopAdd.split("|"); patchCell(vid, d); const n = [...document.querySelectorAll("[data-fk]")].find(i => i.dataset.fk.startsWith(`rn:${d}:${vid}:`)); if (n) n.focus(); return; }
  if ((x = c("[data-save]"))) return x.dataset.save === "fleet" ? confirmFleet() : saveBranch();
  if ((x = c("[data-revert]"))) { if (!confirm("확정·저장하지 않은 변경을 모두 취소할까요?")) return; if (x.dataset.revert === "fleet") { S.draft.clear(); S.vdraft.clear(); S.sdraft.clear(); S.extraStop.clear(); } else S.rdraft.clear(); return refresh(); }
  if (c("#fleetReset")) return resetFleet();
  if (c("#vehAdd")) return addVehicle();
  if ((x = c("[data-vdel]"))) return deleteVehicle(x.dataset.vdel);
  if ((x = c("[data-vhide]"))) return hideVehicle(x.dataset.vhide, false);
  if ((x = c("[data-unhide]"))) return hideVehicle(x.dataset.unhide, true);
  if (c("#unhideBtn")) { S.unhideOpen = !S.unhideOpen; return renderFleet(); }
  if ((x = c("[data-offclr]"))) { const v = vehById(x.dataset.offclr); if (v && canVeh(v)) { setStat(v.id, { off_from: null }); patchVehicle(v.id); } return; }
  if (c("#roundMake")) return makeRound();
  if (c("#confirmAll")) return confirmAll();
  if ((x = c("[data-confirm-hq]"))) return confirmAll(x.dataset.confirmHq);          // 본부 줄의 [일괄 확정](줄 접기보다 먼저)
  if (c("#unconfirmAll")) return unconfirmAll();
  if ((x = c("[data-unconfirm-hq]"))) return unconfirmAll(x.dataset.unconfirmHq);    // 본부 줄의 [일괄 취소]
  if ((x = c("[data-confirm]"))) return confirmBranch(x.dataset.confirm, true);
  if ((x = c("[data-unconfirm]"))) return confirmBranch(x.dataset.unconfirm, false);
  if (c("#roundDel")) return deleteRound();
  if (c("#zoneMgr")) return openZones();
  if ((x = c("[data-zset]"))) return setZone(x.dataset.zset, x.dataset.zinc === "" ? null : x.dataset.zinc === "1");
  if ((x = c("[data-fb]"))) return openForecast(x.dataset.fb);
  if ((x = c("[data-wtab]"))) { S.wtab = x.dataset.wtab; return renderWarnNow(); }
  if (c("#zaddBtn")) { const v = ($("zadd") || {}).value; return v ? setZone(v, true) : toast("더할 구역을 고르세요", true); }
  if (c("#onlyActive")) { S.bview = S.bview === "req" ? "all" : "req"; return renderBranch(); }      // 두 보기 중 하나만, 다시 누르면 모든 지사
  if (c("#onlyFixed")) { S.bview = S.bview === "fixed" ? "all" : "fixed"; return renderBranch(); }
  if ((x = c("[data-fo]"))) { S.fleetOrg = x.dataset.fo; return renderFleet(); }
  if ((x = c("[data-org]"))) { S.org = x.dataset.org; renderFilters(); return renderDest(); }
  if ((x = c("[data-type]")) && x.classList.contains("chip")) { S.type = x.dataset.type; renderFilters(); return renderDest(); }
  if ((x = c("[data-lk]"))) { S.logKind = x.dataset.lk; return renderLog(); }
  if (c("#logToday")) { S.logToday = !S.logToday; return renderLog(); }
  if ((x = c(".vrow"))) return openSheet(x.dataset.vid);
  if ((x = c("tr.hq"))) { const id = x.dataset.hq; S.closedHq.has(id) ? S.closedHq.delete(id) : S.closedHq.add(id); return renderBranch(); }
});
document.addEventListener("keydown", e => { const tr = e.target.closest && e.target.closest("tr.hq"); if (tr && e.target === tr && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); tr.click(); } });

/* ---------- 탭·날짜·화면 모드·아이디 ---------- */
document.querySelectorAll(".tab").forEach(t => t.onclick = () => {
  document.querySelectorAll(".tab").forEach(x => x.setAttribute("aria-selected", x === t));
  document.querySelectorAll(".panel").forEach(p => p.hidden = p.id !== "panel-" + t.dataset.tab);
  hideTip(); if (t.dataset.tab === "move") { fitFilters(); stickHead($("matrix")); } if (t.dataset.tab === "branch") stickHead($("branchTable"));
});
const dateInput = $("dateInput"); dateInput.value = S.date;
async function setDate(v) { if (!v) return; S.date = v; dateInput.value = v; await ensureRoutes(); renderMatrix(); renderDest(); }   // 이동 현황은 고른 날짜 기준
dateInput.onchange = () => setDate(dateInput.value);
dateInput.addEventListener("click", () => { try { dateInput.showPicker(); } catch (e) {} });   // 제목의 큰 날짜를 누르면 달력이 바로 열림
$("prevDay").onclick = () => setDate(addDays(S.date, -1));
$("nextDay").onclick = () => setDate(addDays(S.date, 1));
// 화면 모드: [라이트 모드] [다크 모드] 두 칸 버튼. 고른 모드는 이 브라우저에 기억
const THEME_KEY = "eq_theme";
function curTheme() { const r = document.documentElement.dataset.theme; return r || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"); }
function paintThemeBtns() { document.querySelectorAll("[data-theme-set]").forEach(b => b.setAttribute("aria-pressed", b.dataset.themeSet === curTheme())); }
function setTheme(t) { document.documentElement.dataset.theme = t; try { localStorage.setItem(THEME_KEY, t); } catch (e) {} paintThemeBtns(); }
try { const t = localStorage.getItem(THEME_KEY); if (t === "light" || t === "dark") document.documentElement.dataset.theme = t; } catch (e) {}
document.querySelectorAll("[data-theme-set]").forEach(b => b.onclick = () => setTheme(b.dataset.themeSet));
paintThemeBtns();
function buildUserSel() {
  const box = $("userSel").closest(".user-box"); if (box) box.hidden = !!S.real;     // 로그인한 실제 화면에서는 없음(?sample=1 시연·자동 시험에서만)
  if (S.real) return;
  const groups = [...new Set(DEMO.map(d => d.g))];
  $("userSel").innerHTML = (S.real ? `<option value="__me">내 아이디 · ${esc(S.real.label)}</option>` : "") +
    groups.map(g => `<optgroup label="${S.real ? "미리보기(저장 안 됨) · " : ""}${esc(g)}">${DEMO.filter(d => d.g === g).map(d => `<option value="${d.id}">${esc(d.label)}</option>`).join("")}</optgroup>`).join("");
  $("userSel").value = S.uid;
}
async function switchUser(uid) {
  if ((fleetDirty() || branchDirty()) && !confirm("확정·저장하지 않은 변경이 있습니다. 버리고 아이디를 바꿀까요?")) { $("userSel").value = S.uid; return; }
  S.draft.clear(); S.vdraft.clear(); S.sdraft.clear(); S.rdraft.clear(); S.extraStop.clear();
  S.uid = uid; S.me = uid === "__me" ? S.real : identityOf(DEMO.find(d => d.id === uid));
  S.preview = !!S.real && uid !== "__me";
  Api.setActor(S.me); if (!sheet.hidden) closeSheet();
  await loadAudit(); refresh();
}

// 특보는 서버가 매시 01·11·21…분에 받으므로 화면은 그 1분 뒤(02·12·22…분)에, 보이는 동안만 다시 읽어 특보 칸만 고침.
// 서버 수집이 쉬는 중(확정을 기다리는 기준일자 없음)이면 읽지 않음 → 기준일자를 바꾸거나 새로 열 때 다시 읽음
let warnAt = 0;
async function tickWarn(force) {
  if (!S.me || (!force && (document.hidden || (S.warn && S.warn.paused)))) return;
  warnAt = Date.now(); await loadWarn(); paintWarn(); if (!$("panel-move").hidden) renderDest();
}
(function schedWarn() { const now = new Date(), m = (12 - now.getMinutes() % 10) % 10 || 10; setTimeout(() => { tickWarn(); schedWarn(); }, (m * 60 - now.getSeconds()) * 1000); })();
document.addEventListener("visibilitychange", () => { if (!document.hidden && Date.now() - warnAt > 10 * 60e3) tickWarn(); });

boot();
