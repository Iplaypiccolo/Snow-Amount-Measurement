-- ============================================================
-- 28. 예상 강수량 추가 + 격자별 24시간 값 + 격자 편입 변경 반영 (2026-10-05 사용자 결정)
--  * 단기예보 격자에서 SNO(1시간 신적설, cm)와 PCP(1시간 강수량, mm)를 각각 24시간 → 한 번 모으기 = 48번 요청
--  * 격자마다 24시간 합을 forecast_cells(snow_24h, pcp_24h)에 남김 → '기관별 24시간 예보' 지도가 읽음(지사 격자 934칸, 덮어씀)
--  * 지사 값 = 지사 격자 중 가장 큰 값(적설·강수 따로) → branch_forecast(max_snow_24h, max_pcp_24h)
--  * 지사 격자 = private.grid_effective(): 기본 편입(grid_assign) + 관리자가 '예보 격자 편입' 탭에서 저장한 변경(grid_events)을 순서대로 적용
--    (예전에는 서버가 기본 편입만 써서 탭에서 바꾼 것이 예보 계산에 빠졌음)
--  * 확정 고정에 강수도(round_requests.fc_pcp)
-- ============================================================

/* ---------- 1. 지사 격자(기본 편입 + 변경 이력) ---------- */
create or replace function private.grid_effective()
returns table (nx int, ny int, branch_id text)
language sql stable security definer set search_path = ''
as $$
  with ev as (
    select e.id, e.kind = 'cellAdd' as inc, coalesce(e.payload ->> 'to', e.payload ->> 'from') as b,
           (c.value ->> 0)::int as nx, (c.value ->> 1)::int as ny
      from public.grid_events e, jsonb_array_elements(e.payload -> 'cells') c
     where e.kind in ('cellAdd', 'cellRemove') and jsonb_typeof(e.payload -> 'cells') = 'array'),
  last as (select distinct on (ev.nx, ev.ny, ev.b) ev.nx, ev.ny, ev.b, ev.inc from ev order by ev.nx, ev.ny, ev.b, ev.id desc),
  eff as (
    select g.nx, g.ny, g.branch_id from public.grid_assign g
     where not exists (select 1 from last l where l.nx = g.nx and l.ny = g.ny and l.b = g.branch_id and not l.inc)
    union
    select l.nx, l.ny, l.b from last l where l.inc)
  select eff.nx, eff.ny, eff.branch_id from eff
    join public.branches b on b.id = eff.branch_id and b.status <> 'closed'
    join public.hqs h on h.id = b.hq_id and not coalesce(h.is_private, false)          -- 민자는 예보 대상 아님(화면과 같음)
   where eff.nx between 1 and 149 and eff.ny between 1 and 253
$$;
revoke all on function private.grid_effective() from public, anon, authenticated;

/* ---------- 2. 표 바꾸기 ---------- */
delete from public.forecast_runs;                                       -- 모으던 것은 버리고 다음 발표부터 새 방식으로
alter table public.forecast_hours add column if not exists var text not null default 'SNO' check (var in ('SNO', 'PCP'));
alter table public.forecast_hours drop constraint if exists forecast_hours_pkey;
alter table public.forecast_hours add primary key (tmfc, var, tmef);
alter table public.forecast_hours alter column var drop default;
alter table public.forecast_cells add column if not exists pcp_24h double precision;
alter table public.branch_forecast add column if not exists max_pcp_24h double precision;
alter table public.round_requests add column if not exists fc_pcp double precision;   -- 확정 순간 예상 강수량(mm)

/* ---------- 3. 계획·넣기 ---------- */
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
                  from generate_series(r.start_at, r.start_at + interval '23 hours', interval '1 hour') h, unnest(array['SNO', 'PCP']) v
                 where not exists (select 1 from public.forecast_hours x where x.tmfc = r.tmfc and x.var = v and x.tmef = h)));
end $$;

drop function if exists public.forecast_put(timestamptz, timestamptz, real[]);
create or replace function public.forecast_put(p_tmfc timestamptz, p_var text, p_tmef timestamptz, p_vals real[]) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare r public.forecast_runs; n int;
begin
  select * into r from public.forecast_runs where tmfc = p_tmfc;
  if not found then raise exception 'unknown run' using errcode = '23503'; end if;
  if r.done_at is not null then return jsonb_build_object('ok', true, 'done', true); end if;
  if p_var not in ('SNO', 'PCP') then raise exception 'bad var' using errcode = '22023'; end if;
  if array_length(p_vals, 1) is distinct from jsonb_array_length(r.cells) then raise exception 'bad vals' using errcode = '22023'; end if;
  insert into public.forecast_hours (tmfc, var, tmef, vals) values (p_tmfc, p_var, p_tmef, p_vals)
  on conflict (tmfc, var, tmef) do update set vals = excluded.vals;
  select count(*) into n from public.forecast_hours where tmfc = p_tmfc and tmef >= r.start_at and tmef < r.start_at + interval '24 hours';
  if n < 48 then return jsonb_build_object('ok', true, 'hours', n); end if;

  -- 격자마다 24시간 합(음수 = 바다·없음 → 0)
  drop table if exists _fc;
  create temp table _fc on commit drop as
    with cell as (
      select (c.value ->> 0)::int as nx, (c.value ->> 1)::int as ny, c.ordinality::int as i
        from jsonb_array_elements(r.cells) with ordinality c)
    select cell.nx, cell.ny,
           round(sum(greatest(h.vals[cell.i], 0)) filter (where h.var = 'SNO')::numeric, 1)::double precision as snow,
           round(sum(greatest(h.vals[cell.i], 0)) filter (where h.var = 'PCP')::numeric, 1)::double precision as pcp
      from cell join public.forecast_hours h on h.tmfc = p_tmfc and h.tmef >= r.start_at and h.tmef < r.start_at + interval '24 hours'
     group by cell.nx, cell.ny;

  insert into public.forecast_cells as f (nx, ny, issued_at, snow_24h, pcp_24h, series, updated_at)
  select nx, ny, p_tmfc, snow, pcp, null, now() from _fc
  on conflict (nx, ny) do update set issued_at = excluded.issued_at, snow_24h = excluded.snow_24h, pcp_24h = excluded.pcp_24h, updated_at = now();
  delete from public.forecast_cells f where not exists (select 1 from _fc where _fc.nx = f.nx and _fc.ny = f.ny);

  with s as (select distinct on (g.branch_id) g.branch_id, c.snow, c.nx, c.ny from private.grid_effective() g join _fc c on c.nx = g.nx and c.ny = g.ny order by g.branch_id, c.snow desc, c.ny, c.nx),
       p as (select distinct on (g.branch_id) g.branch_id, c.pcp, c.nx, c.ny from private.grid_effective() g join _fc c on c.nx = g.nx and c.ny = g.ny order by g.branch_id, c.pcp desc, c.ny, c.nx)
  insert into public.branch_forecast as f (branch_id, issued_at, max_snow_24h, max_pcp_24h, worst_nx, worst_ny, detail, updated_at)
  select s.branch_id, p_tmfc, s.snow, p.pcp, s.nx, s.ny,
         jsonb_build_object('start_at', r.start_at, 'end_at', r.start_at + interval '24 hours', 'pcp_nx', p.nx, 'pcp_ny', p.ny), now()
    from s join p using (branch_id)
  on conflict (branch_id) do update set issued_at = excluded.issued_at, max_snow_24h = excluded.max_snow_24h, max_pcp_24h = excluded.max_pcp_24h,
    worst_nx = excluded.worst_nx, worst_ny = excluded.worst_ny, detail = excluded.detail, updated_at = now();
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

/* ---------- 4. 확정 고정에 강수 ---------- */
create or replace function private.branch_fc(p_branch text) returns jsonb
language sql stable security definer set search_path = ''
as $$
  select case when f.issued_at >= now() - interval '12 hours'
              then jsonb_build_object('snow', f.max_snow_24h, 'pcp', f.max_pcp_24h, 'tmfc', f.issued_at) end
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
    new.fc_snow := (f ->> 'snow')::double precision; new.fc_pcp := (f ->> 'pcp')::double precision; new.fc_tmfc := (f ->> 'tmfc')::timestamptz; new.fc_at := now();
  elsif not new.confirmed then
    new.warn_level := null; new.warn_zones := null; new.warn_base := null; new.warn_note := null; new.warn_at := null;
    new.fc_snow := null; new.fc_pcp := null; new.fc_tmfc := null; new.fc_at := null;
  else
    new.warn_level := old.warn_level; new.warn_zones := old.warn_zones; new.warn_base := old.warn_base;
    new.warn_note := old.warn_note; new.warn_at := old.warn_at;
    new.fc_snow := old.fc_snow; new.fc_pcp := old.fc_pcp; new.fc_tmfc := old.fc_tmfc; new.fc_at := old.fc_at;
  end if;
  return new;
end $$;
revoke all on function private.round_requests_warn() from public, anon;

/* ---------- 5. 지도용: 고른 지사들의 격자와 24시간 값 ---------- */
-- { tmfc, start_at, end_at, cells:[[nx, ny, [지사…], 적설, 강수]…] } — 값이 없거나 12시간 넘게 지난 예보면 적설·강수 null
create or replace function public.forecast_grid(p_branches text[]) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare res jsonb;
begin
  if (select private.my_role()) is null then raise exception 'login required' using errcode = '42501'; end if;
  if p_branches is null or cardinality(p_branches) = 0 or cardinality(p_branches) > 30 then raise exception 'bad branches' using errcode = '22023'; end if;
  select jsonb_build_object(
    'tmfc', (select max(issued_at) from public.forecast_cells),
    'start_at', (select detail ->> 'start_at' from public.branch_forecast order by issued_at desc limit 1),
    'end_at', (select detail ->> 'end_at' from public.branch_forecast order by issued_at desc limit 1),
    'cells', coalesce(jsonb_agg(jsonb_build_array(g.nx, g.ny, g.bs,
               case when c.issued_at >= now() - interval '12 hours' then c.snow_24h end,
               case when c.issued_at >= now() - interval '12 hours' then c.pcp_24h end) order by g.ny, g.nx), '[]'::jsonb))
    into res
    from (select e.nx, e.ny, jsonb_agg(e.branch_id order by e.branch_id) as bs
            from private.grid_effective() e where e.branch_id = any(p_branches) group by e.nx, e.ny) g
    left join public.forecast_cells c on c.nx = g.nx and c.ny = g.ny;
  return res;
end $$;
revoke all on function public.forecast_grid(text[]) from public, anon;
grant execute on function public.forecast_grid(text[]) to authenticated;
