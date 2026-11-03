-- ============================================================
-- 60. 24시간 예보 = 앞 6시간 초단기예보 + 나머지 단기예보 (기상청 동네예보와 같은 방식, 2026-11-04 사용자 요청)
--  * 지금까지: 단기예보만 저장(forecast_cells·branch_forecast), 초단기는 기관별 24시간 예보 탭의 [초단기예보] 버튼을 누를 때만 계산(57·58)
--  * 바꿈: private.fc_apply 가 계산할 때 최신 초단기예보(3시간 안에 다 받은 발표분)가 있는 시각의 강수·기온·강수확률을 초단기 값으로 바꿔 넣음
--    → forecast_cells·branch_forecast 자체가 섞은 값 → 지사별 요청·편성의 24시 예보, 확정 고정값(branch_fc), 기관별 24시간 예보 탭이 모두 같은 값
--  * 적설: 초단기예보에는 적설 항목이 없음 → 초단기 시각(앞 6시간)의 적설은 0, 강수만(2026-11-04 사용자 결정 — 단기 적설을 섞지 않음).
--    나머지 시각은 단기 적설. 바다(-99) 등 초단기 강수·기온·확률 값이 빈 칸은 그 값만 단기로 채움(적설은 그래도 0)
--  * 초단기 발표분을 다 받을 때마다(10분마다) 지금 창(발표 시각·시작 시각) 그대로 다시 계산(private.fc_refresh). 매시 정각 창 옮기기·단기 새 발표도 자동으로 섞음
--  * 초단기를 3시간 넘게 못 받으면 단기예보만(다음 계산 때부터)
--  * series.vn = 앞에서 몇 시각이 초단기 값인지, branch_forecast.detail.vsrt_at·vn = 섞은 초단기 발표 시각·시각 수
--  * 동시에 계산하지 않게 잠금(pg_advisory_xact_lock) — 단기 받기와 초단기 받기가 겹쳐도 마지막 계산이 최신 자료
--  * 최저기온 시각 계산을 배열 집계로 바꿔 빠르게(값은 같음: 가장 낮은 기온, 같으면 이른 시각)
--  * 전환 보기 함수(forecast_vsrt_overview·forecast_vsrt_grid·private.fc_vsrt_cells)는 화면에서 버튼을 없애 지움
--  * 시험: supabase/tests/forecast_vsrt_test.sql (되돌림)
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

/* 지금 창(발표 시각·시작 시각) 그대로 다시 계산 — 초단기 새 발표분을 다 받았을 때 */
create or replace function private.fc_refresh() returns boolean
language plpgsql security definer set search_path = ''
as $$
declare t timestamptz; s timestamptz;
begin
  perform pg_advisory_xact_lock(hashtext('ss_fc_apply'));        -- 단기 계산이 끝난 뒤의 창을 읽도록 먼저 잠금
  select f.issued_at, (f.detail ->> 'start_at')::timestamptz into t, s from public.branch_forecast f order by f.issued_at desc, f.updated_at desc limit 1;
  if t is null or s is null then return false; end if;
  return private.fc_apply(t, s);
end $$;
revoke all on function private.fc_refresh() from public, anon, authenticated;

/* 초단기 넣기: 18개가 다 모이면 끝 표시 + 지금 24시간 예보에 섞어 다시 계산(계산이 실패해도 받은 자료는 남김) */
create or replace function public.forecast_vsrt_put(p_tmfc timestamptz, p_var text, p_tmef timestamptz, p_vals real[]) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare r public.forecast_vsrt_runs; n int; h0 timestamptz := date_trunc('hour', p_tmfc) + interval '1 hour'; mixed boolean;
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
  begin
    mixed := private.fc_refresh();
  exception when others then
    mixed := false;
    update public.collector_state set note = left('24시간 예보에 섞기 실패: ' || sqlerrm, 500) where job = 'forecast_vsrt';
  end;
  return jsonb_build_object('ok', true, 'done', true, 'mixed', mixed);
end $$;
revoke all on function public.forecast_vsrt_put(timestamptz, text, timestamptz, real[]) from public, anon, authenticated;
grant execute on function public.forecast_vsrt_put(timestamptz, text, timestamptz, real[]) to service_role;

/* 전환 보기 함수는 더 쓰지 않음 */
drop function if exists public.forecast_vsrt_overview();
drop function if exists public.forecast_vsrt_grid(text[], boolean);
drop function if exists private.fc_vsrt_cells(text[], boolean);

/* 지금 예보에 바로 섞기 */
select private.fc_refresh();
