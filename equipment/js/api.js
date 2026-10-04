/* ============================================================
   api.js — 서버와 주고받는 곳 (화면 코드 app.js 는 이 함수들만 부릅니다)
   - 기본: Supabase 서버. 로그인 정보는 auth/auth.js(SSAuth)가 보관·갱신합니다.
   - 주소에 ?sample=1 이 있으면: 서버 대신 sample-data.js 의 샘플로 움직입니다(시연·자동 시험용, 저장은 이 화면 안에만).
   - 권한 검사는 서버(DB 규칙)가 다시 합니다. 화면의 검사는 보기 좋게 정리하는 용도입니다.
   - 저장은 "바뀐 칸만" 보내고, 한 번의 [확정]/[저장]은 서버 함수 하나로 "전부 되거나 전부 안 되게" 처리합니다.
     · 기관별 장비 [확정] → save_fleet(장비 차량번호·지원 여부, (날짜, 장비)별 경로)
     · 지사별 요청·편성 [저장] → save_requests(기준일자, 지사별 바뀐 열)
   - 모든 함수는 Promise 를 돌려줍니다. 실패하면 { ok:false, message } 입니다.
   ============================================================ */
const Api = (() => {
  const SAMPLE = new URLSearchParams(location.search).has("sample");
  const ERR = { "42501": "권한이 없습니다(다른 기관·지사 자료이거나 권한이 바뀌었습니다).", "23505": "이미 있는 값입니다(차량번호·기준일자 중복).",
    "23514": "값의 형식이 올바르지 않습니다.", "23503": "없는 지사·장비·기준일자입니다.", "22023": "저장할 내용이 없습니다.", "54000": "한 번에 너무 많이 저장하려고 합니다." };
  const fail = (r, fallback) => ({ ok: false, message: (r && r.json && ERR[r.json.code]) || fallback || "저장하지 못했습니다. 잠시 후 다시 시도해 주세요.", code: r && r.json && r.json.code });
  const NET = () => ({ ok: false, message: (window.SSAuth && SSAuth.NET_MSG) || "서버에 연결할 수 없습니다." });
  const EQUIP_TABS = "vehicles,vehicle_routes,round_requests,support_rounds";

  /* ---------- 서버(Supabase) ---------- */
  const server = {
    load() {
      const R = SSAuth.rest;
      return Promise.all([SSAuth.restore(), R("hqs?select=id,name,sort&order=sort"), R("branches?select=id,name,hq_id,status&order=id"),
        R("vehicles?select=id,org,type,plate,status,sort,active&order=sort,id"), R("support_rounds?select=id,name,start_date&order=start_date.desc"), R("equip_orgs?select=name")])
        .then(([me, h, b, v, s, o]) => {
          if (!me.ok) return { ok: false, message: me.message || "로그인이 필요합니다.", login: true };
          if (![h, b, v, s].every(r => r.ok)) return { ok: false, message: "자료를 불러오지 못했습니다." };
          return { ok: true, me: me.me, hqs: h.json, branches: b.json.filter(x => x.status !== "closed"), vehicles: v.json, rounds: s.json, orgs: (o.json || []).map(x => x.name), holdings: null };
        }).catch(NET);
    },
    routes(from, to) {
      return SSAuth.rest(`vehicle_routes?select=date,vehicle_id,stops&date=gte.${from}&date=lte.${to}&order=date`).then(r => r.ok ? { ok: true, rows: r.json } : fail(r, "경로를 불러오지 못했습니다.")).catch(NET);
    },
    vehicleHistory(vid) {
      return SSAuth.rest(`vehicle_routes?select=date,vehicle_id,stops&vehicle_id=eq.${encodeURIComponent(vid)}&order=date.desc&limit=400`).then(r => r.ok ? { ok: true, rows: r.json } : fail(r)).catch(NET);
    },
    requests(round) {
      return SSAuth.rest(`round_requests?select=round_id,branch_id,snow_cm,warning,req_truck,req_blower,assigned_truck,assigned_blower,arrive_at,reason,confirmed&round_id=eq.${+round}`)
        .then(r => r.ok ? { ok: true, rows: r.json } : fail(r, "요청을 불러오지 못했습니다.")).catch(NET);
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
      saveFleet(vehicles, routes) {
        if (vehicles.some(v => !vehOk(v.id)) || routes.some(r => !vehOk(r.vehicle_id))) return done({ ok: false, message: ERR["42501"] });
        if (!can("equip.edit.all") && vehicles.some(v => Object.keys(v).some(k => !["id", "plate", "status"].includes(k)))) return done({ ok: false, message: ERR["42501"] });
        const plates = new Map(db.vehicles.map(v => [v.id, v.plate])); vehicles.forEach(v => { if ("plate" in v) plates.set(v.id, v.plate); });
        if (new Set(plates.values()).size !== plates.size) return done({ ok: false, message: ERR["23505"] });
        vehicles.forEach(p => { const v = db.vehicles.find(x => x.id === p.id), from = {}, to = {}; Object.keys(p).filter(k => k !== "id" && v[k] !== p[k]).forEach(k => { from[k] = v[k]; to[k] = p[k]; v[k] = p[k]; }); if (Object.keys(to).length) log("수정", "vehicles", "vehicles:" + v.id, from, to); });
        routes.forEach(r => {
          const i = db.routes.findIndex(x => x.date === r.date && x.vehicle_id === r.vehicle_id), t = `vehicle_routes:${r.date},${r.vehicle_id}`;
          if (!r.stops.length) { if (i >= 0) { log("삭제", "vehicle_routes", t, clone(db.routes[i]), null); db.routes.splice(i, 1); } }
          else if (i < 0) { db.routes.push(clone(r)); log("추가", "vehicle_routes", t, null, clone(r)); }
          else if (JSON.stringify(db.routes[i].stops) !== JSON.stringify(r.stops)) { log("수정", "vehicle_routes", t, { stops: db.routes[i].stops }, { stops: r.stops.slice() }); db.routes[i].stops = r.stops.slice(); }
        });
        return done({ ok: true });
      },
      saveRequests(round, rows) {
        const br = id => db.branches.find(b => b.id === id);
        const ok = r => can("req.confirm") || (can("req.edit.own") && actor.branch_id === r.branch_id) || (can("req.edit.hq") && br(r.branch_id) && br(r.branch_id).hq_id === actor.hq_id);
        if (rows.some(r => !ok(r)) || (!can("req.confirm") && rows.some(r => "assigned_truck" in r || "assigned_blower" in r || "confirmed" in r))) return done({ ok: false, message: ERR["42501"] });
        rows.forEach(p => {
          let cur = db.requests.find(x => x.round_id === +round && x.branch_id === p.branch_id), from = {}, to = {};
          if (!cur) { cur = { round_id: +round, branch_id: p.branch_id, snow_cm: null, warning: false, req_truck: 0, req_blower: 0, assigned_truck: 0, assigned_blower: 0, arrive_at: null, reason: null, confirmed: false }; db.requests.push(cur); }
          Object.keys(p).filter(k => k !== "branch_id").forEach(k => { from[k] = cur[k]; to[k] = p[k]; cur[k] = p[k]; });
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
      addVehicle(v) {
        if (!can("equip.edit.all")) return done({ ok: false, message: ERR["42501"] });
        if (db.vehicles.some(x => x.plate === v.plate || x.id === v.id)) return done({ ok: false, message: ERR["23505"] });
        const nv = { status: "", active: true, ...v }; db.vehicles.push(nv); log("추가", "vehicles", "vehicles:" + v.id, null, nv); return done({ ok: true, vehicle: clone(nv) });
      },
      deleteVehicle(id) {
        if (!can("equip.edit.all")) return done({ ok: false, message: ERR["42501"] });
        db.vehicles = db.vehicles.filter(x => x.id !== id); db.routes = db.routes.filter(x => x.vehicle_id !== id); log("삭제", "vehicles", "vehicles:" + id, { id }, null); return done({ ok: true });
      }
    };
  })();

  const b = SAMPLE ? sample : server;
  return { sample: SAMPLE, setActor: a => { if (SAMPLE) sample.setActor(a); }, ...Object.fromEntries(Object.keys(server).map(k => [k, (...a) => b[k](...a)])) };
})();
