-- ============================================================
-- Cloudflare D1 표(테이블) 설계 v1 — 아직 Cloudflare에 만들지 않은 "설계안"입니다.
-- 확정된 결정: 무료 플랜만 사용 / 운전원 정보 없음(차량번호만) / 수집 Worker는 쓰기 전용 /
--             과거 시즌 적설은 파일, 올해 시즌부터 D1 / 한 격자를 여러 기관이 함께 가질 수 있음
-- 설명 문서: docs/d1-schema-design.md   (이 파일은 SQLite 문법 검사를 통과하도록 시험했습니다)
-- ============================================================

/* ---------- A. 기준정보 (거의 안 바뀜, 관리자가 수정) ---------- */
CREATE TABLE hqs (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  is_private INTEGER NOT NULL DEFAULT 0,          -- 1 = 민자(구분만 하고 관측소·적설 계산 안 함)
  sort       INTEGER NOT NULL
);
CREATE TABLE branches (
  id         TEXT PRIMARY KEY,                    -- B001… (이름이 바뀌어도 변하지 않는 번호)
  hq_id      TEXT NOT NULL REFERENCES hqs(id),
  name       TEXT NOT NULL UNIQUE,
  status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','new','closed')),
  anchor_lat REAL, anchor_lon REAL,               -- 지도 중심
  radius_km  REAL,                                -- 관측소 배정 반경(5~8)
  created_at TEXT NOT NULL
);
CREATE INDEX idx_branches_hq ON branches(hq_id);
CREATE TABLE sections (                           -- IC/JC 사이 관할 구간 (약 1,011개)
  id        TEXT PRIMARY KEY,                     -- S0001…
  route     TEXT NOT NULL,
  from_name TEXT, to_name TEXT,
  km        REAL NOT NULL,
  owner_id  TEXT REFERENCES branches(id),         -- NULL = 미지정
  chain     TEXT NOT NULL, ord INTEGER NOT NULL,  -- Shift+클릭 범위 선택용 순서
  coords    TEXT NOT NULL                         -- JSON [[경도,위도],...]  (한 행 2MB 제한 안)
);
CREATE INDEX idx_sections_owner ON sections(owner_id);
CREATE TABLE jurisdiction_events (                -- 관할 변경 이력 (이동·신설·본부 이동)
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  at      TEXT NOT NULL, by_user TEXT NOT NULL,
  kind    TEXT NOT NULL CHECK (kind IN ('move','addBranch','moveHq')),
  payload TEXT NOT NULL,                          -- JSON
  note    TEXT
);
CREATE TABLE stations (                           -- 적설관측소 (약 680곳)
  id   INTEGER PRIMARY KEY, name TEXT NOT NULL, addr TEXT,
  lat  REAL NOT NULL, lon REAL NOT NULL
);
CREATE TABLE branch_stations (                    -- 지사별 배정 관측소 (규칙으로 계산한 결과를 저장)
  branch_id  TEXT NOT NULL REFERENCES branches(id),
  station_id INTEGER NOT NULL REFERENCES stations(id),
  dist_km    REAL NOT NULL, road TEXT,
  PRIMARY KEY (branch_id, station_id)
);

/* ---------- B. 예보 격자 편입 (관리자가 지도에서 골라 기관에 편입) ---------- */
CREATE TABLE grid_assign (                        -- 한 격자를 여러 기관이 가질 수 있음 (다대다)
  nx INTEGER NOT NULL, ny INTEGER NOT NULL,       -- 기상청 5km 격자 번호
  branch_id TEXT NOT NULL REFERENCES branches(id),
  PRIMARY KEY (nx, ny, branch_id)
);
CREATE INDEX idx_grid_branch ON grid_assign(branch_id);
CREATE TABLE grid_events (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  at      TEXT NOT NULL, by_user TEXT NOT NULL,
  kind    TEXT NOT NULL CHECK (kind IN ('cellAdd','cellRemove')),
  payload TEXT NOT NULL, note TEXT
);
CREATE TABLE warning_zones (                      -- 기상특보 구역(시·군 등)
  zone_code TEXT PRIMARY KEY, name TEXT NOT NULL
);
CREATE TABLE cell_zone (                          -- 격자 → 특보 구역 대응표 (제가 파일로 생성해 올림)
  nx INTEGER NOT NULL, ny INTEGER NOT NULL,
  zone_code TEXT NOT NULL REFERENCES warning_zones(zone_code),
  PRIMARY KEY (nx, ny, zone_code)
);

/* ---------- C. 기상 데이터 ---------- */
CREATE TABLE snow_daily (                         -- 올해 시즌 이후 일 신적설 (하루치 약 680행을 업로드)
  date TEXT NOT NULL, station_id INTEGER NOT NULL REFERENCES stations(id),
  value REAL,                                     -- NULL = 결측
  PRIMARY KEY (date, station_id)
);
CREATE TABLE snow_uploads (                       -- 업로드 기록
  id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, by_user TEXT NOT NULL,
  date_from TEXT, date_to TEXT, stations INTEGER, rows_written INTEGER, ok INTEGER NOT NULL, note TEXT
);
CREATE TABLE forecast_cells (                     -- 격자별 최신 적설 예보 (편입된 격자의 합집합만, 최신 발표 1건)
  nx INTEGER NOT NULL, ny INTEGER NOT NULL,
  issued_at TEXT NOT NULL,                        -- 기상청 발표 시각
  snow_24h REAL,                                  -- 앞으로 24시간 신적설(cm)
  series TEXT,                                    -- JSON 시간별 값
  updated_at TEXT NOT NULL,
  PRIMARY KEY (nx, ny)
);
CREATE TABLE branch_forecast (                    -- 기관별 집계 (소속 격자 중 최댓값과 그 격자)
  branch_id TEXT PRIMARY KEY REFERENCES branches(id),
  issued_at TEXT, max_snow_24h REAL, worst_nx INTEGER, worst_ny INTEGER,
  detail TEXT, updated_at TEXT NOT NULL
);
CREATE TABLE warnings_active (                    -- 지금 발효 중인 특보
  zone_code TEXT NOT NULL, kind TEXT NOT NULL,    -- kind: 대설 / 한파 / 강풍 …
  level TEXT NOT NULL,                            -- 주의보 / 경보
  issued_at TEXT, updated_at TEXT NOT NULL,
  PRIMARY KEY (zone_code, kind)
);
CREATE TABLE warnings_history (                   -- 끝난 특보 기록
  id INTEGER PRIMARY KEY AUTOINCREMENT, zone_code TEXT NOT NULL, kind TEXT NOT NULL, level TEXT NOT NULL,
  started_at TEXT, ended_at TEXT
);
CREATE TABLE collector_state (                    -- 나눠서 실행할 때 "어디까지 했는지"
  job TEXT PRIMARY KEY, cursor TEXT, started_at TEXT, finished_at TEXT, ok INTEGER, note TEXT
);
CREATE TABLE collector_runs (                     -- 실행 기록 (성공·실패·소요시간)
  id INTEGER PRIMARY KEY AUTOINCREMENT, job TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT,
  ok INTEGER NOT NULL DEFAULT 0, http_status INTEGER, ms INTEGER, calls INTEGER, error TEXT
);
CREATE INDEX idx_runs_started ON collector_runs(started_at);

/* ---------- 읽기용 요약본: 화면이 열릴 때 "한 줄만" 읽도록 미리 만들어 둔 JSON ---------- */
CREATE TABLE snapshots (
  key TEXT PRIMARY KEY,                           -- 'reference'(기준정보) / 'grid'(격자 편입) / 'snow:2026-27'(올해 시즌)
  version INTEGER NOT NULL, built_at TEXT NOT NULL,
  body TEXT NOT NULL                              -- JSON, 2MB 이하
);

/* ---------- D. 장비 지원 (운전원 정보 없음, 차량번호만) ---------- */
CREATE TABLE equip_orgs (name TEXT PRIMARY KEY);  -- 지원하는 기관(기계화부) 이름
CREATE TABLE vehicles (
  plate  TEXT PRIMARY KEY,                        -- 차량번호
  org    TEXT NOT NULL REFERENCES equip_orgs(name),
  type   TEXT NOT NULL CHECK (type IN ('제설차','제설기','이동정비차')),
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE support_rounds (                     -- "지원 회차": 눈이 올 때마다 만드는 지원 건
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
  start_date TEXT NOT NULL, end_date TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  created_by TEXT, created_at TEXT NOT NULL
);
CREATE TABLE round_vehicles (
  round_id INTEGER NOT NULL REFERENCES support_rounds(id),
  plate TEXT NOT NULL REFERENCES vehicles(plate),
  status TEXT NOT NULL DEFAULT '' CHECK (status IN ('','O','X')),   -- '' 미정 / O 지원 / X 지원 불가
  PRIMARY KEY (round_id, plate)
);
CREATE TABLE round_vehicle_days (                 -- 지원 일자별 지원 기관 (하루에 여러 기관은 seq 로 순서)
  round_id INTEGER NOT NULL, plate TEXT NOT NULL,
  date TEXT NOT NULL, seq INTEGER NOT NULL,
  dest_branch_id TEXT REFERENCES branches(id),
  PRIMARY KEY (round_id, plate, date, seq),
  FOREIGN KEY (round_id, plate) REFERENCES round_vehicles(round_id, plate)
);
CREATE TABLE round_requests (                     -- 기관별 요청·편성
  round_id INTEGER NOT NULL REFERENCES support_rounds(id),
  branch_id TEXT NOT NULL REFERENCES branches(id),
  snow_cm REAL, warning INTEGER NOT NULL DEFAULT 0,
  req_truck INTEGER NOT NULL DEFAULT 0, req_blower INTEGER NOT NULL DEFAULT 0,
  assigned_truck INTEGER NOT NULL DEFAULT 0, assigned_blower INTEGER NOT NULL DEFAULT 0,
  arrive_at TEXT, reason TEXT, updated_by TEXT, updated_at TEXT,
  PRIMARY KEY (round_id, branch_id)
);

/* ---------- E. 보안·기록 ---------- */
CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,   -- 이름 대신 기관코드+번호 권장 (예: gw-01)
  display_name  TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin','branch','equip')),
  branch_id     TEXT REFERENCES branches(id),          -- role 이 branch 일 때 본인 지사
  password_hash TEXT NOT NULL,                         -- 비밀번호 원문은 저장하지 않음
  must_change   INTEGER NOT NULL DEFAULT 0, disabled INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL, created_by TEXT, last_login_at TEXT
);
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, expires_at TEXT NOT NULL, ip TEXT
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE TABLE login_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, username TEXT NOT NULL, ip TEXT NOT NULL, ok INTEGER NOT NULL
);
CREATE INDEX idx_attempts_user ON login_attempts(username, at);
CREATE INDEX idx_attempts_ip   ON login_attempts(ip, at);
CREATE TABLE audit_log (                          -- 접속·수정 기록 (서버가 추가만 함)
  id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, username TEXT,
  kind TEXT NOT NULL, tab TEXT, target TEXT, from_val TEXT, to_val TEXT, ip TEXT
);
CREATE INDEX idx_audit_at ON audit_log(at);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT);
