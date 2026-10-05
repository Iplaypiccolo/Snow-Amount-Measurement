/* ============================================================
   sample-data.js — 시연용 샘플 데이터 (실제 데이터가 아닙니다)
   - 주소 끝에 ?sample=1 을 붙이면 서버 대신 이 자료로 화면이 움직입니다(저장해도 이 화면에만 남고 새로고침하면 처음으로).
   - 도공번호(서울경기901 …)는 가상 번호이고 IP도 문서용 예시 주소입니다. (운전원 이름·전화번호는 이 프로그램에서 다루지 않습니다)
   - 날짜는 "오늘"을 기준으로 만들어서, 언제 열어도 오늘·내일 이동이 보입니다.
   - 서버 자료와 같은 모양: 지사는 번호(B001…), 장비는 고유 번호(V001…), 경로는 (날짜, 장비)마다 들르는 지사 목록.
   ============================================================ */
function makeSample(today) {
  const p2 = n => String(n).padStart(2, "0");
  const day = n => { const [y, m, d] = today.split("-").map(Number); const t = new Date(y, m - 1, d + n); return `${t.getFullYear()}-${p2(t.getMonth() + 1)}-${p2(t.getDate())}`; };
  // 본부 → 지사(이름, 보유 제설차, 보유 제설기)
  const H = {
    "수도권":   [["인천",16,0],["시흥",19,0],["군포",17,0],["화성",19,0],["파주",6,0],["구리포천",12,0]],
    "서울경기": [["수원",19,1],["경기광주",19,0],["동서울",17,1],["이천",21,1],["용인",18,0]],
    "강원":     [["원주",14,1],["대관령",24,5],["홍천",14,2],["춘천",18,2],["강릉",20,2],["양양",21,2]],
    "충북":     [["진천",14,0],["제천",16,1],["충주",12,1],["보은",15,0],["엄정",17,1],["상주",10,0]],
    "대전충남": [["천안",20,0],["대전",15,0],["영동",16,0],["당진",18,1],["공주",15,0],["부여",13,0]],
    "전북":     [["전주",20,1],["부안",18,1],["무주",14,1],["논산",14,0],["진안",20,0],["보령",14,1]],
    "광주전남": [["광주",17,1],["담양",13,1],["순천",8,0],["함평",18,1],["구례",16,1],["보성",16,1],["남원",11,0]],
    "대구경북": [["구미",12,0],["대구",19,0],["군위",10,0],["영천",10,0],["고령",10,0],["영주",10,0],["성주",10,0],["청송",18,0]],
    "민자":     [["민자",0,0]],
    "부산경남": [["울산",8,0],["양산",9,0],["창원",10,0],["진주",9,0],["산청",8,1],["경주",7,0],["창녕",7,0],["고성",4,0],["서울산",8,0],["밀양",8,0]]
  };
  const hqs = [], branches = [], holdings = {};
  let n = 0;
  Object.entries(H).forEach(([hq, rows], i) => {
    const hid = "H" + p2(i + 1); hqs.push({ id: hid, name: hq, sort: i + 1, is_private: hq === "민자" });
    rows.forEach(([name, t, w]) => { const id = "B" + String(++n).padStart(3, "0"); branches.push({ id, name, hq_id: hid }); holdings[id] = { truck: t, blower: w }; });
  });
  const B = name => branches.find(b => b.name === name).id;
  const V = [
    ["서울경기","제설차","11가1037","O","대관령"], ["서울경기","제설차","12가1074","O","대관령"], ["서울경기","제설차","13가1111","O","대관령"], ["서울경기","제설차","14가1148","",""],
    ["서울경기","제설차","15가1185","O","양양"], ["서울경기","제설차","16가1222","O","양양"], ["서울경기","제설차","17가1259","O","엄정"], ["서울경기","제설기","18가1296","O","대관령"],
    ["서울경기","제설기","19가1333","O","대관령"], ["서울경기","제설기","20가1370","O","대관령"], ["서울경기","제설기","21가1407","",""], ["서울경기","이동정비차","22가1444","O","대관령"],
    ["충북","제설차","23가1481","",""], ["충북","제설차","24가1518","O","양양"], ["충북","제설차","25가1555","O","양양"], ["충북","제설차","26가1592","O","양양"],
    ["충북","제설차","27가1629","O","대관령"], ["충북","제설차","28가1666","O","대관령"], ["충북","제설차","29가1703","M",""], ["충북","제설기","30가1740","O","대관령"],
    ["충북","이동정비차","31가1777","O","대관령"],
    ["전북","제설차","32가1814","",""], ["전북","제설차","33가1851","",""], ["전북","제설차","34가1888","",""], ["전북","제설차","35가1925","",""], ["전북","제설차","36가1962","",""],
    ["전북","제설차","37가1999","",""], ["전북","제설차","38가2036","",""], ["전북","제설차","39가2073","",""], ["전북","제설차","40가2110","",""], ["전북","제설기","41가2147","",""],
    ["전북","이동정비차","42가2184","",""],
    ["대구경북","제설차","43가2221","O","양양"], ["대구경북","제설차","44가2258","O","양양"], ["대구경북","제설차","45가2295","O","양양"], ["대구경북","제설차","46가2332","X",""],
    ["대구경북","제설차","47가2369","X",""], ["대구경북","제설차","48가2406","X",""], ["대구경북","제설기","49가2443","X",""], ["대구경북","제설기","50가2480","O","양양"],
    ["대구경북","제설기","51가2517","X",""], ["대구경북","제설기","52가2554","O","양양"], ["대구경북","이동정비차","53가2591","O","양양"]
  ];
  // 도공번호: 기관 이름 + 901, 902 … (예: 서울경기901. 차량번호 대신, 사용자 결정 2026-10-04)
  const seq = {}, vehicles = V.map(([org, type, , status], i) => ({ id: "V" + String(i + 1).padStart(3, "0"), org, type, plate: `${org}${900 + (seq[org] = (seq[org] || 0) + 1)}`, status, sort: (i + 1) * 10 }));
  // 경로: (날짜, 장비) → 들르는 지사들. 대관령 3일, 양양 2일, 엄정 1일(오늘부터)
  const SPAN = { "대관령": 3, "양양": 2, "엄정": 1 }, routes = [];
  V.forEach(([, , , st, dest], i) => { if (st === "O" && dest && i > 0) for (let k = 0; k < SPAN[dest]; k++) routes.push({ date: day(k), vehicle_id: vehicles[i].id, stops: [B(dest)] }); });
  // V001: 날마다 들르는 곳이 다르고, 모레는 하루에 두 곳(대관령 → 양양)
  [["대관령"], ["대관령"], ["대관령", "양양"], ["대관령"], ["양양"]].forEach((xs, k) => routes.push({ date: day(k), vehicle_id: "V001", stops: xs.map(B), revised: false, times: k === 0 ? ["21:30"] : k === 2 ? ["08:00", "14:00"] : null }));
  routes.filter(r => r.vehicle_id === "V002" && r.date === day(1)).forEach(r => { r.revised = true; r.times = ["06:00"]; });   // 수정본 예
  // 지난 기록: 1주 전에 엄정·춘천으로 갔던 장비(오늘 다른 곳으로 가도 그대로 남음)
  routes.push({ date: day(-7), vehicle_id: "V005", stops: [B("엄정")] }, { date: day(-6), vehicle_id: "V005", stops: [B("엄정")] }, { date: day(-7), vehicle_id: "V024", stops: [B("춘천")] });
  // 기준일자(지원 회차)와 지사 요청. confirmed = 편성 확정(확정된 지사만 경로의 피지원 기관으로 고를 수 있음)
  const rounds = [{ id: 2, name: day(0) + " 기준", start_date: day(0) }, { id: 1, name: day(-7) + " 기준", start_date: day(-7) }];
  const R = (round, name, o) => ({ round_id: round, branch_id: B(name), snow_cm: null, warning: false, req_truck: 0, req_blower: 0, assigned_truck: 0, assigned_blower: 0, arrive_at: null, reason: null, confirmed: false, ...o });
  const at = (k, hh) => { const [y, m, d] = day(k).split("-").map(Number); return new Date(y, m - 1, d, hh, 0).toISOString(); };
  const requests = [
    R(2, "대관령", { snow_cm: 12, req_truck: 4, req_blower: 6, assigned_truck: 6, assigned_blower: 4, arrive_at: at(0, 22), confirmed: true }),
    R(2, "양양",   { snow_cm: 15, req_truck: 8, req_blower: 2, assigned_truck: 8, assigned_blower: 2, arrive_at: at(0, 22), confirmed: true }),
    R(2, "엄정",   { req_truck: 1, assigned_truck: 1, arrive_at: at(0, 22), reason: "눈길사고 예방", confirmed: true }),
    R(2, "춘천",   { snow_cm: 6, req_truck: 2, arrive_at: at(1, 6) }),                                     // 요청만 하고 아직 확정 안 됨
    R(1, "엄정",   { req_truck: 1, assigned_truck: 1, arrive_at: at(-7, 20), confirmed: true }),
    R(1, "춘천",   { req_truck: 1, assigned_truck: 1, arrive_at: at(-7, 20), confirmed: true })
  ];
  // 수정 기록(서버의 접속·수정 기록과 같은 모양). 말풍선에는 오늘 기록만 나옴
  const T = (k, h, m) => { const [y, mo, d] = day(k).split("-").map(Number); return new Date(Math.min(new Date(y, mo - 1, d, h, m).getTime(), Date.now() - 60000)).toISOString(); };
  const A = (k, h, m, username, ip, kind, tab, target, from_val, to_val) => ({ at: T(k, h, m), username, ip, kind, tab, target, from_val, to_val });
  const rk = name => `round_requests:2,${B(name)}`;
  const audit = [
    A(-1, 16, 20, "exdaegwallyeong", "203.0.113.42", "수정", "round_requests", rk("대관령"), { req_truck: 2 }, { req_truck: 4 }),
    A(0, 0, 5, "exyangyang", "203.0.113.21", "수정", "round_requests", rk("양양"), { req_blower: 10 }, { req_blower: 12 }),
    A(0, 0, 10, "exyangyang", "203.0.113.21", "수정", "round_requests", rk("양양"), { req_blower: 12 }, { req_blower: 13 }),
    A(0, 0, 20, "admin-02", "203.0.113.11", "수정", "round_requests", rk("양양"), { req_blower: 13 }, { req_blower: 14 }),
    A(0, 0, 30, "admin-01", "203.0.113.10", "수정", "round_requests", rk("양양"), { req_blower: 14 }, { req_blower: 15 }),
    A(0, 0, 31, "admin-02", "203.0.113.11", "수정", "round_requests", rk("대관령"), { assigned_truck: 4 }, { assigned_truck: 6 }),
    A(0, 0, 40, "exseoulgigyae", "203.0.113.35", "수정", "vehicles", "vehicles:V001", { status: "" }, { status: "O" }),
    A(0, 0, 41, "exseoulgigyae", "203.0.113.35", "추가", "vehicle_routes", `vehicle_routes:${day(0)},V001`, null, { date: day(0), vehicle_id: "V001", stops: [B("양양")] }),
    A(0, 0, 42, "exseoulgigyae", "203.0.113.35", "수정", "vehicle_routes", `vehicle_routes:${day(0)},V001`, { stops: [B("양양")] }, { stops: [B("대관령")] })
  ].sort((x, y) => x.at.localeCompare(y.at));
  // 대설 특보(샘플): 기상청 특보구역 일부와 지사별 자동 구역, 지금 특보. 기준시각은 오늘 07:00
  const zones = [["L1020000", "강원도", "00000002", "L1000000"], ["L1022400", "평창", "00000003", "L1020000"], ["L1022410", "평창평지", "00000014", "L1022400"], ["L1022420", "평창산지", "00010014", "L1022400"],
    ["L1022500", "강릉", "00000103", "L1020000"], ["L1022510", "강릉평지", "00000114", "L1022500"], ["L1022520", "강릉산지", "00010014", "L1022500"], ["L1022300", "양양", "00000103", "L1020000"],
    ["L1022310", "양양평지", "00000114", "L1022300"], ["L1022320", "양양산지", "00010014", "L1022300"], ["L1022900", "인제", "00000003", "L1020000"], ["L1022910", "인제평지", "00000014", "L1022900"],
    ["L1022920", "인제산지", "00010014", "L1022900"], ["L1021400", "춘천", "00000013", "L1020000"], ["L1022700", "홍천", "00000003", "L1020000"], ["L1022710", "홍천평지", "00000014", "L1022700"],
    ["L1022720", "홍천산지", "00010014", "L1022700"], ["L1021300", "횡성", "00000013", "L1020000"], ["L1040000", "충청북도", "00000002", "L1000000"], ["L1041100", "충주", "00000013", "L1040000"],
    ["L1041200", "음성", "00000013", "L1040000"]].map(([zone_code, name, sp, up_code]) => ({ zone_code, name, sp, up_code }));
  const zoneAuto = { [B("대관령")]: ["L1022410", "L1022420", "L1022510", "L1022520", "L1021300"], [B("양양")]: ["L1022310", "L1022320", "L1022910", "L1022920"],
    [B("춘천")]: ["L1021400", "L1022710", "L1022720"], [B("엄정")]: ["L1041100", "L1041200"] };
  const warnActive = { "L1022420": "경보", "L1022520": "주의", "L1022320": "주의", "L1022920": "예비", "L1022710": "예비", "L1021300": "주의:강풍", "L1022310": "주의:건조", "L1022910": "경보:건조", "L1041100": "예비:호우", "L1041200": "주의:한파" };   // 단계[:종류] (종류 없으면 대설)
  const warnBase = day(0).replace(/-/g, "") + "0700";
  const kst = (k, hm) => new Date(`${day(k)}T${hm}:00+09:00`).toISOString();
  const warnFc = kst(0, "04:00"), warnEf = kst(0, "06:00"), warnEfPre = kst(0, "17:58");      // 발표 04:00, 발효 06:00, 예비특보 발효 = 오늘 오후(12~18시)
  // 이미 확정한 지사는 확정할 때의 특보가 고정돼 있음(대관령 = 주의보로 고정, 양양 = 특보 없음으로 고정, 엄정 = 자료 없음으로 특보 없음)
  const fix = (name, level, zs, note) => Object.assign(requests.find(r => r.round_id === 2 && r.branch_id === B(name)), { warn_level: level, warn_zones: zs, warn_base: warnBase, warn_at: at(0, 6), warn_note: note || null });
  // 예상 적설(샘플): 2시간 전 발표 단기예보, 다음 정시부터 24시간 신적설 합의 지사 최댓값. 확정한 지사는 확정 때 값 고정
  const hr = Math.floor(Date.now() / 3600e3) * 3600e3, fcTm = new Date(hr - 2 * 3600e3).toISOString(), fcStart = new Date(hr + 3600e3).toISOString(), fcEnd = new Date(hr + 25 * 3600e3).toISOString();   // 2시간 전 발표, 다음 정시부터 24시간
  // 최저기온(샘플): 24시간 중 가장 낮은 기온(℃)과 그 시각(시작 몇 시간 뒤)
  const forecast = [["대관령", 14.2, 18.5, -12, 6, 92, 131], ["양양", 9.0, 12.0, -4, 7, 93, 137], ["춘천", 3.5, 6.2, -7, 5, 73, 134], ["엄정", 0, 0.4, 1, 4, 76, 114], ["강릉", 11.3, 15.0, -3, 6, 92, 133]]
    .map(([n, v, p, t, th, nx, ny]) => ({ branch_id: B(n), issued_at: fcTm, max_snow_24h: v, max_pcp_24h: p, min_tmp: t, min_tmp_at: new Date(hr + (1 + th) * 3600e3).toISOString(), worst_nx: nx, worst_ny: ny, detail: { start_at: fcStart, end_at: fcEnd, pcp_nx: nx, pcp_ny: ny } }));
  [["대관령", 12.1, 16.0, -10], ["양양", 8.0, 10.5, -3], ["엄정", 0, 0, 2]].forEach(([n, v, p, t]) => Object.assign(requests.find(r => r.round_id === 2 && r.branch_id === B(n)), { fc_snow: v, fc_pcp: p, fc_tmin: t, fc_tmin_at: kst(1, "06:00"), fc_tmfc: kst(0, "05:00"), fc_at: at(0, 6) }));
  fix("대관령", "주의", [["L1022520", "강릉산지", "주의", "대설", kst(-1, "22:00"), kst(0, "01:00")]]); fix("양양", null, []); fix("엄정", null, [], "기상청 자료를 30분 넘게 받지 못함");
  return { hqs, branches, holdings, vehicles, routes, rounds, requests, audit, orgs: ["서울경기", "충북", "전북", "대구경북"], zones, zoneAuto, zoneOver: [], warnActive, warnBase, warnFc, warnEf, warnEfPre, forecast };
}
