-- ============================================================
-- 36. 예보 24시간 창을 매시 앞으로 옮김 (2026-10-06 사용자 결정)
--  * 예전: 발표분을 받기 시작한 시각의 다음 정시부터 24시간으로 고정 → 다음 발표분을 받을 때(약 3시간)까지 그대로
--    (02시 발표분이면 03:30·04:30 에도 03~다음날 03)
--  * 지금: 늘 "지금의 다음 정시부터 24시간" — 03:00~03:59 면 04~다음날 04, 04:00~04:59 면 05~다음날 05
--    · 한 번 모으기 = 받기 시작한 시각의 다음 정시부터 27시간(3종류 × 27 = 81번 요청) → 다음 발표분까지 매시 창을 만들 수 있음
--    · 매시 정각(cron)에 가장 최근에 다 받은 발표분으로 그 시각의 창을 다시 계산(격자·지사 값·추이·최저기온)
--    · 창이 받은 범위를 넘으면(다음 발표분이 늦어질 때) 마지막 창을 그대로 둠
--  * 계산은 private.fc_apply(발표 시각, 창 시작) 하나로(받기를 끝낼 때와 매시 같은 계산)
-- ============================================================

/* ---------- 1. 창 하나 계산: [p_start, p_start + 24시간) ---------- */
create or replace function private.fc_apply(p_tmfc timestamptz, p_start timestamptz) returns boolean
language plpgsql security definer set search_path = ''
as $$
declare r public.forecast_runs; n int;
begin
  select * into r from public.forecast_runs where tmfc = p_tmfc;
  if not found then return false; end if;
  select count(*) into n from public.forecast_hours where tmfc = p_tmfc and tmef >= p_start and tmef < p_start + interval '24 hours';
  if n < 72 then return false; end if;                                    -- 창 24시간 × 3종류가 다 있어야

  drop table if exists _fh;
  create temp table _fh on commit drop as
    with cell as (
      select (c.value ->> 0)::int as nx, (c.value ->> 1)::int as ny, c.ordinality::int as i
        from jsonb_array_elements(r.cells) with ordinality c)
    select cell.nx, cell.ny, h.tmef,
           max(greatest(h.vals[cell.i], 0)) filter (where h.var = 'SNO')::double precision as s,
           max(greatest(h.vals[cell.i], 0)) filter (where h.var = 'PCP')::double precision as p,
           max(case when h.vals[cell.i] > -90 then h.vals[cell.i] end) filter (where h.var = 'TMP')::double precision as t
      from cell join public.forecast_hours h on h.tmfc = p_tmfc and h.tmef >= p_start and h.tmef < p_start + interval '24 hours'
     group by cell.nx, cell.ny, h.tmef;

  drop table if exists _fc;
  create temp table _fc on commit drop as
    select x.nx, x.ny,
           round(sum(x.s)::numeric, 1)::double precision as snow,
           round(sum(x.p)::numeric, 1)::double precision as pcp,
           min(x.t) as tmin,
           (select y.tmef from _fh y where y.nx = x.nx and y.ny = x.ny and y.t is not null order by y.t, y.tmef limit 1) as tmin_at,
           jsonb_build_object('s', jsonb_agg(round(x.s::numeric, 1) order by x.tmef), 'p', jsonb_agg(round(x.p::numeric, 1) order by x.tmef),
                              't', jsonb_agg(round(x.t::numeric, 1) order by x.tmef)) as series
      from _fh x group by x.nx, x.ny;

  insert into public.forecast_cells as f (nx, ny, issued_at, snow_24h, pcp_24h, tmin, tmin_at, series, updated_at)
  select nx, ny, p_tmfc, snow, pcp, tmin, tmin_at, series, now() from _fc
  on conflict (nx, ny) do update set issued_at = excluded.issued_at, snow_24h = excluded.snow_24h, pcp_24h = excluded.pcp_24h,
    tmin = excluded.tmin, tmin_at = excluded.tmin_at, series = excluded.series, updated_at = now();
  delete from public.forecast_cells f where not exists (select 1 from _fc where _fc.nx = f.nx and _fc.ny = f.ny);

  with s as (select distinct on (g.branch_id) g.branch_id, c.snow, c.nx, c.ny from private.grid_effective() g join _fc c on c.nx = g.nx and c.ny = g.ny order by g.branch_id, c.snow desc, c.ny, c.nx),
       p as (select distinct on (g.branch_id) g.branch_id, c.pcp, c.nx, c.ny from private.grid_effective() g join _fc c on c.nx = g.nx and c.ny = g.ny order by g.branch_id, c.pcp desc, c.ny, c.nx),
       t as (select distinct on (g.branch_id) g.branch_id, c.tmin, c.tmin_at, c.nx, c.ny from private.grid_effective() g join _fc c on c.nx = g.nx and c.ny = g.ny
              order by g.branch_id, c.tmin asc nulls last, c.tmin_at, c.ny, c.nx)
  insert into public.branch_forecast as f (branch_id, issued_at, max_snow_24h, max_pcp_24h, min_tmp, min_tmp_at, worst_nx, worst_ny, detail, updated_at)
  select s.branch_id, p_tmfc, s.snow, p.pcp, t.tmin, t.tmin_at, s.nx, s.ny,
         jsonb_build_object('start_at', p_start, 'end_at', p_start + interval '24 hours', 'pcp_nx', p.nx, 'pcp_ny', p.ny, 'tmp_nx', t.nx, 'tmp_ny', t.ny), now()
    from s join p using (branch_id) join t using (branch_id)
  on conflict (branch_id) do update set issued_at = excluded.issued_at, max_snow_24h = excluded.max_snow_24h, max_pcp_24h = excluded.max_pcp_24h,
    min_tmp = excluded.min_tmp, min_tmp_at = excluded.min_tmp_at, worst_nx = excluded.worst_nx, worst_ny = excluded.worst_ny, detail = excluded.detail, updated_at = now();
  delete from public.branch_forecast f where not exists (select 1 from private.grid_effective() g where g.branch_id = f.branch_id);
  return true;
end $$;
revoke all on function private.fc_apply(timestamptz, timestamptz) from public, anon, authenticated;

/* ---------- 2. 계획: 27시간 × 3종류 ---------- */
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
      from (select distinct e.nx, e.ny from private.grid_effective() e) c
    returning * into r;
  end if;
  return jsonb_build_object('done', false, 'tmfc', r.tmfc, 'start_at', r.start_at, 'cells', r.cells,
    'missing', (select coalesce(jsonb_agg(jsonb_build_array(v, h) order by h, v), '[]'::jsonb)
                  from generate_series(r.start_at, r.start_at + interval '26 hours', interval '1 hour') h, unnest(array['SNO', 'PCP', 'TMP']) v
                 where not exists (select 1 from public.forecast_hours x where x.tmfc = r.tmfc and x.var = v and x.tmef = h)));
end $$;

/* ---------- 3. 넣기: 81개가 다 모이면 지금 창으로 계산하고 끝냄 ---------- */
create or replace function public.forecast_put(p_tmfc timestamptz, p_var text, p_tmef timestamptz, p_vals real[]) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare r public.forecast_runs; n int; w timestamptz;
begin
  select * into r from public.forecast_runs where tmfc = p_tmfc;
  if not found then raise exception 'unknown run' using errcode = '23503'; end if;
  if r.done_at is not null then return jsonb_build_object('ok', true, 'done', true); end if;
  if p_var not in ('SNO', 'PCP', 'TMP') then raise exception 'bad var' using errcode = '22023'; end if;
  if array_length(p_vals, 1) is distinct from jsonb_array_length(r.cells) then raise exception 'bad vals' using errcode = '22023'; end if;
  insert into public.forecast_hours (tmfc, var, tmef, vals) values (p_tmfc, p_var, p_tmef, p_vals)
  on conflict (tmfc, var, tmef) do update set vals = excluded.vals;
  select count(*) into n from public.forecast_hours where tmfc = p_tmfc and tmef >= r.start_at and tmef < r.start_at + interval '27 hours';
  if n < 81 then return jsonb_build_object('ok', true, 'hours', n); end if;

  w := least(greatest(date_trunc('hour', now()) + interval '1 hour', r.start_at), r.start_at + interval '3 hours');   -- 지금의 다음 정시(받은 범위 안)
  perform private.fc_apply(p_tmfc, w);
  update public.forecast_runs set done_at = now() where tmfc = p_tmfc;
  delete from public.forecast_runs where tmfc < p_tmfc;                   -- 지난 발표분(1시간치들도 함께)
  insert into public.collector_state as s (job, cursor, started_at, finished_at, ok, note)
  values ('forecast', to_char(p_tmfc at time zone 'Asia/Seoul', 'YYYYMMDDHH24'), r.created_at, now(), true, null)
  on conflict (job) do update set cursor = excluded.cursor, started_at = excluded.started_at, finished_at = now(), ok = true, note = null;
  return jsonb_build_object('ok', true, 'done', true, 'window', w);
end $$;
revoke all on function public.forecast_plan(), public.forecast_put(timestamptz, text, timestamptz, real[]) from public, anon, authenticated;
grant execute on function public.forecast_plan(), public.forecast_put(timestamptz, text, timestamptz, real[]) to service_role;

/* ---------- 4. 매시 정각: 가장 최근에 다 받은 발표분으로 지금 창 다시 계산 ---------- */
create or replace function private.fc_roll() returns boolean
language plpgsql security definer set search_path = ''
as $$
declare t timestamptz;
begin
  select tmfc into t from public.forecast_runs where done_at is not null order by tmfc desc limit 1;
  if t is null then return false; end if;
  return private.fc_apply(t, date_trunc('hour', now()) + interval '1 hour');   -- 받은 범위를 넘으면 false(마지막 창 그대로)
end $$;
revoke all on function private.fc_roll() from public, anon, authenticated;

select cron.unschedule(jobid) from cron.job where jobname = 'forecast-roll';
select cron.schedule('forecast-roll', '0 * * * *', 'select private.fc_roll()');

-- 지금 받아 둔 발표분(24시간치)은 그대로 두고 다음 발표분부터 27시간으로 받음. 지금 창을 한 번 맞춤
select private.fc_roll();
