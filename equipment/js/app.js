/* ============================================================
   app.js — 장비 지원 화면 전체 (권한, 이동 현황, 기관별 장비, 지사별 요청·편성, 로그 기록)
   불러오는 순서: auth/auth.js → sample-data.js → api.js → app.js
   - 자료는 서버(Supabase)에서 읽고 api.js 로 저장합니다. 주소에 ?sample=1 이면 샘플 자료로 시연합니다.
   - 권한은 계정의 세부 권한(perms)으로 판단합니다. 관리자는 모든 권한.
       equip.edit.own  자기 출발 기관 장비 추가·도공번호·지원 여부 / equip.edit.all  모든 장비 + 날짜별 경로 + 장비 삭제 + 지원일 1 날짜 + 초기화
       req.edit.own    자기 지사 요청 / req.edit.hq  자기 본부 지사들 요청 / req.confirm  편성·확정·기준일자 만들기 / log.view  수정 기록
     ⚠ 화면의 권한 검사는 보기 좋게 정리하는 용도이고, 실제로 막는 것은 서버 규칙(RLS·트리거)입니다.
   - 경로는 (날짜, 장비)마다 한 줄로 서버에 남습니다. 다른 날짜를 확정해도 지난 날짜 경로는 지워지지 않습니다.
   - 사람이 읽는 규칙 설명: docs/equipment-rules.md
   ============================================================ */
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
  { id: "hq-gw", label: "강원본부", role: "hq", hq: "강원", perms: ["req.edit.hq", "hq.supply.edit"], g: "지역본부" },
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
  routes: new Map(), loaded: null, reqs: {}, audit: [],
  draft: new Map(), vdraft: new Map(), rdraft: new Map(),          // 아직 확정·저장하지 않은 변경(경로 / 장비 / 지사 요청)
  date: todayISO(), day1: todayISO(), cols: 4, round: null,
  org: "전체", type: "전체", fleetOrg: "전체", onlyActive: true, closedHq: new Set(), extraStop: new Set(),
  logUser: "전체", logKind: "전체", logToday: false
};
const SOURCE_ORGS = () => [...S.orgs, "지역본부"];        // 이동 현황 출발 기관 열. 지역본부 장비는 나중에 '지역본부' 탭에서 연동(지금은 0)
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
const routeOf = (date, vid) => { const k = rk(date, vid); return S.draft.has(k) ? S.draft.get(k) : (S.routes.get(k) || []); };
const vval = (v, f) => { const d = S.vdraft.get(v.id); return d && f in d ? d[f] : v[f]; };
const REQ_DEF = { snow_cm: null, warning: false, req_truck: 0, req_blower: 0, assigned_truck: 0, assigned_blower: 0, arrive_at: null, reason: null, confirmed: false };
const rbase = (b, f) => { const r = S.reqs[b]; return r ? r[f] : REQ_DEF[f]; };
const rval = (b, f) => { const d = S.rdraft.get(b); return d && f in d ? d[f] : rbase(b, f); };
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
function setRoute(date, vid, stops) {
  stops = [...new Set(stops.filter(Boolean))];
  const k = rk(date, vid);
  if (same(stops, S.routes.get(k) || [])) S.draft.delete(k); else S.draft.set(k, stops);
}
function setVeh(vid, f, val) {
  const v = vehById(vid), d = { ...(S.vdraft.get(vid) || {}) };
  if (same(val, v[f])) delete d[f]; else d[f] = val;
  if (Object.keys(d).length) S.vdraft.set(vid, d); else S.vdraft.delete(vid);
}
function setReq(b, f, val) {
  const d = { ...(S.rdraft.get(b) || {}) };
  if (same(val, rbase(b, f))) delete d[f]; else d[f] = val;
  if (Object.keys(d).length) S.rdraft.set(b, d); else S.rdraft.delete(b);
}
const fleetDirty = () => S.draft.size > 0 || S.vdraft.size > 0;
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
  if (S.loaded && from >= S.loaded[0] && to <= S.loaded[1]) return;
  if (S.loaded) { from = from < S.loaded[0] ? from : S.loaded[0]; to = to > S.loaded[1] ? to : S.loaded[1]; }
  const r = await Api.routes(from, to);
  if (!r.ok) return toast(r.message, true);
  [...S.routes.keys()].forEach(k => { const d = k.split("|")[0]; if (d >= from && d <= to) S.routes.delete(k); });
  r.rows.forEach(x => S.routes.set(rk(x.date, x.vehicle_id), x.stops.slice()));
  S.loaded = [from, to];
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
  S.hqById = Object.fromEntries(S.hqs.map(h => [h.id, h])); S.brById = Object.fromEntries(S.branches.map(b => [b.id, b]));
  S.order = S.hqs.flatMap(h => S.branches.filter(b => b.hq_id === h.id));               // 본부(순서) → 지사(번호 순) = 강설량 화면과 같은 계층
  if (r.me) {
    S.real = { label: r.me.display_name, username: r.me.username, role: r.me.role, perms: r.me.perms || [], branch_id: r.me.branch_id, org: r.me.org, hq_id: r.me.hq_id || (S.brById[r.me.branch_id] || {}).hq_id || null };
    S.me = S.real; S.uid = "__me";
  } else { S.me = identityOf(DEMO[0]); S.uid = DEMO[0].id; }
  Api.setActor(S.me);
  S.round = pickRound(); const rr = curRound(); if (rr) S.day1 = rr.start_date;
  buildUserSel();
  await Promise.all([ensureRoutes(), loadReqs(), loadAudit()]);
  $("loading").hidden = true; document.querySelector("main").hidden = false;
  refresh();
}

/* ============================================================
   [3] 공통: 알림·말풍선(수정 기록)·안내
   ============================================================ */
let toastTimer;
function toast(msg, isErr) {
  const el = $("toast"); el.textContent = msg; el.className = "toast" + (isErr ? " err" : ""); el.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, 3500);
}
const TAB_LABEL = { vehicles: "장비", vehicle_routes: "경로", round_requests: "지사 요청", support_rounds: "기준일자" };
const FIELD = { plate: "도공번호", status: "지원 여부", stops: "경로", snow_cm: "예상 적설", warning: "특보", req_truck: "요청 제설차", req_blower: "요청 제설기",
  assigned_truck: "편성 제설차", assigned_blower: "편성 제설기", arrive_at: "도착 요청", reason: "사유", confirmed: "확정", start_date: "기준일자", type: "장비", org: "기관" };
const HIDE = new Set(["updated_by", "updated_at", "confirmed_by", "confirmed_at", "created_by", "created_at", "round_id", "branch_id", "vehicle_id", "date", "id", "sort", "active", "name", "end_date"]);
function fmtField(f, v) {
  if (v == null || v === "") return f === "stops" ? "(없음)" : "(빈칸)";
  if (f === "stops") return v.length ? v.map(bn).join(" → ") : "(없음)";
  if (f === "status") return (STATUS[v] || STATUS[""])[1];
  if (f === "warning") return v ? "발효" : "없음";
  if (f === "confirmed") return v ? "확정" : "미확정";
  if (f === "arrive_at") return fmtTime(localInput(v));
  if (f === "snow_cm") return v + "cm";
  return String(v);
}
// 칸 하나(target)의 오늘 수정 기록. field 를 주면 그 열이 바뀐 기록만
const histOf = (target, field) => S.audit.filter(a => a.target === target && sameDay(a.at) && (!field || (a.to_val && field in a.to_val) || (a.from_val && field in a.from_val)));
const hvA = (target, field = "") => can("log.view") && histOf(target, field).length ? ` data-hv="${esc(target)}" data-hf="${esc(field)}" tabindex="0"` : "";
const H = (target, field, html) => { const a = hvA(target, field); return a ? `<span${a}>${html}</span>` : html; };
const tip = $("tip");
function showTip(el) {
  const t = el.dataset.hv, f = el.dataset.hf || "stops", list = histOf(t, el.dataset.hf).slice(-3).reverse();
  if (!list.length) return;
  tip.innerHTML = `<b>이 칸의 오늘 수정 기록</b>` + list.map(h => `<div>${esc(p2(new Date(h.at).getHours()) + ":" + p2(new Date(h.at).getMinutes()))} · ${esc(h.username || "-")}<br>` +
    `${esc(fmtField(f, h.from_val ? h.from_val[f] : null))} → ${esc(fmtField(f, h.to_val ? h.to_val[f] : null))}</div>`).join("");
  tip.hidden = false;
  const r = el.getBoundingClientRect();
  let top = r.bottom + 8; if (top + tip.offsetHeight > innerHeight - 8) top = Math.max(8, r.top - tip.offsetHeight - 8);
  tip.style.top = top + "px"; tip.style.left = Math.max(8, Math.min(r.left, innerWidth - tip.offsetWidth - 8)) + "px";
}
const hideTip = () => { tip.hidden = true; };
["mouseover", "focusin"].forEach(ev => document.addEventListener(ev, e => { const el = e.target.closest && e.target.closest("[data-hv]"); if (el) showTip(el); }));
["mouseout", "focusout"].forEach(ev => document.addEventListener(ev, e => { if (e.target.closest && e.target.closest("[data-hv]")) hideTip(); }));
function banner(id, canEdit, ok, no) {
  const el = $(id); el.className = "perm" + (canEdit ? " can" : "");
  el.innerHTML = (S.preview ? `<b class="pv">미리보기: ${esc(S.me.label)} 권한으로 보는 화면입니다. 저장·확정은 '내 아이디'로 돌아와야 합니다.</b> ` : "") + esc(canEdit ? ok : no) +
    (can("log.view") ? `<span class="hint-admin">점선 밑줄이 있는 칸에 마우스를 올리면 그 칸의 오늘 수정 기록이 최대 3건 보입니다. 이전 기록은 '로그 기록' 탭에서 확인하세요.</span>` : "");
}
function roundSel(id) {
  return `<label class="ctl">기준일자 <select class="ci" id="${id}" data-round>${S.rounds.length ? S.rounds.map(r => `<option value="${r.id}" ${r.id === S.round ? "selected" : ""}>${esc(fmtMD(r.start_date))} ${esc(r.start_date.slice(0, 4))}</option>`).join("") : '<option value="">(없음)</option>'}</select></label>`;
}

/* ============================================================
   [4] 이동 현황 (모두 보기만)
   ============================================================ */
const movesOn = date => S.vehicles.map(v => ({ v, stops: routeOf(date, v.id) })).filter(m => m.stops.length);
function runOf(vid, date) {     // 그날을 포함해 하루씩 이어지는 지원 기간: k일차 / n일
  let back = 0; while (back < 30 && routeOf(addDays(date, -(back + 1)), vid).length) back++;
  let fwd = 0; while (fwd < 30 && routeOf(addDays(date, fwd + 1), vid).length) fwd++;
  return { k: back + 1, n: back + fwd + 1, first: addDays(date, -back) };
}
function renderMatrix() {
  // 세로 = 본부 → 지사(그날 지원받는 지사만), 가로 = 출발 기관. 본부 줄은 그 본부 지사들로 가는 장비 대수(장비 1대는 한 번만 셈)
  const moves = movesOn(S.date), src = SOURCE_ORGS(), used = new Set(moves.flatMap(m => m.stops));
  const pick = (org, ids) => moves.filter(m => (org == null || m.v.org === org) && m.stops.some(s => ids.has(s)));
  const td = l => l.length ? `<td>${l.length}<span class="sub">차 ${l.filter(m => m.v.type === "제설차").length} · 기 ${l.filter(m => m.v.type === "제설기").length}</span></td>` : `<td class="zero">0</td>`;
  let body = "";
  S.hqs.forEach(h => {
    const brs = S.order.filter(b => b.hq_id === h.id && used.has(b.id)); if (!brs.length) return;
    const ids = new Set(brs.map(b => b.id));
    body += `<tr class="hqrow"><th scope="row">${esc(h.name)}<span class="sub">본부</span></th>${src.map(o => td(o === "지역본부" ? [] : pick(o, ids))).join("")}<td><strong>${pick(null, ids).length}</strong></td></tr>`;
    brs.forEach(b => { const one = new Set([b.id]); body += `<tr class="brrow"><th scope="row"><span class="ind" aria-hidden="true">└</span>${esc(b.name)}</th>${src.map(o => td(o === "지역본부" ? [] : pick(o, one))).join("")}<td><strong>${pick(null, one).length}</strong></td></tr>`; });
  });
  $("matrix").innerHTML = `<thead><tr><th class="l" scope="col">본부 · 피지원 지사</th>${src.map(o => `<th scope="col">${esc(o)}${o === "지역본부" ? '<span class="sub">연동 예정</span>' : ""}</th>`).join("")}<th scope="col">합계</th></tr></thead>` +
    `<tbody>${body || `<tr><td class="empty" colspan="${src.length + 2}">${esc(fmtMD(S.date))}에 이동하는 장비가 없습니다.</td></tr>`}</tbody>` +
    `<tfoot><tr><th scope="row">합계</th>${src.map(o => `<td>${moves.filter(m => m.v.org === o).length}</td>`).join("")}<td>${moves.length}</td></tr></tfoot>`;
  const tr = moves.filter(m => m.v.type === "제설차").length, bl = moves.filter(m => m.v.type === "제설기").length;
  $("summaryNote").textContent = `${fmtMD(S.date)} · 제설차 ${tr}대, 제설기 ${bl}대, 이동정비차 ${moves.length - tr - bl}대 (차 = 제설차, 기 = 제설기)` +
    (moves.some(m => m.stops.length > 1) ? " · 하루에 여러 지사를 들르는 장비는 각 지사에 모두 표시되고, 합계는 장비 1대로 셉니다" : "");
}
function renderFilters() {
  const f = $("filters"); f.className = "filters split";
  f.innerHTML = `<div class="fgroup" role="group" aria-label="출발 기관"><span class="flabel">출발 기관</span>` +
    ["전체", ...SOURCE_ORGS()].map(o => `<button type="button" class="chip" data-org="${esc(o)}" aria-pressed="${S.org === o}">${o === "전체" ? "모든 기관" : esc(o)}</button>`).join("") + `</div>` +
    `<div class="fgroup right" role="group" aria-label="장비 종류"><span class="flabel">장비</span>` +
    ["전체", ...TYPES].map(t => `<button type="button" class="chip" data-type="${esc(t)}" aria-pressed="${S.type === t}">${t === "전체" ? "모든 장비" : esc(t)}</button>`).join("") + `</div>`;
}
const matches = v => (S.org === "전체" || v.org === S.org) && (S.type === "전체" || v.type === S.type);
function vehicleRow(v, stops) {
  const st = vval(v, "status"), [cls, label] = STATUS[st] || STATUS[""], run = runOf(v.id, S.date);
  const dayTag = run.n > 1 ? `<span class="tag day" title="${esc(fmtMD(run.first))}부터 연속">${run.k}일차 / ${run.n}일</span>` : "";
  return `<button type="button" class="vrow" data-vid="${esc(v.id)}"><span class="plate">${esc(vval(v, "plate"))}</span><span class="vtype">${esc(v.type)}</span><span class="vfrom">${esc(v.org)}</span>
    <span class="status-wrap">${dayTag}<span class="status ${cls}">${label}</span>${stops.length > 1 ? `<span class="tag" title="${esc(stops.map(bn).join(" → "))}">${stops.length}곳 경유</span>` : ""}</span></button>`;
}
function renderDest() {
  const moves = movesOn(S.date), filtered = S.org !== "전체" || S.type !== "전체", out = [];
  S.hqs.forEach(h => {
    const cards = [];
    S.order.filter(b => b.hq_id === h.id).forEach(b => {
      const list = moves.filter(m => m.stops.includes(b.id) && matches(m.v)), arr = rval(b.id, "arrive_at");
      const arriveToday = arr && arr.slice(0, 10) === S.date && rval(b.id, "confirmed");
      if (!list.length && (filtered || !arriveToday)) return;       // 그날 이동도, 확정된 도착 요청도 없는 지사는 숨김
      const t = `round_requests:${S.round},${b.id}`, snow = rval(b.id, "snow_cm"), why = rval(b.id, "reason");
      cards.push(`<article class="dest"><div class="dest-head">
        <h3 class="dest-name">${esc(b.name)}<span>${esc(h.name)}본부</span></h3>
        <div class="dest-time"><strong>${H(t, "arrive_at", esc(fmtTime(arr)))}</strong><small>도착 요청</small></div>
        <div class="dest-meta">${snow != null ? `<span class="tag snow">예상 적설 ${H(t, "snow_cm", esc(snow) + "cm")}</span>` : ""}${rval(b.id, "warning") ? `<span class="tag warn">${H(t, "warning", "대설 특보")}</span>` : ""}
          <span class="tag">편성 제설차 ${H(t, "assigned_truck", rval(b.id, "assigned_truck"))} · 제설기 ${H(t, "assigned_blower", rval(b.id, "assigned_blower"))}</span>${why ? `<span class="tag">사유: ${H(t, "reason", esc(why))}</span>` : ""}
          <span class="tag api">날씨·특보 연동 예정</span></div></div>
        ${list.length ? list.map(m => vehicleRow(m.v, m.stops)).join("") : `<div class="empty-state" style="border:0">조건에 맞는 장비가 없습니다.</div>`}</article>`);
    });
    if (cards.length) out.push(`<h3 class="hq-head">${esc(h.name)}본부</h3>` + cards.join(""));
  });
  $("destList").innerHTML = out.length ? out.join("") : `<div class="empty-state">${esc(fmtMD(S.date))}에 이동하는 장비가 없습니다. 위의 날짜(‹ ›)를 바꿔 보세요.</div>`;
}

/* ============================================================
   [5] 기관별 장비 — 도공번호·지원 여부·날짜별 경로. [확정]을 눌러야 서버에 날짜별로 저장
   ============================================================ */
function routeChoices() {      // 고를 수 있는 피지원 지사 = 고른 기준일자에서 편성이 확정된 지사(저장된 것 기준)
  const conf = new Set(Object.values(S.reqs).filter(r => r.confirmed).map(r => r.branch_id));
  return S.order.filter(b => conf.has(b.id));
}
// 요청은 저장됐지만 아직 확정 안 된 지사: 목록에 회색(고를 수 없음)으로 보여서 "왜 없지?"를 바로 알게 함
const pendingChoices = () => S.order.filter(b => S.reqs[b.id] && !S.reqs[b.id].confirmed);
const fleetRows = () => S.vehicles.filter(v => S.fleetOrg === "전체" || v.org === S.fleetOrg);
const canRoute = () => can("equip.edit.all");                      // 날짜별 경로·장비 삭제·지원일 1·초기화 = 관리자(모든 장비 권한)만
const canAddVeh = () => can("equip.edit.all") || can("equip.edit.own"); // 장비 추가: 관리자(모든 기관) / 지원장비(자기 기관)
const PLATE_RE = /^[가-힣]{1,10}-\d{1,5}$/;                             // 도공번호(예: 서울경기-901)
const plateEx = org => `${org || "서울경기"}-901`;
function renderFleet() {
  const choices = routeChoices(), r = curRound(), all = canRoute(), pend = pendingChoices();
  banner("perm-fleet", canAnyVeh(),
    all ? "도공번호·지원 여부·지원일별 피지원 지사(하루 여러 곳은 ＋)를 고친 뒤 아래 [확정]을 눌러야 저장됩니다. 확정한 날짜의 경로는 날짜별로 계속 남습니다."
        : `${S.me.org || ""} 장비를 추가하고 도공번호·지원 여부를 고칠 수 있습니다(지원일별 경로는 관리자). 고친 뒤 아래 [확정]을 눌러야 저장됩니다.`,
    "보기만 가능합니다.");
  $("fleetRound").innerHTML = roundSel("roundSelFleet") + `<span class="hint">` +
    (r ? `피지원 지사는 이 기준일자에 '확정'된 지사만 고를 수 있습니다 (${choices.length}곳).` + (pend.length ? ` 확정 전(요청만): ${esc(pend.map(b => b.name).join(", "))} — 지사별 요청·편성에서 [확정]을 누르세요.` : "")
       : "기준일자가 없습니다 — 지사별 요청·편성에서 만드세요.") + `</span>`;
  renderOrgGrid();
  const myOrgs = all ? S.orgs : S.orgs.filter(o => o === S.me.org);
  $("fleetFilters").innerHTML =
    `<div class="tb-row"><span class="tb-label">기관</span><span class="fgroup">${["전체", ...S.orgs].map(o => `<button type="button" class="chip" data-fo="${esc(o)}" aria-pressed="${S.fleetOrg === o}">${o === "전체" ? "모든 기관" : esc(o)}</button>`).join("")}</span>` +
    `<span class="tb-right"><label class="ctl">지원일 칸 <select class="ci" id="colsSel">${Array.from({ length: 9 }, (_, k) => k + 2).map(n => `<option value="${n}" ${n === S.cols ? "selected" : ""}>${n}개</option>`).join("")}</select></label>` +
    (all ? `<button type="button" class="btn" id="fleetReset" title="보이는 장비의 지원일 칸 경로와 지원 여부를 비웁니다(확정 전까지는 되돌리기 가능)">초기화</button>` : "") + `</span></div>` +
    (canAddVeh() && myOrgs.length ? `<div class="tb-row"><span class="tb-label">장비 추가</span><select class="ci" id="nvOrg" aria-label="새 장비 기관">${myOrgs.map(o => `<option>${esc(o)}</option>`).join("")}</select>` +
      `<select class="ci" id="nvType" aria-label="새 장비 종류">${TYPES.map(t => `<option>${t}</option>`).join("")}</select>` +
      `<input class="ci plate-in" id="nvPlate" maxlength="16" placeholder="${esc(plateEx(myOrgs[0]))}" aria-label="새 장비 도공번호"><button type="button" class="btn" id="vehAdd">추가</button></div>` : "");
  const dates = windowDates(), head = dates.map((d, i) => `<th class="dayh">지원일 ${i + 1}<span class="sub">` +
    (i === 0 && all ? `<input class="ci" type="date" id="day1In" value="${esc(d)}" aria-label="지원일 1 날짜(나머지 지원일은 하루씩 자동)">` : esc(fmtMD(d))) + `</span></th>`).join("");
  const rows = fleetRows().map(v => fleetRowHtml(v, dates, choices, all)).join("");
  $("eqTable").innerHTML = `<thead><tr><th>도공번호</th><th>장비</th><th>기관</th><th>지원 여부</th>${head}${all ? "<th></th>" : ""}</tr></thead><tbody>${rows || `<tr><td colspan="${5 + dates.length}" class="empty">장비가 없습니다.${canAddVeh() ? " 위의 [장비 추가]로 넣으세요." : ""}</td></tr>`}</tbody>`;
}
function fleetRowHtml(v, dates, choices, all) {
    const ed = canVeh(v), st = vval(v, "status"), [cls, label] = STATUS[st] || STATUS[""], tv = "vehicles:" + v.id;
    const statusCell = ed ? `<select class="ci" data-vs="${esc(v.id)}" data-fk="vs:${esc(v.id)}" aria-label="${esc(vval(v, "plate"))} 지원 여부"${hvA(tv, "status")}>${Object.keys(STATUS).map(s => `<option value="${s}" ${st === s ? "selected" : ""}>${STATUS[s][1]}</option>`).join("")}</select>`
      : H(tv, "status", `<span class="status ${cls}">${label}</span>`);
    const plateCell = ed ? `<input class="ci plate-in" type="text" maxlength="16" data-vp="${esc(v.id)}" data-fk="vp:${esc(v.id)}" value="${esc(vval(v, "plate"))}" aria-label="도공번호"${hvA(tv, "plate")}>`
      : H(tv, "plate", `<span class="plate">${esc(vval(v, "plate"))}</span>`);
    const changed = S.vdraft.has(v.id) ? " changed" : "";
    return `<tr class="${changed}" data-vrow="${esc(v.id)}"><td>${plateCell}</td><td>${esc(v.type)}</td><td>${esc(v.org)}</td><td>${statusCell}</td>${dates.map(d => `<td data-cell="${esc(rk(d, v.id))}">${slotCell(v, d, canRoute(), choices)}</td>`).join("")}` +
      (all ? `<td><button type="button" class="btn sm danger" data-vdel="${esc(v.id)}" title="장비를 목록에서 지웁니다(경로 기록도 함께 지워짐)">삭제</button></td>` : "") + `</tr>`;
}
function renderOrgGrid() {
  $("orgGrid").innerHTML = S.orgs.map(org => {
    const l = S.vehicles.filter(v => v.org === org), c = s => l.filter(v => vval(v, "status") === s).length, w = x => l.length ? x / l.length * 100 : 0;
    return `<div class="org"><h3>${esc(org)}</h3>
      <div class="bar" aria-hidden="true"><i class="b-go" style="width:${w(c("O"))}%"></i><i class="b-stop" style="width:${w(c("X") + c("M"))}%"></i></div>
      <dl><dt>지원</dt><dd>${c("O")}대</dd><dt>지원 불가</dt><dd>${c("X")}대</dd><dt>정비중</dt><dd>${c("M")}대</dd><dt>미정</dt><dd>${c("")}대</dd>
      ${TYPES.map(t => { const tl = l.filter(v => v.type === t); return `<dt>${t}</dt><dd>${tl.filter(v => vval(v, "status") === "O").length} / ${tl.length}</dd>`; }).join("")}</dl></div>`;
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
  if (v && td) keepFocus(() => { td.innerHTML = slotCell(v, d, canVeh(v), routeChoices()); });
  afterAnyChange();
}
function afterAnyChange() { hideTip(); renderMatrix(); renderDest(); updateSavebars(); }   // 다른 탭(이동 현황)과 저장 바만 새로
function slotCell(v, d, ed, choices) {
  const stops = routeOf(d, v.id), k = rk(d, v.id), t = `vehicle_routes:${d},${v.id}`, changed = S.draft.has(k), vid = esc(v.id);
  if (!ed) return stops.length ? `<div class="slot${changed ? " changed" : ""}"${hvA(t)}>${stops.map(x => `<div class="sl-x">${esc(bn(x))}</div>`).join("")}</div>` : `<span class="muted">-</span>`;
  const off = vval(v, "status") !== "O", ids = new Set(choices.map(b => b.id)), pend = pendingChoices();
  const opts = cur => `<option value="">지사 선택</option>` + S.hqs.map(h => { const l = choices.filter(b => b.hq_id === h.id); return l.length ? `<optgroup label="${esc(h.name)}">${l.map(b => `<option value="${b.id}" ${cur === b.id ? "selected" : ""}>${esc(b.name)}</option>`).join("")}</optgroup>` : ""; }).join("") +
    (cur && !ids.has(cur) ? `<option value="${esc(cur)}" selected>${esc(bn(cur))} (미확정)</option>` : "") +
    (pend.length ? `<optgroup label="확정 전(요청만) — 고를 수 없음">${pend.map(b => `<option disabled>${esc(b.name)}</option>`).join("")}</optgroup>` : "") + `<option value="__del">지우기</option>`;
  const sel = (cur, j, extra) => `<select class="ci" data-rv="${vid}" data-rd="${d}" data-fk="${extra ? "rn" : "r"}:${d}:${vid}:${j}" ${off ? "disabled" : ""} aria-label="${esc(vval(v, "plate"))} ${esc(fmtMD(d))} 피지원 지사 ${j + 1}">${opts(cur)}</select>`;
  const extra = S.extraStop.has(k), list = stops.length ? stops : [""];
  const plus = `<button type="button" class="btn sm" data-stop-add="${esc(k)}" ${off || !stops.length ? "disabled" : ""} aria-label="${esc(vval(v, "plate"))} ${esc(fmtMD(d))}에 들르는 지사 추가" title="이 날 들르는 지사 추가">＋</button>`;
  return `<div class="slot${changed ? " changed" : ""}"${hvA(t)}>${list.map((x, j) => `<div class="slot-x">${sel(x, j, false)}${j === list.length - 1 && !extra ? plus : ""}</div>`).join("")}${extra ? `<div class="slot-x">${sel("", list.length, true)}</div>` : ""}</div>`;
}
function readCell(vid, d) { return [...document.querySelectorAll("select[data-rv]")].filter(q => q.dataset.rv === vid && q.dataset.rd === d).map(q => q.value).filter(x => x && x !== "__del"); }
async function confirmFleet() {
  if (S.preview) return toast("미리보기에서는 확정할 수 없습니다. '내 아이디'로 돌아오세요.", true);
  const vehicles = [...S.vdraft].map(([id, f]) => ({ id, ...f })), routes = [...S.draft].map(([k, stops]) => { const [date, vehicle_id] = k.split("|"); return { date, vehicle_id, stops }; });
  if (!vehicles.length && !routes.length) return;
  if (!confirm(`경로 ${routes.length}칸${vehicles.length ? `, 장비 ${vehicles.length}대(도공번호·지원 여부)` : ""} 변경을 확정할까요?\n확정한 날짜의 경로는 서버에 날짜별로 남고, 나중에 다른 날짜를 확정해도 지워지지 않습니다.`)) return;
  busy("fleet", true);
  const r = await Api.saveFleet(vehicles, routes);
  busy("fleet", false);
  if (!r.ok) return toast(r.message, true);
  vehicles.forEach(p => Object.assign(vehById(p.id), p));
  routes.forEach(x => { const k = rk(x.date, x.vehicle_id); if (x.stops.length) S.routes.set(k, x.stops.slice()); else S.routes.delete(k); });
  S.draft.clear(); S.vdraft.clear(); S.extraStop.clear();
  await loadAudit(); refresh();
  toast(`확정했습니다 (경로 ${routes.length}칸${vehicles.length ? ` · 장비 ${vehicles.length}대` : ""})`);
}
function resetFleet() {
  const vs = fleetRows().filter(canVeh), ds = windowDates();
  if (!vs.length || !canRoute()) return;
  if (!confirm(`보이는 장비 ${vs.length}대의 지원일 ${fmtMD(ds[0])} ~ ${fmtMD(ds[ds.length - 1])} 경로와 지원 여부를 모두 비울까요?\n[확정]을 눌러야 서버에 반영되고, 그 전에는 [되돌리기]로 돌아갈 수 있습니다.`)) return;
  vs.forEach(v => { ds.forEach(d => setRoute(d, v.id, [])); setVeh(v.id, "status", ""); });
  S.extraStop.clear(); refresh(); toast("입력을 비웠습니다. [확정]을 눌러야 저장됩니다.");
}
async function addVehicle() {
  const plate = $("nvPlate").value.replace(/\s/g, ""), org = $("nvOrg").value;
  if (!PLATE_RE.test(plate)) return toast(`도공번호 형식이 올바르지 않습니다 (예: ${plateEx(org)})`, true);
  if (S.vehicles.some(v => vval(v, "plate") === plate)) return toast("같은 도공번호가 이미 있습니다", true);
  if (!can("equip.edit.all") && org !== S.me.org) return toast("자기 기관 장비만 추가할 수 있습니다", true);
  if (S.preview) return toast("미리보기에서는 장비를 추가할 수 없습니다.", true);
  const num = Math.max(0, ...S.vehicles.map(v => +v.id.slice(1) || 0)) + 1;
  const v = { id: "V" + String(num).padStart(3, "0"), org, type: $("nvType").value, plate, sort: Math.max(0, ...S.vehicles.map(x => x.sort || 0)) + 10 };
  const r = await Api.addVehicle(v);
  if (!r.ok) return toast(r.message, true);
  S.vehicles.push(r.vehicle); await loadAudit(); refresh(); toast(`장비를 추가했습니다 (${plate})`);
}
async function deleteVehicle(id) {
  const v = vehById(id); if (!v) return;
  if (S.preview) return toast("미리보기에서는 장비를 지울 수 없습니다.", true);
  if (!confirm(`${v.plate} (${v.org} ${v.type})를 지울까요?\n이 장비의 날짜별 경로 기록도 함께 지워집니다. 잠시 쓰지 않는 장비라면 지원 여부를 '지원 불가'·'정비중'으로 두세요.`)) return;
  const r = await Api.deleteVehicle(id);
  if (!r.ok) return toast(r.message, true);
  S.vehicles = S.vehicles.filter(x => x.id !== id); S.vdraft.delete(id);
  [...S.draft.keys()].filter(k => k.endsWith("|" + id)).forEach(k => S.draft.delete(k)); [...S.routes.keys()].filter(k => k.endsWith("|" + id)).forEach(k => S.routes.delete(k));
  await loadAudit(); refresh(); toast("장비를 지웠습니다");
}

/* ============================================================
   [6] 지사별 요청·편성 — 기준일자마다 지사별 요청, 편성 대수, 확정
   ============================================================ */
const HOURS = Array.from({ length: 24 }, (_, i) => p2(i)), MINS = ["00", "10", "20", "30", "40", "50"];
function arriveCell(b, ed, t) {
  const v = rval(b.id, "arrive_at");
  if (!ed) return v ? H(t, "arrive_at", esc(fmtTime(v))) : '<span class="muted">-</span>';
  const [d, tm] = v ? v.split("T") : ["", ""], [hh, mm] = tm ? tm.split(":") : ["", ""];
  const mins = MINS.includes(mm) || !mm ? MINS : [...MINS, mm].sort();
  // 시는 00~23, 분은 10분 단위 — 고르는 목록이라 위아래 끝에서 멈춤(무한히 돌지 않음)
  return `<span class="arr"${hvA(t, "arrive_at")}><input class="ci" type="date" data-arr="${b.id}" data-part="d" data-fk="ad:${b.id}" value="${esc(d)}" aria-label="${esc(b.name)} 도착 요청 날짜">` +
    `<select class="ci" data-arr="${b.id}" data-part="h" data-fk="ah:${b.id}" ${d ? "" : "disabled"} aria-label="${esc(b.name)} 도착 시">${HOURS.map(x => `<option ${x === (hh || "00") ? "selected" : ""}>${x}</option>`).join("")}</select>시 ` +
    `<select class="ci" data-arr="${b.id}" data-part="m" data-fk="am:${b.id}" ${d ? "" : "disabled"} aria-label="${esc(b.name)} 도착 분">${mins.map(x => `<option ${x === (mm || "00") ? "selected" : ""}>${x}</option>`).join("")}</select>분</span>`;
}
const HQ_SUM_KEYS = ["req_truck", "req_blower", "assigned_truck", "assigned_blower", "confirmed", "tot_truck", "tot_blower"];
function hqSums(hid) {
  const rows = S.order.filter(b => b.hq_id === hid), sum = f => rows.reduce((a, b) => a + (+rval(b.id, f) || 0), 0), hs = k => rows.reduce((a, b) => a + (((S.holdings || {})[b.id] || {})[k] || 0), 0);
  return { req_truck: sum("req_truck"), req_blower: sum("req_blower"), assigned_truck: sum("assigned_truck"), assigned_blower: sum("assigned_blower"),
    confirmed: rows.filter(b => rval(b.id, "confirmed")).length || "", tot_truck: hs("truck") + sum("assigned_truck"), tot_blower: hs("blower") + sum("assigned_blower") };
}
function afterReq(id) {          // 지사 요청 칸을 고친 뒤: 그 줄 표시·최종 대수·본부 합계·도착 시각 칸 잠금만 고침(입력 중인 칸은 그대로)
  const b = S.brById[id], tr = document.querySelector(`#branchTable tr[data-b="${id}"]`), ho = (S.holdings || {})[id];
  if (tr) {
    tr.classList.toggle("changed", S.rdraft.has(id)); tr.classList.add("active");
    tr.querySelector('[data-tot="truck"]').textContent = (ho ? ho.truck : 0) + (+rval(id, "assigned_truck") || 0);
    tr.querySelector('[data-tot="blower"]').textContent = (ho ? ho.blower : 0) + (+rval(id, "assigned_blower") || 0);
    const hasDate = !!rval(id, "arrive_at"); tr.querySelectorAll('[data-arr][data-part="h"], [data-arr][data-part="m"]').forEach(x => { x.disabled = !hasDate; });
  }
  const hr = b && document.querySelector(`#branchTable tr.hq[data-hq="${b.hq_id}"]`);
  if (hr) { const sm = hqSums(b.hq_id); HQ_SUM_KEYS.forEach(k => { const c = hr.querySelector(`[data-s="${k}"]`); if (c) c.textContent = sm[k]; }); }
  afterAnyChange();
}
function renderBranch() {
  const m = S.me, r = curRound();
  banner("perm-branch", canAnyReq(),
    can("req.confirm") ? "모든 지사의 요청·편성·확정을 고칠 수 있습니다. 확정한 지사만 기관별 장비에서 피지원 지사로 고를 수 있습니다. 고친 뒤 아래 [저장]을 눌러 주세요."
      : can("req.edit.hq") ? `${(S.hqById[m.hq_id] || {}).name || ""}본부 지사들의 요청을 고칠 수 있습니다(편성·확정은 관리자). 고친 뒤 [저장]을 눌러 주세요.`
      : `${bn(m.branch_id)} 지사 행의 요청만 고칠 수 있습니다(편성·확정은 관리자). 고친 뒤 [저장]을 눌러 주세요.`,
    "보기만 가능합니다.");
  $("branchRound").innerHTML = roundSel("roundSelBranch") +
    (can("req.confirm") && r ? `<button type="button" class="btn danger" id="roundDel" title="고른 기준일자와 그 지사 요청·편성을 지웁니다(장비 경로 기록은 남음)">기준일자 삭제</button>` : "") +
    (can("req.confirm") ? `<span class="sep"></span><label class="ctl">새 기준일자 <input class="ci" type="date" id="newRoundDate" value="${esc(todayISO())}"></label><button type="button" class="btn" id="roundMake">만들기</button>` : "");
  $("branchCtl").innerHTML = r ? `<div class="tb-row"><span class="tb-label">보기</span><button type="button" class="chip" id="onlyActive" aria-pressed="${S.onlyActive}">요청 있는 지사만</button>` +
    `<span class="tb-right hint">${can("req.confirm") ? "편성 대수를 정하고 [확정]을 누르면 그 지사가 기관별 장비의 선택지에 나옵니다." : ""}</span></div>` : "";
  if (!r) { $("branchTable").innerHTML = `<tbody><tr><td class="empty">기준일자가 없습니다.${can("req.confirm") ? " 위에서 기준일자를 만드세요." : " 관리자가 기준일자를 만들면 요청을 입력할 수 있습니다."}</td></tr></tbody>`; return; }
  const conf = can("req.confirm"), hold = b => (S.holdings && S.holdings[b]) || null;
  let h = `<thead><tr><th class="l" rowspan="2">지사</th><th colspan="2">보유</th><th rowspan="2">예상 적설(cm)</th><th rowspan="2">특보</th><th colspan="2">지사 요청</th><th colspan="2">편성</th><th rowspan="2">확정</th><th colspan="2">최종</th><th class="l" rowspan="2">도착 요청</th><th class="l" rowspan="2">사유</th></tr>
    <tr><th>제설차</th><th>제설기</th><th>제설차</th><th>제설기</th><th>제설차</th><th>제설기</th><th>제설차</th><th>제설기</th></tr></thead><tbody>`;
  const has = b => !!S.reqs[b.id] || S.rdraft.has(b.id);
  const mine = b => (m.branch_id === b.id) || (can("req.edit.hq") && !can("req.confirm") && b.hq_id === m.hq_id);
  S.hqs.forEach(hq => {
    const rows = S.order.filter(b => b.hq_id === hq.id), shown = rows.filter(b => !S.onlyActive || has(b) || mine(b));
    if (!shown.length) return;
    const closed = S.closedHq.has(hq.id), hs = k => rows.reduce((a, b) => a + ((hold(b.id) || {})[k] || 0), 0);
    const hsum = hqSums(hq.id);
    h += `<tr class="hq ${closed ? "closed" : ""}" data-hq="${hq.id}" tabindex="0"><td class="l">${esc(hq.name)}</td><td>${S.holdings ? hs("truck") : "-"}</td><td>${S.holdings ? hs("blower") : "-"}</td><td></td><td></td>
      ${HQ_SUM_KEYS.map(k => `<td data-s="${k}">${hsum[k]}</td>`).join("")}<td></td><td></td></tr>`;
    if (closed) return;
    shown.forEach(b => {
      const ed = canReq(b), t = `round_requests:${S.round},${b.id}`, ho = hold(b.id), on = has(b);
      const num = (f, lab, editable) => editable ? `<input class="ci num" type="number" inputmode="numeric" min="0" max="999" data-rq="${b.id}" data-f="${f}" data-fk="q:${b.id}:${f}" value="${esc(rval(b.id, f) ?? 0)}" aria-label="${esc(b.name)} ${lab}"${hvA(t, f)}>`
        : (on ? H(t, f, esc(rval(b.id, f) ?? 0)) : "-");
      const snow = rval(b.id, "snow_cm"), why = rval(b.id, "reason"), ok = rval(b.id, "confirmed");
      h += `<tr class="${on ? "active" : ""} ${m.branch_id === b.id ? "mine" : ""} ${S.rdraft.has(b.id) ? "changed" : ""}" data-b="${b.id}"><td class="l">${esc(b.name)}${m.branch_id === b.id ? ' <span class="tag">내 지사</span>' : ""}</td><td>${ho ? ho.truck : "-"}</td><td>${ho ? ho.blower : "-"}</td>
        <td>${ed ? `<input class="ci num" type="number" min="0" max="999" step="0.1" data-rq="${b.id}" data-f="snow_cm" data-fk="q:${b.id}:snow_cm" value="${esc(snow ?? "")}" aria-label="${esc(b.name)} 예상 적설"${hvA(t, "snow_cm")}>` : (snow != null ? H(t, "snow_cm", esc(snow)) : '<span class="muted">-</span>')}</td>
        <td>${ed ? `<input class="ci" type="checkbox" data-rq="${b.id}" data-f="warning" data-fk="q:${b.id}:warning" ${rval(b.id, "warning") ? "checked" : ""} aria-label="${esc(b.name)} 특보 발효"${hvA(t, "warning")}>` : (rval(b.id, "warning") ? H(t, "warning", '<span class="status stop">발효</span>') : '<span class="muted">-</span>')}</td>
        <td>${num("req_truck", "요청 제설차", ed)}</td><td>${num("req_blower", "요청 제설기", ed)}</td><td>${num("assigned_truck", "편성 제설차", ed && conf)}</td><td>${num("assigned_blower", "편성 제설기", ed && conf)}</td>
        <td class="cf">${conf ? H(t, "confirmed", ok ? `<span class="status go">확정됨</span> <button type="button" class="btn sm" data-unconfirm="${b.id}" title="확정 취소(기관별 장비 선택지에서 빠짐)">취소</button>`
                                                     : `<button type="button" class="btn sm primary" data-confirm="${b.id}" title="편성 확정 — 누르면 바로 저장되고 기관별 장비에서 이 지사를 고를 수 있음">확정</button>`)
                                 : (ok ? H(t, "confirmed", '<span class="status go">확정</span>') : '<span class="muted">-</span>')}</td>
        <td><strong data-tot="truck">${(ho ? ho.truck : 0) + (+rval(b.id, "assigned_truck") || 0)}</strong></td><td><strong data-tot="blower">${(ho ? ho.blower : 0) + (+rval(b.id, "assigned_blower") || 0)}</strong></td>
        <td class="l">${arriveCell(b, ed, t)}</td>
        <td class="l">${ed ? `<input class="ci rs" type="text" maxlength="200" data-rq="${b.id}" data-f="reason" data-fk="q:${b.id}:reason" value="${esc(why ?? "")}" aria-label="${esc(b.name)} 사유"${hvA(t, "reason")}>` : (why ? H(t, "reason", esc(why)) : '<span class="muted">-</span>')}</td>
</tr>`;
    });
  });
  $("branchTable").innerHTML = h + "</tbody>";
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
  if (!r.ok) return toast(r.message, true);
  list.forEach(({ o, f }) => { S.reqs[o.branch_id] = { ...REQ_DEF, round_id: S.round, branch_id: o.branch_id, ...(S.reqs[o.branch_id] || {}), ...f }; S.rdraft.delete(o.branch_id); });
  await loadAudit(); refresh(); toast(msg);
}
const saveBranch = () => saveBranchRows([...S.rdraft.keys()], null, `저장했습니다 (${S.rdraft.size}개 지사)`);
function confirmBranch(id, on) {
  const b = S.brById[id]; if (!b || !can("req.confirm")) return;
  const more = S.rdraft.has(id) ? "\n이 지사 줄에서 고친 값도 함께 저장됩니다." : "";
  if (!confirm(on ? `${b.name} 지사의 편성을 확정할까요? 바로 저장되고, 기관별 장비에서 이 지사를 고를 수 있습니다.${more}` : `${b.name} 지사의 확정을 취소할까요? 기관별 장비 선택지에서 빠집니다(이미 넣은 경로는 그대로).${more}`)) return;
  saveBranchRows([id], { confirmed: on }, on ? `${b.name} 지사를 확정했습니다` : `${b.name} 지사 확정을 취소했습니다`);
}
async function makeRound() {
  const d = $("newRoundDate").value;
  if (!d) return toast("기준일자 날짜를 고르세요", true);
  if (S.preview) return toast("미리보기에서는 만들 수 없습니다.", true);
  if (S.rounds.some(r => r.start_date === d)) return toast("같은 기준일자가 이미 있습니다", true);
  if (!confirm(`${d} 기준일자를 만들까요?`)) return;
  const r = await Api.createRound(d);
  if (!r.ok) return toast(r.message, true);
  S.rounds.push(r.round); S.rounds.sort((a, b) => b.start_date.localeCompare(a.start_date));
  await loadAudit(); await switchRound(r.round.id, true); toast("기준일자를 만들었습니다");
}
async function deleteRound() {
  const r = curRound(); if (!r) return;
  if (S.preview) return toast("미리보기에서는 지울 수 없습니다.", true);
  const n = Object.keys(S.reqs).length;
  if (!confirm(`기준일자 ${r.start_date}를 지울까요?\n이 기준일자의 지사 요청·편성 ${n}건도 함께 지워집니다(지운 내용은 수정 기록에 남음).\n기관별 장비의 날짜별 경로 기록은 지워지지 않습니다.`)) return;
  const res = await Api.deleteRound(r.id);
  if (!res.ok) return toast(res.message, true);
  S.rounds = S.rounds.filter(x => x.id !== r.id);
  await loadAudit(); await switchRound(pickRound(), true); toast("기준일자를 지웠습니다");
}
async function switchRound(id, force) {
  if (!force && branchDirty() && !confirm("지사별 요청·편성에 저장하지 않은 변경이 있습니다. 버리고 기준일자를 바꿀까요?")) { refresh(); return; }
  S.rdraft.clear(); S.round = +id || null;
  const r = curRound(); if (r) S.day1 = r.start_date;               // 기준일자를 고르면 지원일 1도 그 날짜로
  await Promise.all([loadReqs(), ensureRoutes()]); refresh();
}

/* ============================================================
   [7] 로그 기록 (log.view 권한) — 서버의 접속·수정 기록 중 장비 지원 관련
   ============================================================ */
function describeTarget(a) {
  const [tab, rest = ""] = (a.target || "").split(":"), p = rest.split(",");
  if (tab === "vehicle_routes") return `${plateOf(p[1])} · ${fmtMD(p[0])}`;
  if (tab === "vehicles") return plateOf(p[0]);
  if (tab === "round_requests") { const r = S.rounds.find(x => x.id === +p[0]); return `${bn(p[1])} · 기준일자 ${r ? fmtMD(r.start_date) : p[0]}`; }
  if (tab === "support_rounds") { const r = S.rounds.find(x => x.id === +p[0]); return `기준일자 ${r ? r.start_date : p[0]}`; }
  return a.target || "-";
}
function describeChange(a) {
  if (a.kind === "추가" && a.tab !== "vehicle_routes") return "새로 만듦";
  if (a.kind === "삭제" && a.tab !== "vehicle_routes") return "지움";
  const keys = [...new Set([...Object.keys(a.from_val || {}), ...Object.keys(a.to_val || {})])].filter(k => !HIDE.has(k));
  return keys.map(k => `${FIELD[k] || k}: ${fmtField(k, a.from_val ? a.from_val[k] : null)} → ${fmtField(k, a.to_val ? a.to_val[k] : null)}`).join(" / ") || "-";
}
function renderLog() {
  const box = $("logTable");
  if (!can("log.view")) { box.innerHTML = ""; $("logFilters").innerHTML = ""; return; }
  const pm = $("perm-log"); pm.className = "perm can";
  pm.textContent = "장비 지원 관련 수정 기록(최근 300건)입니다. 기록은 서버가 남기며 화면에서 고치거나 지울 수 없습니다.";
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
  const [cls, label] = STATUS[vval(v, "status")] || STATUS[""], cur = routeOf(S.date, v.id);
  sheet.innerHTML = `<button type="button" class="sheet-close" id="sheetClose">닫기</button><span class="plate" style="font-size:18px">${esc(vval(v, "plate"))}</span>
    <h2 id="sheetTitle">${esc(v.org)} ${esc(v.type)}</h2>${H("vehicles:" + v.id, "status", `<span class="status ${cls}">${label}</span>`)}
    <section><h3>${esc(fmtMD(S.date))} 이동</h3><dl class="kv"><dt>출발</dt><dd>${esc(v.org)} 기계화부</dd>
      <dt>들르는 지사</dt><dd>${cur.length ? cur.map(x => esc(bn(x))).join(" → ") : "-"}</dd>
      <dt>도착 요청</dt><dd>${cur.length ? cur.map(x => `${esc(bn(x))} ${esc(fmtTime(rval(x, "arrive_at")))}`).join("<br>") : "-"}</dd></dl></section>
    <section><h3>날짜별 경로 기록</h3><div id="vhist" class="muted">불러오는 중…</div></section>`;
  sheet.hidden = false; backdrop.hidden = false;
  if (!lastFocus) lastFocus = document.activeElement;
  $("sheetClose").focus(); $("sheetClose").onclick = closeSheet;
  const r = await Api.vehicleHistory(vid);
  if (sheet.hidden || !$("vhist")) return;
  $("vhist").className = "";
  $("vhist").innerHTML = !r.ok ? esc(r.message) : r.rows.length ? `<ol class="vhist">${r.rows.map(x => `<li class="${x.date === S.date ? "on" : ""}"><b>${esc(fmtMD(x.date))}</b> ${esc(x.date.slice(0, 4))} · ${esc(x.stops.map(bn).join(" → "))}</li>`).join("")}</ol>` : "확정된 경로 기록이 없습니다.";
}
function closeSheet() { sheet.hidden = true; backdrop.hidden = true; hideTip(); if (lastFocus) lastFocus.focus(); lastFocus = null; }
backdrop.onclick = closeSheet;
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
  fb.querySelector(".save-state").textContent = fd ? `확정하지 않은 변경: 경로 ${S.draft.size}칸${S.vdraft.size ? ` · 장비 ${S.vdraft.size}대` : ""}` + (S.preview ? " (미리보기 — 확정 불가)" : "") : "변경 사항 없음";
  bb.querySelector(".save-state").textContent = bd ? `저장하지 않은 변경: ${S.rdraft.size}개 지사` + (S.preview ? " (미리보기 — 저장 불가)" : "") : "변경 사항 없음";
  fb.querySelector("[data-revert]").disabled = !fd; fb.querySelector("[data-save]").disabled = !fd || S.preview;
  bb.querySelector("[data-revert]").disabled = !bd; bb.querySelector("[data-save]").disabled = !bd || S.preview;
}
addEventListener("beforeunload", e => { if (fleetDirty() || branchDirty()) { e.preventDefault(); e.returnValue = ""; } });
function refresh() {
  hideTip();
  banner("perm-move", false, "", "위에서 고른 날짜(‹ ›)에 이동하는 장비를 본부 → 지사 순서로 보여 줍니다. 수정은 권한에 따라 '기관별 장비'·'지사별 요청·편성'에서 합니다.");
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
  if (t.id === "day1In") { if (!t.value) return; S.day1 = t.value; S.extraStop.clear(); await ensureRoutes(); return refresh(); }
  if (t.id === "colsSel") { S.cols = Math.min(10, Math.max(2, +t.value)); await ensureRoutes(); return refresh(); }
  if (t.id === "logUser") { S.logUser = t.value; return renderLog(); }
  if (t.dataset.rv) {                       // 경로 칸(관리자): 그 (날짜, 장비)의 지사 목록을 다시 모음
    const vid = t.dataset.rv, d = t.dataset.rd, v = vehById(vid); if (!v || !canRoute()) return refresh();
    S.extraStop.delete(rk(d, vid)); setRoute(d, vid, readCell(vid, d)); return patchCell(vid, d);
  }
  if (t.dataset.vs) {                       // 지원 여부: 지원이 아니면 오늘 이후 칸의 경로를 비움(확정 전 되돌리기 가능)
    const v = vehById(t.dataset.vs); if (!v || !canVeh(v)) return refresh();
    setVeh(v.id, "status", t.value);
    if (t.value !== "O" && canRoute()) { const cut = windowDates().filter(d => d >= todayISO() && routeOf(d, v.id).length); cut.forEach(d => setRoute(d, v.id, [])); if (cut.length) toast(`${STATUS[t.value][1]}(으)로 바꿔 ${cut.length}일치 경로를 비웠습니다. [확정] 전에는 되돌릴 수 있습니다.`); }
    return patchVehicle(v.id);
  }
  if (t.id === "nvOrg") { $("nvPlate").placeholder = plateEx(t.value); return; }
  if (t.dataset.vp) {                       // 도공번호: 형식(예: 서울경기-901)과 중복 검사
    const v = vehById(t.dataset.vp), val = t.value.replace(/\s/g, ""); if (!v || !canVeh(v)) return refresh();
    if (!PLATE_RE.test(val)) { toast(`도공번호 형식이 올바르지 않습니다 (예: ${plateEx(v.org)})`, true); return refresh(); }
    if (S.vehicles.some(x => x.id !== v.id && vval(x, "plate") === val)) { toast("같은 도공번호가 이미 있습니다", true); return refresh(); }
    setVeh(v.id, "plate", val); const tr = t.closest("tr"); if (tr) tr.classList.toggle("changed", S.vdraft.has(v.id)); return afterAnyChange();
  }
  if (t.dataset.arr) {                      // 도착 요청: 날짜 + 시(00~23) + 분(10분 단위)
    const b = S.brById[t.dataset.arr]; if (!b || !canReq(b)) return refresh();
    const get = p => (document.querySelector(`[data-arr="${b.id}"][data-part="${p}"]`) || {}).value || "";
    const d = get("d"); setReq(b.id, "arrive_at", d ? `${d}T${get("h") || "00"}:${get("m") || "00"}` : null); return afterReq(b.id);
  }
  if (t.dataset.rq) {
    const b = S.brById[t.dataset.rq], f = t.dataset.f; if (!b || !canReq(b) || (["assigned_truck", "assigned_blower", "confirmed"].includes(f) && !can("req.confirm"))) return refresh();
    let v;
    if (f === "warning" || f === "confirmed") v = t.checked;
    else if (f === "snow_cm") v = t.value === "" ? null : Math.max(0, Math.min(999, Math.round(+t.value * 10) / 10 || 0));
    else if (f === "reason") v = t.value.trim() || null;
    else v = t.value === "" ? 0 : Math.max(0, Math.min(999, Math.floor(+t.value) || 0));
    setReq(b.id, f, v); return afterReq(b.id);
  }
});
document.addEventListener("click", e => {
  const c = sel => e.target.closest && e.target.closest(sel);
  let x;
  if ((x = c("[data-stop-add]"))) { S.extraStop.add(x.dataset.stopAdd); const [d, vid] = x.dataset.stopAdd.split("|"); patchCell(vid, d); const n = [...document.querySelectorAll("[data-fk]")].find(i => i.dataset.fk.startsWith(`rn:${d}:${vid}:`)); if (n) n.focus(); return; }
  if ((x = c("[data-save]"))) return x.dataset.save === "fleet" ? confirmFleet() : saveBranch();
  if ((x = c("[data-revert]"))) { if (!confirm("확정·저장하지 않은 변경을 모두 취소할까요?")) return; if (x.dataset.revert === "fleet") { S.draft.clear(); S.vdraft.clear(); S.extraStop.clear(); } else S.rdraft.clear(); return refresh(); }
  if (c("#fleetReset")) return resetFleet();
  if (c("#vehAdd")) return addVehicle();
  if ((x = c("[data-vdel]"))) return deleteVehicle(x.dataset.vdel);
  if (c("#roundMake")) return makeRound();
  if ((x = c("[data-confirm]"))) return confirmBranch(x.dataset.confirm, true);
  if ((x = c("[data-unconfirm]"))) return confirmBranch(x.dataset.unconfirm, false);
  if (c("#roundDel")) return deleteRound();
  if (c("#onlyActive")) { S.onlyActive = !S.onlyActive; return renderBranch(); }
  if ((x = c("[data-fo]"))) { S.fleetOrg = x.dataset.fo; return renderFleet(); }
  if ((x = c("[data-org]"))) { S.org = x.dataset.org; renderFilters(); return renderDest(); }
  if ((x = c("[data-type]")) && x.classList.contains("chip")) { S.type = x.dataset.type; renderFilters(); return renderDest(); }
  if ((x = c("[data-lk]"))) { S.logKind = x.dataset.lk; return renderLog(); }
  if (c("#logToday")) { S.logToday = !S.logToday; return renderLog(); }
  if ((x = c(".vrow"))) return openSheet(x.dataset.vid);
  if ((x = c("tr.hq"))) { const id = x.dataset.hq; S.closedHq.has(id) ? S.closedHq.delete(id) : S.closedHq.add(id); return renderBranch(); }
});
document.addEventListener("keydown", e => { const tr = e.target.closest && e.target.closest("tr.hq"); if (tr && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); tr.click(); } });

/* ---------- 탭·날짜·화면 모드·아이디 ---------- */
document.querySelectorAll(".tab").forEach(t => t.onclick = () => {
  document.querySelectorAll(".tab").forEach(x => x.setAttribute("aria-selected", x === t));
  document.querySelectorAll(".panel").forEach(p => p.hidden = p.id !== "panel-" + t.dataset.tab);
  hideTip();
});
const dateInput = $("dateInput"); dateInput.value = S.date;
async function setDate(v) { if (!v) return; S.date = v; dateInput.value = v; await ensureRoutes(); renderMatrix(); renderDest(); }   // 이동 현황은 고른 날짜 기준
dateInput.onchange = () => setDate(dateInput.value);
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
  const groups = [...new Set(DEMO.map(d => d.g))];
  $("userSel").innerHTML = (S.real ? `<option value="__me">내 아이디 · ${esc(S.real.label)}</option>` : "") +
    groups.map(g => `<optgroup label="${S.real ? "미리보기(저장 안 됨) · " : ""}${esc(g)}">${DEMO.filter(d => d.g === g).map(d => `<option value="${d.id}">${esc(d.label)}</option>`).join("")}</optgroup>`).join("");
  $("userSel").value = S.uid;
}
async function switchUser(uid) {
  if ((fleetDirty() || branchDirty()) && !confirm("확정·저장하지 않은 변경이 있습니다. 버리고 아이디를 바꿀까요?")) { $("userSel").value = S.uid; return; }
  S.draft.clear(); S.vdraft.clear(); S.rdraft.clear(); S.extraStop.clear();
  S.uid = uid; S.me = uid === "__me" ? S.real : identityOf(DEMO.find(d => d.id === uid));
  S.preview = !!S.real && uid !== "__me";
  Api.setActor(S.me); if (!sheet.hidden) closeSheet();
  await loadAudit(); refresh();
}

boot();
