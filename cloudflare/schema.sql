-- ============================================================
-- D1 데이터베이스 표(테이블) 정의 — 여러 번 실행해도 안전합니다 (IF NOT EXISTS)
-- 실행: npx wrangler d1 execute snow-ops --remote --file=cloudflare/schema.sql
-- ============================================================

-- 계정. 비밀번호는 원문이 아니라 "해시"(되돌릴 수 없는 암호 지문)만 저장합니다.
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,      -- 로그인 아이디 (소문자·숫자·._-, 3~32자)
  display_name  TEXT NOT NULL,                            -- 화면에 보일 이름
  role          TEXT NOT NULL CHECK (role IN ('admin','branch','equip')),   -- 관리자 / 피지원지사 / 지원장비
  branch        TEXT,                                     -- role 이 branch 일 때 본인 지사 이름
  password_hash TEXT NOT NULL,                            -- 형식: pbkdf2-sha256$반복횟수$salt$hash
  must_change   INTEGER NOT NULL DEFAULT 0,               -- 1 이면 다음 로그인 때 비밀번호를 바꿔야 함
  disabled      INTEGER NOT NULL DEFAULT 0,               -- 1 이면 로그인 불가
  created_at    TEXT NOT NULL,
  created_by    TEXT,
  last_login_at TEXT
);

-- 로그인 상태(세션). 브라우저 쿠키 값의 해시만 저장하므로 DB가 유출돼도 쿠키를 만들 수 없습니다.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash   TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id),
  created_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  ip           TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- 로그인 시도 기록 (실패 횟수 제한용)
CREATE TABLE IF NOT EXISTS login_attempts (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  at       TEXT NOT NULL,
  username TEXT NOT NULL,
  ip       TEXT NOT NULL,
  ok       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attempts_user ON login_attempts(username, at);
CREATE INDEX IF NOT EXISTS idx_attempts_ip   ON login_attempts(ip, at);

-- 접속·수정 기록 (누가·언제·무엇을·어디서). 추가만 하고 고치거나 지우는 기능은 만들지 않습니다.
CREATE TABLE IF NOT EXISTS audit_log (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  at       TEXT NOT NULL,
  username TEXT,
  kind     TEXT NOT NULL,        -- 접속 / 접속실패 / 로그아웃 / 계정생성 / 비밀번호변경 / 비밀번호초기화 / 계정비활성화 / 계정활성화 / 수정 / 조회 ...
  tab      TEXT,
  target   TEXT,
  from_val TEXT,
  to_val   TEXT,
  ip       TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at);

-- 기상청 자료 수집 기록 (수집 Worker 가 기록)
CREATE TABLE IF NOT EXISTS collector_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  source      TEXT NOT NULL,      -- cron(자동) / manual(수동)
  ok          INTEGER NOT NULL DEFAULT 0,
  http_status INTEGER,
  ms          INTEGER,
  bytes       INTEGER,
  url_masked  TEXT,               -- 인증키는 *** 로 가린 주소
  snippet     TEXT,               -- 응답 앞부분 (형식 확인용)
  error       TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_started ON collector_runs(started_at);
