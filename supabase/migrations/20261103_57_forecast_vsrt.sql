-- ============================================================
-- 57. 초단기예보 받기 — 기관별 24시간 예보 탭에서 단기예보와 바꿔 볼 수 있게 (2026-11-03 사용자 요청)
--  * 기본은 그대로 단기예보: forecast_cells·branch_forecast·지사별 요청·편성·확정 고정값은 전혀 바뀌지 않음(private.fc_apply 안 건드림)
--  * 기상청 초단기예보 격자(nph-dfs_vsrt_grd, 10분 간격 발표, 발표 시각의 다음 정시부터 6시간)의 T1H(기온)·RN1(1시간 강수)·POP(강수확률)을 받음
--    한 번에 3종류 × 6시각 = 18번 요청. 지사 격자만 골라 최신 발표분만 보관(다음 발표분을 다 받으면 예전 것은 지움)
--  * 값은 미리 계산해 두지 않고 볼 때 계산(forecast_vsrt_overview·forecast_vsrt_grid) — 10분마다 표를 다시 쓰지 않아 DB 부담이 없음
--  * 적설은 초단기예보에 없어 빈 값. 3시간 넘게 못 받았으면 '자료 없음'
--  * 함정: 기상청은 6시간을 넘는 시각도 200 으로 0 을 돌려줌 → forecast_vsrt_put 이 다음 정시 +6시간 밖을 거절
--  * 함정: 아직 안 나온 발표분도 200 으로 '# dfs_file_read error' 를 돌려줌 → 수집 함수가 한 칸 앞 발표분을 받음
--  * 시험: supabase/tests/forecast_vsrt_test.sql
-- ============================================================

/* ---------- 1. 표: 최신 발표분만 보관, 계정은 직접 읽지 않음(아래 함수로만) ---------- */
create table if not exists public.forecast_vsrt_runs (
  tmfc timestamptz primary key,                       -- 발표 시각(10분 간격)
  cells jsonb not null,                               -- [[nx, ny]…] — forecast_vsrt_hours.vals 가 이 순서
  created_at timestamptz not null default now(),
  done_at timestamptz
);
create table if not exists public.forecast_vsrt_hours (
  tmfc timestamptz not null references public.forecast_vsrt_runs(tmfc) on delete cascade,
  var text not null check (var in ('T1H', 'RN1', 'POP')),
  tmef timestamptz not null,
  vals real[] not null,
  primary key (tmfc, var, tmef)
);
alter table public.forecast_vsrt_runs enable row level security;
alter table public.forecast_vsrt_hours enable row level security;
revoke all on public.forecast_vsrt_runs, public.forecast_vsrt_hours from authenticated, anon;

/* ---------- 2. 받을 발표분: 지금 10분 칸부터 20분 앞까지, 이미 다 받은 것보다 새 것만(새 것부터) ---------- */
create or replace function public.forecast_vsrt_plan() returns jsonb
language sql security definer set search_path = ''
as $$
  select jsonb_build_object('candidates', coalesce(jsonb_agg(c.t order by c.t desc), '[]'::jsonb))
    from (select to_timestamp(floor(extract(epoch from now()) / 600) * 600) - (n * interval '10 minutes') as t from generate_series(0, 2) n) c
   where c.t > coalesce((select max(r.tmfc) from public.forecast_vsrt_runs r where r.done_at is not null), 'epoch');
$$;

/* ---------- 3. 한 발표분 시작(이미 있으면 이어서): 격자와 아직 없는 [종류, 시각] ---------- */
create or replace function public.forecast_vsrt_begin(p_tmfc timestamptz) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare r public.forecast_vsrt_runs; h0 timestamptz := date_trunc('hour', p_tmfc) + interval '1 hour';
begin
  insert into public.forecast_vsrt_runs (tmfc, cells)
  select p_tmfc, coalesce(jsonb_agg(jsonb_build_array(c.nx, c.ny) order by c.ny, c.nx), '[]'::jsonb)
    from (select distinct e.nx, e.ny from private.grid_effective() e) c
  on conflict (tmfc) do nothing;
  select * into r from public.forecast_vsrt_runs where tmfc = p_tmfc;
  return jsonb_build_object('tmfc', r.tmfc, 'cells', r.cells,
    'missing', (select coalesce(jsonb_agg(jsonb_build_array(v, h) order by h, v), '[]'::jsonb)
                  from generate_series(h0, h0 + interval '5 hours', interval '1 hour') h, unnest(array['T1H', 'RN1', 'POP']) v
                 where not exists (select 1 from public.forecast_vsrt_hours x where x.tmfc = p_tmfc and x.var = v and x.tmef = h)));
end $$;

/* ---------- 4. 1시간치 넣기: 18개가 다 모이면 끝 표시, 예전 발표분 지움 ---------- */
create or replace function public.forecast_vsrt_put(p_tmfc timestamptz, p_var text, p_tmef timestamptz, p_vals real[]) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare r public.forecast_vsrt_runs; n int; h0 timestamptz := date_trunc('hour', p_tmfc) + interval '1 hour';
begin
  select * into r from public.forecast_vsrt_runs where tmfc = p_tmfc;
  if not found then raise exception 'unknown run' using errcode = '23503'; end if;
  if r.done_at is not null then return jsonb_build_object('ok', true, 'done', true); end if;
  if p_var not in ('T1H', 'RN1', 'POP') then raise exception 'bad var' using errcode = '22023'; end if;
  if p_tmef < h0 or p_tmef > h0 + interval '5 hours' then raise exception 'bad tmef' using errcode = '22023'; end if;
  if array_length(p_vals, 1) is distinct from jsonb_array_length(r.cells) then raise exception 'bad vals' using errcode = '22023'; end if;
  insert into public.forecast_vsrt_hours (tmfc, var, tmef, vals) values (p_tmfc, p_var, p_tmef, p_vals)
  on conflict (tmfc, var, tmef) do update set vals = excluded.vals;
  select count(*) into n from public.forecast_vsrt_hours where tmfc = p_tmfc;
  if n < 18 then return jsonb_build_object('ok', true, 'hours', n); end if;

  update public.forecast_vsrt_runs set done_at = now() where tmfc = p_tmfc;
  delete from public.forecast_vsrt_runs where tmfc < p_tmfc;
  insert into public.collector_state as s (job, cursor, started_at, finished_at, ok, note)
  values ('forecast_vsrt', to_char(p_tmfc at time zone 'Asia/Seoul', 'YYYYMMDDHH24MI'), r.created_at, now(), true, null)
  on conflict (job) do update set cursor = excluded.cursor, started_at = excluded.started_at, finished_at = now(), ok = true, note = null;
  return jsonb_build_object('ok', true, 'done', true);
end $$;

create or replace function public.forecast_vsrt_fail(p_note text) returns void
language sql security definer set search_path = ''
as $$
  insert into public.collector_state as s (job, started_at, ok, note) values ('forecast_vsrt', now(), false, left(p_note, 500))
  on conflict (job) do update set started_at = now(), ok = false, note = left(p_note, 500);
  insert into public.collector_runs (job, started_at, finished_at, ok, calls, error) values ('forecast_vsrt', now(), now(), false, 1, left(p_note, 500));
  delete from public.collector_runs where job = 'forecast_vsrt' and started_at < now() - interval '7 days';
$$;

revoke all on function public.forecast_vsrt_plan(), public.forecast_vsrt_begin(timestamptz), public.forecast_vsrt_put(timestamptz, text, timestamptz, real[]), public.forecast_vsrt_fail(text) from public, anon, authenticated;
grant execute on function public.forecast_vsrt_plan(), public.forecast_vsrt_begin(timestamptz), public.forecast_vsrt_put(timestamptz, text, timestamptz, real[]), public.forecast_vsrt_fail(text) to service_role;

/* ---------- 5. 격자별 값: 3시간 안에 다 받은 가장 새 발표분의 다음 정시 이후(최대 6시각). 바다(-99)는 빈 값 ---------- */
create or replace function private.fc_vsrt_cells()
returns table (nx int, ny int, tmfc timestamptz, start_at timestamptz, end_at timestamptz, pcp double precision, tmin double precision, tmin_at timestamptz, pop int, series jsonb)
language sql stable security definer set search_path = ''
as $$
  with v as (select r.tmfc, r.cells from public.forecast_vsrt_runs r where r.done_at is not null and r.tmfc > now() - interval '3 hours' order by r.tmfc desc limit 1),
  cell as (select (c.value ->> 0)::int as nx, (c.value ->> 1)::int as ny, c.ordinality::int as i from v, jsonb_array_elements(v.cells) with ordinality c),
  x as (
    select cell.nx, cell.ny, h.tmef,
           max(case when h.vals[cell.i] >= 0 then h.vals[cell.i] end) filter (where h.var = 'RN1')::double precision as p,
           max(case when h.vals[cell.i] > -90 then h.vals[cell.i] end) filter (where h.var = 'T1H')::double precision as t,
           max(case when h.vals[cell.i] >= 0 then least(h.vals[cell.i], 100) end) filter (where h.var = 'POP')::int as o
      from cell join public.forecast_vsrt_hours h on h.tmfc = (select v.tmfc from v) and h.tmef >= date_trunc('hour', now()) + interval '1 hour'
     group by cell.nx, cell.ny, h.tmef)
  select x.nx, x.ny, (select v.tmfc from v), min(x.tmef), max(x.tmef) + interval '1 hour',
         round(sum(x.p)::numeric, 1)::double precision, min(x.t),
         (array_agg(x.tmef order by x.t, x.tmef) filter (where x.t is not null))[1], max(x.o),
         jsonb_build_object('p', jsonb_agg(round(x.p::numeric, 1) order by x.tmef), 't', jsonb_agg(round(x.t::numeric, 1) order by x.tmef), 'r', jsonb_agg(x.o order by x.tmef))
    from x group by x.nx, x.ny;
$$;
revoke all on function private.fc_vsrt_cells() from public, anon, authenticated;

/* ---------- 6. 화면용: 지사별(branch_forecast 와 같은 이름의 칸) — 강수는 격자 중 가장 많은 값, 기온은 가장 추운 값 ---------- */
create or replace function public.forecast_vsrt_overview() returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare res jsonb;
begin
  if (select private.my_role()) is null then raise exception 'login required' using errcode = '42501'; end if;
  with c as (select * from private.fc_vsrt_cells()),
  b as (
    select g.branch_id, max(c.pcp) as pcp, max(c.pop) as pop, min(c.tmin) as tmin,
           (array_agg(c.tmin_at order by c.tmin, c.tmin_at) filter (where c.tmin is not null))[1] as tmin_at
      from private.grid_effective() g join c on c.nx = g.nx and c.ny = g.ny group by g.branch_id)
  select jsonb_build_object('tmfc', (select max(c.tmfc) from c), 'start_at', (select min(c.start_at) from c), 'end_at', (select max(c.end_at) from c),
           'rows', coalesce((select jsonb_agg(jsonb_build_object('branch_id', b.branch_id, 'issued_at', (select max(c.tmfc) from c), 'max_snow_24h', null, 'max_pcp_24h', b.pcp, 'max_pop_24h', b.pop, 'min_tmp', b.tmin, 'min_tmp_at', b.tmin_at)) from b), '[]'::jsonb))
    into res;
  return res;
end $$;

/* ---------- 7. 화면용: 격자(forecast_grid 와 같은 모양, 적설 자리는 null). 추이는 지사 하나일 때만 ---------- */
create or replace function public.forecast_vsrt_grid(p_branches text[], p_series boolean default false) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare res jsonb;
begin
  if (select private.my_role()) is null then raise exception 'login required' using errcode = '42501'; end if;
  if p_branches is null or cardinality(p_branches) = 0 or cardinality(p_branches) > 30 then raise exception 'bad branches' using errcode = '22023'; end if;
  if p_series and cardinality(p_branches) > 1 then raise exception 'series for one branch only' using errcode = '22023'; end if;
  with c as (select * from private.fc_vsrt_cells())
  select jsonb_build_object('tmfc', (select max(c.tmfc) from c), 'start_at', (select min(c.start_at) from c), 'end_at', (select max(c.end_at) from c),
    'cells', coalesce(jsonb_agg(jsonb_build_array(g.nx, g.ny, g.bs, null, c.pcp, c.tmin, c.tmin_at, case when p_series then c.series end, c.pop) order by g.ny, g.nx), '[]'::jsonb))
    into res
    from (select e.nx, e.ny, jsonb_agg(e.branch_id order by e.branch_id) as bs
            from private.grid_effective() e where e.branch_id = any(p_branches) group by e.nx, e.ny) g
    left join c on c.nx = g.nx and c.ny = g.ny;
  return res;
end $$;
revoke all on function public.forecast_vsrt_overview(), public.forecast_vsrt_grid(text[], boolean) from public, anon;
grant execute on function public.forecast_vsrt_overview(), public.forecast_vsrt_grid(text[], boolean) to authenticated;

/* ---------- 8. 10분마다(매시 08·18…분) 부르기: 지금 10분 칸까지 이미 다 받았으면 함수를 부르지 않음 ---------- */
create or replace function private.kick_vsrt() returns bigint
language plpgsql security definer set search_path = ''
as $$
begin
  if not private.warn_needed() then return null; end if;
  if exists (select 1 from public.forecast_vsrt_runs where done_at is not null and tmfc >= to_timestamp(floor(extract(epoch from now()) / 600) * 600)) then return null; end if;
  if coalesce((select started_at from public.collector_state where job = 'forecast_vsrt_kick'), 'epoch') > now() - interval '3 minutes' then return null; end if;
  insert into public.collector_state as s (job, started_at) values ('forecast_vsrt_kick', now())
  on conflict (job) do update set started_at = now();
  return net.http_post(
    url := 'https://yzwbnohzhnctdvufntig.supabase.co/functions/v1/collect-forecast',
    body := '{"vsrt":true}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-collector-token', (select token from private.collector_token where id = 1)),
    timeout_milliseconds := 150000);
end $$;
revoke all on function private.kick_vsrt() from public, anon, authenticated;

select cron.schedule('collect-vsrt', '8-58/10 * * * *', 'select private.kick_vsrt()');
