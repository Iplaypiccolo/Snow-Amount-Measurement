-- ============================================================
-- snow-support (서울) — 표 정의 v1
-- 설계: docs/d1-schema-design.md 를 Postgres 로 옮김. 로그인·세션·시도 제한은 Supabase Auth 가 담당하므로 표가 없음.
-- 운전원 정보 없음(차량번호만). 모든 표는 02 에서 RLS(행 단위 권한)를 켭니다.
-- ============================================================

/* ---------- A. 기준정보 (관리자가 수정) ---------- */
create table public.hqs (
  id         text primary key,
  name       text not null unique,
  is_private boolean not null default false,        -- true = 민자(구분만 하고 관측소·적설 계산 안 함)
  sort       integer not null
);
create table public.branches (
  id         text primary key,                      -- B001… (이름이 바뀌어도 변하지 않는 번호)
  hq_id      text not null references public.hqs(id),
  name       text not null unique,
  status     text not null default 'active' check (status in ('active','new','closed')),
  anchor_lat double precision, anchor_lon double precision,
  radius_km  double precision,
  created_at timestamptz not null default now()
);
create index branches_hq_idx on public.branches(hq_id);
create table public.sections (                      -- IC/JC 사이 관할 구간
  id        text primary key,                       -- S0001…
  route     text not null,
  from_name text, to_name text,
  km        double precision not null,
  owner_id  text references public.branches(id),    -- null = 미지정
  chain     text not null, ord integer not null,
  coords    jsonb not null                          -- [[경도,위도],...]
);
create index sections_owner_idx on public.sections(owner_id);
create table public.jurisdiction_events (
  id      bigint generated always as identity primary key,
  at      timestamptz not null default now(),
  by_user uuid,
  kind    text not null check (kind in ('move','addBranch','moveHq')),
  payload jsonb not null, note text
);
create table public.stations (
  id   integer primary key, name text not null, addr text,
  lat  double precision not null, lon double precision not null
);
create table public.branch_stations (
  branch_id  text not null references public.branches(id) on delete cascade,
  station_id integer not null references public.stations(id),
  dist_km    double precision not null, road text,
  primary key (branch_id, station_id)
);
create index branch_stations_station_idx on public.branch_stations(station_id);

/* ---------- B. 예보 격자 편입 (한 격자를 여러 기관이 공유 가능) ---------- */
create table public.grid_assign (
  nx integer not null check (nx between 1 and 149),
  ny integer not null check (ny between 1 and 253),
  branch_id text not null references public.branches(id) on delete cascade,
  primary key (nx, ny, branch_id)
);
create index grid_assign_branch_idx on public.grid_assign(branch_id);
create table public.grid_events (
  id      bigint generated always as identity primary key,
  at      timestamptz not null default now(),
  by_user uuid,
  kind    text not null check (kind in ('cellAdd','cellRemove')),
  payload jsonb not null, note text
);
create table public.warning_zones (zone_code text primary key, name text not null);
create table public.cell_zone (
  nx integer not null, ny integer not null,
  zone_code text not null references public.warning_zones(zone_code),
  primary key (nx, ny, zone_code)
);

/* ---------- C. 기상 데이터 ---------- */
create table public.snow_daily (                    -- 올해 시즌부터의 일 신적설 (과거 시즌은 파일)
  date date not null,
  station_id integer not null references public.stations(id),
  value double precision,                           -- null = 결측
  primary key (date, station_id)
);
create table public.snow_uploads (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(), by_user uuid,
  date_from date, date_to date, stations integer, rows_written integer,
  ok boolean not null, note text
);
create table public.forecast_cells (
  nx integer not null, ny integer not null,
  issued_at timestamptz, snow_24h double precision, series jsonb,
  updated_at timestamptz not null default now(),
  primary key (nx, ny)
);
create table public.branch_forecast (
  branch_id text primary key references public.branches(id) on delete cascade,
  issued_at timestamptz, max_snow_24h double precision, worst_nx integer, worst_ny integer,
  detail jsonb, updated_at timestamptz not null default now()
);
create table public.warnings_active (
  zone_code text not null, kind text not null, level text not null,
  issued_at timestamptz, updated_at timestamptz not null default now(),
  primary key (zone_code, kind)
);
create table public.warnings_history (
  id bigint generated always as identity primary key,
  zone_code text not null, kind text not null, level text not null,
  started_at timestamptz, ended_at timestamptz
);
create table public.collector_state (
  job text primary key, cursor text, started_at timestamptz, finished_at timestamptz, ok boolean, note text
);
create table public.collector_runs (
  id bigint generated always as identity primary key,
  job text not null, started_at timestamptz not null, finished_at timestamptz,
  ok boolean not null default false, http_status integer, ms integer, calls integer, error text
);
create index collector_runs_started_idx on public.collector_runs(started_at);
create table public.snapshots (                     -- 화면이 열릴 때 "한 줄만" 읽는 요약본
  key text primary key, version integer not null,
  built_at timestamptz not null default now(), body jsonb not null
);

/* ---------- D. 장비 지원 (운전원 정보 없음) ---------- */
create table public.equip_orgs (name text primary key);
create table public.vehicles (
  plate  text primary key,
  org    text not null references public.equip_orgs(name),
  type   text not null check (type in ('제설차','제설기','이동정비차')),
  active boolean not null default true
);
create table public.support_rounds (                -- 지원 회차: 눈이 올 때마다 만드는 지원 건
  id bigint generated always as identity primary key,
  name text not null, start_date date not null, end_date date,
  status text not null default 'open' check (status in ('open','closed')),
  created_by uuid, created_at timestamptz not null default now()
);
create table public.round_vehicles (
  round_id bigint not null references public.support_rounds(id) on delete cascade,
  plate    text not null references public.vehicles(plate),
  status   text not null default '' check (status in ('','O','X')),   -- '' 미정 / O 지원 / X 지원 불가
  primary key (round_id, plate)
);
create table public.round_vehicle_days (
  round_id bigint not null, plate text not null,
  date date not null, seq integer not null,
  dest_branch_id text references public.branches(id),
  primary key (round_id, plate, date, seq),
  foreign key (round_id, plate) references public.round_vehicles(round_id, plate) on delete cascade
);
create index round_vehicle_days_dest_idx on public.round_vehicle_days(dest_branch_id);
create table public.round_requests (
  round_id  bigint not null references public.support_rounds(id) on delete cascade,
  branch_id text   not null references public.branches(id),
  snow_cm double precision, warning boolean not null default false,
  req_truck integer not null default 0 check (req_truck >= 0),
  req_blower integer not null default 0 check (req_blower >= 0),
  assigned_truck integer not null default 0 check (assigned_truck >= 0),
  assigned_blower integer not null default 0 check (assigned_blower >= 0),
  arrive_at timestamptz, reason text check (reason is null or length(reason) <= 200),
  updated_by uuid, updated_at timestamptz not null default now(),
  primary key (round_id, branch_id)
);
create index round_requests_branch_idx on public.round_requests(branch_id);

/* ---------- E. 보안·기록 ---------- */
create table public.profiles (                      -- 로그인 계정(Supabase Auth)의 역할·소속
  id           uuid primary key references auth.users(id) on delete cascade,
  username     text not null unique check (username = lower(username) and username ~ '^[a-z0-9._-]{3,32}$'),
  display_name text not null check (length(display_name) between 1 and 40),
  role         text not null check (role in ('admin','branch','equip')),
  branch_id    text references public.branches(id),
  disabled     boolean not null default false,
  created_at   timestamptz not null default now(),
  constraint branch_role_needs_branch check ((role = 'branch') = (branch_id is not null))
);
create index profiles_branch_idx on public.profiles(branch_id);
create table public.audit_log (                     -- 접속·수정 기록. DB 트리거가 기록하고, 고치거나 지울 수 없음
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  user_id uuid, username text, role text,
  kind text not null, tab text, target text,
  from_val jsonb, to_val jsonb, ip text
);
create index audit_log_at_idx on public.audit_log(at);
create table public.settings (key text primary key, value jsonb not null, updated_at timestamptz not null default now());
