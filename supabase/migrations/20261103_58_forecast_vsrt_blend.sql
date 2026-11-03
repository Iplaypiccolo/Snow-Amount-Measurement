-- ============================================================
-- 58. 초단기 보기를 '같은 24시간 표에서 앞 6시간만 바꾸기'로 (2026-11-03 사용자 요청)
--  * 전환해도 표는 그대로 24시간: 단기예보(forecast_cells.series)에서 초단기가 있는 시각의 강수·기온·강수확률만 바꿔 다시 합침. 적설은 단기 그대로
--  * 지사별 값(왼쪽 목록)·격자 값·추이 모두 이 값으로. 초단기가 없거나 3시간 넘게 못 받았으면 단기예보와 똑같은 값(vsrt_at = null)
--  * 저장하지 않고 볼 때 계산. 단기 표·요청·편성·확정 값은 그대로. 표·권한 규칙·예약은 그대로이고 보기 함수 3개만 바꿈
--  * 초단기 시각은 창 시작(다음 정시)부터라, 앞 시 발표분이 최신인 동안(매시 약 25분까지)은 5시각만 바뀜 → series.vn = 바뀐 시각 수
--  * 시험: supabase/tests/forecast_vsrt_test.sql
-- ============================================================
drop function if exists private.fc_vsrt_cells();
-- p_branches: 그 지사들의 격자만 계산(없으면 전부), p_series: 추이까지 만들지(가장 오래 걸리는 부분이라 필요할 때만)
create function private.fc_vsrt_cells(p_branches text[] default null, p_series boolean default false)
returns table (nx int, ny int, issued_at timestamptz, vsrt_at timestamptz, start_at timestamptz, vn int, snow double precision, pcp double precision, tmin double precision, tmin_at timestamptz, pop int, series jsonb)
language sql stable security definer set search_path = ''
as $$
  with st as (select (b.detail ->> 'start_at')::timestamptz as start_at from public.branch_forecast b order by b.issued_at desc, b.updated_at desc limit 1),
  sel as (select distinct e.nx, e.ny from private.grid_effective() e where p_branches is null or e.branch_id = any(p_branches)),
  v as (select r.tmfc, r.cells from public.forecast_vsrt_runs r where r.done_at is not null and r.tmfc > now() - interval '3 hours' order by r.tmfc desc limit 1),
  cell as (select (c.value ->> 0)::int as nx, (c.value ->> 1)::int as ny, c.ordinality::int as i from v, jsonb_array_elements(v.cells) with ordinality c),
  x as (
    select cell.nx, cell.ny, h.tmef,
           max(case when h.vals[cell.i] >= 0 then h.vals[cell.i] end) filter (where h.var = 'RN1')::double precision as p,
           max(case when h.vals[cell.i] > -90 then h.vals[cell.i] end) filter (where h.var = 'T1H')::double precision as t,
           max(case when h.vals[cell.i] >= 0 then least(h.vals[cell.i], 100) end) filter (where h.var = 'POP')::int as o
      from cell join sel on sel.nx = cell.nx and sel.ny = cell.ny join public.forecast_vsrt_hours h on h.tmfc = (select v.tmfc from v)
     group by cell.nx, cell.ny, h.tmef),
  f as (
    select c.nx, c.ny, c.issued_at, c.snow_24h, g.i, (select st.start_at from st) + g.i * interval '1 hour' as tmef,
           (c.series -> 's' ->> g.i)::numeric as s, (c.series -> 'p' ->> g.i)::double precision as p, (c.series -> 't' ->> g.i)::double precision as t, (c.series -> 'r' ->> g.i)::int as o
      from public.forecast_cells c join sel on sel.nx = c.nx and sel.ny = c.ny cross join lateral generate_series(0, jsonb_array_length(c.series -> 't') - 1) g(i)),
  m as (
    select f.nx, f.ny, f.issued_at, f.snow_24h, f.i, f.tmef, f.s, coalesce(x.p, f.p) as p, coalesce(x.t, f.t) as t, coalesce(x.o, f.o) as o, x.tmef is not null as vs
      from f left join x on x.nx = f.nx and x.ny = f.ny and x.tmef = f.tmef)
  select m.nx, m.ny, max(m.issued_at), (select v.tmfc from v), (select st.start_at from st), (count(*) filter (where m.vs))::int, max(m.snow_24h),
         round(sum(m.p)::numeric, 1)::double precision, min(m.t),
         (array_agg(m.tmef order by m.t, m.tmef) filter (where m.t is not null))[1], max(m.o),
         case when p_series then jsonb_build_object('s', jsonb_agg(m.s order by m.i), 'p', jsonb_agg(round(m.p::numeric, 1) order by m.i), 't', jsonb_agg(round(m.t::numeric, 1) order by m.i), 'vn', count(*) filter (where m.vs))
           || case when count(m.o) > 0 then jsonb_build_object('r', jsonb_agg(m.o order by m.i)) else '{}'::jsonb end end
    from m group by m.nx, m.ny;
$$;
revoke all on function private.fc_vsrt_cells(text[], boolean) from public, anon, authenticated;

/* 지사별: branch_forecast 와 같은 이름의 칸 — 적설·강수는 격자 중 가장 많은 값, 기온은 가장 추운 값 */
create or replace function public.forecast_vsrt_overview() returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare res jsonb;
begin
  if (select private.my_role()) is null then raise exception 'login required' using errcode = '42501'; end if;
  with c as (select * from private.fc_vsrt_cells()),
  b as (
    select g.branch_id, max(c.issued_at) as issued_at, max(c.snow) as snow, max(c.pcp) as pcp, max(c.pop) as pop, min(c.tmin) as tmin,
           (array_agg(c.tmin_at order by c.tmin, c.tmin_at) filter (where c.tmin is not null))[1] as tmin_at
      from private.grid_effective() g join c on c.nx = g.nx and c.ny = g.ny group by g.branch_id)
  select jsonb_build_object('tmfc', (select max(c.issued_at) from c), 'vsrt_at', (select max(c.vsrt_at) from c), 'vn', (select max(c.vn) from c),
           'start_at', (select min(c.start_at) from c), 'end_at', (select min(c.start_at) + interval '24 hours' from c),
           'rows', coalesce((select jsonb_agg(jsonb_build_object('branch_id', b.branch_id, 'issued_at', b.issued_at, 'max_snow_24h', b.snow, 'max_pcp_24h', b.pcp, 'max_pop_24h', b.pop, 'min_tmp', b.tmin, 'min_tmp_at', b.tmin_at)) from b), '[]'::jsonb))
    into res;
  return res;
end $$;

/* 격자: forecast_grid 와 같은 모양. 추이는 지사 하나일 때만 */
create or replace function public.forecast_vsrt_grid(p_branches text[], p_series boolean default false) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare res jsonb;
begin
  if (select private.my_role()) is null then raise exception 'login required' using errcode = '42501'; end if;
  if p_branches is null or cardinality(p_branches) = 0 or cardinality(p_branches) > 30 then raise exception 'bad branches' using errcode = '22023'; end if;
  if p_series and cardinality(p_branches) > 1 then raise exception 'series for one branch only' using errcode = '22023'; end if;
  with c as (select * from private.fc_vsrt_cells(p_branches, p_series))
  select jsonb_build_object('tmfc', (select max(c.issued_at) from c), 'vsrt_at', (select max(c.vsrt_at) from c),
    'start_at', (select min(c.start_at) from c), 'end_at', (select min(c.start_at) + interval '24 hours' from c),
    'cells', coalesce(jsonb_agg(jsonb_build_array(g.nx, g.ny, g.bs, c.snow, c.pcp, c.tmin, c.tmin_at, case when p_series then c.series end, c.pop) order by g.ny, g.nx), '[]'::jsonb))
    into res
    from (select e.nx, e.ny, jsonb_agg(e.branch_id order by e.branch_id) as bs
            from private.grid_effective() e where e.branch_id = any(p_branches) group by e.nx, e.ny) g
    left join c on c.nx = g.nx and c.ny = g.ny;
  return res;
end $$;
revoke all on function public.forecast_vsrt_overview(), public.forecast_vsrt_grid(text[], boolean) from public, anon;
grant execute on function public.forecast_vsrt_overview(), public.forecast_vsrt_grid(text[], boolean) to authenticated;
