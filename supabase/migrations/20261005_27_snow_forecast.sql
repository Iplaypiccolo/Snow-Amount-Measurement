-- ============================================================
-- 27. 예상 적설 = 기상청 단기예보 격자(nph-dfs_shrt_grd, SNO = 1시간 신적설 cm) 24시간 합의 지사별 최댓값 (2026-10-05 사용자 결정)
--  * 단기예보는 하루 8번(02·05·08·11·14·17·20·23시) 발표, 자료는 발표 10분쯤 뒤부터.
--  * 받는 때: 특보와 같은 조건(private.warn_needed — 기준일자를 만든 시각부터 확정까지)일 때
--      기준일자를 만들면 바로 + 발표 시각 15·25·35·45분(아직 다 못 받았으면 이어서).
--  * 한 번 모으기(run) = 가장 최근 발표분에서 "받기 시작한 시각의 다음 정시부터 24시간" = 1시간치 24번 요청
--      (요청 1번 = 전국 149×253 격자 1시간치. 그중 지사 격자(grid_assign) 934칸만 골라 forecast_hours 에 한 줄씩)
--      24시간이 다 모이면 격자마다 합 → 지사마다 가장 큰 격자 = branch_forecast. 지난 모으기는 지움(DB 가 늘지 않음).
--  * 확정할 때 그 순간 예상 적설을 round_requests.fc_snow·fc_tmfc·fc_at 에 고정(특보와 같은 트리거).
--    지사가 직접 넣던 snow_cm 열은 그대로 둠(나중에 지사 입력을 다시 붙일 때 씀).
--  * 화면은 branch_forecast(59줄)만 읽음. 발표 후 12시간이 지난 예보는 쓰지 않음.
-- ============================================================

/* ---------- 1. 모으기 표(서버 전용) ---------- */
create table if not exists public.forecast_runs (
  tmfc timestamptz primary key,                       -- 발표 시각
  start_at timestamptz not null,                      -- 24시간 시작(받기 시작한 시각의 다음 정시)
  cells jsonb not null,                               -- [[nx, ny]…] — forecast_hours.vals 가 이 순서
  created_at timestamptz not null default now(),
  done_at timestamptz
);
create table if not exists public.forecast_hours (
  tmfc timestamptz not null references public.forecast_runs(tmfc) on delete cascade,
  tmef timestamptz not null,                          -- 예보 시각(그 1시간 동안 새로 쌓일 눈)
  vals real[] not null,
  primary key (tmfc, tmef)
);
alter table public.forecast_runs enable row level security;
alter table public.forecast_hours enable row level security;
create policy forecast_runs_read on public.forecast_runs for select to authenticated using ((select private.my_role()) = 'admin');
revoke insert, update, delete on public.forecast_runs, public.forecast_hours from authenticated, anon;

/* ---------- 2. 확정 고정 열 ---------- */
alter table public.round_requests
  add column if not exists fc_snow  double precision,  -- 확정 순간 예상 적설(cm, 24시간 합의 지사 최댓값)
  add column if not exists fc_tmfc  timestamptz,       -- 그 예보의 발표 시각
  add column if not exists fc_at    timestamptz;       -- 고정한 시각(null 이면 고정 안 됨)

/* ---------- 3. 시각 도우미 ---------- */
-- 지금 쓸 수 있는 가장 최근 발표 시각(02·05·…·23시, 발표 10분 뒤부터)
create or replace function private.fc_latest_tmfc(p_now timestamptz default now()) returns timestamptz
language sql stable set search_path = ''
as $$
  select ((h - make_interval(hours => ((extract(hour from h)::int - 2 + 24) % 3))) at time zone 'Asia/Seoul')
    from (select date_trunc('hour', (p_now - interval '10 minutes') at time zone 'Asia/Seoul') as h) x
$$;

-- 지사별 지금 예상 적설(발표 후 12시간 안의 것만)
create or replace function private.branch_fc(p_branch text) returns jsonb
language sql stable security definer set search_path = ''
as $$
  select case when f.issued_at >= now() - interval '12 hours'
              then jsonb_build_object('snow', f.max_snow_24h, 'tmfc', f.issued_at) end
    from public.branch_forecast f where f.branch_id = p_branch
$$;
revoke all on function private.branch_fc(text) from public, anon, authenticated;

/* ---------- 4. Edge Function 이 부르는 DB 함수(서버 전용) ---------- */
-- 이번에 받을 것: { done } 또는 { tmfc, start_at, cells, missing:[tmef…] }
create or replace function public.forecast_plan() returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare t timestamptz := private.fc_latest_tmfc(); r public.forecast_runs;
begin
  select * into r from public.forecast_runs where tmfc = t;
  if found and r.done_at is not null then return jsonb_build_object('done', true, 'tmfc', t); end if;
  if not found then
    insert into public.forecast_runs (tmfc, start_at, cells)
    select t, date_trunc('hour', now()) + interval '1 hour',
           coalesce(jsonb_agg(jsonb_build_array(c.nx, c.ny) order by c.ny, c.nx), '[]'::jsonb)
      from (select distinct nx, ny from public.grid_assign) c
    returning * into r;
  end if;
  return jsonb_build_object('done', false, 'tmfc', r.tmfc, 'start_at', r.start_at, 'cells', r.cells,
    'missing', (select coalesce(jsonb_agg(h order by h), '[]'::jsonb)
                  from generate_series(r.start_at, r.start_at + interval '23 hours', interval '1 hour') h
                 where not exists (select 1 from public.forecast_hours x where x.tmfc = r.tmfc and x.tmef = h)));
end $$;

-- 1시간치 넣기. 24시간이 다 모이면 지사별 최댓값을 만들고 끝냄
create or replace function public.forecast_put(p_tmfc timestamptz, p_tmef timestamptz, p_vals real[]) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare r public.forecast_runs; n int;
begin
  select * into r from public.forecast_runs where tmfc = p_tmfc;
  if not found then raise exception 'unknown run' using errcode = '23503'; end if;
  if r.done_at is not null then return jsonb_build_object('ok', true, 'done', true); end if;
  if array_length(p_vals, 1) is distinct from jsonb_array_length(r.cells) then raise exception 'bad vals' using errcode = '22023'; end if;
  insert into public.forecast_hours (tmfc, tmef, vals) values (p_tmfc, p_tmef, p_vals)
  on conflict (tmfc, tmef) do update set vals = excluded.vals;
  select count(*) into n from public.forecast_hours where tmfc = p_tmfc and tmef >= r.start_at and tmef < r.start_at + interval '24 hours';
  if n < 24 then return jsonb_build_object('ok', true, 'hours', n); end if;

  -- 격자마다 24시간 합(음수 = 바다·없음 → 0) → 지사마다 가장 큰 격자
  with cell as (
    select (c.value ->> 0)::int as nx, (c.value ->> 1)::int as ny, c.ordinality::int as i
      from jsonb_array_elements(r.cells) with ordinality c),
  sums as (
    select cell.nx, cell.ny, sum(greatest(h.vals[cell.i], 0)) as s
      from cell join public.forecast_hours h on h.tmfc = p_tmfc and h.tmef >= r.start_at and h.tmef < r.start_at + interval '24 hours'
     group by cell.nx, cell.ny),
  best as (
    select distinct on (g.branch_id) g.branch_id, s.s, s.nx, s.ny
      from public.grid_assign g join sums s on s.nx = g.nx and s.ny = g.ny
     order by g.branch_id, s.s desc, s.ny, s.nx)
  insert into public.branch_forecast as f (branch_id, issued_at, max_snow_24h, worst_nx, worst_ny, detail, updated_at)
  select b.branch_id, p_tmfc, round(b.s::numeric, 1), b.nx, b.ny, jsonb_build_object('start_at', r.start_at, 'end_at', r.start_at + interval '24 hours'), now()
    from best b
  on conflict (branch_id) do update set issued_at = excluded.issued_at, max_snow_24h = excluded.max_snow_24h, worst_nx = excluded.worst_nx,
    worst_ny = excluded.worst_ny, detail = excluded.detail, updated_at = now();
  delete from public.branch_forecast f where not exists (select 1 from public.grid_assign g where g.branch_id = f.branch_id);

  update public.forecast_runs set done_at = now() where tmfc = p_tmfc;
  delete from public.forecast_runs where tmfc < p_tmfc;                      -- 지난 모으기(1시간치들도 함께) 지움
  insert into public.collector_state as s (job, cursor, started_at, finished_at, ok, note)
  values ('forecast', to_char(p_tmfc at time zone 'Asia/Seoul', 'YYYYMMDDHH24'), r.created_at, now(), true, null)
  on conflict (job) do update set cursor = excluded.cursor, started_at = excluded.started_at, finished_at = now(), ok = true, note = null;
  return jsonb_build_object('ok', true, 'done', true);
end $$;

create or replace function public.forecast_fail(p_note text) returns void
language sql security definer set search_path = ''
as $$
  insert into public.collector_state as s (job, started_at, ok, note) values ('forecast', now(), false, left(p_note, 500))
  on conflict (job) do update set started_at = now(), ok = false, note = left(p_note, 500);
  insert into public.collector_runs (job, started_at, finished_at, ok, calls, error) values ('forecast', now(), now(), false, 1, left(p_note, 500));
  delete from public.collector_runs where job = 'forecast' and started_at < now() - interval '7 days';
$$;

revoke all on function public.forecast_plan(), public.forecast_put(timestamptz, timestamptz, real[]), public.forecast_fail(text) from public, anon, authenticated;
grant execute on function public.forecast_plan(), public.forecast_put(timestamptz, timestamptz, real[]), public.forecast_fail(text) to service_role;

/* ---------- 5. 확정할 때 예상 적설도 고정(특보 트리거에 더함) ---------- */
create or replace function private.round_requests_warn() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare w jsonb; f jsonb;
begin
  if new.confirmed and (tg_op = 'INSERT' or not old.confirmed) then
    w := private.branch_warn(new.branch_id);
    new.warn_level := w ->> 'level'; new.warn_zones := w -> 'zones'; new.warn_base := w ->> 'base';
    new.warn_note := w ->> 'note'; new.warn_at := now();
    f := private.branch_fc(new.branch_id);
    new.fc_snow := (f ->> 'snow')::double precision; new.fc_tmfc := (f ->> 'tmfc')::timestamptz; new.fc_at := now();
  elsif not new.confirmed then
    new.warn_level := null; new.warn_zones := null; new.warn_base := null; new.warn_note := null; new.warn_at := null;
    new.fc_snow := null; new.fc_tmfc := null; new.fc_at := null;
  else
    new.warn_level := old.warn_level; new.warn_zones := old.warn_zones; new.warn_base := old.warn_base;
    new.warn_note := old.warn_note; new.warn_at := old.warn_at;
    new.fc_snow := old.fc_snow; new.fc_tmfc := old.fc_tmfc; new.fc_at := old.fc_at;
  end if;
  return new;
end $$;
revoke all on function private.round_requests_warn() from public, anon;

/* ---------- 6. 언제 받나 ---------- */
create or replace function private.kick_forecast() returns bigint
language plpgsql security definer set search_path = ''
as $$
begin
  if not private.warn_needed() then return null; end if;
  if exists (select 1 from public.forecast_runs where tmfc = private.fc_latest_tmfc() and done_at is not null) then return null; end if;
  if coalesce((select started_at from public.collector_state where job = 'forecast_kick'), 'epoch') > now() - interval '3 minutes' then return null; end if;   -- 아직 받는 중
  insert into public.collector_state as s (job, started_at) values ('forecast_kick', now())
  on conflict (job) do update set started_at = now();
  return net.http_post(
    url := 'https://yzwbnohzhnctdvufntig.supabase.co/functions/v1/collect-forecast',
    body := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-collector-token', (select token from private.collector_token where id = 1)),
    timeout_milliseconds := 150000);
end $$;
revoke all on function private.kick_forecast() from public, anon, authenticated;

-- 기준일자를 만들면 특보와 예상 적설을 바로 한 번
create or replace function private.warn_kick_on_round() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if private.warn_needed() then
    if coalesce((select started_at from public.collector_state where job = 'warnings_kick'), 'epoch') < now() - interval '1 minute' then
      perform private.kick_warnings(false);
    end if;
    perform private.kick_forecast();
  end if;
  return null;
end $$;
revoke all on function private.warn_kick_on_round() from public, anon, authenticated;

-- pg_cron 은 UTC 기준이지만 한국 02·05·…·23시는 UTC 로도 3의 배수+2 시라 같은 목록
select cron.unschedule(jobid) from cron.job where jobname = 'collect-forecast';
select cron.schedule('collect-forecast', '15,25,35,45 2,5,8,11,14,17,20,23 * * *', 'select private.kick_forecast()');
