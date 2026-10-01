/* ============================================================
   app.js — 화면과 동작 전체 (역할·권한, 저장, 수정기록, 각 탭, 이벤트)
   불러오는 순서: sample-data.js → api.js → app.js
   - 데이터(DATA, LOG)는 sample-data.js, 서버와의 통신은 api.js 에 있습니다.
   - 권한 규칙은 아래 [1] 구역과 canVeh / canBranch / canEditTab 함수에 모여 있습니다. (사람이 읽는 설명: docs/equipment-rules.md)
   ============================================================ */
/* ============================================================
   [1] 접속 아이디와 역할 (지금은 데모용 선택창)
   실제 운영에서는 로그인 결과(서버가 알려주는 역할)로 대체합니다.
   ⚠ 이 파일 안의 권한 검사는 "화면 정리용"일 뿐입니다.
     누구든 브라우저에서 코드를 바꿀 수 있으므로,
     '누가 무엇을 수정할 수 있는지'는 반드시 서버(DB 규칙)에서도 막아야 합니다.
   ============================================================ */
const USERS = {
  admin1: { label: "관리자1",  role: "admin" },
  admin2: { label: "관리자2",  role: "admin" },
  br1:    { label: "대관령지사", role: "branch", branch: "대관령" },
  br2:    { label: "양양지사",   role: "branch", branch: "양양" },
  br3:    { label: "엄정지사",   role: "branch", branch: "엄정" },
  eq1:    { label: "지원장비",   role: "equip" }
};
const state = { uid: "admin1", org: "전체", type: "전체", q: "", onlyActive: true,
  closedHq: new Set(), fleetOrg: "전체", drvOrg: "전체", revealed: new Set() };
const me = () => USERS[state.uid];
const isAdmin = () => me().role === "admin";
const canVeh = () => me().role === "admin" || me().role === "equip";   // 기관별 장비
const canDrv = canVeh;                                                    // 운전원 현황
const canBranch = b => isAdmin() || (me().role === "branch" && me().branch === b); // 본인 지사만

/* ============================================================
   [3] 도우미
   ============================================================ */
function esc(v) {   // XSS 방지: 화면에 글자를 넣을 땐 항상 이 함수를 거칩니다
  return String(v ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
const maskName = n => (!n ? "" : n.length < 2 ? n : n[0] + "○" + n.slice(2));
const maskPhone = p => (p || "").replace(/(\d{3})-?(\d{3,4})-?(\d{4})/, "$1-****-$3");
const p2 = n => String(n).padStart(2, "0");
function fmtTime(iso) {
  if (!iso) return "미정";
  const d = new Date(iso);
  return `${d.getMonth() + 1}월 ${d.getDate()}일 ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}
function fmtShort(iso) { const d = new Date(iso); return `${d.getMonth() + 1}/${d.getDate()} ${p2(d.getHours())}:${p2(d.getMinutes())}`; }
const TYPES = ["제설차", "제설기", "이동정비차"];
const STATUS = { O: ["go", "지원"], X: ["stop", "지원 불가"], "": ["wait", "미정"] };
const hqOf = b => Object.keys(DATA.branches).find(h => DATA.branches[h].some(r => r[0] === b));
const WD = "일월화수목금토";
function fmtMD(iso) { const [y, m, d] = iso.split("-").map(Number); return `${m}/${d}(${WD[new Date(y, m - 1, d).getDay()]})`; }
const driverOf = (v, i) => DATA.drivers.find(d => d.id === v.driverIds[i]);
const sameDay = iso => new Date(iso).toDateString() === new Date().toDateString();
const todayEdits = k => LOG.filter(l => l.kind === "수정" && l.key === k && sameDay(l.at));   // 말풍선은 '오늘' 수정분만
const hasHist = k => todayEdits(k).length > 0;
const TAB_NAME = { fleet: "기관별 장비", branch: "지사별 요청·편성", driver: "운전원 현황" };
const FIELD = { "req.truck": "요청 제설차", "req.blower": "요청 제설기", "assigned.truck": "편성 제설차", "assigned.blower": "편성 제설기",
  snowCm: "예상 적설", warning: "특보", arrive: "도착 요청", reason: "사유", status: "지원 여부", days: "지원 일자·기관", driver0: "운전원 1", driver1: "운전원 2", name: "이름", phone: "전화번호", org: "기관" };
function describeKey(key) {
  const [t, id, f] = key.split(":"), fl = FIELD[f] || f;
  if (t === "req") return `${id} 지사 · ${fl}`;
  if (t === "veh") return `${id} · ${fl}`;
  const d = DATA.drivers.find(x => x.id === id);
  return `${d && d.name ? maskName(d.name) : "운전원"} · ${fl}`;
}
function logAdd(o) { LOG.push({ at: new Date().toISOString(), by: me().label, ip: "-", key: null, from: null, to: null, ...o }); }

/* ---------- 값 읽기·쓰기 (키 하나로 어떤 값이든) ---------- */
function getVal(key) {
  const [t, id, f] = key.split(":");
  if (t === "req") {
    const r = DATA.requests[id];
    if (!r) return f === "snowCm" ? null : f === "warning" ? false : f === "arrive" || f === "reason" ? "" : 0;
    return f.split(".").reduce((o, k) => o[k], r);
  }
  if (t === "veh") { const v = DATA.vehicles.find(x => x.plate === id); return f.startsWith("driver") ? v.driverIds[+f.slice(6)] : v[f]; }
  if (t === "drv") return DATA.drivers.find(d => d.id === id)[f];
}
function putVal(key, val) {
  const [t, id, f] = key.split(":");
  if (t === "req") {
    const r = DATA.requests[id] ||= { snowCm: null, warning: false, req: { truck: 0, blower: 0 }, assigned: { truck: 0, blower: 0 }, arrive: "", reason: "" };
    const path = f.split("."); const last = path.pop();
    path.reduce((o, k) => o[k], r)[last] = val;
  } else if (t === "veh") {
    const v = DATA.vehicles.find(x => x.plate === id);
    if (f.startsWith("driver")) v.driverIds[+f.slice(6)] = val || null;
    else v[f] = Array.isArray(val) ? JSON.parse(JSON.stringify(val)) : val;
  }
  else if (t === "drv") DATA.drivers.find(d => d.id === id)[f] = val;
}
function allowed(key) {   // 이 아이디가 이 값을 고칠 수 있는가 (화면용 검사. 서버에서도 똑같이 막아야 함)
  const [t, id] = key.split(":");
  if (t === "req") return canBranch(id);
  return canVeh();
}
function commitRaw(key, val) {
  if (!allowed(key)) return false;
  const old = getVal(key);
  if (String(old ?? "") === String(val ?? "")) return false;
  putVal(key, val);
  PENDING.push({ key, from: old, to: val });   // 저장 버튼을 누를 때 수정기록으로 확정
  return true;
}
function commit(key, val) {
  if (!commitRaw(key, val)) return;
  const [t, id, f] = key.split(":");
  if (t === "veh" && f === "status" && val !== "O") commitRaw(`veh:${id}:days`, []); // 지원 아님 → 도착지 비움
  // TODO: 여기서 서버에 저장 요청을 보냅니다
  const light = (t === "drv" && (f === "name" || f === "phone")) || (t === "req" && f === "reason");
  if (light) { hideTip(); renderMatrix(); renderDest(); renderFleet(); updateSavebars(); }   // 입력 중인 칸은 다시 그리지 않음(연속 입력 보호)
  else refreshKeepFocus();
}

/* ---------- 저장 기능: 저장 전 변경은 '임시', 저장 버튼을 눌러야 확정 ---------- */
const PENDING = [];   // 아직 저장하지 않은 변경 목록
const SNAP = {};      // 마지막으로 저장한 상태(되돌리기용 사본)
const TABS = ["fleet", "branch", "driver"];
const tabOf = key => ({ req: "branch", veh: "fleet", drv: "driver" })[key.split(":")[0]];
const slice = {
  fleet:  () => JSON.stringify(DATA.vehicles.map(v => [v.plate, v.status, v.days, v.driverIds])),
  branch: () => JSON.stringify(DATA.requests),
  driver: () => JSON.stringify(DATA.drivers)
};
const takeSnap = t => { SNAP[t] = slice[t](); };
const isDirty = t => slice[t]() !== SNAP[t];
const canEditTab = t => t === "branch" ? (isAdmin() || me().role === "branch") : canVeh();
function dropPending(t) { for (let i = PENDING.length - 1; i >= 0; i--) if (tabOf(PENDING[i].key) === t) PENDING.splice(i, 1); }
function restore(t) {
  const s = JSON.parse(SNAP[t]);
  if (t === "fleet") s.forEach(([p, st, ds, ids]) => { const v = DATA.vehicles.find(x => x.plate === p); v.status = st; v.days = ds; v.driverIds = ids; });
  else if (t === "branch") DATA.requests = s;
  else DATA.drivers = s;
  dropPending(t);
}
let toastTimer;
function toast(msg, isErr) {
  const el = document.getElementById("toast");
  el.textContent = msg; el.className = "toast" + (isErr ? " err" : ""); el.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, 3500);
}
function saveTab(t) {
  if (!canEditTab(t) || !isDirty(t)) return;
  if (t === "driver") {   // 저장 전 입력 확인
    if (DATA.drivers.some(d => !d.name.trim())) return toast("이름이 비어 있는 운전원이 있습니다. 이름을 입력하거나 삭제해 주세요.", true);
    const bad = DATA.drivers.find(d => d.phone && !/^01\d-?\d{3,4}-?\d{4}$/.test(d.phone));
    if (bad) return toast(`전화번호 형식을 확인해 주세요 (${maskName(bad.name)}). 예: 010-1234-5678`, true);
  }
  // 같은 칸을 여러 번 고쳤으면 "처음 값 → 마지막 값" 한 건으로 합칩니다
  const merged = new Map();
  PENDING.filter(p => tabOf(p.key) === t).forEach(p => { const e = merged.get(p.key); if (e) e.to = p.to; else merged.set(p.key, { ...p }); });
  let added = [], removed = [];
  if (t === "driver") {   // 운전원을 새로 넣거나 뺀 것도 기록 대상
    const before = JSON.parse(SNAP.driver);
    added = DATA.drivers.filter(d => !before.some(b => b.id === d.id));
    removed = before.filter(b => !DATA.drivers.some(d => d.id === b.id));
  }
  // 서버에 저장 요청 (js/api.js). 성공했을 때만 아래(기록 남기기·화면 확정)를 실행하고, 실패하면 알리고 그대로 둡니다
  if (!Api.save(t, [...merged.values()], { added, removed })) return toast("저장하지 못했습니다. 잠시 후 다시 시도해 주세요.", true);
  added.forEach(d => logAdd({ kind: "추가", tab: TAB_NAME.driver, target: `${maskName(d.name)} (${d.org})` }));
  removed.forEach(d => logAdd({ kind: "삭제", tab: TAB_NAME.driver, target: `${maskName(d.name) || "(이름 없음)"} (${d.org})` }));
  let n = 0;
  merged.forEach((p, key) => {
    if (added.some(d => key.startsWith("drv:" + d.id + ":"))) return;   // 새 운전원의 입력값은 '추가' 한 건으로 갈음
    if (String(p.from ?? "") !== String(p.to ?? "")) {
      logAdd({ kind: "수정", tab: TAB_NAME[t], key, target: describeKey(key), from: p.from, to: p.to }); n++;
    }
  });
  const total = n + added.length + removed.length;
  dropPending(t); takeSnap(t); refresh();
  toast(total ? `저장했습니다 (${total}건)` : "저장했습니다");
}
function updateSavebars() {
  TABS.forEach(t => {
    const bar = document.getElementById("save-" + t), can = canEditTab(t);
    bar.hidden = !can; if (!can) return;
    const d = isDirty(t);
    bar.classList.toggle("dirty", d);
    bar.querySelector(".save-state").textContent = d ? "저장하지 않은 변경이 있습니다" : "변경 사항 없음";
    bar.querySelectorAll("button").forEach(b => { b.disabled = !d; });
  });
}
addEventListener("beforeunload", e => { if (TABS.some(isDirty)) { e.preventDefault(); e.returnValue = ""; } });

/* ---------- 수정기록 말풍선 (관리자에게만) ---------- */
function showVal(key, v) {
  const f = key.split(":")[2];
  if (f === "status") return STATUS[v ?? ""][1];
  if (f === "dest") return v || "미정";
  if (f === "warning") return v ? "발효" : "없음";
  if (f === "arrive") return fmtTime(v);
  if (f === "snowCm") return v == null || v === "" ? "없음" : v + "cm";
  if (f === "days") return v && v.length ? v.map(([d, xs]) => `${fmtMD(d)} ${xs.map(x => x || "기관 미정").join("→")}`).join(", ") : "(없음)";
  if (f === "driver0" || f === "driver1") { const d = DATA.drivers.find(x => x.id === v); return d ? maskName(d.name) : "미지정"; }
  if (f === "name") return v ? maskName(v) : "(빈칸)";
  if (f === "phone") return v ? maskPhone(v) : "(빈칸)";
  return v === "" || v == null ? "(빈칸)" : String(v);
}
const hvA = (key, focus = true) => (isAdmin() && hasHist(key)) ? ` data-hv="${esc(key)}"${focus ? ' tabindex="0"' : ""}` : "";
const H = (key, html) => hvA(key) ? `<span${hvA(key)}>${html}</span>` : html;   // 값을 말풍선 대상으로 감싸기
const tip = document.getElementById("tip");
function showTip(el) {
  const key = el.dataset.hv, list = todayEdits(key).slice(-3).reverse();
  tip.innerHTML = `<b>오늘 수정 기록</b>` + list.map(h =>
    `<div>${esc(p2(new Date(h.at).getHours()) + ":" + p2(new Date(h.at).getMinutes()))} · ${esc(h.by)}<br>${esc(showVal(key, h.from))} → ${esc(showVal(key, h.to))}</div>`).join("");
  tip.hidden = false;
  const r = el.getBoundingClientRect();
  let top = r.bottom + 8; if (top + tip.offsetHeight > innerHeight - 8) top = Math.max(8, r.top - tip.offsetHeight - 8);
  tip.style.top = top + "px";
  tip.style.left = Math.max(8, Math.min(r.left, innerWidth - tip.offsetWidth - 8)) + "px";
}
const hideTip = () => { tip.hidden = true; };
["mouseover", "focusin"].forEach(ev => document.addEventListener(ev, e => {
  const el = e.target.closest && e.target.closest("[data-hv]"); if (el) showTip(el);
}));
["mouseout", "focusout"].forEach(ev => document.addEventListener(ev, e => {
  if (e.target.closest && e.target.closest("[data-hv]")) hideTip();
}));

/* ---------- 입력 칸 만들기 ---------- */
const numIn = (key, val, label, type = "int") =>
  `<input class="ci num" type="number" inputmode="numeric" min="0" max="999" data-edit="${esc(key)}" data-type="${type}" value="${esc(val ?? "")}" aria-label="${esc(label)}"${hvA(key, false)}>`;
const banner = (id, can, ok, no) => {
  const el = document.getElementById(id);
  el.className = "perm" + (can ? " can" : "");
  el.innerHTML = esc(can ? ok : no) +
    (isAdmin() ? `<span class="hint-admin">관리자: 점선 밑줄이 있는 값에 마우스를 올리거나 누르면 오늘 수정된 기록이 최대 3건까지 보입니다. 이전 날짜 기록은 '로그 기록' 탭에서 확인하세요.</span>` : "");
};

/* ============================================================
   [4] 이동 현황 (모두 보기만)
   ============================================================ */
const movesOn = date => {   // 그 날짜에 이동하는 장비와, 그날 들르는 기관들(순서대로)
  const out = [];
  DATA.vehicles.forEach(v => { if (v.status === "O") (v.days || []).forEach(([d, xs]) => { const stops = xs.filter(Boolean); if (d === date && stops.length) out.push({ v, stops }); }); });
  return out;
};
function renderMatrix() {
  const dests = Object.keys(DATA.requests), moves = movesOn(state.date);
  const cell = (org, d) => {
    const l = moves.filter(m => m.v.org === org && m.stops.includes(d));
    return { n: l.length, t: l.filter(m => m.v.type === "제설차").length, b: l.filter(m => m.v.type === "제설기").length };
  };
  let h = `<thead><tr><th class="l" scope="col">출발 기관</th>${dests.map(d => `<th scope="col">${esc(d)}</th>`).join("")}<th scope="col">합계</th></tr></thead><tbody>`;
  DATA.orgs.forEach(org => {
    const cs = dests.map(d => cell(org, d));
    const distinct = moves.filter(m => m.v.org === org).length;   // 여러 기관을 들러도 장비 1대로 셈
    h += `<tr><th scope="row">${esc(org)}</th>${cs.map(c => c.n ? `<td>${c.n}<span class="sub">차 ${c.t} · 기 ${c.b}</span></td>` : `<td class="zero">0</td>`).join("")}<td><strong>${distinct}</strong></td></tr>`;
  });
  h += `</tbody><tfoot><tr><th scope="row">합계</th>${dests.map(d => `<td>${moves.filter(m => m.stops.includes(d)).length}</td>`).join("")}<td>${moves.length}</td></tr></tfoot>`;
  document.getElementById("matrix").innerHTML = h;
  const tr = moves.filter(m => m.v.type === "제설차").length, bl = moves.filter(m => m.v.type === "제설기").length;
  const multi = moves.some(m => m.stops.length > 1);
  document.getElementById("summaryNote").textContent = `${fmtMD(state.date)} · 제설차 ${tr}대, 제설기 ${bl}대, 이동정비차 ${moves.length - tr - bl}대 (차 = 제설차, 기 = 제설기)` +
    (multi ? " · 하루에 여러 기관을 들르는 장비는 각 기관에 모두 표시되고, 합계는 장비 1대로 셉니다" : "");
}
function renderFilters() {
  const f = document.getElementById("filters");
  f.innerHTML = ["전체", ...DATA.orgs].map(o => `<button type="button" class="chip" data-org="${esc(o)}" aria-pressed="${state.org === o}">${o === "전체" ? "모든 기관" : esc(o)}</button>`).join("") +
    `<span style="width:8px"></span>` +
    ["전체", ...TYPES].map(t => `<button type="button" class="chip" data-type="${esc(t)}" aria-pressed="${state.type === t}">${t === "전체" ? "모든 장비" : esc(t)}</button>`).join("") +
    `<input class="search" type="search" id="search" placeholder="차량번호 검색 (예: 5272)" value="${esc(state.q)}" aria-label="차량번호 검색">`;
  f.querySelectorAll("[data-org]").forEach(b => b.onclick = () => { state.org = b.dataset.org; renderFilters(); renderDest(); });
  f.querySelectorAll("[data-type]").forEach(b => b.onclick = () => { state.type = b.dataset.type; renderFilters(); renderDest(); });
  const s = document.getElementById("search"); s.oninput = () => { state.q = s.value.trim(); renderDest(); };
}
const matches = v => (state.org === "전체" || v.org === state.org) && (state.type === "전체" || v.type === state.type) &&
  (!state.q || v.plate.replace(/\s/g, "").includes(state.q.replace(/\s/g, "")));
function driverText(v, i) {
  const d = driverOf(v, i);
  return d ? esc(maskName(d.name)) : `<span class="muted">미지정</span>`;
}
function vehicleRow(v, stops = []) {
  const [cls, label] = STATUS[v.status];
  return `<button type="button" class="vrow" data-plate="${esc(v.plate)}">
    <span class="plate">${esc(v.plate)}</span><span class="vtype">${esc(v.type)}</span>
    <span class="vfrom">${esc(v.org)}</span><span class="vdriver">${driverText(v, 0)}</span>
    <span class="status-wrap"><span class="status ${cls}">${label}</span>${stops.length > 1 ? `<span class="tag" title="${esc(stops.join(" → "))}">${stops.length}곳 경유</span>` : ""}</span></button>`;
}
function renderDest() {
  const out = [], moves = movesOn(state.date), filtered = state.org !== "전체" || state.type !== "전체" || state.q;
  Object.entries(DATA.requests).forEach(([b, r]) => {
    const list = moves.filter(m => m.stops.includes(b) && matches(m.v));
    const arriveToday = r.arrive && r.arrive.slice(0, 10) === state.date;
    if (!list.length && (filtered || !arriveToday)) return;   // 그날 이동도, 도착 요청도 없는 지사는 숨김
    const k = f => `req:${b}:${f}`;
    out.push(`<article class="dest"><div class="dest-head">
      <h3 class="dest-name">${esc(b)}<span>${esc(hqOf(b))}본부</span></h3>
      <div class="dest-time"><strong>${H(k("arrive"), fmtTime(r.arrive))}</strong><small>도착 요청</small></div>
      <div class="dest-meta">
        ${r.snowCm != null ? `<span class="tag snow">예상 적설 ${H(k("snowCm"), esc(r.snowCm) + "cm")}</span>` : ""}
        ${r.warning ? `<span class="tag warn">${H(k("warning"), "대설 특보")}</span>` : ""}
        <span class="tag">편성 제설차 ${H(k("assigned.truck"), r.assigned.truck)} · 제설기 ${H(k("assigned.blower"), r.assigned.blower)}</span>
        ${r.reason ? `<span class="tag">사유: ${H(k("reason"), esc(r.reason))}</span>` : ""}
        <span class="tag api">날씨·특보 연동 예정</span>
      </div></div>
      ${list.length ? list.map(m => vehicleRow(m.v, m.stops)).join("") : `<div class="empty-state" style="border:0">조건에 맞는 장비가 없습니다.</div>`}
    </article>`);
  });
  const el = document.getElementById("destList");
  el.innerHTML = out.length ? out.join("") : `<div class="empty-state">${esc(fmtMD(state.date))}에 이동하는 장비가 없습니다. 위의 날짜(‹ ›)를 바꿔 보세요.</div>`;
  el.querySelectorAll(".vrow").forEach(b => b.onclick = () => openSheet(b.dataset.plate));
}

/* ============================================================
   [5] 기관별 장비 (관리자·지원장비 수정)
   ============================================================ */
function renderFleet() {
  banner("perm-fleet", canVeh(),
    "지원 여부·지원일별 기관(하루 여러 기관은 ＋)·운전원을 수정한 뒤 아래 [저장]을 눌러야 확정됩니다. 운전원은 '운전원 현황'에 등록된 같은 기관 소속 중에서 고릅니다.",
    "보기만 가능합니다. 수정은 관리자·지원장비 아이디만 할 수 있습니다.");
  document.getElementById("orgGrid").innerHTML = DATA.orgs.map(org => {
    const l = DATA.vehicles.filter(v => v.org === org);
    const go = l.filter(v => v.status === "O").length, stop = l.filter(v => v.status === "X").length;
    return `<div class="org"><h3>${esc(org)}</h3>
      <div class="bar" aria-hidden="true"><i class="b-go" style="width:${go / l.length * 100}%"></i><i class="b-stop" style="width:${stop / l.length * 100}%"></i></div>
      <dl><dt>지원</dt><dd>${go}대</dd><dt>지원 불가</dt><dd>${stop}대</dd><dt>미정</dt><dd>${l.length - go - stop}대</dd>
      ${TYPES.map(t => { const tl = l.filter(v => v.type === t); return `<dt>${t}</dt><dd>${tl.filter(v => v.status === "O").length} / ${tl.length}</dd>`; }).join("")}</dl></div>`;
  }).join("");

  const f = document.getElementById("fleetFilters");
  f.innerHTML = ["전체", ...DATA.orgs].map(o => `<button type="button" class="chip" data-fo="${esc(o)}" aria-pressed="${state.fleetOrg === o}">${o === "전체" ? "모든 기관" : esc(o)}</button>`).join("") + colsCtl();
  f.querySelectorAll("[data-fo]").forEach(b => b.onclick = () => { state.fleetOrg = b.dataset.fo; renderFleet(); });

  const edit = canVeh(), dests = Object.keys(DATA.requests), cols = dayCols();
  const rows = DATA.vehicles.filter(v => state.fleetOrg === "전체" || v.org === state.fleetOrg).map(v => {
    const kS = `veh:${v.plate}:status`, [cls, label] = STATUS[v.status];
    const statusCell = edit
      ? `<select class="ci" data-edit="${esc(kS)}" data-type="text" aria-label="${esc(v.plate)} 지원 여부"${hvA(kS, false)}>${["", "O", "X"].map(s => `<option value="${s}" ${v.status === s ? "selected" : ""}>${STATUS[s][1]}</option>`).join("")}</select>`
      : H(kS, `<span class="status ${cls}">${label}</span>`);
    return `<tr><td><span class="plate">${esc(v.plate)}</span></td><td>${esc(v.type)}</td><td>${esc(v.org)}</td><td>${statusCell}</td>
      ${Array.from({ length: cols }, (_, i) => `<td>${slotCell(v, i, edit, dests)}</td>`).join("")}
      <td>${driverCell(v, 0, edit)}</td><td>${driverCell(v, 1, edit)}</td></tr>`;
  }).join("");
  document.getElementById("eqTable").innerHTML = `<thead><tr><th>차량번호</th><th>장비</th><th>기관</th><th>지원 여부</th>${Array.from({ length: cols }, (_, i) => `<th>지원일 ${i + 1}</th>`).join("")}<th>운전원 1</th><th>운전원 2</th></tr></thead><tbody>${rows}</tbody>`;
}

/* ---------- 지원 일자별 지원 기관: 가로로 '지원일 1, 2, 3, 4 …' 칸 (기본 4칸, [＋ 칸 추가]로 늘림) ---------- */
Object.assign(state, { dayCols: 4, date: DATA.date, extraStop: new Set() });
const usedMax = () => Math.max(0, ...DATA.vehicles.map(v => (v.days || []).length));
const dayCols = () => Math.min(10, Math.max(state.dayCols, usedMax(), 2));
function colsCtl() {
  if (!canVeh()) return "";
  const c = dayCols(), min = Math.max(2, usedMax());
  return `<label style="margin-left:auto;display:flex;gap:6px;align-items:center;font-size:13px;color:var(--ink-soft)">지원일 칸 수
    <select class="ci" id="colsSel" style="min-height:32px">${Array.from({ length: 9 }, (_, k) => k + 2).map(n => `<option value="${n}" ${n === c ? "selected" : ""} ${n < min ? "disabled" : ""}>${n}개</option>`).join("")}</select></label>`;
}
function slotCell(v, i, edit, dests) {
  const e = (v.days || [])[i], key = `veh:${v.plate}:days`, pl = esc(v.plate);
  if (!edit) return e ? H(key, `<div class="sl-d">${esc(fmtMD(e[0]))}</div>${e[1].map(x => `<div class="sl-x">${x ? esc(x) : "기관 미정"}</div>`).join("")}`) : `<span class="muted">-</span>`;
  const off = v.status !== "O";
  const sel = (cur, j, extra) => `<select class="ci" data-sx="${pl}" data-i="${i}" ${extra ? 'data-extra="1"' : ""} data-fk="${extra ? "sxn:" + pl + "|" + esc(e[0]) : `sx:${pl}:${i}:${j}`}" ${off || !e ? "disabled" : ""} aria-label="${pl} 지원일 ${i + 1} 지원 기관 ${j + 1}"${hvA(key, false)}>
      <option value="">기관 선택</option>${dests.map(d => `<option value="${esc(d)}" ${cur === d ? "selected" : ""}>${esc(d)}</option>`).join("")}${cur && !dests.includes(cur) ? `<option value="${esc(cur)}" selected>${esc(cur)}</option>` : ""}<option value="__del">지우기</option></select>`;
  const stops = e ? e[1] : [""], extra = e && state.extraStop.has(`${v.plate}|${e[0]}`);
  const plus = e ? `<button type="button" class="btn sm" data-stop-add="${pl}|${esc(e[0])}" ${off ? "disabled" : ""} aria-label="${pl} 지원일 ${i + 1}에 들르는 기관 추가" title="이 날 들르는 기관 추가">＋</button>` : "";
  return `<div class="slot">
    <input class="ci" type="date" data-sd="${pl}" data-i="${i}" data-fk="sd:${pl}:${i}" value="${esc(e ? e[0] : "")}" ${off ? "disabled" : ""} aria-label="${pl} 지원일 ${i + 1} 날짜"${hvA(key, false)}>
    ${stops.map((x, j) => `<div class="slot-x">${sel(x, j, false)}${j === stops.length - 1 && !extra ? plus : ""}</div>`).join("")}
    ${extra ? `<div class="slot-x">${sel("", stops.length, true)}</div>` : ""}</div>`;
}

/* ---------- 운전원: '운전원 현황' 명단에서 같은 기관 이름만 골라 쓰기 (번호는 자동 표시) ---------- */
function driverOptions(v, i) {
  const other = v.driverIds[1 - i], cur = driverOf(v, i);
  const list = DATA.drivers.filter(d => d.org === v.org && d.id !== other && d.name.trim());
  if (cur && !list.includes(cur)) list.push(cur);   // 소속이 바뀐 운전원도 현재 배정은 보이게
  return list.map(d => ({ d, label: d.name + (list.filter(x => x.name === d.name).length > 1 ? ` (${d.phone.slice(-4)})` : "") + (d.org !== v.org ? " · 다른 기관" : "") }));
}
function driverCell(v, i, edit) {
  const d = driverOf(v, i), k = `veh:${v.plate}:driver${i}`, kind = `<span class="tag">${esc(v.kinds[i])}</span>`;
  if (edit) return `<select class="ci" data-edit="${esc(k)}" data-type="text" aria-label="${esc(v.plate)} 운전원 ${i + 1}"${hvA(k, false)}>
      <option value="">선택 안 함</option>${driverOptions(v, i).map(o => `<option value="${esc(o.d.id)}" ${d && d.id === o.d.id ? "selected" : ""}>${esc(o.label)}</option>`).join("")}</select>
    <div class="dphone">${d ? esc(d.phone || "번호 미등록") : '<span class="muted">-</span>'} ${kind}</div>`;
  if (!d) return `<span class="muted">미지정</span> ${kind}`;
  const shown = state.revealed.has(d.id);
  return `${H(k, esc(shown ? d.name : maskName(d.name)))}
    <div class="dphone">${esc(shown ? d.phone : maskPhone(d.phone))} ${shown ? "" : `<button type="button" class="btn sm" data-reveal="${esc(d.id)}">보기</button>`} ${kind}</div>`;
}

/* ============================================================
   [6] 지사별 요청·편성 (관리자 전체 / 지사는 본인 지사만)
   ============================================================ */
function renderBranch() {
  const m = me();
  banner("perm-branch", isAdmin() || m.role === "branch",
    isAdmin() ? "모든 지사를 수정할 수 있습니다. 수정 후 아래 [저장]을 눌러 주세요. 요청이 없는 지사는 '요청 있는 지사만'을 끄면 나옵니다."
              : `${m.branch} 지사 행만 수정할 수 있습니다. 수정 후 아래 [저장]을 눌러 주세요.`,
    "보기만 가능합니다. 수정은 관리자·피지원지사 아이디만 할 수 있습니다.");
  let h = `<thead>
    <tr><th class="l" rowspan="2">지사</th><th colspan="2">보유</th><th rowspan="2">예상 적설(cm)</th><th rowspan="2">특보</th>
      <th colspan="2">지사 요청</th><th colspan="2">편성</th><th colspan="2">최종</th><th class="l" rowspan="2">도착 요청</th><th class="l" rowspan="2">사유</th></tr>
    <tr><th>제설차</th><th>제설기</th><th>제설차</th><th>제설기</th><th>제설차</th><th>제설기</th><th>제설차</th><th>제설기</th></tr></thead><tbody>`;
  for (const [hq, rows] of Object.entries(DATA.branches)) {
    const mineIn = b => m.role === "branch" && m.branch === b;
    const shown = rows.filter(([b]) => !state.onlyActive || DATA.requests[b] || mineIn(b));
    if (!shown.length) continue;
    const closed = state.closedHq.has(hq);
    const s = rows.reduce((a, [b, t, w]) => { const r = DATA.requests[b]; a.t += t; a.w += w;
      if (r) { a.rt += r.req.truck; a.rw += r.req.blower; a.at += r.assigned.truck; a.aw += r.assigned.blower; } return a; }, { t: 0, w: 0, rt: 0, rw: 0, at: 0, aw: 0 });
    h += `<tr class="hq ${closed ? "closed" : ""}" data-hq="${esc(hq)}" tabindex="0"><td class="l">${esc(hq)}</td><td>${s.t}</td><td>${s.w}</td><td></td><td></td>
      <td>${s.rt}</td><td>${s.rw}</td><td>${s.at}</td><td>${s.aw}</td><td>${s.t + s.at}</td><td>${s.w + s.aw}</td><td></td><td></td></tr>`;
    if (closed) continue;
    shown.forEach(([b, t, w]) => {
      const r = DATA.requests[b], ed = canBranch(b), k = f => `req:${b}:${f}`;
      const n = (f, v, lab) => ed ? numIn(k(f), v ?? 0, `${b} ${lab}`) : (r ? H(k(f), v ?? 0) : "-");
      h += `<tr class="${r ? "active" : ""} ${mineIn(b) ? "mine" : ""}"><td class="l">${esc(b)}${mineIn(b) ? ' <span class="tag">내 지사</span>' : ""}</td><td>${t}</td><td>${w}</td>
        <td>${ed ? numIn(k("snowCm"), r?.snowCm ?? "", `${b} 예상 적설`, "num") : (r && r.snowCm != null ? H(k("snowCm"), esc(r.snowCm)) : '<span class="muted">-</span>')}</td>
        <td>${ed ? `<input class="ci" type="checkbox" data-edit="${esc(k("warning"))}" data-type="bool" ${r?.warning ? "checked" : ""} aria-label="${esc(b)} 특보 발효"${hvA(k("warning"), false)}>`
                 : (r && r.warning ? H(k("warning"), '<span class="status stop">발효</span>') : '<span class="muted">-</span>')}</td>
        <td>${n("req.truck", r?.req.truck, "요청 제설차")}</td><td>${n("req.blower", r?.req.blower, "요청 제설기")}</td>
        <td>${n("assigned.truck", r?.assigned.truck, "편성 제설차")}</td><td>${n("assigned.blower", r?.assigned.blower, "편성 제설기")}</td>
        <td><strong>${t + (r ? r.assigned.truck : 0)}</strong></td><td><strong>${w + (r ? r.assigned.blower : 0)}</strong></td>
        <td class="l">${ed ? `<input class="ci dt" type="datetime-local" data-edit="${esc(k("arrive"))}" data-type="text" value="${esc(r?.arrive ?? "")}" aria-label="${esc(b)} 도착 요청"${hvA(k("arrive"), false)}>`
                           : (r ? H(k("arrive"), fmtTime(r.arrive)) : '<span class="muted">-</span>')}</td>
        <td class="l">${ed ? `<input class="ci rs" type="text" maxlength="30" data-edit="${esc(k("reason"))}" data-type="text" value="${esc(r?.reason ?? "")}" aria-label="${esc(b)} 사유"${hvA(k("reason"), false)}>`
                           : (r && r.reason ? H(k("reason"), esc(r.reason)) : '<span class="muted">-</span>')}</td></tr>`;
    });
  }
  const tb = document.getElementById("branchTable");
  tb.innerHTML = h + "</tbody>";
  tb.querySelectorAll("tr.hq").forEach(tr => {
    const toggle = () => { const hq = tr.dataset.hq; state.closedHq.has(hq) ? state.closedHq.delete(hq) : state.closedHq.add(hq); renderBranch(); };
    tr.onclick = toggle; tr.onkeydown = e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } };
  });
}
document.getElementById("onlyActive").onclick = e => {
  state.onlyActive = !state.onlyActive; e.currentTarget.setAttribute("aria-pressed", state.onlyActive); renderBranch();
};

/* ============================================================
   [7] 운전원 현황 (관리자·지원장비 수정: 이름·전화번호)
   ============================================================ */
function renderDrivers() {
  const edit = canDrv();
  banner("perm-driver", edit,
    "이름과 전화번호를 입력한 뒤 아래 [저장]을 눌러 주세요. 이 명단을 나중에 기관별 장비 탭에서 골라 쓰게 됩니다.",
    "보기만 가능합니다. 이름·전화번호는 가려서 보이고, '보기'를 누르면 표시됩니다(조회 기록 대상).");
  const f = document.getElementById("drvFilters");
  f.innerHTML = ["전체", ...DATA.orgs].map(o => `<button type="button" class="chip" data-do="${esc(o)}" aria-pressed="${state.drvOrg === o}">${o === "전체" ? "모든 기관" : esc(o)}</button>`).join("") +
    (edit ? `<button type="button" class="btn primary" id="addDrv" style="margin-left:auto">＋ 운전원 추가</button>` : "");
  f.querySelectorAll("[data-do]").forEach(b => b.onclick = () => { state.drvOrg = b.dataset.do; renderDrivers(); });
  const add = document.getElementById("addDrv");
  if (add) add.onclick = () => {
    const id = "d" + Date.now();
    DATA.drivers.push({ id, org: state.drvOrg !== "전체" ? state.drvOrg : DATA.orgs[0], name: "", phone: "" });
    renderDrivers(); updateSavebars();
    const n = document.querySelector(`[data-edit="${CSS.escape("drv:" + id + ":name")}"]`); if (n) n.focus();
  };
  const list = DATA.drivers.filter(d => state.drvOrg === "전체" || d.org === state.drvOrg);
  const rows = list.map(d => {
    const kN = `drv:${d.id}:name`, kP = `drv:${d.id}:phone`, kO = `drv:${d.id}:org`;
    const plates = DATA.vehicles.filter(v => v.driverIds.includes(d.id)).map(v => `<span class="plate" style="font-size:12.5px">${esc(v.plate)}</span>`).join(" ") || '<span class="muted">-</span>';
    if (edit) return `<tr>
      <td><select class="ci" data-edit="${esc(kO)}" data-type="text" aria-label="소속 기관"${hvA(kO, false)}>${DATA.orgs.map(o => `<option ${d.org === o ? "selected" : ""}>${esc(o)}</option>`).join("")}</select></td>
      <td><input class="ci nm" type="text" maxlength="20" placeholder="이름" data-edit="${esc(kN)}" data-type="text" value="${esc(d.name)}" aria-label="운전원 이름"${hvA(kN, false)}></td>
      <td><input class="ci ph" type="tel" inputmode="tel" maxlength="13" placeholder="010-0000-0000" data-edit="${esc(kP)}" data-type="phone" value="${esc(d.phone)}" aria-label="전화번호"${hvA(kP, false)}></td>
      <td>${plates}</td><td><button type="button" class="btn sm danger" data-del="${esc(d.id)}">삭제</button></td></tr>`;
    const shown = state.revealed.has(d.id);
    return `<tr><td>${esc(d.org)}</td><td>${H(kN, esc(shown ? d.name : maskName(d.name)))}</td>
      <td>${H(kP, esc(shown ? d.phone : maskPhone(d.phone)))} ${shown ? "" : `<button type="button" class="btn sm" data-reveal="${esc(d.id)}">보기</button>`}</td><td>${plates}</td><td></td></tr>`;
  }).join("");
  document.getElementById("drvTable").innerHTML = `<thead><tr><th>기관</th><th>이름</th><th>전화번호</th><th>배정 장비</th><th></th></tr></thead><tbody>${rows || `<tr><td colspan="5" class="muted" style="text-align:center;padding:28px">등록된 운전원이 없습니다.</td></tr>`}</tbody>`;
}

/* ============================================================
   [7-2] 로그 기록 (관리자만 그리기)
   ============================================================ */
Object.assign(state, { logUser: "전체", logKind: "전체", logToday: false });
function renderLog() {
  const box = document.getElementById("logTable");
  if (!isAdmin()) { box.innerHTML = ""; document.getElementById("logFilters").innerHTML = ""; return; }  // 관리자가 아니면 내용을 그리지 않음
  const pm = document.getElementById("perm-log");
  pm.className = "perm can";
  pm.textContent = "관리자만 볼 수 있습니다. 로그는 화면에서 고치거나 지울 수 없습니다. 실제 운영에서는 서버가 IP와 함께 기록하고 1년 이상 보관하세요. (이 시연 화면에서 새로 생긴 기록의 IP는 서버가 없어 '-'로 표시됩니다.)";
  const kinds = ["전체", "접속", "수정", "조회", "추가", "삭제"];
  const users = [...new Set(LOG.map(l => l.by))];
  const f = document.getElementById("logFilters");
  f.innerHTML = kinds.map(k => `<button type="button" class="chip" data-lk="${k}" aria-pressed="${state.logKind === k}">${k === "전체" ? "모든 구분" : k}</button>`).join("") +
    `<select class="ci" id="logUser" aria-label="아이디로 거르기"><option value="전체">모든 아이디</option>${users.map(u => `<option ${state.logUser === u ? "selected" : ""}>${esc(u)}</option>`).join("")}</select>` +
    `<button type="button" class="chip" id="logToday" aria-pressed="${state.logToday}">오늘만</button>`;
  f.querySelectorAll("[data-lk]").forEach(b => b.onclick = () => { state.logKind = b.dataset.lk; renderLog(); });
  document.getElementById("logUser").onchange = e => { state.logUser = e.target.value; renderLog(); };
  document.getElementById("logToday").onclick = () => { state.logToday = !state.logToday; renderLog(); };
  const badge = k => k === "조회" ? `<span class="tag snow">조회</span>` : `<span class="status ${k === "삭제" ? "stop" : k === "접속" ? "wait" : "go"}">${esc(k)}</span>`;
  const rows = LOG.filter(l => (state.logKind === "전체" || l.kind === state.logKind) && (state.logUser === "전체" || l.by === state.logUser) && (!state.logToday || sameDay(l.at)))
    .slice().reverse().slice(0, 300).map(l => `<tr>
      <td class="t">${esc(fmtShort(l.at))}</td><td>${esc(l.by)}</td><td>${badge(l.kind)}</td><td>${esc(l.tab || "-")}</td>
      <td>${esc(l.target || (l.key ? describeKeyLog(l.key) : "-"))}</td>
      <td>${l.kind === "수정" ? `${esc(showVal(l.key, l.from))} → ${esc(showVal(l.key, l.to))}` : l.kind === "조회" ? "연락처 표시" : l.kind === "접속" ? "접속" : l.kind === "추가" ? "운전원 등록" : "운전원 삭제"}</td>
      <td class="ip">${esc(l.ip)}</td></tr>`).join("");
  box.innerHTML = `<thead><tr><th>일시</th><th>아이디</th><th>구분</th><th>탭</th><th>대상</th><th>내용</th><th>IP</th></tr></thead><tbody>${rows || `<tr><td colspan="7" class="muted" style="text-align:center;padding:28px">조건에 맞는 기록이 없습니다.</td></tr>`}</tbody>`;
}
const describeKeyLog = describeKey;

/* ============================================================
   [8] 장비 상세 시트
   ============================================================ */
const sheet = document.getElementById("sheet"), backdrop = document.getElementById("backdrop");
let lastFocus = null, curPlate = null;
function openSheet(plate) {
  const v = DATA.vehicles.find(x => x.plate === plate); if (!v) return;
  curPlate = plate;
  const cur = (v.days || []).find(([d]) => d === state.date), curStops = cur ? cur[1].filter(Boolean) : [], [cls, label] = STATUS[v.status];
  const drv = i => {
    const d = driverOf(v, i), shown = d && state.revealed.has(d.id);
    return `<dt>운전원 ${i + 1}</dt><dd>${d ? esc(shown ? d.name : maskName(d.name)) : '<span class="muted">미지정</span>'} <span class="tag" style="margin-left:6px">${esc(v.kinds[i])}</span></dd>
      <dt>연락처</dt><dd>${d ? esc(shown ? d.phone : maskPhone(d.phone)) + (shown ? "" : ` <button type="button" class="reveal" data-reveal="${esc(d.id)}">보기</button>`) : '<span class="muted">-</span>'}</dd>`;
  };
  sheet.innerHTML = `<button type="button" class="sheet-close" id="sheetClose">닫기</button>
    <span class="plate" style="font-size:18px">${esc(v.plate)}</span>
    <h2 id="sheetTitle">${esc(v.org)} ${esc(v.type)}</h2>
    ${H(`veh:${v.plate}:status`, `<span class="status ${cls}">${label}</span>`)}
    <section><h3>이동</h3><dl class="kv"><dt>출발</dt><dd>${esc(v.org)} 기계화부</dd>
      <dt>지원 일자</dt><dd>${v.days && v.days.length ? H(`veh:${v.plate}:days`, v.days.map(([d, xs]) => `${esc(fmtMD(d))} → ${esc(xs.map(x => x || "기관 미정").join(" → "))}`).join("<br>")) : "-"}</dd>
      <dt>도착 요청</dt><dd>${curStops.length ? curStops.map(x => DATA.requests[x] ? `${esc(x)} ${H(`req:${x}:arrive`, fmtTime(DATA.requests[x].arrive))}` : esc(x)).join("<br>") : "-"}</dd></dl></section>
    <section><h3>운전원</h3><dl class="kv">${drv(0)}${drv(1)}</dl>
      <p class="note">연락처는 가려서 보여주고 '보기'를 누를 때만 표시합니다. 실제 운영 시 이 동작을 접속기록에 남기세요.</p></section>`;
  sheet.hidden = false; backdrop.hidden = false;
  if (!lastFocus) lastFocus = document.activeElement;
  document.getElementById("sheetClose").focus();
  document.getElementById("sheetClose").onclick = closeSheet;
}
function closeSheet() { sheet.hidden = true; backdrop.hidden = true; curPlate = null; hideTip(); if (lastFocus) lastFocus.focus(); lastFocus = null; }
backdrop.onclick = closeSheet;
document.addEventListener("keydown", e => { if (e.key === "Escape" && !sheet.hidden) closeSheet(); });

/* ============================================================
   [9] 이벤트 (수정·삭제·보기) — 한 곳에서 처리
   ============================================================ */
document.addEventListener("change", e => {
  if (e.target.id === "colsSel") { state.dayCols = +e.target.value; renderFleet(); return; }
  const sl = e.target.closest("[data-sd], [data-sx]");
  if (sl) {   // 지원일 칸: 같은 장비의 (날짜, 들르는 기관들)을 모아 한 번에 처리
    const plate = sl.dataset.sd ?? sl.dataset.sx, key = `veh:${plate}:days`;
    const ds = [...document.querySelectorAll("input[data-sd]")].filter(i => i.dataset.sd === plate);
    const xs = [...document.querySelectorAll("select[data-sx]")].filter(i => i.dataset.sx === plate);
    const filled = ds.filter(i => i.value);
    if (new Set(filled.map(i => i.value)).size < filled.length) { toast("같은 날짜가 이미 입력되어 있습니다. 다른 날짜를 골라 주세요.", true); renderFleet(); return; }
    const days = [];
    filled.forEach(inp => {
      const mine = xs.filter(q => q.dataset.i === inp.dataset.i), deleted = mine.some(q => q.value === "__del");
      let stops = [...new Set(mine.filter(q => q.value !== "__del").map(q => q.value).filter(Boolean))];   // 비어 있는 기관은 제거, 중복 기관은 한 번만
      if (!stops.length) { if (deleted) return; stops = [""]; }   // '지우기'로 마지막 기관을 지우면 그 날짜도 삭제
      days.push([inp.value, stops]);
    });
    days.sort((a, b) => a[0].localeCompare(b[0]));
    [...state.extraStop].filter(k => k.startsWith(plate + "|")).forEach(k => state.extraStop.delete(k));
    const same = JSON.stringify(getVal(key)) === JSON.stringify(days);
    commit(key, days);
    if (same) renderFleet();
    return;
  }
  const el = e.target.closest("[data-edit]"); if (!el) return;
  const t = el.dataset.type; let v;
  if (t === "bool") v = el.checked;
  else if (t === "int") v = el.value === "" ? 0 : Math.max(0, Math.min(999, Math.floor(+el.value) || 0));
  else if (t === "num") v = el.value === "" ? null : Math.max(0, Math.min(999, +el.value || 0));
  else if (t === "phone") v = el.value.replace(/[^\d-]/g, "").slice(0, 13);
  else v = el.value.trim();
  commit(el.dataset.edit, v);
  if (isAdmin() && hasHist(el.dataset.edit) && !el.dataset.hv) el.dataset.hv = el.dataset.edit;
});
document.addEventListener("click", e => {
  const del = e.target.closest("[data-del]");
  if (del && canDrv() && confirm("이 운전원을 명단에서 삭제할까요?")) {
    const id = del.dataset.del;
    DATA.drivers = DATA.drivers.filter(d => d.id !== id);
    PENDING.splice(0, PENDING.length, ...PENDING.filter(p => !p.key.startsWith("drv:" + id + ":")));
    // TODO: 서버에 삭제 요청
    refresh();
  }
  const sa = e.target.closest("[data-stop-add]");
  if (sa && canVeh()) {
    state.extraStop.add(sa.dataset.stopAdd); renderFleet();
    const n = [...document.querySelectorAll("[data-fk]")].find(i => i.dataset.fk === "sxn:" + sa.dataset.stopAdd); if (n) n.focus();
  }
  const sv = e.target.closest("[data-save]");
  if (sv) saveTab(sv.dataset.save);
  const rt = e.target.closest("[data-revert]");
  if (rt && confirm("저장하지 않은 변경을 모두 취소할까요?")) { restore(rt.dataset.revert); refresh(); }
  const rv = e.target.closest("[data-reveal]");
  if (rv) {
    state.revealed.add(rv.dataset.reveal);
    const dd = DATA.drivers.find(x => x.id === rv.dataset.reveal);
    if (dd) logAdd({ kind: "조회", tab: curPlate ? "장비 상세" : TAB_NAME.driver, target: `${maskName(dd.name)} 연락처` });
    // TODO: 서버에 "누가 언제 어느 운전원 연락처를 봤는지" 기록 요청
    const p = curPlate; refresh(); if (p) openSheet(p);
  }
});
function refresh() {
  hideTip();
  banner("perm-move", false, "", "위에서 고른 날짜(‹ ›)에 이동하는 장비를 보여줍니다. 모든 탭의 현황을 볼 수 있고, 수정은 아이디 역할에 따라 각 탭에서 할 수 있습니다.");
  renderMatrix(); renderFilters(); renderDest(); renderFleet(); renderBranch(); renderDrivers(); renderLog(); updateSavebars();
  document.getElementById("logTabBtn").hidden = !isAdmin();
  if (!isAdmin() && !document.getElementById("panel-log").hidden) document.querySelector('[data-tab="move"]').click();
}
function refreshKeepFocus() {   // 값을 고친 뒤 화면을 다시 그리되, 커서 위치는 유지
  setTimeout(() => {
    const a = document.activeElement, k = a && a.dataset && a.dataset.edit, fk = a && a.dataset && a.dataset.fk;
    refresh();
    if (k) { const n = document.querySelector(`[data-edit="${CSS.escape(k)}"]`); if (n) n.focus(); }
    else if (fk) { const n = [...document.querySelectorAll("[data-fk]")].find(i => i.dataset.fk === fk); if (n) n.focus(); }
  }, 0);
}

/* ---------- 탭·날짜·밝기·아이디 선택 ---------- */
document.querySelectorAll(".tab").forEach(t => t.onclick = () => {
  document.querySelectorAll(".tab").forEach(x => x.setAttribute("aria-selected", x === t));
  document.querySelectorAll(".panel").forEach(p => p.hidden = p.id !== "panel-" + t.dataset.tab);
  hideTip();
});
const dateInput = document.getElementById("dateInput"); dateInput.value = state.date;
function setDate(v) { if (!v) return; state.date = v; dateInput.value = v; renderMatrix(); renderDest(); }   // 이동 현황은 고른 날짜 기준
function shiftDate(n) { const [y, m, d] = state.date.split("-").map(Number); const t = new Date(y, m - 1, d + n); setDate(`${t.getFullYear()}-${p2(t.getMonth() + 1)}-${p2(t.getDate())}`); }
dateInput.onchange = () => setDate(dateInput.value);
document.getElementById("prevDay").onclick = () => shiftDate(-1);
document.getElementById("nextDay").onclick = () => shiftDate(1);
document.getElementById("themeBtn").onclick = () => {
  const root = document.documentElement;
  const dark = root.dataset.theme ? root.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  root.dataset.theme = dark ? "light" : "dark";
};
const userSel = document.getElementById("userSel");
userSel.innerHTML =
  `<optgroup label="관리자">${["admin1", "admin2"].map(u => `<option value="${u}">${esc(USERS[u].label)}</option>`).join("")}</optgroup>` +
  `<optgroup label="피지원지사">${["br1", "br2", "br3"].map(u => `<option value="${u}">${esc(USERS[u].label)}</option>`).join("")}</optgroup>` +
  `<optgroup label="지원장비"><option value="eq1">${esc(USERS.eq1.label)}</option></optgroup>`;
userSel.onchange = () => {
  if (TABS.some(isDirty) && !confirm("저장하지 않은 변경이 있습니다. 버리고 아이디를 바꿀까요?")) { userSel.value = state.uid; return; }
  TABS.forEach(t => { if (isDirty(t)) restore(t); });
  state.uid = userSel.value; logAdd({ kind: "접속" }); if (!sheet.hidden) closeSheet(); refresh(); };

TABS.forEach(takeSnap);
logAdd({ kind: "접속" });   // 시연: 화면을 연 것을 '접속'으로 기록
refresh();
