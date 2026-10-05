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
    "55000": "확정한 지사는 확정을 취소한 뒤에 고칠 수 있습니다." };
  const fail = (r, fallback) => ({ ok: false, message: (r && r.json && ERR[r.json.code]) || fallback || "저장하지 못했습니다. 잠시 후 다시 시도해 주세요.", code: r && r.json && r.json.code });
  const NET = () => ({ ok: false, message: (window.SSAuth && SSAuth.NET_MSG) || "서버에 연결할 수 없습니다." });
  const EQUIP_TABS = "vehicles,vehicle_routes,round_requests,support_rounds,branch_zone_overrides";

  /* ---------- 서버(Supabase) ---------- */
  const server = {
    load() {
      const R = SSAuth.rest;
      return Promise.all([SSAuth.restore(), R("hqs?select=id,name,sort,is_private&order=sort"), R("branches?select=id,name,hq_id,status&order=id"),
        R("vehicles?select=id,org,type,plate,status,sort,active&order=sort,id"), R("support_rounds?select=id,name,start_date&order=start_date.desc"), R("equip_orgs?select=name")])
        .then(([me, h, b, v, s, o]) => {
          if (!me.ok) return { ok: false, message: me.message || "로그인이 필요합니다.", login: true };
          if (![h, b, v, s].every(r => r.ok)) return { ok: false, message: "자료를 불러오지 못했습니다." };
          return { ok: true, me: me.me, hqs: h.json, branches: b.json.filter(x => x.status !== "closed"), vehicles: v.json, rounds: s.json, orgs: (o.json || []).map(x => x.name), holdings: null };
        }).catch(NET);
    },
    routes(from, to) {
      return SSAuth.rest(`vehicle_routes?select=date,vehicle_id,stops,revised,times&date=gte.${from}&date=lte.${to}&order=date`).then(r => r.ok ? { ok: true, rows: r.json } : fail(r, "경로를 불러오지 못했습니다.")).catch(NET);
    },
    vehicleHistory(vid) {
      return SSAuth.rest(`vehicle_routes?select=date,vehicle_id,stops,revised,times&vehicle_id=eq.${encodeURIComponent(vid)}&order=date.desc&limit=400`).then(r => r.ok ? { ok: true, rows: r.json } : fail(r)).catch(NET);
    },
    requests(round) {
      return SSAuth.rest(`round_requests?select=round_id,branch_id,snow_cm,warning,req_truck,req_blower,assigned_truck,assigned_blower,arrive_at,reason,confirmed,warn_level,warn_zones,warn_base,warn_at,warn_note,fc_snow,fc_pcp,fc_tmin,fc_tmin_at,fc_tmfc,fc_at,wx_manual,wx_snow,wx_pcp,wx_tmin,wx_tmin_at,wx_level,wx_fc,wx_ef&round_id=eq.${+round}`)
        .then(r => r.ok ? { ok: true, rows: r.json } : fail(r, "요청을 불러오지 못했습니다.")).catch(NET);
    },
    warnings() {
      return SSAuth.authed("/rest/v1/rpc/warning_status", { method: "POST", body: {} }).then(r => r.ok ? { ok: true, status: r.json } : fail(r, "특보를 불러오지 못했습니다.")).catch(NET);
    },
    forecast() {         // 지사별 예상 적설(59줄)
      return SSAuth.rest("branch_forecast?select=branch_id,issued_at,max_snow_24h,max_pcp_24h,min_tmp,min_tmp_at,worst_nx,worst_ny,detail").then(r => r.ok ? { ok: true, rows: r.json } : fail(r, "예상 적설을 불러오지 못했습니다.")).catch(NET);
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
    saveFleet(vehicles, routes) {
      return SSAuth.authed("/rest/v1/rpc/save_fleet", { method: "POST", body: { p_vehicles: vehicles, p_routes: routes } }).then(r => r.ok ? { ok: true, result: r.json } : fail(r)).catch(NET);
    },
    saveRequests(round, rows) {
      return SSAuth.authed("/rest/v1/rpc/save_requests", { method: "POST", body: { p_round: round, p_rows: rows } }).then(r => r.ok ? { ok: true, result: r.json } : fail(r)).catch(NET);
    },
    createRound(date) {
      return SSAuth.authed("/rest/v1/support_rounds?select=id,name,start_date", { method: "POST", body: { name: date + " 기준", start_date: date }, headers: { Prefer: "return=representation" } })
        .then(r => r.ok && r.json && r.json[0] ? { ok: true, round: r.json[0] } : fail(r, "기준일자를 만들지 못했습니다.")).catch(NET);
    },
    deleteRound(id) {           // 그 기준일자의 지사 요청은 DB 가 함께 지움(외래키 cascade, 지운 줄은 수정 기록에 남음)
      return SSAuth.authed(`/rest/v1/support_rounds?id=eq.${+id}&select=id`, { method: "DELETE", headers: { Prefer: "return=representation" } })
        .then(r => r.ok && r.json && r.json.length ? { ok: true } : fail(r, "기준일자를 지우지 못했습니다(권한이 없을 수 있습니다).")).catch(NET);
    },
    addVehicle(v) {
      return SSAuth.authed("/rest/v1/vehicles?select=id,org,type,plate,status,sort,active", { method: "POST", body: v, headers: { Prefer: "return=representation" } })
        .then(r => r.ok && r.json && r.json[0] ? { ok: true, vehicle: r.json[0] } : fail(r, "장비를 추가하지 못했습니다.")).catch(NET);
    },
    deleteVehicle(id) {
      return SSAuth.authed(`/rest/v1/vehicles?id=eq.${encodeURIComponent(id)}&select=id`, { method: "DELETE", headers: { Prefer: "return=representation" } })
        .then(r => r.ok && r.json && r.json.length ? { ok: true } : fail(r, "장비를 지우지 못했습니다(권한이 없을 수 있습니다).")).catch(NET);
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
      routes(from, to) { return done({ ok: true, rows: clone(db.routes.filter(r => r.date >= from && r.date <= to)) }); },
      vehicleHistory(vid) { return done({ ok: true, rows: clone(db.routes.filter(r => r.vehicle_id === vid).sort((a, b) => b.date.localeCompare(a.date))) }); },
      requests(round) { return done({ ok: true, rows: clone(db.requests.filter(r => r.round_id === +round)) }); },
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
      saveFleet(vehicles, routes) {
        // 경로는 관리자(equip.edit.all)만. 지원장비는 자기 기관 장비의 정해진 경로(지사 그대로)에서 도착 예상 시각만
        const timeOnlyOk = r => vehOk(r.vehicle_id) && db.routes.some(x => x.date === r.date && x.vehicle_id === r.vehicle_id && JSON.stringify(x.stops) === JSON.stringify(r.stops));
        if (vehicles.some(v => !vehOk(v.id)) || (!can("equip.edit.all") && routes.some(r => !timeOnlyOk(r)))) return done({ ok: false, message: ERR["42501"] });
        if (!can("equip.edit.all")) routes = routes.map(r => { const x = db.routes.find(y => y.date === r.date && y.vehicle_id === r.vehicle_id); return { ...r, revised: !!x.revised }; });
        if (!can("equip.edit.all") && vehicles.some(v => Object.keys(v).some(k => !["id", "plate", "status"].includes(k)))) return done({ ok: false, message: ERR["42501"] });
        const plates = new Map(db.vehicles.map(v => [v.id, v.plate])); vehicles.forEach(v => { if ("plate" in v) plates.set(v.id, v.plate); });
        if (new Set(plates.values()).size !== plates.size) return done({ ok: false, message: ERR["23505"] });
        vehicles.forEach(p => { const v = db.vehicles.find(x => x.id === p.id), from = {}, to = {}; Object.keys(p).filter(k => k !== "id" && v[k] !== p[k]).forEach(k => { from[k] = v[k]; to[k] = p[k]; v[k] = p[k]; }); if (Object.keys(to).length) log("수정", "vehicles", "vehicles:" + v.id, from, to); });
        routes.forEach(r => {
          const i = db.routes.findIndex(x => x.date === r.date && x.vehicle_id === r.vehicle_id), t = `vehicle_routes:${r.date},${r.vehicle_id}`;
          const nr = { date: r.date, vehicle_id: r.vehicle_id, stops: r.stops.slice(), revised: !!r.revised, times: r.times ? r.times.slice() : null };
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
          if (!cur) { cur = { round_id: +round, branch_id: p.branch_id, snow_cm: null, warning: false, req_truck: 0, req_blower: 0, assigned_truck: 0, assigned_blower: 0, arrive_at: null, reason: null, confirmed: false,
            wx_manual: false, wx_snow: null, wx_pcp: null, wx_tmin: null, wx_tmin_at: null, wx_level: null, wx_fc: null, wx_ef: null }; db.requests.push(cur); }
          const was = cur.confirmed;
          Object.keys(p).filter(k => k !== "branch_id").forEach(k => { from[k] = cur[k]; to[k] = p[k]; cur[k] = p[k]; });
          if (cur.confirmed && !was) { const w = warnStatus().branches[cur.branch_id]; Object.assign(cur, { warn_level: w ? w.level : null, warn_zones: w ? w.zones : [], warn_base: db.warnBase, warn_at: new Date().toISOString(), warn_note: null }); to.warn_level = cur.warn_level; }   // 서버 트리거 흉내: 확정 순간 특보 고정
          if (cur.confirmed && !was) { const f = db.forecast.find(x => x.branch_id === cur.branch_id); Object.assign(cur, { fc_snow: f ? f.max_snow_24h : null, fc_pcp: f ? f.max_pcp_24h : null, fc_tmin: f ? f.min_tmp : null, fc_tmin_at: f ? f.min_tmp_at : null, fc_tmfc: f ? f.issued_at : null, fc_at: new Date().toISOString() }); }
          if (!cur.confirmed) Object.assign(cur, { warn_level: null, warn_zones: null, warn_base: null, warn_at: null, warn_note: null, fc_snow: null, fc_pcp: null, fc_tmin: null, fc_tmin_at: null, fc_tmfc: null, fc_at: null });
          log("수정", "round_requests", `round_requests:${round},${p.branch_id}`, from, to);
        });
        return done({ ok: true });
      },
      createRound(date) {
        if (!can("req.confirm")) return done({ ok: false, message: ERR["42501"] });
        if (db.rounds.some(r => r.start_date === date)) return done({ ok: false, message: ERR["23505"] });
        const r = { id: Math.max(0, ...db.rounds.map(x => x.id)) + 1, name: date + " 기준", start_date: date }; db.rounds.push(r); log("추가", "support_rounds", "support_rounds:" + r.id, null, r);
        return done({ ok: true, round: clone(r) });
      },
      deleteRound(id) {
        if (!can("req.confirm")) return done({ ok: false, message: ERR["42501"] });
        const r = db.rounds.find(x => x.id === +id); if (!r) return done({ ok: false, message: ERR["23503"] });
        db.requests.filter(x => x.round_id === +id).forEach(x => log("삭제", "round_requests", `round_requests:${id},${x.branch_id}`, clone(x), null));
        db.requests = db.requests.filter(x => x.round_id !== +id); db.rounds = db.rounds.filter(x => x.id !== +id); log("삭제", "support_rounds", "support_rounds:" + id, r, null);
        return done({ ok: true });
      },
      addVehicle(v) {
        if (!(can("equip.edit.all") || (can("equip.edit.own") && v.org === actor.org))) return done({ ok: false, message: ERR["42501"] });
        if (db.vehicles.some(x => x.plate === v.plate || x.id === v.id)) return done({ ok: false, message: ERR["23505"] });
        const nv = { status: "", active: true, ...v }; db.vehicles.push(nv); log("추가", "vehicles", "vehicles:" + v.id, null, nv); return done({ ok: true, vehicle: clone(nv) });
      },
      deleteVehicle(id) {
        if (!vehOk(id)) return done({ ok: false, message: ERR["42501"] });      // 관리자 또는 자기 기관 장비
        db.vehicles = db.vehicles.filter(x => x.id !== id); db.routes = db.routes.filter(x => x.vehicle_id !== id); log("삭제", "vehicles", "vehicles:" + id, { id }, null); return done({ ok: true });
      }
    };
  })();

  const b = SAMPLE ? sample : server;
  return { sample: SAMPLE, setActor: a => { if (SAMPLE) sample.setActor(a); }, ...Object.fromEntries(Object.keys(server).map(k => [k, (...a) => b[k](...a)])) };
})();
