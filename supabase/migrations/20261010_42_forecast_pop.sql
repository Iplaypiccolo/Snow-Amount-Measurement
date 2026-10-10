-- ============================================================
-- 42. 강수확률(POP) 추가 (2026-10-10 사용자 요청, Claude Code)
--  * 기상청 단기예보 격자의 POP(강수확률 %, 1시간 단위)를 적설·강수·기온과 함께 받는다. 발표 한 번에 요청 81 → 108(27시간 × 4종).
--  * 저장: forecast_hours 에 var = 'POP' 줄(27줄 추가), forecast_cells.pop_24h(24시간 중 최고 %)·series.r(시각별 %),
--          branch_forecast.max_pop_24h(지사 격자 중 최고 %), round_requests.fc_pop(확정 순간의 값 — 적설·강수와 같이 고정)
--  * 예보가 늦어지지 않게: 적설·강수·기온(81줄)이 다 모이면 **먼저** 계산해 보여 주고(core_at), 강수확률(27줄)이 마저 오면 다시 계산하고 끝(done_at).
--    기상청이 강수확률만 못 줘도 적설·강수·기온은 평소대로 나온다(확률 칸만 '-').
--  * forecast_grid 결과의 격자 배열 맨 뒤(9번째)에 pop_24h 추가 — 앞 순서는 그대로
--  * 용량: 지금 예보 표 전체 약 2.4MB → 약 2.7MB(전체 DB 62MB / 무료 한도 500MB)
--  * 시험: supabase/tests/forecast_test.sql
-- ============================================================

-- 1) 칸 추가(모두 비어 있어도 되는 새 칸 — 기존 자료는 그대로)
alter table public.forecast_runs   add column if not exists core_at timestamptz;      -- 적설·강수·기온이 다 모여 처음 계산한 시각
alter table public.forecast_cells  add column if not exists pop_24h integer;          -- 24시간 중 최고 강수확률(%)
alter table public.branch_forecast add column if not exists max_pop_24h integer;      -- 지사 격자 중 최고 강수확률(%)
alter table public.round_requests  add column if not exists fc_pop integer;           -- 확정 순간의 최고 강수확률(%)
update public.forecast_runs set core_at = done_at where done_at is not null and core_at is null;

alter table public.forecast_hours drop constraint if exists forecast_hours_var_check;
alter table public.forecast_hours add constraint forecast_hours_var_check check (var = any (array['SNO', 'PCP', 'TMP', 'POP']));

-- 2) 받을 목록: 적설·강수·기온 먼저, 강수확률은 그다음
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
    'missing', (select coalesce(jsonb_agg(jsonb_build_array(v, h) order by (v = 'POP'), h, v), '[]'::jsonb)
                  from generate_series(r.start_at, r.start_at + interval '26 hours', interval '1 hour') h, unnest(array['SNO', 'PCP', 'TMP', 'POP']) v
                 where not exists (select 1 from public.forecast_hours x where x.tmfc = r.tmfc and x.var = v and x.tmef = h)));
end $$;

-- 3) 한 시각치 넣기: 81줄(적설·강수·기온)이 모이면 먼저 계산, 강수확률 27줄까지 모이면 다시 계산하고 끝
create or replace function public.forecast_put(p_tmfc timestamptz, p_var text, p_tmef timestamptz, p_vals real[]) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare r public.forecast_runs; n int; np int; w timestamptz;
begin
  select * into r from public.forecast_runs where tmfc = p_tmfc;
  if not found then raise exception 'unknown run' using errcode = '23503'; end if;
  if r.done_at is not null then return jsonb_build_object('ok', true, 'done', true); end if;
  if p_var not in ('SNO', 'PCP', 'TMP', 'POP') then raise exception 'bad var' using errcode = '22023'; end if;
  if array_length(p_vals, 1) is distinct from jsonb_array_length(r.cells) then raise exception 'bad vals' using errcode = '22023'; end if;
  insert into public.forecast_hours (tmfc, var, tmef, vals) values (p_tmfc, p_var, p_tmef, p_vals)
  on conflict (tmfc, var, tmef) do update set vals = excluded.vals;
  select count(*) filter (where var <> 'POP'), count(*) filter (where var = 'POP') into n, np
    from public.forecast_hours where tmfc = p_tmfc and tmef >= r.start_at and tmef < r.start_at + interval '27 hours';
  if n < 81 or (r.core_at is not null and np < 27) then return jsonb_build_object('ok', true, 'hours', n + np); end if;

  w := least(greatest(date_trunc('hour', now()) + interval '1 hour', r.start_at), r.start_at + interval '3 hours');
  perform private.fc_apply(p_tmfc, w);
  if r.core_at is null then
    update public.forecast_runs set core_at = now() where tmfc = p_tmfc;
    delete from public.forecast_runs where tmfc < p_tmfc;
    insert into public.collector_state as s (job, cursor, started_at, finished_at, ok, note)
    values ('forecast', to_char(p_tmfc at time zone 'Asia/Seoul', 'YYYYMMDDHH24'), r.created_at, now(), true, null)
    on conflict (job) do update set cursor = excluded.cursor, started_at = excluded.started_at, finished_at = now(), ok = true, note = null;
  end if;
  if np < 27 then return jsonb_build_object('ok', true, 'hours', n + np, 'core', true, 'window', w); end if;
  update public.forecast_runs set done_at = now() where tmfc = p_tmfc;
  return jsonb_build_object('ok', true, 'done', true, 'window', w);
end $$;

-- 4) 계산: 격자별 24시간 합·최저 + 강수확률 최고(%)와 시각별 값(series.r). 강수확률이 아직 없으면 그 칸만 비움
create or replace function private.fc_apply(p_tmfc timestamptz, p_start timestamptz) returns boolean
language plpgsql security definer set search_path = ''
as $$
declare r public.forecast_runs; n int;
begin
  select * into r from public.forecast_runs where tmfc = p_tmfc;
  if not found then return false; end if;
  select count(*) into n from public.forecast_hours where tmfc = p_tmfc and var <> 'POP' and tmef >= p_start and tmef < p_start + interval '24 hours';
  if n < 72 then return false; end if;

  drop table if exists _fh;
  create temp table _fh on commit drop as
    with cell as (
      select (c.value ->> 0)::int as nx, (c.value ->> 1)::int as ny, c.ordinality::int as i
        from jsonb_array_elements(r.cells) with ordinality c)
    select cell.nx, cell.ny, h.tmef,
           max(greatest(h.vals[cell.i], 0)) filter (where h.var = 'SNO')::double precision as s,
           max(greatest(h.vals[cell.i], 0)) filter (where h.var = 'PCP')::double precision as p,
           max(case when h.vals[cell.i] > -90 then h.vals[cell.i] end) filter (where h.var = 'TMP')::double precision as t,
           max(case when h.vals[cell.i] >= 0 then least(h.vals[cell.i], 100) end) filter (where h.var = 'POP')::int as o
      from cell join public.forecast_hours h on h.tmfc = p_tmfc and h.tmef >= p_start and h.tmef < p_start + interval '24 hours'
     group by cell.nx, cell.ny, h.tmef;

  drop table if exists _fc;
  create temp table _fc on commit drop as
    select x.nx, x.ny,
           round(sum(x.s)::numeric, 1)::double precision as snow,
           round(sum(x.p)::numeric, 1)::double precision as pcp,
           min(x.t) as tmin,
           (select y.tmef from _fh y where y.nx = x.nx and y.ny = x.ny and y.t is not null order by y.t, y.tmef limit 1) as tmin_at,
           max(x.o) as pop,
           jsonb_build_object('s', jsonb_agg(round(x.s::numeric, 1) order by x.tmef), 'p', jsonb_agg(round(x.p::numeric, 1) order by x.tmef),
                              't', jsonb_agg(round(x.t::numeric, 1) order by x.tmef))
             || case when count(x.o) > 0 then jsonb_build_object('r', jsonb_agg(x.o order by x.tmef)) else '{}'::jsonb end as series
      from _fh x group by x.nx, x.ny;

  insert into public.forecast_cells as f (nx, ny, issued_at, snow_24h, pcp_24h, tmin, tmin_at, pop_24h, series, updated_at)
  select nx, ny, p_tmfc, snow, pcp, tmin, tmin_at, pop, series, now() from _fc
  on conflict (nx, ny) do update set issued_at = excluded.issued_at, snow_24h = excluded.snow_24h, pcp_24h = excluded.pcp_24h,
    tmin = excluded.tmin, tmin_at = excluded.tmin_at, pop_24h = excluded.pop_24h, series = excluded.series, updated_at = now();
  delete from public.forecast_cells f where not exists (select 1 from _fc where _fc.nx = f.nx and _fc.ny = f.ny);

  with s as (select distinct on (g.branch_id) g.branch_id, c.snow, c.nx, c.ny from private.grid_effective() g join _fc c on c.nx = g.nx and c.ny = g.ny order by g.branch_id, c.snow desc, c.ny, c.nx),
       p as (select distinct on (g.branch_id) g.branch_id, c.pcp, c.nx, c.ny from private.grid_effective() g join _fc c on c.nx = g.nx and c.ny = g.ny order by g.branch_id, c.pcp desc, c.ny, c.nx),
       t as (select distinct on (g.branch_id) g.branch_id, c.tmin, c.tmin_at, c.nx, c.ny from private.grid_effective() g join _fc c on c.nx = g.nx and c.ny = g.ny
              order by g.branch_id, c.tmin asc nulls last, c.tmin_at, c.ny, c.nx),
       o as (select g.branch_id, max(c.pop) as pop from private.grid_effective() g join _fc c on c.nx = g.nx and c.ny = g.ny group by g.branch_id)
  insert into public.branch_forecast as f (branch_id, issued_at, max_snow_24h, max_pcp_24h, min_tmp, min_tmp_at, max_pop_24h, worst_nx, worst_ny, detail, updated_at)
  select s.branch_id, p_tmfc, s.snow, p.pcp, t.tmin, t.tmin_at, o.pop, s.nx, s.ny,
         jsonb_build_object('start_at', p_start, 'end_at', p_start + interval '24 hours', 'pcp_nx', p.nx, 'pcp_ny', p.ny, 'tmp_nx', t.nx, 'tmp_ny', t.ny), now()
    from s join p using (branch_id) join t using (branch_id) join o using (branch_id)
  on conflict (branch_id) do update set issued_at = excluded.issued_at, max_snow_24h = excluded.max_snow_24h, max_pcp_24h = excluded.max_pcp_24h,
    min_tmp = excluded.min_tmp, min_tmp_at = excluded.min_tmp_at, max_pop_24h = excluded.max_pop_24h,
    worst_nx = excluded.worst_nx, worst_ny = excluded.worst_ny, detail = excluded.detail, updated_at = now();
  delete from public.branch_forecast f where not exists (select 1 from private.grid_effective() g where g.branch_id = f.branch_id);
  return true;
end $$;

-- 5) 매시 24시간 창 옮기기: 적설·강수·기온이 다 모인(core_at) 가장 최근 발표분으로
create or replace function private.fc_roll() returns boolean
language plpgsql security definer set search_path = ''
as $$
declare t timestamptz;
begin
  select tmfc into t from public.forecast_runs where core_at is not null order by tmfc desc limit 1;
  if t is null then return false; end if;
  return private.fc_apply(t, date_trunc('hour', now()) + interval '1 hour');
end $$;

-- 6) 화면이 읽는 격자 목록: 배열 맨 뒤에 24시간 최고 강수확률(%) 추가
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
               case when ok and p_series then c.series end,
               case when ok then c.pop_24h end) order by g.ny, g.nx), '[]'::jsonb))
    into res
    from (select e.nx, e.ny, jsonb_agg(e.branch_id order by e.branch_id) as bs
            from private.grid_effective() e where e.branch_id = any(p_branches) group by e.nx, e.ny) g
    left join public.forecast_cells c on c.nx = g.nx and c.ny = g.ny
    cross join lateral (select c.issued_at >= now() - interval '12 hours' as ok) k;
  return res;
end $$;

-- 7) 확정 순간에 남기는 값에 강수확률 추가(적설·강수·최저기온과 같이 고정, 취소하면 비움)
create or replace function private.branch_fc(p_branch text) returns jsonb
language sql stable security definer set search_path = ''
as $$
  select case when f.issued_at >= now() - interval '12 hours'
              then jsonb_build_object('snow', f.max_snow_24h, 'pcp', f.max_pcp_24h, 'tmin', f.min_tmp, 'tmin_at', f.min_tmp_at, 'pop', f.max_pop_24h, 'tmfc', f.issued_at) end
    from public.branch_forecast f where f.branch_id = p_branch
$$;

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
    new.fc_pop := (f ->> 'pop')::int;
    new.fc_tmfc := (f ->> 'tmfc')::timestamptz; new.fc_at := now();
  elsif not new.confirmed then
    new.warn_level := null; new.warn_zones := null; new.warn_base := null; new.warn_note := null; new.warn_at := null;
    new.fc_snow := null; new.fc_pcp := null; new.fc_tmin := null; new.fc_tmin_at := null; new.fc_pop := null; new.fc_tmfc := null; new.fc_at := null;
  else
    new.warn_level := old.warn_level; new.warn_zones := old.warn_zones; new.warn_base := old.warn_base;
    new.warn_note := old.warn_note; new.warn_at := old.warn_at;
    new.fc_snow := old.fc_snow; new.fc_pcp := old.fc_pcp; new.fc_tmin := old.fc_tmin; new.fc_tmin_at := old.fc_tmin_at; new.fc_pop := old.fc_pop;
    new.fc_tmfc := old.fc_tmfc; new.fc_at := old.fc_at;
  end if;
  return new;
end $$;

-- 8) 지금 발표분에도 강수확률을 바로 받도록: 끝난 표시만 풀어 둠(다음 예약 때 강수확률 27줄만 더 받고 다시 끝남. 적설·강수·기온은 그대로)
update public.forecast_runs set done_at = null where tmfc = (select max(tmfc) from public.forecast_runs) and core_at is not null;
