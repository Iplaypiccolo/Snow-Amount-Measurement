-- 67. 신적설은 앞 6시간을 포함해 단기예보 사용 (1단계)
-- 서버 적용 전 사용자 확인 필요. 수집 범위·권한·확정값은 변경하지 않음.
-- 서버 현재 정의가 검토 당시와 다르면 중단. 변경 후 현재 예보 창만 다시 계산.
begin;
set local lock_timeout = '10s';
set local statement_timeout = '45s';
select pg_advisory_xact_lock(hashtext('ss_fc_apply'));
do $guard$
begin
 if md5(pg_get_functiondef('private.fc_apply(timestamptz,timestamptz)'::regprocedure)) <> 'd06ffb70647d7022dd40b989655a3be8' then
  raise exception 'fc_apply가 검토 후 변경되었습니다. 최신 정의를 다시 확인하세요.';
 end if;
end $guard$;

CREATE OR REPLACE FUNCTION private.fc_apply(p_tmfc timestamp with time zone, p_start timestamp with time zone)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare r public.forecast_runs; n int; vt timestamptz; vc jsonb;
begin
  perform pg_advisory_xact_lock(hashtext('ss_fc_apply'));        -- 한 번에 하나만 계산
  select * into r from public.forecast_runs where tmfc = p_tmfc;
  if not found then return false; end if;
  select count(*) into n from public.forecast_hours where tmfc = p_tmfc and var in ('SNO', 'PCP', 'TMP') and tmef >= p_start and tmef < p_start + interval '24 hours';
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
             max(case when h.vals[cell.i] >= 0 then least(h.vals[cell.i], 100) end) filter (where h.var = 'POP')::int as o,
             max(case when h.vals[cell.i] >= 0 then h.vals[cell.i] end) filter (where h.var = 'PTY')::int as y      -- 62: 강수형태 0 없음·1 비·2 비/눈·3 눈·4 소나기
        from cell join public.forecast_hours h on h.tmfc = p_tmfc and h.tmef >= p_start and h.tmef < p_start + interval '24 hours'
       group by cell.nx, cell.ny, h.tmef),
    vcell as (
      select (c.value ->> 0)::int as nx, (c.value ->> 1)::int as ny, c.ordinality::int as i
        from jsonb_array_elements(coalesce(vc, '[]'::jsonb)) with ordinality c),
    vx as (
      select vcell.nx, vcell.ny, h.tmef,
             max(case when h.vals[vcell.i] >= 0 then h.vals[vcell.i] end) filter (where h.var = 'RN1')::double precision as p,
             max(case when h.vals[vcell.i] > -90 then h.vals[vcell.i] end) filter (where h.var = 'T1H')::double precision as t,
             max(case when h.vals[vcell.i] >= 0 then least(h.vals[vcell.i], 100) end) filter (where h.var = 'POP')::int as o,
             max(case when h.vals[vcell.i] >= 0 then h.vals[vcell.i] end) filter (where h.var = 'PTY')::int as y      -- 62: 초단기 강수형태(5 빗방울·6 빗방울눈날림·7 눈날림 추가)
        from vcell join public.forecast_vsrt_hours h on h.tmfc = vt and h.tmef >= p_start and h.tmef < p_start + interval '24 hours'
       where h.tmef in (select z.tmef from public.forecast_vsrt_hours z where z.tmfc = vt and z.var = 'T1H' and exists (select 1 from unnest(z.vals) q where q <> 0))      -- 61: 기온이 전국 모두 0 인 시각 = 아직 안 나온 시각 → 섞지 않음
       group by vcell.nx, vcell.ny, h.tmef)
    , m as (
      select sh.nx, sh.ny, sh.tmef, vx.tmef is not null as vs,
             sh.s as s, coalesce(vx.p, sh.p) as p, coalesce(vx.t, sh.t) as t, coalesce(vx.o, sh.o) as o,
             case when vx.p is not null then coalesce(vx.y, sh.y) else sh.y end as y, sh.y as sy
        from sh left join vx on vx.nx = sh.nx and vx.ny = sh.ny and vx.tmef = sh.tmef)
    -- 62: '1mm 미만'·'1cm 미만'은 격자에 0 으로 옴 → 강수형태가 있는데 양이 0 이면 그 시각은 '~1'(pq·sq). 신적설은 모든 시각에 단기 값 사용(67)
    select m.nx, m.ny, m.tmef, m.vs, m.s, m.p, m.t, m.o,
           (m.p = 0 and coalesce(m.y, 0) > 0) as pq,
           (m.s = 0 and coalesce(m.sy, 0) in (2, 3, 6, 7)) as sq
      from m;

  drop table if exists _fc;
  create temp table _fc on commit drop as
    select x.nx, x.ny,
           round(sum(x.s)::numeric, 1)::double precision as snow,
           round(sum(x.p)::numeric, 1)::double precision as pcp,
           round((sum(x.p) + count(*) filter (where x.pq))::numeric, 1)::double precision as pcp_hi,      -- 62: 범위 위쪽 = '~1' 시각마다 1 을 더함(0~3mm)
           round((sum(x.s) + count(*) filter (where x.sq))::numeric, 1)::double precision as snow_hi,
           min(x.t) as tmin,
           (array_agg(x.tmef order by x.t, x.tmef) filter (where x.t is not null))[1] as tmin_at,
           max(x.o) as pop,
           (count(*) filter (where x.vs))::int as vn,
           jsonb_build_object('s', jsonb_agg(round(x.s::numeric, 1) order by x.tmef), 'p', jsonb_agg(round(x.p::numeric, 1) order by x.tmef),
                              't', jsonb_agg(round(x.t::numeric, 1) order by x.tmef))
             || case when count(x.o) > 0 then jsonb_build_object('r', jsonb_agg(x.o order by x.tmef)) else '{}'::jsonb end
             || case when count(*) filter (where x.vs) > 0 then jsonb_build_object('vn', count(*) filter (where x.vs)) else '{}'::jsonb end
             || case when count(*) filter (where x.pq) > 0 then jsonb_build_object('pq', jsonb_agg(x.pq::int order by x.tmef)) else '{}'::jsonb end
             || case when count(*) filter (where x.sq) > 0 then jsonb_build_object('sq', jsonb_agg(x.sq::int order by x.tmef)) else '{}'::jsonb end as series
      from _fh x group by x.nx, x.ny;

  insert into public.forecast_cells as f (nx, ny, issued_at, snow_24h, pcp_24h, tmin, tmin_at, pop_24h, series, pcp_hi, snow_hi, updated_at)
  select nx, ny, p_tmfc, snow, pcp, tmin, tmin_at, pop, series, pcp_hi, snow_hi, now() from _fc
  on conflict (nx, ny) do update set issued_at = excluded.issued_at, snow_24h = excluded.snow_24h, pcp_24h = excluded.pcp_24h, pcp_hi = excluded.pcp_hi, snow_hi = excluded.snow_hi,
    tmin = excluded.tmin, tmin_at = excluded.tmin_at, pop_24h = excluded.pop_24h, series = excluded.series, updated_at = now();
  delete from public.forecast_cells f where not exists (select 1 from _fc where _fc.nx = f.nx and _fc.ny = f.ny);

  with s as (select distinct on (g.branch_id) g.branch_id, c.snow, c.nx, c.ny from private.grid_effective() g join _fc c on c.nx = g.nx and c.ny = g.ny order by g.branch_id, c.snow desc, c.ny, c.nx),
       p as (select distinct on (g.branch_id) g.branch_id, c.pcp, c.nx, c.ny from private.grid_effective() g join _fc c on c.nx = g.nx and c.ny = g.ny order by g.branch_id, c.pcp desc, c.ny, c.nx),
       t as (select distinct on (g.branch_id) g.branch_id, c.tmin, c.tmin_at, c.nx, c.ny from private.grid_effective() g join _fc c on c.nx = g.nx and c.ny = g.ny
              order by g.branch_id, c.tmin asc nulls last, c.tmin_at, c.ny, c.nx),
       o as (select g.branch_id, max(c.pop) as pop, max(c.vn) as vn, max(c.pcp_hi) as pcp_hi, max(c.snow_hi) as snow_hi from private.grid_effective() g join _fc c on c.nx = g.nx and c.ny = g.ny group by g.branch_id)
  insert into public.branch_forecast as f (branch_id, issued_at, max_snow_24h, max_pcp_24h, min_tmp, min_tmp_at, max_pop_24h, max_pcp_hi, max_snow_hi, worst_nx, worst_ny, detail, updated_at)
  select s.branch_id, p_tmfc, s.snow, p.pcp, t.tmin, t.tmin_at, o.pop, o.pcp_hi, o.snow_hi, s.nx, s.ny,
         jsonb_build_object('start_at', p_start, 'end_at', p_start + interval '24 hours', 'pcp_nx', p.nx, 'pcp_ny', p.ny, 'tmp_nx', t.nx, 'tmp_ny', t.ny,
                            'vsrt_at', case when o.vn > 0 then vt end, 'vn', o.vn), now()
    from s join p using (branch_id) join t using (branch_id) join o using (branch_id)
  on conflict (branch_id) do update set issued_at = excluded.issued_at, max_snow_24h = excluded.max_snow_24h, max_pcp_24h = excluded.max_pcp_24h,
    min_tmp = excluded.min_tmp, min_tmp_at = excluded.min_tmp_at, max_pop_24h = excluded.max_pop_24h, max_pcp_hi = excluded.max_pcp_hi, max_snow_hi = excluded.max_snow_hi,
    worst_nx = excluded.worst_nx, worst_ny = excluded.worst_ny, detail = excluded.detail, updated_at = now();
  delete from public.branch_forecast f where not exists (select 1 from private.grid_effective() g where g.branch_id = f.branch_id);
  return true;
end $function$
;

-- 이미 확정된 round_requests.fc_*는 건드리지 않음.
do $refresh$
begin
 if private.fc_refresh() is distinct from true then
  raise exception '현재 예보 창 재계산 실패: 함수 변경을 포함해 전부 취소합니다.';
 end if;
end $refresh$;
commit;
