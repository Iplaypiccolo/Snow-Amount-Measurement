-- ============================================================
-- 34. 예보에 최저기온 추가 + 격자별 24시간 추이 (2026-10-05 사용자 결정)
--  * 단기예보 격자의 TMP(1시간 기온, ℃)도 24시간 받음 → 한 번 모으기 = 적설 24 + 강수 24 + 기온 24 = 72번 요청
--  * 격자마다: 24시간 중 가장 낮은 기온(tmin)과 그 시각(tmin_at, 같으면 이른 시각), 시간별 값(series = {s:[24], p:[24], t:[24]})
--  * 지사 값 = 지사 격자 중 가장 추운 격자의 최저기온·시각 → branch_forecast.min_tmp·min_tmp_at
--  * 확정하면 그 순간 값을 round_requests.fc_tmin·fc_tmin_at 에 남김. 기상현황 직접입력에 wx_tmin·wx_tmin_at
--  * forecast_grid(지사들, 추이 포함 여부): 지사 하나를 열 때만 시간별 값을 보냄(내려받는 양 줄이기)
--  * 기온 -90 이하는 자료 없음(기상청 격자의 -99 등)으로 봄
-- ============================================================

/* ---------- 1. 표 ---------- */
delete from public.forecast_runs;                                       -- 모으던 것은 버리고 다음 발표부터 기온까지
alter table public.forecast_hours drop constraint if exists forecast_hours_var_check;
alter table public.forecast_hours add constraint forecast_hours_var_check check (var in ('SNO', 'PCP', 'TMP'));
alter table public.forecast_cells add column if not exists tmin double precision, add column if not exists tmin_at timestamptz;
alter table public.branch_forecast add column if not exists min_tmp double precision, add column if not exists min_tmp_at timestamptz;
alter table public.round_requests
  add column if not exists fc_tmin    double precision,     -- 확정 순간 최저기온(℃)
  add column if not exists fc_tmin_at timestamptz,          -- 그 최저기온 시각
  add column if not exists wx_tmin    double precision check (wx_tmin is null or (wx_tmin >= -60 and wx_tmin <= 50)),   -- 직접입력 최저기온
  add column if not exists wx_tmin_at timestamptz;          -- 직접입력 최저기온 시각

/* ---------- 2. 계획·넣기 ---------- */
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
                  from generate_series(r.start_at, r.start_at + interval '23 hours', interval '1 hour') h, unnest(array['SNO', 'PCP', 'TMP']) v
                 where not exists (select 1 from public.forecast_hours x where x.tmfc = r.tmfc and x.var = v and x.tmef = h)));
end $$;

create or replace function public.forecast_put(p_tmfc timestamptz, p_var text, p_tmef timestamptz, p_vals real[]) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare r public.forecast_runs; n int;
begin
  select * into r from public.forecast_runs where tmfc = p_tmfc;
  if not found then raise exception 'unknown run' using errcode = '23503'; end if;
  if r.done_at is not null then return jsonb_build_object('ok', true, 'done', true); end if;
  if p_var not in ('SNO', 'PCP', 'TMP') then raise exception 'bad var' using errcode = '22023'; end if;
  if array_length(p_vals, 1) is distinct from jsonb_array_length(r.cells) then raise exception 'bad vals' using errcode = '22023'; end if;
  insert into public.forecast_hours (tmfc, var, tmef, vals) values (p_tmfc, p_var, p_tmef, p_vals)
  on conflict (tmfc, var, tmef) do update set vals = excluded.vals;
  select count(*) into n from public.forecast_hours where tmfc = p_tmfc and tmef >= r.start_at and tmef < r.start_at + interval '24 hours';
  if n < 72 then return jsonb_build_object('ok', true, 'hours', n); end if;

  -- 격자·시각마다 값(적설·강수 음수 = 0, 기온 -90 이하 = 없음)
  drop table if exists _fh;
  create temp table _fh on commit drop as
    with cell as (
      select (c.value ->> 0)::int as nx, (c.value ->> 1)::int as ny, c.ordinality::int as i
        from jsonb_array_elements(r.cells) with ordinality c)
    select cell.nx, cell.ny, h.tmef,
           max(greatest(h.vals[cell.i], 0)) filter (where h.var = 'SNO')::double precision as s,
           max(greatest(h.vals[cell.i], 0)) filter (where h.var = 'PCP')::double precision as p,
           max(case when h.vals[cell.i] > -90 then h.vals[cell.i] end) filter (where h.var = 'TMP')::double precision as t
      from cell join public.forecast_hours h on h.tmfc = p_tmfc and h.tmef >= r.start_at and h.tmef < r.start_at + interval '24 hours'
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
         jsonb_build_object('start_at', r.start_at, 'end_at', r.start_at + interval '24 hours', 'pcp_nx', p.nx, 'pcp_ny', p.ny, 'tmp_nx', t.nx, 'tmp_ny', t.ny), now()
    from s join p using (branch_id) join t using (branch_id)
  on conflict (branch_id) do update set issued_at = excluded.issued_at, max_snow_24h = excluded.max_snow_24h, max_pcp_24h = excluded.max_pcp_24h,
    min_tmp = excluded.min_tmp, min_tmp_at = excluded.min_tmp_at, worst_nx = excluded.worst_nx, worst_ny = excluded.worst_ny, detail = excluded.detail, updated_at = now();
  delete from public.branch_forecast f where not exists (select 1 from private.grid_effective() g where g.branch_id = f.branch_id);

  update public.forecast_runs set done_at = now() where tmfc = p_tmfc;
  delete from public.forecast_runs where tmfc < p_tmfc;
  insert into public.collector_state as s (job, cursor, started_at, finished_at, ok, note)
  values ('forecast', to_char(p_tmfc at time zone 'Asia/Seoul', 'YYYYMMDDHH24'), r.created_at, now(), true, null)
  on conflict (job) do update set cursor = excluded.cursor, started_at = excluded.started_at, finished_at = now(), ok = true, note = null;
  return jsonb_build_object('ok', true, 'done', true);
end $$;
revoke all on function public.forecast_plan(), public.forecast_put(timestamptz, text, timestamptz, real[]) from public, anon, authenticated;
grant execute on function public.forecast_plan(), public.forecast_put(timestamptz, text, timestamptz, real[]) to service_role;

/* ---------- 3. 확정할 때 최저기온도 남김 ---------- */
create or replace function private.branch_fc(p_branch text) returns jsonb
language sql stable security definer set search_path = ''
as $$
  select case when f.issued_at >= now() - interval '12 hours'
              then jsonb_build_object('snow', f.max_snow_24h, 'pcp', f.max_pcp_24h, 'tmin', f.min_tmp, 'tmin_at', f.min_tmp_at, 'tmfc', f.issued_at) end
    from public.branch_forecast f where f.branch_id = p_branch
$$;
revoke all on function private.branch_fc(text) from public, anon, authenticated;

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
    new.fc_snow := (f ->> 'snow')::double precision; new.fc_pcp := (f ->> 'pcp')::double precision;
    new.fc_tmin := (f ->> 'tmin')::double precision; new.fc_tmin_at := (f ->> 'tmin_at')::timestamptz;
    new.fc_tmfc := (f ->> 'tmfc')::timestamptz; new.fc_at := now();
  elsif not new.confirmed then
    new.warn_level := null; new.warn_zones := null; new.warn_base := null; new.warn_note := null; new.warn_at := null;
    new.fc_snow := null; new.fc_pcp := null; new.fc_tmin := null; new.fc_tmin_at := null; new.fc_tmfc := null; new.fc_at := null;
  else
    new.warn_level := old.warn_level; new.warn_zones := old.warn_zones; new.warn_base := old.warn_base;
    new.warn_note := old.warn_note; new.warn_at := old.warn_at;
    new.fc_snow := old.fc_snow; new.fc_pcp := old.fc_pcp; new.fc_tmin := old.fc_tmin; new.fc_tmin_at := old.fc_tmin_at;
    new.fc_tmfc := old.fc_tmfc; new.fc_at := old.fc_at;
  end if;
  return new;
end $$;
revoke all on function private.round_requests_warn() from public, anon;

/* ---------- 4. 지도용: 격자 값(+ 지사 하나를 열 때만 시간별 추이) ---------- */
-- cells: [[nx, ny, [지사…], 적설, 강수, 최저기온, 최저 시각, 추이{s,p,t}|null]…] — 12시간 넘게 지난 예보면 값 null
drop function if exists public.forecast_grid(text[]);
create or replace function public.forecast_grid(p_branches text[], p_series boolean default false) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare res jsonb;
begin
  if (select private.my_role()) is null then raise exception 'login required' using errcode = '42501'; end if;
  if p_branches is null or cardinality(p_branches) = 0 or cardinality(p_branches) > 30 then raise exception 'bad branches' using errcode = '22023'; end if;
  if p_series and cardinality(p_branches) > 1 then raise exception 'series for one branch only' using errcode = '22023'; end if;
  select jsonb_build_object(
    'tmfc', (select max(issued_at) from public.forecast_cells),
    'start_at', (select detail ->> 'start_at' from public.branch_forecast order by issued_at desc limit 1),
    'end_at', (select detail ->> 'end_at' from public.branch_forecast order by issued_at desc limit 1),
    'cells', coalesce(jsonb_agg(jsonb_build_array(g.nx, g.ny, g.bs,
               case when ok then c.snow_24h end, case when ok then c.pcp_24h end,
               case when ok then c.tmin end, case when ok then c.tmin_at end,
               case when ok and p_series then c.series end) order by g.ny, g.nx), '[]'::jsonb))
    into res
    from (select e.nx, e.ny, jsonb_agg(e.branch_id order by e.branch_id) as bs
            from private.grid_effective() e where e.branch_id = any(p_branches) group by e.nx, e.ny) g
    left join public.forecast_cells c on c.nx = g.nx and c.ny = g.ny
    cross join lateral (select c.issued_at >= now() - interval '12 hours' as ok) k;
  return res;
end $$;
revoke all on function public.forecast_grid(text[], boolean) from public, anon;
grant execute on function public.forecast_grid(text[], boolean) to authenticated;

/* ---------- 5. 기상현황 직접입력에 최저기온 ---------- */
create or replace function public.save_requests(p_round bigint, p_rows jsonb) returns jsonb
language plpgsql set search_path = ''
as $$
declare r jsonb; c int; n int := 0; b text;
begin
  if jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows) = 0 then raise exception 'nothing to save' using errcode = '22023'; end if;
  if jsonb_array_length(p_rows) > 500 then raise exception 'too many rows' using errcode = '54000'; end if;
  if not exists (select 1 from public.support_rounds s where s.id = p_round) then raise exception 'unknown round' using errcode = '23503'; end if;
  for r in select * from jsonb_array_elements(p_rows) loop
    if jsonb_typeof(r) is distinct from 'object' or not (r ? 'branch_id') then raise exception 'bad row' using errcode = '22023'; end if;
    b := r ->> 'branch_id';
    if exists (select 1 from public.round_requests q where q.round_id = p_round and q.branch_id = b) then
      update public.round_requests q set
        snow_cm         = case when r ? 'snow_cm'         then (r ->> 'snow_cm')::double precision      else q.snow_cm end,
        warning         = case when r ? 'warning'         then coalesce((r ->> 'warning')::boolean, false) else q.warning end,
        req_truck       = case when r ? 'req_truck'       then coalesce((r ->> 'req_truck')::int, 0)       else q.req_truck end,
        req_blower      = case when r ? 'req_blower'      then coalesce((r ->> 'req_blower')::int, 0)      else q.req_blower end,
        assigned_truck  = case when r ? 'assigned_truck'  then coalesce((r ->> 'assigned_truck')::int, 0)  else q.assigned_truck end,
        assigned_blower = case when r ? 'assigned_blower' then coalesce((r ->> 'assigned_blower')::int, 0) else q.assigned_blower end,
        arrive_at       = case when r ? 'arrive_at'       then (r ->> 'arrive_at')::timestamptz          else q.arrive_at end,
        reason          = case when r ? 'reason'          then nullif(r ->> 'reason', '')                else q.reason end,
        confirmed       = case when r ? 'confirmed'       then coalesce((r ->> 'confirmed')::boolean, false) else q.confirmed end,
        wx_manual       = case when r ? 'wx_manual'       then coalesce((r ->> 'wx_manual')::boolean, false) else q.wx_manual end,
        wx_snow         = case when r ? 'wx_snow'         then (r ->> 'wx_snow')::double precision      else q.wx_snow end,
        wx_pcp          = case when r ? 'wx_pcp'          then (r ->> 'wx_pcp')::double precision       else q.wx_pcp end,
        wx_tmin         = case when r ? 'wx_tmin'         then (r ->> 'wx_tmin')::double precision      else q.wx_tmin end,
        wx_tmin_at      = case when r ? 'wx_tmin_at'      then (r ->> 'wx_tmin_at')::timestamptz        else q.wx_tmin_at end,
        wx_level        = case when r ? 'wx_level'        then nullif(r ->> 'wx_level', '')              else q.wx_level end,
        wx_fc           = case when r ? 'wx_fc'           then (r ->> 'wx_fc')::timestamptz             else q.wx_fc end,
        wx_ef           = case when r ? 'wx_ef'           then (r ->> 'wx_ef')::timestamptz             else q.wx_ef end
      where q.round_id = p_round and q.branch_id = b;
      get diagnostics c = row_count;
      if c = 0 then raise exception 'row not allowed: %', b using errcode = '42501'; end if;
    else
      insert into public.round_requests (round_id, branch_id, snow_cm, warning, req_truck, req_blower, assigned_truck, assigned_blower, arrive_at, reason, confirmed,
                                         wx_manual, wx_snow, wx_pcp, wx_tmin, wx_tmin_at, wx_level, wx_fc, wx_ef)
      values (p_round, b, (r ->> 'snow_cm')::double precision, coalesce((r ->> 'warning')::boolean, false),
              coalesce((r ->> 'req_truck')::int, 0), coalesce((r ->> 'req_blower')::int, 0),
              coalesce((r ->> 'assigned_truck')::int, 0), coalesce((r ->> 'assigned_blower')::int, 0),
              (r ->> 'arrive_at')::timestamptz, nullif(r ->> 'reason', ''), coalesce((r ->> 'confirmed')::boolean, false),
              coalesce((r ->> 'wx_manual')::boolean, false), (r ->> 'wx_snow')::double precision, (r ->> 'wx_pcp')::double precision,
              (r ->> 'wx_tmin')::double precision, (r ->> 'wx_tmin_at')::timestamptz,
              nullif(r ->> 'wx_level', ''), (r ->> 'wx_fc')::timestamptz, (r ->> 'wx_ef')::timestamptz);
    end if;
    n := n + 1;
  end loop;
  return jsonb_build_object('rows', n);
end $$;
