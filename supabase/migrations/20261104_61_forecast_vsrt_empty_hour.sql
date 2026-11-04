-- ============================================================
-- 61. 초단기예보의 '아직 안 나온 시각'(전국 모든 칸 0)을 섞지 않음 (2026-11-04 사용자 보고: 6시간 중 15시가 0)
--  * 원인: 기상청 초단기 격자는 발표분이 아직 담지 않은 시각(예: 09:00 발표의 15시)도 200 + 모든 칸 0 을 돌려줌.
--    60 이 그 0 을 진짜 값으로 섞어 59개 지사 모두 최저기온 0℃(15시)·강수 0·확률 0 으로 보였음(2026-11-04 09:2x 확인)
--  * 고침: 그 발표분에서 기온(T1H)이 한 칸이라도 0 이 아닌 시각만 섞음 → 빈 시각은 단기예보 값(색칠 안 함, series.vn 이 5)
--  * 함수 private.fc_apply 의 초단기 읽는 곳에 조건 한 줄. 표·권한·예약 그대로. 바로 다시 계산(fc_refresh)
--  * 시험: supabase/tests/forecast_vsrt_test.sql ('빈 시각(모두 0)은 섞지 않음')
-- ============================================================
create or replace function private.fc_apply(p_tmfc timestamptz, p_start timestamptz) returns boolean
language plpgsql security definer set search_path = ''
as $$
declare r public.forecast_runs; n int; vt timestamptz; vc jsonb;
begin
  perform pg_advisory_xact_lock(hashtext('ss_fc_apply'));        -- 한 번에 하나만 계산
  select * into r from public.forecast_runs where tmfc = p_tmfc;
  if not found then return false; end if;
  select count(*) into n from public.forecast_hours where tmfc = p_tmfc and var <> 'POP' and tmef >= p_start and tmef < p_start + interval '24 hours';
  if n < 72 then return false; end if;
  select v.tmfc, v.cells into vt, vc from public.forecast_vsrt_runs v
   where v.done_at is not null and v.tmfc > now() - interval '3 hours' order by v.tmfc desc limit 1;      -- 섞을 초단기(없으면 단기만)

  drop table if exists _fh;
  create temp table _fh on commit drop as
    with cell as (
      select (c.value ->> 0)::int as nx, (c.value ->> 1)::int as ny, c.ordinality::int as i
        from jsonb_array_elements(r.cells) with ordinality c),
    sh as (
      select cell.nx, cell.ny, h.tmef,
             max(greatest(h.vals[cell.i], 0)) filter (where h.var = 'SNO')::double precision as s,
             max(greatest(h.vals[cell.i], 0)) filter (where h.var = 'PCP')::double precision as p,
             max(case when h.vals[cell.i] > -90 then h.vals[cell.i] end) filter (where h.var = 'TMP')::double precision as t,
             max(case when h.vals[cell.i] >= 0 then least(h.vals[cell.i], 100) end) filter (where h.var = 'POP')::int as o
        from cell join public.forecast_hours h on h.tmfc = p_tmfc and h.tmef >= p_start and h.tmef < p_start + interval '24 hours'
       group by cell.nx, cell.ny, h.tmef),
    vcell as (
      select (c.value ->> 0)::int as nx, (c.value ->> 1)::int as ny, c.ordinality::int as i
        from jsonb_array_elements(coalesce(vc, '[]'::jsonb)) with ordinality c),
    vx as (
      select vcell.nx, vcell.ny, h.tmef,
             max(case when h.vals[vcell.i] >= 0 then h.vals[vcell.i] end) filter (where h.var = 'RN1')::double precision as p,
             max(case when h.vals[vcell.i] > -90 then h.vals[vcell.i] end) filter (where h.var = 'T1H')::double precision as t,
             max(case when h.vals[vcell.i] >= 0 then least(h.vals[vcell.i], 100) end) filter (where h.var = 'POP')::int as o
        from vcell join public.forecast_vsrt_hours h on h.tmfc = vt and h.tmef >= p_start and h.tmef < p_start + interval '24 hours'
       where h.tmef in (select z.tmef from public.forecast_vsrt_hours z where z.tmfc = vt and z.var = 'T1H' and exists (select 1 from unnest(z.vals) q where q <> 0))      -- 61: 기온이 전국 모두 0 인 시각 = 아직 안 나온 시각(기상청이 0 으로 채워 줌) → 섞지 않음
       group by vcell.nx, vcell.ny, h.tmef)
    select sh.nx, sh.ny, sh.tmef, case when vx.tmef is not null then 0 else sh.s end as s, coalesce(vx.p, sh.p) as p, coalesce(vx.t, sh.t) as t, coalesce(vx.o, sh.o) as o, vx.tmef is not null as vs
      from sh left join vx on vx.nx = sh.nx and vx.ny = sh.ny and vx.tmef = sh.tmef;

  drop table if exists _fc;
  create temp table _fc on commit drop as
    select x.nx, x.ny,
           round(sum(x.s)::numeric, 1)::double precision as snow,
           round(sum(x.p)::numeric, 1)::double precision as pcp,
           min(x.t) as tmin,
           (array_agg(x.tmef order by x.t, x.tmef) filter (where x.t is not null))[1] as tmin_at,
           max(x.o) as pop,
           (count(*) filter (where x.vs))::int as vn,
           jsonb_build_object('s', jsonb_agg(round(x.s::numeric, 1) order by x.tmef), 'p', jsonb_agg(round(x.p::numeric, 1) order by x.tmef),
                              't', jsonb_agg(round(x.t::numeric, 1) order by x.tmef))
             || case when count(x.o) > 0 then jsonb_build_object('r', jsonb_agg(x.o order by x.tmef)) else '{}'::jsonb end
             || case when count(*) filter (where x.vs) > 0 then jsonb_build_object('vn', count(*) filter (where x.vs)) else '{}'::jsonb end as series
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
       o as (select g.branch_id, max(c.pop) as pop, max(c.vn) as vn from private.grid_effective() g join _fc c on c.nx = g.nx and c.ny = g.ny group by g.branch_id)
  insert into public.branch_forecast as f (branch_id, issued_at, max_snow_24h, max_pcp_24h, min_tmp, min_tmp_at, max_pop_24h, worst_nx, worst_ny, detail, updated_at)
  select s.branch_id, p_tmfc, s.snow, p.pcp, t.tmin, t.tmin_at, o.pop, s.nx, s.ny,
         jsonb_build_object('start_at', p_start, 'end_at', p_start + interval '24 hours', 'pcp_nx', p.nx, 'pcp_ny', p.ny, 'tmp_nx', t.nx, 'tmp_ny', t.ny,
                            'vsrt_at', case when o.vn > 0 then vt end, 'vn', o.vn), now()
    from s join p using (branch_id) join t using (branch_id) join o using (branch_id)
  on conflict (branch_id) do update set issued_at = excluded.issued_at, max_snow_24h = excluded.max_snow_24h, max_pcp_24h = excluded.max_pcp_24h,
    min_tmp = excluded.min_tmp, min_tmp_at = excluded.min_tmp_at, max_pop_24h = excluded.max_pop_24h,
    worst_nx = excluded.worst_nx, worst_ny = excluded.worst_ny, detail = excluded.detail, updated_at = now();
  delete from public.branch_forecast f where not exists (select 1 from private.grid_effective() g where g.branch_id = f.branch_id);
  return true;
end $$;
revoke all on function private.fc_apply(timestamptz, timestamptz) from public, anon, authenticated;

select private.fc_refresh();
