/* ============================================================
   api.js — 서버와 주고받는 곳 (화면 코드 app.js 는 이 함수들만 부릅니다)
   - 기본: Supabase 서버. 로그인 정보는 auth/auth.js(SSAuth)가 보관·갱신합니다.
   - 주소에 ?sample=1 이 있으면: 서버 대신 sample-data.js 의 샘플로 움직입니다(시연·자동 시험용, 저장은 이 화면 안에만).
   - 권한 검사는 서버(DB 규칙)가 다시 합니다. 화면의 검사는 보기 좋게 정리하는 용도입니다.
   - 저장은 "바뀐 칸만" 보내고, 한 번의 [확정]/[저장]은 서버 함수 하나로 "전부 되거나 전부 안 되게" 처리합니다.
     · 기관별 장비 [확정] → save_fleet(장비 도공번호·지원 여부, (날짜, 장비)별 경로 — 경로는 관리자)
     · 지사별 요청·편성 [저장] → save_requests(기준일자, 지사별 바뀐 열)
     · 대설 특보 → warning_status(서버가 5분마다 기상청에서 받은 것) / 특보구역 관리(관리자) → branch_zone_list + branch_zone_overrides
   - 모든 함수는 Promise 를 돌려줍니다. 실패하면 { ok:false, message } 입니다.
   ============================================================ */
const Api = (() => {
  const SAMPLE = new URLSearchParams(location.search).has("sample");
  const ERR = { "42501": "권한이 없습니다(다른 기관·지사 자료이거나 권한이 바뀌었습니다).", "23505": "이미 있는 값입니다(도공번호·기준일자 중복).",
    "23514": "값의 형식이 올바르지 않습니다.", "23503": "없는 지사·장비·기준일자입니다.", "22023": "저장할 내용이 없습니다.", "54000": "한 번에 너무 많이 저장하려고 합니다.",
    "55000": "확정한 지사는 확정을 취소한 뒤에 고칠 수 있습니다.",
    // 기계화부(지원장비 계정)가 지원일 1의 지사를 고를 때(마이그레이션 43)
    "SA001": "관리자가 이 기관에 배정하지 않은 지사입니다. 기관별 배정을 확인해 주세요.", "SA002": "배정받은 대수보다 많은 장비를 같은 지사로 보낼 수 없습니다.",
    "SA003": "지원일 1의 피지원 지사 한 곳만 고를 수 있습니다(둘째 날부터·하루 여러 곳·수정본·관리자가 정한 경로는 관리자가 고칩니다)." };
  // over = 이 요청에서만 쓰는 오류 설명(예: { "23503": "…" }) — 같은 오류 번호라도 상황마다 뜻이 달라서
  const fail = (r, fallback, over) => { const c = r && r.json && r.json.code; return { ok: false, message: (over && over[c]) || ERR[c] || fallback || "저장하지 못했습니다. 잠시 후 다시 시도해 주세요.", code: c }; };
  // 저장 함수(save_fleet)의 23514 = 다른 기준일자가 맡은 날짜이거나, 그날 지원 가능이 아닌 장비의 경로(마이그레이션 38)
  const FLEET_ERR = { "23514": "다른 기준일자가 맡은 날짜이거나, 그날 지원 가능이 아닌 장비의 경로입니다. 새로고침(F5) 후 다시 확인해 주세요.", "22023": "저장할 내용이 없거나 기준일자가 없습니다." };
  const ROUND_ERR = { "23514": "새 기준일자는 마지막 기준일자보다 뒤 날짜여야 하고, 기준일자는 마지막 것이면서 그 기간에 경로가 없을 때만 지울 수 있습니다." };
  const ALLOC_ERR = { "23514": "편성이 확정된 지사에만 배정할 수 있습니다.", "23503": "없는 기관·지사·기준일자입니다." };
  const VDEL_ERR = { "23503": "경로 기록이 있는 장비는 지울 수 없습니다. [숨기기]를 쓰세요." };
  const NET = () => ({ ok: false, message: (window.SSAuth && SSAuth.NET_MSG) || "서버에 연결할 수 없습니다." });
  const EQUIP_TABS = "vehicles,vehicle_routes,round_vehicle_status,round_requests,round_allocations,support_rounds,branch_zone_overrides";

  /* ---------- 서버(Supabase) ---------- */
  const server = {
    load() {
      const R = SSAuth.rest;
      return Promise.all([SSAuth.restore(), R("hqs?select=id,name,sort,is_private&order=sort"), R("branches?select=id,name,hq_id,status&order=id"),
        R("vehicles?select=id,org,type,plate,status,sort,active,blower_s,blower_l,hidden_after&order=sort,id"), R("support_rounds?select=id,name,start_date,days&order=start_date.desc"), R("equip_orgs?select=name")])
        .then(([me, h, b, v, s, o]) => {
          if (!me.ok) return { ok: false, message: me.message || "로그인이 필요합니다.", login: true };
          if (![h, b, v, s].every(r => r.ok)) return { ok: false, message: "자료를 불러오지 못했습니다." };
          return { ok: true, me: me.me, hqs: h.json, branches: b.json.filter(x => x.status !== "closed"), vehicles: v.json, rounds: s.json, orgs: (o.json || []).map(x => x.name), holdings: null };
        }).catch(NET);
    },
    routes(from, to) {
      return SSAuth.rest(`vehicle_routes?select=date,vehicle_id,stops,revised,times,confirmed_at&date=gte.${from}&date=lte.${to}&order=date`).then(r => r.ok ? { ok: true, rows: r.json } : fail(r, "경로를 불러오지 못했습니다.")).catch(NET);
    },
    statuses(ids) {      // 기준일자별 지원 여부(마이그레이션 38). 서버는 한 번에 1,000줄까지라 기준일자마다 따로 읽음
      return Promise.all(ids.map(id => SSAuth.rest(`round_vehicle_status?select=round_id,vehicle_id,status,off_from,updated_at&round_id=eq.${+id}`)))
        .then(rs => rs.every(r => r.ok) ? { ok: true, rows: rs.flatMap(r => r.json) } : fail(rs.find(r => !r.ok), "지원 여부를 불러오지 못했습니다.")).catch(NET);
    },
    vehicleHistory(vid) {
      return SSAuth.rest(`vehicle_routes?select=date,vehicle_id,stops,revised,times&vehicle_id=eq.${encodeURIComponent(vid)}&order=date.desc&limit=400`).then(r => r.ok ? { ok: true, rows: r.json } : fail(r)).catch(NET);
    },
    requests(round) {
      return SSAuth.rest(`round_requests?select=round_id,branch_id,req_truck,req_blower,assigned_truck,assigned_blower,arrive_at,reason,confirmed,warn_level,warn_zones,warn_base,warn_at,warn_note,fc_snow,fc_pcp,fc_pop,fc_tmin,fc_tmin_at,fc_tmfc,fc_at,wx_manual,wx_snow,wx_pcp,wx_tmin,wx_tmin_at,wx_level,wx_fc,wx_ef&round_id=eq.${+round}`)
        .then(r => r.ok ? { ok: true, rows: r.json } : fail(r, "요청을 불러오지 못했습니다.")).catch(NET);
    },
    allocations(round) {     // 기관별 배정(기준일자, 기관, 지사) → 제설차·제설기 대수
      return SSAuth.rest(`round_allocations?select=round_id,org,branch_id,truck,blower&round_id=eq.${+round}`).then(r => r.ok ? { ok: true, rows: r.json } : fail(r, "기관별 배정을 불러오지 못했습니다.")).catch(NET);
    },
    saveAllocations(round, rows) {
      return SSAuth.authed("/rest/v1/rpc/save_allocations", { method: "POST", body: { p_round: round, p_rows: rows } }).then(r => r.ok ? { ok: true, result: r.json } : fail(r, null, ALLOC_ERR)).catch(NET);
    },
    warnings() {
      return SSAuth.authed("/rest/v1/rpc/warning_status", { method: "POST", body: {} }).then(r => r.ok ? { ok: true, status: r.json } : fail(r, "특보를 불러오지 못했습니다.")).catch(NET);
    },
    forecast() {         // 지사별 예상 적설(59줄)
      return SSAuth.rest("branch_forecast?select=branch_id,issued_at,max_snow_24h,max_pcp_24h,max_pop_24h,min_tmp,min_tmp_at,worst_nx,worst_ny,detail").then(r => r.ok ? { ok: true, rows: r.json } : fail(r, "예상 적설을 불러오지 못했습니다.")).catch(NET);
    },
    zoneData() {
      return Promise.all([SSAuth.authed("/rest/v1/rpc/branch_zone_list", { method: "POST", body: {} }), SSAuth.rest("branch_zone_overrides?select=branch_id,zone_code,include"),
        SSAuth.rest("warning_zones?select=zone_code,name,sp,up_code&zone_code=like.L*&order=zone_code"), SSAuth.authed("/rest/v1/rpc/warning_active_list", { method: "POST", body: {} })])
        .then(([a, o, z, w]) => a.ok && o.ok && z.ok ? { ok: true, list: a.json || {}, overrides: o.json, zones: z.json, active: w.ok ? w.json : null } : fail(!a.ok ? a : !o.ok ? o : z, "특보구역을 불러오지 못했습니다.")).catch(NET);
    },
    setZone(branch, zone, include) {       // include null = 손댄 것을 지움(자동대로)
      const q = `branch_zone_overrides?branch_id=eq.${encodeURIComponent(branch)}&zone_code=eq.${encodeURIComponent(zone)}`;
      const p = include === null ? SSAuth.authed("/rest/v1/" + q, { method: "DELETE", headers: { Prefer: "return=representation" } })
        : SSAuth.authed("/rest/v1/branch_zone_overrides?on_conflict=branch_id,zone_code", { method: "POST", body: { branch_id: branch, zone_code: zone, include }, headers: { Prefer: "resolution=merge-duplicates,return=representation" } });
      return p.then(r => r.ok ? { ok: true } : fail(r, "특보구역을 바꾸지 못했습니다(관리자만).")).catch(NET);
    },
    audit() {         // 장비 지원 관련 수정 기록(최근 300건). log.view 권한이 없으면 서버가 0건을 돌려줌
      return SSAuth.rest(`audit_log?select=id,at,username,kind,tab,target,from_val,to_val,ip&tab=in.(${EQUIP_TABS})&order=id.desc&limit=300`)
        .then(r => ({ ok: r.ok, rows: r.ok ? r.json.slice().reverse() : [] })).catch(() => ({ ok: false, rows: [] }));
    },
    saveFleet(vehicles, routes, round, status) {
      return SSAuth.authed("/rest/v1/rpc/save_fleet", { method: "POST", body: { p_vehicles: vehicles, p_routes: routes, p_round: round, p_status: status } }).then(r => r.ok ? { ok: true, result: r.json } : fail(r, null, FLEET_ERR)).catch(NET);
    },
    saveRequests(round, rows) {
      return SSAuth.authed("/rest/v1/rpc/save_requests", { method: "POST", body: { p_round: round, p_rows: rows } }).then(r => r.ok ? { ok: true, result: r.json } : fail(r)).catch(NET);
    },
    createRound(date) {          // 서버 함수가 기준일자를 만들고 전체 장비 지원 여부를 이전 기준일자에서 이어받음(마이그레이션 38)
      return SSAuth.authed("/rest/v1/rpc/create_round", { method: "POST", body: { p_date: date } })
        .then(r => r.ok && r.json && r.json.id ? { ok: true, round: { id: r.json.id, name: r.json.name, start_date: r.json.start_date, days: r.json.days } } : fail(r, "기준일자를 만들지 못했습니다.", ROUND_ERR)).catch(NET);
    },
    deleteRound(id) {           // 그 기준일자의 지사 요청은 DB 가 함께 지움(외래키 cascade, 지운 줄은 수정 기록에 남음)
      return SSAuth.authed(`/rest/v1/support_rounds?id=eq.${+id}&select=id`, { method: "DELETE", headers: { Prefer: "return=representation" } })
        .then(r => r.ok && r.json && r.json.length ? { ok: true } : fail(r, "기준일자를 지우지 못했습니다(권한이 없을 수 있습니다).", ROUND_ERR)).catch(NET);
    },
    addVehicle(v) {
      return SSAuth.authed("/rest/v1/vehicles?select=id,org,type,plate,status,sort,active,blower_s,blower_l,hidden_after", { method: "POST", body: v, headers: { Prefer: "return=representation" } })
        .then(r => r.ok && r.json && r.json[0] ? { ok: true, vehicle: r.json[0] } : fail(r, "장비를 추가하지 못했습니다.")).catch(NET);
    },
    deleteVehicle(id) {
      return SSAuth.authed(`/rest/v1/vehicles?id=eq.${encodeURIComponent(id)}&select=id`, { method: "DELETE", headers: { Prefer: "return=representation" } })
        .then(r => r.ok && r.json && r.json.length ? { ok: true } : fail(r, "장비를 지우지 못했습니다(권한이 없을 수 있습니다).", VDEL_ERR)).catch(NET);
    },
    hideVehicle(id, after) {    // 숨기기(after = 이 날짜보다 늦게 시작하는 기준일자부터 안 보임) / 숨김 취소(after = null). 관리자만
      return SSAuth.authed(`/rest/v1/vehicles?id=eq.${encodeURIComponent(id)}&select=id,hidden_after`, { method: "PATCH", body: { hidden_after: after }, headers: { Prefer: "return=representation" } })
        .then(r => r.ok && r.json && r.json.length ? { ok: true } : fail(r, "숨기기를 바꾸지 못했습니다(관리자만).")).catch(NET);
    }
  };

  /* ---------- 샘플(브라우저 안에서만) — 서버와 같은 권한 규칙을 흉내 ---------- */
  const sample = (() => {
    let db = null, actor = null;
    const clone = x => JSON.parse(JSON.stringify(x));
    const can = p => !!actor && (actor.role === "admin" || (actor.perms || []).includes(p));
    const vehOk = vid => { const v = db.vehicles.find(x => x.id === vid); return v && (can("equip.edit.all") || (can("equip.edit.own") && v.org === actor.org)); };
    const log = (kind, tab, target, from_val, to_val) => db.audit.push({ at: new Date().toISOString(), username: actor.username || actor.label, ip: "-", kind, tab, target, from_val, to_val });
    const done = x => Promise.resolve(x);
    // 서버 규칙 흉내(마이그레이션 38): 날짜를 맡은 기준일자 = 그 날짜를 기간 안에 둔 기준일자 중 시작일이 가장 늦은 것
    const addD = (iso, n) => { const [y, m, d] = iso.split("-").map(Number); const t = new Date(y, m - 1, d + n); return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`; };
    const gov = d => db.rounds.filter(r => r.start_date <= d && d <= addD(r.start_date, (r.days || 4) - 1)).sort((a, b) => b.start_date.localeCompare(a.start_date))[0] || null;
    const stRow = (rid, vid) => db.status.find(x => x.round_id === rid && x.vehicle_id === vid);
    const avail = (vid, d) => { const r = gov(d), x = r && stRow(r.id, vid); return !!x && x.status === "O" && (!x.off_from || d < x.off_from); };
    // 샘플 대설 특보: 서버 warning_status 와 같은 모양(지사 구역 중 가장 높은 단계)
    const RANK = { "예비": 1, "주의": 2, "경보": 3 };
    const zname = c => (db.zones.find(z => z.zone_code === c) || {}).name || c;
    function zonesOf(b) { return [...(db.zoneAuto[b] || []).filter(z => !db.zoneOver.some(o => o.branch_id === b && o.zone_code === z)), ...db.zoneOver.filter(o => o.branch_id === b && o.include).map(o => o.zone_code)]; }
    function warnStatus() {
      const branches = {};
      db.branches.forEach(b => {
        const zs = zonesOf(b.id).filter(z => db.warnActive[z] && !db.warnActive[z].includes(":")).map(z => { const lv = db.warnActive[z]; return [z, zname(z), lv, "대설", db.warnFc, lv === "예비" ? db.warnEfPre : db.warnEf]; })
          .sort((x, y) => RANK[y[2]] - RANK[x[2]] || x[1].localeCompare(y[1]));      // 지사별은 대설만(서버와 같음)
        if (zs.length) branches[b.id] = { level: zs[0][2], kind: "대설", zones: zs };
      });
      return { ok: true, paused: false, all: false, base: db.warnBase, fetched_at: new Date().toISOString(), branches, note: null };
    }
    return {
      setActor(a) { actor = a; },
      load(today) {
        db = makeSample(today);
        return done({ ok: true, me: null, hqs: clone(db.hqs), branches: clone(db.branches), vehicles: clone(db.vehicles), rounds: clone(db.rounds), orgs: db.orgs.slice(), holdings: clone(db.holdings) });
      },
      statuses(ids) { return done({ ok: true, rows: clone(db.status.filter(x => ids.includes(x.round_id))) }); },
      routes(from, to) { return done({ ok: true, rows: clone(db.routes.filter(r => r.date >= from && r.date <= to)) }); },
      vehicleHistory(vid) { return done({ ok: true, rows: clone(db.routes.filter(r => r.vehicle_id === vid).sort((a, b) => b.date.localeCompare(a.date))) }); },
      requests(round) { return done({ ok: true, rows: clone(db.requests.filter(r => r.round_id === +round)) }); },
      allocations(round) { return done({ ok: true, rows: clone(db.allocations.filter(a => a.round_id === +round)) }); },
      saveAllocations(round, rows) {       // 서버 save_allocations 흉내: 관리자만, 편성이 확정된 지사만, 둘 다 0 이면 줄 삭제
        if (!can("equip.edit.all")) return done({ ok: false, message: ERR["42501"], code: "42501" });
        if (rows.some(x => (x.truck || x.blower) && !db.requests.some(q => q.round_id === +round && q.branch_id === x.branch_id && q.confirmed))) return done({ ok: false, message: ALLOC_ERR["23514"], code: "23514" });
        rows.forEach(x => {
          const i = db.allocations.findIndex(a => a.round_id === +round && a.org === x.org && a.branch_id === x.branch_id), t = `round_allocations:${round},${x.org},${x.branch_id}`, old = i >= 0 ? db.allocations[i] : null;
          const nv = { round_id: +round, org: x.org, branch_id: x.branch_id, truck: x.truck || 0, blower: x.blower || 0 };
          if (!nv.truck && !nv.blower) { if (old) { log("삭제", "round_allocations", t, clone(old), null); db.allocations.splice(i, 1); } }
          else if (!old) { db.allocations.push(nv); log("추가", "round_allocations", t, null, clone(nv)); }
          else if (old.truck !== nv.truck || old.blower !== nv.blower) { log("수정", "round_allocations", t, { truck: old.truck, blower: old.blower }, { truck: nv.truck, blower: nv.blower }); db.allocations[i] = nv; }
        });
        return done({ ok: true });
      },
      audit() { return done({ ok: true, rows: can("log.view") ? clone(db.audit) : [] }); },
      warnings() { return done({ ok: true, status: clone(warnStatus()) }); },
      forecast() { return done({ ok: true, rows: clone(db.forecast) }); },
      zoneData() {
        if (!actor) return done({ ok: false, message: ERR["42501"] });
        const list = {};
        Object.entries(db.zoneAuto).forEach(([b, zs]) => { list[b] = zs.filter(z => !db.zoneOver.some(o => o.branch_id === b && o.zone_code === z)).map(z => [z, zname(z), "auto"]); });
        db.zoneOver.filter(o => o.include).forEach(o => (list[o.branch_id] = list[o.branch_id] || []).push([o.zone_code, zname(o.zone_code), "manual"]));
        const rows = Object.entries(db.warnActive).map(([zone, v]) => { const [level, kind] = v.split(":"); return { zone, name: zname(zone), kind: kind || "대설", level, tm_fc: db.warnFc, tm_ef: level === "예비" ? db.warnEfPre : db.warnEf, branches: db.branches.filter(b => zonesOf(b.id).includes(zone)).map(b => b.id) }; })
          .sort((x, y) => RANK[y.level] - RANK[x.level] || x.kind.localeCompare(y.kind));
        return done({ ok: true, list, overrides: clone(db.zoneOver), zones: clone(db.zones), active: { state: { fetched_at: new Date().toISOString(), ok: true }, needed: true, all: true, rows } });
      },
      setZone(branch, zone, include) {
        if (!actor || actor.role !== "admin") return done({ ok: false, message: ERR["42501"] });
        const i = db.zoneOver.findIndex(o => o.branch_id === branch && o.zone_code === zone), t = `branch_zone_overrides:${branch},${zone}`;
        if (include === null) { if (i >= 0) { log("삭제", "branch_zone_overrides", t, db.zoneOver[i], null); db.zoneOver.splice(i, 1); } }
        else if (i >= 0) db.zoneOver[i].include = include;
        else { db.zoneOver.push({ branch_id: branch, zone_code: zone, include }); log("추가", "branch_zone_overrides", t, null, { include }); }
        return done({ ok: true });
      },
      saveFleet(vehicles, routes, round, status) {
        status = status || [];
        // 경로는 관리자(equip.edit.all). 기계화부(지원장비)는 자기 기관 장비의 ① 정해진 경로의 도착 예상 시각 ② 지원일 1의 지사 한 곳(배정받은 지사·대수 안에서, 마이그레이션 43)
        const allocOf = (org, bid) => db.allocations.find(a => a.round_id === +round && a.org === org && a.branch_id === bid);
        const ownRoutesErr = () => {      // 서버 트리거 흉내: 오류 번호 또는 null. 대수는 이번 저장을 모두 적용한 뒤에 셈(서로 바꾸기 허용)
          const rd0 = db.rounds.find(r => r.id === +round), sim = new Map(db.routes.map(x => [x.date + "|" + x.vehicle_id, x])), touched = [];
          for (const r of routes) {
            if (!vehOk(r.vehicle_id)) return "42501";
            const k = r.date + "|" + r.vehicle_id, old = sim.get(k), v = db.vehicles.find(x => x.id === r.vehicle_id);
            if (old && JSON.stringify(old.stops) === JSON.stringify(r.stops)) continue;                 // 시각만
            if (!rd0 || r.date !== rd0.start_date || (old && (old.revised || old.stops.length !== 1)) || r.stops.length > 1) return "SA003";
            if (!r.stops.length) { sim.delete(k); continue; }
            const a = allocOf(v.org, r.stops[0]);
            if (!a || (v.type === "제설차" && !a.truck) || (v.type === "제설기" && !a.blower)) return "SA001";
            sim.set(k, { ...r, revised: false }); touched.push([v, r.stops[0]]);
          }
          for (const [v, bid] of touched) {
            if (v.type === "이동정비차") continue;
            const cur = sim.get(rd0.start_date + "|" + v.id); if (!cur || cur.stops[0] !== bid) continue;
            const a = allocOf(v.org, bid), cap = a ? (v.type === "제설차" ? a.truck : a.blower) : 0;
            const n = [...sim.values()].filter(x => { const y = db.vehicles.find(z => z.id === x.vehicle_id); return x.date === rd0.start_date && x.stops[0] === bid && y && y.org === v.org && y.type === v.type; }).length;
            if (n > cap) return "SA002";
          }
          return null;
        };
        if (vehicles.some(v => "status" in v)) return done({ ok: false, message: "저장할 내용이 없거나 기준일자가 없습니다.", code: "22023" });
        if ((routes.length || status.length) && !db.rounds.some(r => r.id === +round)) return done({ ok: false, message: "저장할 내용이 없거나 기준일자가 없습니다.", code: "22023" });
        if (vehicles.some(v => !vehOk(v.id)) || status.some(x => !vehOk(x.vehicle_id))) return done({ ok: false, message: ERR["42501"] });
        if (!can("equip.edit.all")) { const c = ownRoutesErr(); if (c) return done({ ok: false, message: ERR[c], code: c }); }
        if (!can("equip.edit.all")) routes = routes.map(r => { const x = db.routes.find(y => y.date === r.date && y.vehicle_id === r.vehicle_id); return { ...r, revised: !!(x && x.revised) }; });
        if (!can("equip.edit.all") && vehicles.some(v => Object.keys(v).some(k => !["id", "plate", "blower_s", "blower_l"].includes(k)))) return done({ ok: false, message: ERR["42501"] });
        if (vehicles.some(p => (p.blower_s || p.blower_l) && (db.vehicles.find(x => x.id === p.id) || {}).type !== "제설기")) return done({ ok: false, message: ERR["23514"] || "값이 규칙에 맞지 않습니다." });
        const plates = new Map(db.vehicles.map(v => [v.id, v.plate])); vehicles.forEach(v => { if ("plate" in v) plates.set(v.id, v.plate); });
        if (new Set(plates.values()).size !== plates.size) return done({ ok: false, message: ERR["23505"] });
        const rd = db.rounds.find(r => r.id === +round);
        if (status.some(x => x.status === "O" && x.off_from && x.off_from < rd.start_date)) return done({ ok: false, message: FLEET_ERR["23514"] });
        if (routes.some(r => (gov(r.date) || {}).id !== +round)) return done({ ok: false, message: FLEET_ERR["23514"] });
        const before = clone(db.status);                                           // 하나라도 안 되면 전부 취소(서버 함수와 같게)
        status.forEach(x => { let row = stRow(+round, x.vehicle_id); if (!row) { row = { round_id: +round, vehicle_id: x.vehicle_id, status: "", off_from: null }; db.status.push(row); }
          row.status = x.status || ""; row.off_from = row.status === "O" ? x.off_from || null : null; row.updated_at = new Date().toISOString(); });
        if (routes.some(r => r.stops.length && !avail(r.vehicle_id, r.date))) { db.status = before; return done({ ok: false, message: FLEET_ERR["23514"] }); }
        status.forEach(x => log("수정", "round_vehicle_status", `round_vehicle_status:${round},${x.vehicle_id}`, null, { status: x.status, off_from: x.off_from || null }));
        vehicles.forEach(p => { const v = db.vehicles.find(x => x.id === p.id), from = {}, to = {}; Object.keys(p).filter(k => k !== "id" && v[k] !== p[k]).forEach(k => { from[k] = v[k]; to[k] = p[k]; v[k] = p[k]; }); if (Object.keys(to).length) log("수정", "vehicles", "vehicles:" + v.id, from, to); });
        routes.forEach(r => {
          const i = db.routes.findIndex(x => x.date === r.date && x.vehicle_id === r.vehicle_id), t = `vehicle_routes:${r.date},${r.vehicle_id}`;
          const nr = { date: r.date, vehicle_id: r.vehicle_id, stops: r.stops.slice(), revised: !!r.revised, times: r.times ? r.times.slice() : null, confirmed_at: new Date().toISOString() };
          if (!r.stops.length) { if (i >= 0) { log("삭제", "vehicle_routes", t, clone(db.routes[i]), null); db.routes.splice(i, 1); } }
          else if (i < 0) { db.routes.push(nr); log("추가", "vehicle_routes", t, null, clone(nr)); }
          else { const o = db.routes[i], from = {}, to = {};
            ["stops", "revised", "times"].forEach(f => { if (JSON.stringify(o[f] ?? null) !== JSON.stringify(nr[f] ?? null)) { from[f] = o[f] ?? null; to[f] = nr[f]; } });
            if (Object.keys(to).length) { log("수정", "vehicle_routes", t, from, to); db.routes[i] = nr; } }
        });
        return done({ ok: true });
      },
      saveRequests(round, rows) {
        const br = id => db.branches.find(b => b.id === id);
        const ok = r => can("req.confirm") || (can("req.edit.own") && actor.branch_id === r.branch_id) || (can("req.edit.hq") && br(r.branch_id) && br(r.branch_id).hq_id === actor.hq_id);
        if (rows.some(r => !ok(r)) || (!can("req.confirm") && rows.some(r => "assigned_truck" in r || "assigned_blower" in r || "confirmed" in r))) return done({ ok: false, message: ERR["42501"] });
        // 서버 트리거 흉내(마이그레이션 35): 확정한 줄은 확정 열 말고는 못 바꿈(취소하면서 바꾸는 것도)
        const locked = r => { const c = db.requests.find(x => x.round_id === +round && x.branch_id === r.branch_id); return c && c.confirmed && Object.keys(r).some(k => k !== "branch_id" && k !== "confirmed" && JSON.stringify(r[k] ?? null) !== JSON.stringify(c[k] ?? null)); };
        if (rows.some(locked)) return done({ ok: false, message: ERR["55000"], code: "55000" });
        rows.forEach(p => {
          let cur = db.requests.find(x => x.round_id === +round && x.branch_id === p.branch_id), from = {}, to = {};
          if (!cur) { cur = { round_id: +round, branch_id: p.branch_id, req_truck: 0, req_blower: 0, assigned_truck: 0, assigned_blower: 0, arrive_at: null, reason: null, confirmed: false,
            wx_manual: false, wx_snow: null, wx_pcp: null, wx_tmin: null, wx_tmin_at: null, wx_level: null, wx_fc: null, wx_ef: null }; db.requests.push(cur); }
          const was = cur.confirmed;
          Object.keys(p).filter(k => k !== "branch_id").forEach(k => { from[k] = cur[k]; to[k] = p[k]; cur[k] = p[k]; });
          if (cur.confirmed && !was) { const w = warnStatus().branches[cur.branch_id]; Object.assign(cur, { warn_level: w ? w.level : null, warn_zones: w ? w.zones : [], warn_base: db.warnBase, warn_at: new Date().toISOString(), warn_note: null }); to.warn_level = cur.warn_level; }   // 서버 트리거 흉내: 확정 순간 특보 고정
          if (cur.confirmed && !was) { const f = db.forecast.find(x => x.branch_id === cur.branch_id); Object.assign(cur, { fc_snow: f ? f.max_snow_24h : null, fc_pcp: f ? f.max_pcp_24h : null, fc_pop: f && f.max_pop_24h != null ? f.max_pop_24h : null, fc_tmin: f ? f.min_tmp : null, fc_tmin_at: f ? f.min_tmp_at : null, fc_tmfc: f ? f.issued_at : null, fc_at: new Date().toISOString() }); }
          if (!cur.confirmed) Object.assign(cur, { warn_level: null, warn_zones: null, warn_base: null, warn_at: null, warn_note: null, fc_snow: null, fc_pcp: null, fc_pop: null, fc_tmin: null, fc_tmin_at: null, fc_tmfc: null, fc_at: null });
          log("수정", "round_requests", `round_requests:${round},${p.branch_id}`, from, to);
        });
        return done({ ok: true });
      },
      createRound(date) {
        if (!can("req.confirm")) return done({ ok: false, message: ERR["42501"] });
        if (db.rounds.some(r => r.start_date >= date)) return done({ ok: false, message: ROUND_ERR["23514"] });
        const prev = db.rounds.slice().sort((a, b) => b.start_date.localeCompare(a.start_date))[0];
        const r = { id: Math.max(0, ...db.rounds.map(x => x.id)) + 1, name: date + " 기준", start_date: date, days: 4 }; db.rounds.push(r); log("추가", "support_rounds", "support_rounds:" + r.id, null, r);
        db.vehicles.filter(v => v.active !== false && (!v.hidden_after || date <= v.hidden_after)).forEach(v => {     // 전체 장비 지원 여부 이어받기(정비중·지원 불가 포함)
          const p = prev && stRow(prev.id, v.id), st = p ? p.status : prev ? "" : (v.status || "");
          const gone = p && p.status === "O" && p.off_from && p.off_from <= date;
          db.status.push({ round_id: r.id, vehicle_id: v.id, status: gone ? "X" : st, off_from: !gone && p && p.status === "O" ? p.off_from || null : null, updated_at: new Date().toISOString() });
        });
        return done({ ok: true, round: clone(r) });
      },
      deleteRound(id) {
        if (!can("req.confirm")) return done({ ok: false, message: ERR["42501"] });
        const r = db.rounds.find(x => x.id === +id); if (!r) return done({ ok: false, message: ERR["23503"] });
        if (db.rounds.some(x => x.start_date > r.start_date) || db.routes.some(x => x.date >= r.start_date && x.date <= addD(r.start_date, (r.days || 4) - 1))) return done({ ok: false, message: ROUND_ERR["23514"] });
        db.requests.filter(x => x.round_id === +id).forEach(x => log("삭제", "round_requests", `round_requests:${id},${x.branch_id}`, clone(x), null));
        db.requests = db.requests.filter(x => x.round_id !== +id); db.status = db.status.filter(x => x.round_id !== +id); db.rounds = db.rounds.filter(x => x.id !== +id); log("삭제", "support_rounds", "support_rounds:" + id, r, null);
        return done({ ok: true });
      },
      addVehicle(v) {
        if (!(can("equip.edit.all") || (can("equip.edit.own") && v.org === actor.org))) return done({ ok: false, message: ERR["42501"] });
        if (db.vehicles.some(x => x.plate === v.plate || x.id === v.id)) return done({ ok: false, message: ERR["23505"] });
        const nv = { status: "", active: true, ...v }; db.vehicles.push(nv); log("추가", "vehicles", "vehicles:" + v.id, null, nv); return done({ ok: true, vehicle: clone(nv) });
      },
      deleteVehicle(id) {
        if (!can("equip.edit.all")) return done({ ok: false, message: ERR["42501"] });      // 장비 삭제는 관리자만
        if (db.routes.some(x => x.vehicle_id === id)) return done({ ok: false, message: VDEL_ERR["23503"], code: "23503" });   // 경로 기록이 있으면 숨기기를 써야 함
        db.vehicles = db.vehicles.filter(x => x.id !== id); db.status = db.status.filter(x => x.vehicle_id !== id); log("삭제", "vehicles", "vehicles:" + id, { id }, null); return done({ ok: true });
      },
      hideVehicle(id, after) {
        if (!can("equip.edit.all")) return done({ ok: false, message: ERR["42501"] });
        const v = db.vehicles.find(x => x.id === id); if (!v) return done({ ok: false, message: ERR["23503"] });
        log("수정", "vehicles", "vehicles:" + id, { hidden_after: v.hidden_after || null }, { hidden_after: after }); v.hidden_after = after; return done({ ok: true });
      }
    };
  })();

  const b = SAMPLE ? sample : server;
  return { sample: SAMPLE, setActor: a => { if (SAMPLE) sample.setActor(a); }, ...Object.fromEntries(Object.keys(server).map(k => [k, (...a) => b[k](...a)])) };
})();
