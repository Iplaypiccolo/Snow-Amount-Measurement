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
  closedHq: new Set(), fleetOrg: "전체" };
const me = () => USERS[state.uid];
const isAdmin = () => me().role === "admin";
const canVeh = () => me().role === "admin" || me().role === "equip";   // 기관별 장비
const canBranch = b => isAdmin() || (me().role === "branch" && me().branch === b); // 본인 지사만

/* ============================================================
   [3] 도우미
   ============================================================ */
function esc(v) {   // XSS 방지: 화면에 글자를 넣을 땐 항상 이 함수를 거칩니다
  return String(v ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
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
const sameDay = iso => new Date(iso).toDateString() === new Date().toDateString();
const todayISO = () => { const t = new Date(); return `${t.getFullYear()}-${p2(t.getMonth() + 1)}-${p2(t.getDate())}`; };
function addDays(iso, n) { const [y, m, d] = iso.split("-").map(Number); const t = new Date(y, m - 1, d + n); return `${t.getFullYear()}-${p2(t.getMonth() + 1)}-${p2(t.getDate())}`; }
const vehById = id => DATA.vehicles.find(x => x.id === id);
const plateOf = id => (vehById(id) || {}).plate || id;
const todayEdits = k => LOG.filter(l => l.kind === "수정" && l.key === k && sameDay(l.at));   // 말풍선은 '오늘' 수정분만
const hasHist = k => todayEdits(k).length > 0;
const TAB_NAME = { fleet: "기관별 장비", branch: "지사별 요청·편성" };
const FIELD = { plate: "차량번호", "req.truck": "요청 제설차", "req.blower": "요청 제설기", "assigned.truck": "편성 제설차", "assigned.blower": "편성 제설기",
  snowCm: "예상 적설", warning: "특보", arrive: "도착 요청", reason: "사유", status: "지원 여부", days: "지원 일자·기관" };
function describeKey(key) {
  const [t, id, f] = key.split(":"), fl = FIELD[f] || f;
  if (t === "req") return `${id} 지사 · ${fl}`;
  return `${plateOf(id)} · ${fl}`;          // 장비는 고유 번호(id)로 기록하고, 화면에는 지금 차량번호로 보여 줌
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
  if (t === "veh") return vehById(id)[f];
}
function putVal(key, val) {
  const [t, id, f] = key.split(":");
  if (t === "req") {
    const r = DATA.requests[id] ||= { snowCm: null, warning: false, req: { truck: 0, blower: 0 }, assigned: { truck: 0, blower: 0 }, arrive: "", reason: "" };
    const path = f.split("."); const last = path.pop();
    path.reduce((o, k) => o[k], r)[last] = val;
  } else if (t === "veh") {
    const v = vehById(id);
    v[f] = Array.isArray(val) ? JSON.parse(JSON.stringify(val)) : val;
  }
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
  const light = (t === "req" && f === "reason");
  if (light) { hideTip(); renderMatrix(); renderDest(); renderFleet(); updateSavebars(); }   // 입력 중인 칸은 다시 그리지 않음(연속 입력 보호)
  else refreshKeepFocus();
}

/* ---------- 저장 기능: 저장 전 변경은 '임시', 저장 버튼을 눌러야 확정 ---------- */
const PENDING = [];   // 아직 저장하지 않은 변경 목록
const SNAP = {};      // 마지막으로 저장한 상태(되돌리기용 사본)
const TABS = ["fleet", "branch"];
const tabOf = key => ({ req: "branch", veh: "fleet" })[key.split(":")[0]];
const slice = {
  fleet:  () => JSON.stringify(DATA.vehicles.map(v => [v.id, v.plate, v.status, v.days])),
  branch: () => JSON.stringify(DATA.requests)
};
const takeSnap = t => { SNAP[t] = slice[t](); };
const isDirty = t => slice[t]() !== SNAP[t];
const canEditTab = t => t === "branch" ? (isAdmin() || me().role === "branch") : canVeh();
function dropPending(t) { for (let i = PENDING.length - 1; i >= 0; i--) if (tabOf(PENDING[i].key) === t) PENDING.splice(i, 1); }
function restore(t) {
  const s = JSON.parse(SNAP[t]);
  if (t === "fleet") s.forEach(([id, pl, st, ds]) => { const v = vehById(id); v.plate = pl; v.status = st; v.days = ds; });
  else DATA.requests = s;
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
  // 같은 칸을 여러 번 고쳤으면 "처음 값 → 마지막 값" 한 건으로 합칩니다
  const merged = new Map();
  PENDING.filter(p => tabOf(p.key) === t).forEach(p => { const e = merged.get(p.key); if (e) e.to = p.to; else merged.set(p.key, { ...p }); });
  // 서버에 저장 요청 (js/api.js). 성공했을 때만 아래(기록 남기기·화면 확정)를 실행하고, 실패하면 알리고 그대로 둡니다
  if (!Api.save(t, [...merged.values()], {})) return toast("저장하지 못했습니다. 잠시 후 다시 시도해 주세요.", true);
  let n = 0;
  merged.forEach((p, key) => {
    if (String(p.from ?? "") !== String(p.to ?? "")) {
      logAdd({ kind: "수정", tab: TAB_NAME[t], key, target: describeKey(key), from: p.from, to: p.to }); n++;
    }
  });
  dropPending(t); takeSnap(t); refresh();
  toast(n ? `저장했습니다 (${n}건)` : "저장했습니다");
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
  // 세로(행) = 피지원 기관: 50곳이 넘을 수 있어 아래로 늘어나게. 가로(열) = 출발 기관 5곳(서울경기·충북·전북·대구경북·지역본부)
  const dests = Object.keys(DATA.requests), moves = movesOn(state.date), src = DATA.sourceOrgs;
  const cell = (org, d) => {
    const l = moves.filter(m => m.v.org === org && m.stops.includes(d));
    return { n: l.length, t: l.filter(m => m.v.type === "제설차").length, b: l.filter(m => m.v.type === "제설기").length };
  };
  const td = c => c.n ? `<td>${c.n}<span class="sub">차 ${c.t} · 기 ${c.b}</span></td>` : `<td class="zero">0</td>`;
  let h = `<thead><tr><th class="l" scope="col">피지원 기관</th>${src.map(o => `<th scope="col">${esc(o)}${o === "지역본부" ? '<span class="sub">연동 예정</span>' : ""}</th>`).join("")}<th scope="col">합계</th></tr></thead><tbody>`;
  dests.forEach(d => {
    const n = moves.filter(m => m.stops.includes(d)).length;
    h += `<tr${n ? "" : ' class="none"'}><th scope="row">${esc(d)}<span class="sub">${esc(hqOf(d) || "")}</span></th>${src.map(o => td(cell(o, d))).join("")}<td><strong>${n}</strong></td></tr>`;
  });
  h += `</tbody><tfoot><tr><th scope="row">합계</th>${src.map(o => `<td>${moves.filter(m => m.v.org === o).length}</td>`).join("")}<td>${moves.length}</td></tr></tfoot>`;   // 출발 기관 합계: 여러 기관을 들러도 장비 1대로 셈
  document.getElementById("matrix").innerHTML = h;
  const tr = moves.filter(m => m.v.type === "제설차").length, bl = moves.filter(m => m.v.type === "제설기").length;
  const multi = moves.some(m => m.stops.length > 1);
  document.getElementById("summaryNote").textContent = `${fmtMD(state.date)} · 제설차 ${tr}대, 제설기 ${bl}대, 이동정비차 ${moves.length - tr - bl}대 (차 = 제설차, 기 = 제설기)` +
    (multi ? " · 하루에 여러 기관을 들르는 장비는 각 기관에 모두 표시되고, 합계는 장비 1대로 셉니다" : "");
}
function renderFilters() {
  const f = document.getElementById("filters");
  f.className = "filters split";
  f.innerHTML = `<div class="fgroup" role="group" aria-label="출발 기관"><span class="flabel">출발 기관</span>` +
    ["전체", ...DATA.sourceOrgs].map(o => `<button type="button" class="chip" data-org="${esc(o)}" aria-pressed="${state.org === o}">${o === "전체" ? "모든 기관" : esc(o)}</button>`).join("") + `</div>` +
    `<div class="fgroup right" role="group" aria-label="장비 종류"><span class="flabel">장비</span>` +
    ["전체", ...TYPES].map(t => `<button type="button" class="chip" data-type="${esc(t)}" aria-pressed="${state.type === t}">${t === "전체" ? "모든 장비" : esc(t)}</button>`).join("") + `</div>`;
  f.querySelectorAll("[data-org]").forEach(b => b.onclick = () => { state.org = b.dataset.org; renderFilters(); renderDest(); });
  f.querySelectorAll("[data-type]").forEach(b => b.onclick = () => { state.type = b.dataset.type; renderFilters(); renderDest(); });
}
const matches = v => (state.org === "전체" || v.org === state.org) && (state.type === "전체" || v.type === state.type);
function vehicleRow(v, stops = []) {
  const [cls, label] = STATUS[v.status], k = (v.days || []).findIndex(([d]) => d === state.date), n = (v.days || []).filter(([, xs]) => xs.some(Boolean)).length;
  const dayTag = k >= 0 && n > 1 ? `<span class="tag day" title="지원일 1 = ${esc(fmtMD(v.days[0][0]))}부터 연속">${k + 1}일차 / ${n}일</span>` : "";
  return `<button type="button" class="vrow" data-vid="${esc(v.id)}">
    <span class="plate">${esc(v.plate)}</span><span class="vtype">${esc(v.type)}</span>
    <span class="vfrom">${esc(v.org)}</span>
    <span class="status-wrap">${dayTag}<span class="status ${cls}">${label}</span>${stops.length > 1 ? `<span class="tag" title="${esc(stops.join(" → "))}">${stops.length}곳 경유</span>` : ""}</span></button>`;
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
  el.querySelectorAll(".vrow").forEach(b => b.onclick = () => openSheet(b.dataset.vid));
}

/* ============================================================
   [5] 기관별 장비 (관리자·지원장비 수정)
   ============================================================ */
function renderFleet() {
  banner("perm-fleet", canVeh(),
    isAdmin() ? "차량번호·지원 여부·지원일 1(관리자만)·지원일별 기관(하루 여러 기관은 ＋)을 수정한 뒤 아래 [저장]을 눌러야 확정됩니다. 지원일 2부터는 지원일 1 다음 날부터 자동으로 이어집니다."
              : "차량번호·지원 여부·지원일별 기관(하루 여러 기관은 ＋)을 수정한 뒤 아래 [저장]을 눌러야 확정됩니다. 지원일 1은 관리자가 정하고, 지원일 2부터는 자동으로 이어집니다.",
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
    const kS = `veh:${v.id}:status`, kP = `veh:${v.id}:plate`, [cls, label] = STATUS[v.status];
    const statusCell = edit
      ? `<select class="ci" data-edit="${esc(kS)}" data-type="text" aria-label="${esc(v.plate)} 지원 여부"${hvA(kS, false)}>${["", "O", "X"].map(s => `<option value="${s}" ${v.status === s ? "selected" : ""}>${STATUS[s][1]}</option>`).join("")}</select>`
      : H(kS, `<span class="status ${cls}">${label}</span>`);
    const plateCell = edit
      ? `<input class="ci plate-in" type="text" maxlength="12" data-edit="${esc(kP)}" data-type="plate" value="${esc(v.plate)}" aria-label="차량번호"${hvA(kP, false)}>`
      : H(kP, `<span class="plate">${esc(v.plate)}</span>`);
    return `<tr><td>${plateCell}</td><td>${esc(v.type)}</td><td>${esc(v.org)}</td><td>${statusCell}</td>
      ${Array.from({ length: cols }, (_, i) => `<td>${slotCell(v, i, edit, dests)}</td>`).join("")}</tr>`;
  }).join("");
  document.getElementById("eqTable").innerHTML = `<thead><tr><th>차량번호</th><th>장비</th><th>기관</th><th>지원 여부</th>${Array.from({ length: cols }, (_, i) => `<th>지원일 ${i + 1}</th>`).join("")}</tr></thead><tbody>${rows}</tbody>`;
}

/* ---------- 지원 일자별 지원 기관: 가로로 '지원일 1, 2, 3 …' 칸 ----------
   지원일 1 날짜만 관리자가 고르고, 지원일 2부터는 하루씩 자동으로 이어집니다. 날마다 들르는 기관은 관리자·지원장비가 고릅니다(하루 여러 기관은 ＋).
   v.days = [[날짜, [기관…]], …] — 날짜는 항상 지원일 1부터 하루씩 연속. 이동 현황은 이 날짜·기관으로 그 날 이동하는 장비를 셉니다. */
Object.assign(state, { dayCols: 4, date: todayISO(), extraStop: new Set() });
const usedMax = () => Math.max(0, ...DATA.vehicles.map(v => { const d = v.days || []; let n = d.length; while (n > 0 && !d[n - 1][1].some(Boolean)) n--; return n; }));   // 기관이 들어 있는 마지막 지원일
const dayCols = () => Math.min(10, Math.max(2, state.dayCols));
function colsCtl() {
  if (!canVeh()) return "";
  const c = dayCols();
  return `<label class="cols-ctl">지원일 칸 수
    <select class="ci" id="colsSel">${Array.from({ length: 9 }, (_, k) => k + 2).map(n => `<option value="${n}" ${n === c ? "selected" : ""}>${n}개</option>`).join("")}</select></label>`;
}
function slotCell(v, i, edit, dests) {
  const e = (v.days || [])[i], day1 = v.days && v.days[0] ? v.days[0][0] : "", key = `veh:${v.id}:days`, vid = esc(v.id);
  const date = day1 ? addDays(day1, i) : "";
  if (!edit) return e && e[1].some(Boolean) ? H(key, `<div class="sl-d">${esc(fmtMD(e[0]))}</div>${e[1].map(x => `<div class="sl-x">${x ? esc(x) : "기관 미정"}</div>`).join("")}`)
                                            : (date ? `<div class="sl-d muted">${esc(fmtMD(date))}</div>` : `<span class="muted">-</span>`);
  const off = v.status !== "O";
  const sel = (cur, j, extra) => `<select class="ci" data-sx="${vid}" data-i="${i}" ${extra ? 'data-extra="1"' : ""} data-fk="${extra ? "sxn:" + vid + "|" + i : `sx:${vid}:${i}:${j}`}" ${off || !day1 ? "disabled" : ""} aria-label="${esc(v.plate)} 지원일 ${i + 1} 지원 기관 ${j + 1}"${hvA(key, false)}>
      <option value="">기관 선택</option>${dests.map(d => `<option value="${esc(d)}" ${cur === d ? "selected" : ""}>${esc(d)}</option>`).join("")}${cur && !dests.includes(cur) ? `<option value="${esc(cur)}" selected>${esc(cur)}</option>` : ""}<option value="__del">지우기</option></select>`;
  const stops = e ? e[1] : [""], extra = state.extraStop.has(`${v.id}|${i}`);
  const plus = day1 ? `<button type="button" class="btn sm" data-stop-add="${vid}|${i}" ${off ? "disabled" : ""} aria-label="${esc(v.plate)} 지원일 ${i + 1}에 들르는 기관 추가" title="이 날 들르는 기관 추가">＋</button>` : "";
  const dateEl = i === 0
    ? (isAdmin() ? `<input class="ci" type="date" data-sd="${vid}" data-fk="sd:${vid}" value="${esc(day1)}" ${off ? "disabled" : ""} aria-label="${esc(v.plate)} 지원일 1 날짜"${hvA(key, false)}>`
                 : `<div class="sl-d auto" title="지원일 1은 관리자가 정합니다">${day1 ? esc(fmtMD(day1)) : "관리자 지정 전"}</div>`)
    : `<div class="sl-d auto" title="지원일 1 다음 날부터 자동">${date ? esc(fmtMD(date)) : "-"}</div>`;
  return `<div class="slot">${dateEl}
    ${stops.map((x, j) => `<div class="slot-x">${sel(x, j, false)}${j === stops.length - 1 && !extra ? plus : ""}</div>`).join("")}
    ${extra ? `<div class="slot-x">${sel("", stops.length, true)}</div>` : ""}</div>`;
}
// 지원일 칸의 입력을 모아 days 로: 날짜는 지원일 1부터 하루씩, 끝쪽의 기관 없는 날은 지움
function buildDays(vid, day1Override) {
  const v = vehById(vid), day1 = day1Override !== undefined ? day1Override : (v.days && v.days[0] ? v.days[0][0] : "");
  if (!day1) return [];
  const xs = [...document.querySelectorAll("select[data-sx]")].filter(q => q.dataset.sx === vid);
  const n = Math.max(dayCols(), (v.days || []).length), out = [];
  for (let i = 0; i < n; i++) {
    const mine = xs.filter(q => +q.dataset.i === i);
    let stops = mine.length ? [...new Set(mine.filter(q => q.value !== "__del").map(q => q.value).filter(Boolean))] : ((v.days || [])[i] ? v.days[i][1].filter(Boolean) : []);
    out.push([addDays(day1, i), stops.length ? stops : [""]]);
  }
  while (out.length > 1 && !out[out.length - 1][1].some(Boolean)) out.pop();      // 끝쪽 빈 날은 지움(지원일 1은 남김)
  return out;
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
   [7-2] 로그 기록 (관리자만 그리기)
   ============================================================ */
Object.assign(state, { logUser: "전체", logKind: "전체", logToday: false });
function renderLog() {
  const box = document.getElementById("logTable");
  if (!isAdmin()) { box.innerHTML = ""; document.getElementById("logFilters").innerHTML = ""; return; }  // 관리자가 아니면 내용을 그리지 않음
  const pm = document.getElementById("perm-log");
  pm.className = "perm can";
  pm.textContent = "관리자만 볼 수 있습니다. 로그는 화면에서 고치거나 지울 수 없습니다. 실제 운영에서는 서버가 IP와 함께 기록하고 1년 이상 보관하세요. (이 시연 화면에서 새로 생긴 기록의 IP는 서버가 없어 '-'로 표시됩니다.)";
  const kinds = ["전체", "접속", "수정"];
  const users = [...new Set(LOG.map(l => l.by))];
  const f = document.getElementById("logFilters");
  f.innerHTML = kinds.map(k => `<button type="button" class="chip" data-lk="${k}" aria-pressed="${state.logKind === k}">${k === "전체" ? "모든 구분" : k}</button>`).join("") +
    `<select class="ci" id="logUser" aria-label="아이디로 거르기"><option value="전체">모든 아이디</option>${users.map(u => `<option ${state.logUser === u ? "selected" : ""}>${esc(u)}</option>`).join("")}</select>` +
    `<button type="button" class="chip" id="logToday" aria-pressed="${state.logToday}">오늘만</button>`;
  f.querySelectorAll("[data-lk]").forEach(b => b.onclick = () => { state.logKind = b.dataset.lk; renderLog(); });
  document.getElementById("logUser").onchange = e => { state.logUser = e.target.value; renderLog(); };
  document.getElementById("logToday").onclick = () => { state.logToday = !state.logToday; renderLog(); };
  const badge = k => `<span class="status ${k === "접속" ? "wait" : "go"}">${esc(k)}</span>`;
  const rows = LOG.filter(l => (state.logKind === "전체" || l.kind === state.logKind) && (state.logUser === "전체" || l.by === state.logUser) && (!state.logToday || sameDay(l.at)))
    .slice().reverse().slice(0, 300).map(l => `<tr>
      <td class="t">${esc(fmtShort(l.at))}</td><td>${esc(l.by)}</td><td>${badge(l.kind)}</td><td>${esc(l.tab || "-")}</td>
      <td>${esc(l.target || (l.key ? describeKeyLog(l.key) : "-"))}</td>
      <td>${l.kind === "수정" ? `${esc(showVal(l.key, l.from))} → ${esc(showVal(l.key, l.to))}` : "접속"}</td>
      <td class="ip">${esc(l.ip)}</td></tr>`).join("");
  box.innerHTML = `<thead><tr><th>일시</th><th>아이디</th><th>구분</th><th>탭</th><th>대상</th><th>내용</th><th>IP</th></tr></thead><tbody>${rows || `<tr><td colspan="7" class="muted" style="text-align:center;padding:28px">조건에 맞는 기록이 없습니다.</td></tr>`}</tbody>`;
}
const describeKeyLog = describeKey;

/* ============================================================
   [8] 장비 상세 시트
   ============================================================ */
const sheet = document.getElementById("sheet"), backdrop = document.getElementById("backdrop");
let lastFocus = null, curPlate = null;
function openSheet(vid) {
  const v = vehById(vid); if (!v) return;
  curPlate = vid;
  const cur = (v.days || []).find(([d]) => d === state.date), curStops = cur ? cur[1].filter(Boolean) : [], [cls, label] = STATUS[v.status];
  sheet.innerHTML = `<button type="button" class="sheet-close" id="sheetClose">닫기</button>
    <span class="plate" style="font-size:18px">${esc(v.plate)}</span>
    <h2 id="sheetTitle">${esc(v.org)} ${esc(v.type)}</h2>
    ${H(`veh:${v.id}:status`, `<span class="status ${cls}">${label}</span>`)}
    <section><h3>이동</h3><dl class="kv"><dt>출발</dt><dd>${esc(v.org)} 기계화부</dd>
      <dt>지원 일자</dt><dd>${v.days && v.days.length ? H(`veh:${v.id}:days`, v.days.map(([d, xs], k) => `${k + 1}일차 ${esc(fmtMD(d))} → ${esc(xs.map(x => x || "기관 미정").join(" → "))}`).join("<br>")) : "-"}</dd>
      <dt>도착 요청</dt><dd>${curStops.length ? curStops.map(x => DATA.requests[x] ? `${esc(x)} ${H(`req:${x}:arrive`, fmtTime(DATA.requests[x].arrive))}` : esc(x)).join("<br>") : "-"}</dd></dl></section>`;
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
  if (e.target.id === "colsSel") {           // 칸 수: 2~10개. 기관이 들어 있는 지원일보다 줄이면 그 뒤 지원일의 기관을 지울지 묻고 지움(저장 전까지는 되돌리기 가능)
    const n = +e.target.value, cut = DATA.vehicles.filter(v => (v.days || []).slice(n).some(([, xs]) => xs.some(Boolean)));
    if (cut.length && !confirm(`${cut.length}대 장비의 지원일 ${n + 1} 이후 기관이 지워집니다. 줄일까요?\n(저장하기 전에는 [되돌리기]로 돌아갈 수 있습니다)`)) { e.target.value = dayCols(); return; }
    state.dayCols = n;
    cut.forEach(v => { const d = v.days.slice(0, n); while (d.length > 1 && !d[d.length - 1][1].some(Boolean)) d.pop(); commitRaw(`veh:${v.id}:days`, d); });
    refresh(); return;
  }
  const sl = e.target.closest("[data-sd], [data-sx]");
  if (sl) {   // 지원일 칸: 지원일 1 날짜(관리자) 또는 날별 기관을 바꾸면, 그 장비의 days 를 새로 만듦
    const vid = sl.dataset.sd ?? sl.dataset.sx, key = `veh:${vid}:days`;
    if (sl.dataset.sd !== undefined && !isAdmin()) { renderFleet(); return; }       // 지원일 1은 관리자만
    const days = buildDays(vid, sl.dataset.sd !== undefined ? sl.value : undefined);
    [...state.extraStop].filter(k => k.startsWith(vid + "|")).forEach(k => state.extraStop.delete(k));
    const same = JSON.stringify(getVal(key)) === JSON.stringify(days);
    commit(key, days);
    if (same) renderFleet();
    return;
  }
  const pe = e.target.closest('[data-type="plate"]');
  if (pe) {                                   // 차량번호: 형식(예: 12가3456)과 중복 검사
    const val = pe.value.replace(/\s/g, ""), vid = pe.dataset.edit.split(":")[1];
    if (!/^\d{2,3}[가-힣]\d{4}$/.test(val)) { toast("차량번호 형식이 올바르지 않습니다 (예: 12가3456)", true); renderFleet(); return; }
    if (DATA.vehicles.some(v => v.id !== vid && v.plate === val)) { toast("같은 차량번호가 이미 있습니다", true); renderFleet(); return; }
    commit(pe.dataset.edit, val); return;
  }
  const el = e.target.closest("[data-edit]"); if (!el) return;
  const t = el.dataset.type; let v;
  if (t === "bool") v = el.checked;
  else if (t === "int") v = el.value === "" ? 0 : Math.max(0, Math.min(999, Math.floor(+el.value) || 0));
  else if (t === "num") v = el.value === "" ? null : Math.max(0, Math.min(999, +el.value || 0));
  else v = el.value.trim();
  commit(el.dataset.edit, v);
  if (isAdmin() && hasHist(el.dataset.edit) && !el.dataset.hv) el.dataset.hv = el.dataset.edit;
});
document.addEventListener("click", e => {
  const sa = e.target.closest("[data-stop-add]");
  if (sa && canVeh()) {
    state.extraStop.add(sa.dataset.stopAdd); renderFleet();          // 값: "장비id|지원일 칸 번호"
    const n = [...document.querySelectorAll("[data-fk]")].find(i => i.dataset.fk === "sxn:" + sa.dataset.stopAdd); if (n) n.focus();
  }
  const sv = e.target.closest("[data-save]");
  if (sv) saveTab(sv.dataset.save);
  const rt = e.target.closest("[data-revert]");
  if (rt && confirm("저장하지 않은 변경을 모두 취소할까요?")) { restore(rt.dataset.revert); refresh(); }
});
function refresh() {
  hideTip();
  banner("perm-move", false, "", "위에서 고른 날짜(‹ ›)에 이동하는 장비를 보여줍니다. 모든 탭의 현황을 볼 수 있고, 수정은 아이디 역할에 따라 각 탭에서 할 수 있습니다.");
  renderMatrix(); renderFilters(); renderDest(); renderFleet(); renderBranch(); renderLog(); updateSavebars();
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
// 화면 모드: [라이트 모드] [다크 모드] 두 칸 버튼. 고른 모드는 이 브라우저에 기억
const THEME_KEY = "eq_theme";
function curTheme() { const r = document.documentElement.dataset.theme; return r || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"); }
function paintThemeBtns() { document.querySelectorAll("[data-theme-set]").forEach(b => b.setAttribute("aria-pressed", b.dataset.themeSet === curTheme())); }
function setTheme(t) { document.documentElement.dataset.theme = t; try { localStorage.setItem(THEME_KEY, t); } catch (e) {} paintThemeBtns(); }
try { const t = localStorage.getItem(THEME_KEY); if (t === "light" || t === "dark") document.documentElement.dataset.theme = t; } catch (e) {}
document.querySelectorAll("[data-theme-set]").forEach(b => b.onclick = () => setTheme(b.dataset.themeSet));
paintThemeBtns();
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
