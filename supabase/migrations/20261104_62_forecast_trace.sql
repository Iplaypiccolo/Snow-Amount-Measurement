-- ============================================================
-- 62. 강수형태(PTY)도 받아 '1mm 미만'을 '~1mm'로, 합계는 범위(0~3mm) (2026-11-04 사용자 결정)
--  * 확인한 것: 기상청 격자 강수량(PCP·RN1)은 0·1·2… 정수로만 옴. 2026-11-04 08시 발표분에서 강수량이 있는 칸은 모두 강수확률 60%,
--    확률 60% + 강수량 0 인 칸이 3,179개 → '1mm 미만'이 0 으로 오는 것으로 봄(추정). 그래서 강수형태(비·눈 등)를 같이 받아 구분
--  * 받기: 단기 PTY 27시각(108 → 135번, 적설·강수·기온 먼저, 확률·강수형태는 그다음), 초단기 PTY 6시각(18 → 24번). 수집 함수는 서버 목록대로 받으므로 고치지 않음
--  * 계산(private.fc_apply): 그 시각 강수형태 > 0 인데 강수량 0 → '~1mm'(series.pq = 1). 적설은 단기 시각만: 강수형태가 눈 계열(2·3·6·7)인데 적설 0 → '~1cm'(series.sq)
--    초단기 시각(앞 6시간)의 적설은 지금처럼 늘 0. 범위 위쪽 = 아래쪽 + '~1' 시각 수(예: ~1mm 세 시간 = 0~3mm) → forecast_cells.pcp_hi·snow_hi,
--    branch_forecast.max_pcp_hi·max_snow_hi(지사 격자 중 가장 큰 값), 확정하면 round_requests.fc_pcp_hi·fc_snow_hi 에 고정
--  * forecast_grid 격자 배열 맨 뒤에 [9] pcp_hi, [10] snow_hi 추가(앞 순서 그대로)
--  * 지금 발표분도 강수형태를 바로 받도록 끝난 표시만 풀어 둠(다음 예약 때 강수형태 27줄만 더 받음)
--  * 시험: supabase/tests/forecast_vsrt_test.sql, forecast_test.sql
-- ============================================================

-- 1) 새 칸(비어 있어도 되는 칸 — 기존 자료 그대로)
alter table public.forecast_cells  add column if not exists pcp_hi double precision, add column if not exists snow_hi double precision;
alter table public.branch_forecast add column if not exists max_pcp_hi double precision, add column if not exists max_snow_hi double precision;
alter table public.round_requests  add column if not exists fc_pcp_hi double precision, add column if not exists fc_snow_hi double precision;
comment on column public.forecast_cells.pcp_hi is '24시간 강수 범위 위쪽(mm) — 1mm 미만(~1) 시각마다 1 을 더함. 아래쪽은 pcp_24h';
comment on column public.branch_forecast.max_pcp_hi is '지사 격자 중 강수 범위 위쪽이 가장 큰 값(mm)';
comment on column public.round_requests.fc_pcp_hi is '확정 순간의 강수 범위 위쪽(mm)';

-- 2) 받을 종류에 강수형태
alter table public.forecast_hours drop constraint if exists forecast_hours_var_check;
alter table public.forecast_hours add constraint forecast_hours_var_check check (var = any (array['SNO', 'PCP', 'TMP', 'POP', 'PTY']));
alter table public.forecast_vsrt_hours drop constraint if exists forecast_vsrt_hours_var_check;
alter table public.forecast_vsrt_hours add constraint forecast_vsrt_hours_var_check check (var = any (array['T1H', 'RN1', 'POP', 'PTY']));

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
    'missing', (select coalesce(jsonb_agg(jsonb_build_array(v, h) order by (v in ('POP', 'PTY')), h, v), '[]'::jsonb)
                  from generate_series(r.start_at, r.start_at + interval '26 hours', interval '1 hour') h, unnest(array['SNO', 'PCP', 'TMP', 'POP', 'PTY']) v
                 where not exists (select 1 from public.forecast_hours x where x.tmfc = r.tmfc and x.var = v and x.tmef = h)));
end $$;

-- 단기 넣기: 적설·강수·기온 81줄이 모이면 먼저 계산, 강수확률·강수형태 54줄까지 모이면 다시 계산하고 끝
create or replace function public.forecast_put(p_tmfc timestamptz, p_var text, p_tmef timestamptz, p_vals real[]) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare r public.forecast_runs; n int; np int; w timestamptz;
begin
  select * into r from public.forecast_runs where tmfc = p_tmfc;
  if not found then raise exception 'unknown run' using errcode = '23503'; end if;
  if r.done_at is not null then return jsonb_build_object('ok', true, 'done', true); end if;
  if p_var not in ('SNO', 'PCP', 'TMP', 'POP', 'PTY') then raise exception 'bad var' using errcode = '22023'; end if;
  if array_length(p_vals, 1) is distinct from jsonb_array_length(r.cells) then raise exception 'bad vals' using errcode = '22023'; end if;
  insert into public.forecast_hours (tmfc, var, tmef, vals) values (p_tmfc, p_var, p_tmef, p_vals)
  on conflict (tmfc, var, tmef) do update set vals = excluded.vals;
  select count(*) filter (where var in ('SNO', 'PCP', 'TMP')), count(*) filter (where var in ('POP', 'PTY')) into n, np
    from public.forecast_hours where tmfc = p_tmfc and tmef >= r.start_at and tmef < r.start_at + interval '27 hours';
  if n < 81 or (r.core_at is not null and np < 54) then return jsonb_build_object('ok', true, 'hours', n + np); end if;

  w := least(greatest(date_trunc('hour', now()) + interval '1 hour', r.start_at), r.start_at + interval '3 hours');
  perform private.fc_apply(p_tmfc, w);
  if r.core_at is null then
    update public.forecast_runs set core_at = now() where tmfc = p_tmfc;
    delete from public.forecast_runs where tmfc < p_tmfc;
    insert into public.collector_state as s (job, cursor, started_at, finished_at, ok, note)
    values ('forecast', to_char(p_tmfc at time zone 'Asia/Seoul', 'YYYYMMDDHH24'), r.created_at, now(), true, null)
    on conflict (job) do update set cursor = excluded.cursor, started_at = excluded.started_at, finished_at = now(), ok = true, note = null;
  end if;
  if np < 54 then return jsonb_build_object('ok', true, 'hours', n + np, 'core', true, 'window', w); end if;
  update public.forecast_runs set done_at = now() where tmfc = p_tmfc;
  return jsonb_build_object('ok', true, 'done', true, 'window', w);
end $$;

-- 초단기: 시작할 때 강수형태도 목록에, 24줄(4종 × 6시각)이 모이면 끝
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
                  from generate_series(h0, h0 + interval '5 hours', interval '1 hour') h, unnest(array['T1H', 'RN1', 'POP', 'PTY']) v
                 where not exists (select 1 from public.forecast_vsrt_hours x where x.tmfc = p_tmfc and x.var = v and x.tmef = h)));
end $$;

create or replace function public.forecast_vsrt_put(p_tmfc timestamptz, p_var text, p_tmef timestamptz, p_vals real[]) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare r public.forecast_vsrt_runs; n int; h0 timestamptz := date_trunc('hour', p_tmfc) + interval '1 hour'; mixed boolean;
begin
  select * into r from public.forecast_vsrt_runs where tmfc = p_tmfc;
  if not found then raise exception 'unknown run' using errcode = '23503'; end if;
  if r.done_at is not null then return jsonb_build_object('ok', true, 'done', true); end if;
  if p_var not in ('T1H', 'RN1', 'POP', 'PTY') then raise exception 'bad var' using errcode = '22023'; end if;
  if p_tmef < h0 or p_tmef > h0 + interval '5 hours' then raise exception 'bad tmef' using errcode = '22023'; end if;
  if array_length(p_vals, 1) is distinct from jsonb_array_length(r.cells) then raise exception 'bad vals' using errcode = '22023'; end if;
  insert into public.forecast_vsrt_hours (tmfc, var, tmef, vals) values (p_tmfc, p_var, p_tmef, p_vals)
  on conflict (tmfc, var, tmef) do update set vals = excluded.vals;
  select count(*) into n from public.forecast_vsrt_hours where tmfc = p_tmfc;
  if n < 24 then return jsonb_build_object('ok', true, 'hours', n); end if;

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
revoke all on function public.forecast_plan(), public.forecast_put(timestamptz, text, timestamptz, real[]), public.forecast_vsrt_begin(timestamptz), public.forecast_vsrt_put(timestamptz, text, timestamptz, real[]) from public, anon, authenticated;
grant execute on function public.forecast_plan(), public.forecast_put(timestamptz, text, timestamptz, real[]), public.forecast_vsrt_begin(timestamptz), public.forecast_vsrt_put(timestamptz, text, timestamptz, real[]) to service_role;

-- 3) 계산
create or replace function private.fc_apply(p_tmfc timestamptz, p_start timestamptz) returns boolean
language plpgsql security definer set search_path = ''
as $$
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
       where h.tmef in (select z.tmef from public.forecast_vsrt_hours z where z.tmfc = vt and z.var = 'T1H' and exists (select 1 from unnest(z.vals) q where q <> 0))      -- 61: 기온이 전국 모두 0 인 시각 = 아직 안 나온 시각(기상청이 0 으로 채워 줌) → 섞지 않음
       group by vcell.nx, vcell.ny, h.tmef)
    , m as (
      select sh.nx, sh.ny, sh.tmef, vx.tmef is not null as vs,
             case when vx.tmef is not null then 0 else sh.s end as s, coalesce(vx.p, sh.p) as p, coalesce(vx.t, sh.t) as t, coalesce(vx.o, sh.o) as o,
             case when vx.p is not null then coalesce(vx.y, sh.y) else sh.y end as y, sh.y as sy
        from sh left join vx on vx.nx = sh.nx and vx.ny = sh.ny and vx.tmef = sh.tmef)
    -- 62: '1mm 미만'·'1cm 미만'은 격자에 0 으로 옴 → 강수형태가 있는데 양이 0 이면 그 시각은 '~1'(pq·sq). 적설은 단기 시각만(초단기 시각 적설은 늘 0)
    select m.nx, m.ny, m.tmef, m.vs, m.s, m.p, m.t, m.o,
           (m.p = 0 and coalesce(m.y, 0) > 0) as pq,
           (not m.vs and m.s = 0 and coalesce(m.sy, 0) in (2, 3, 6, 7)) as sq
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
end $$;
revoke all on function private.fc_apply(timestamptz, timestamptz) from public, anon, authenticated;

-- 4) 화면이 읽는 격자 목록: 맨 뒤에 [9] 강수 범위 위쪽, [10] 적설 범위 위쪽
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
               case when ok then c.pop_24h end,
               case when ok then c.pcp_hi end, case when ok then c.snow_hi end) order by g.ny, g.nx), '[]'::jsonb))
    into res
    from (select e.nx, e.ny, jsonb_agg(e.branch_id order by e.branch_id) as bs
            from private.grid_effective() e where e.branch_id = any(p_branches) group by e.nx, e.ny) g
    left join public.forecast_cells c on c.nx = g.nx and c.ny = g.ny
    cross join lateral (select c.issued_at >= now() - interval '12 hours' as ok) k;
  return res;
end $$;

-- 5) 확정 순간에 남기는 값에 범위 위쪽 추가(취소하면 비움)
create or replace function private.branch_fc(p_branch text) returns jsonb
language sql stable security definer set search_path = ''
as $$
  select case when f.issued_at >= now() - interval '12 hours'
              then jsonb_build_object('snow', f.max_snow_24h, 'pcp', f.max_pcp_24h, 'tmin', f.min_tmp, 'tmin_at', f.min_tmp_at, 'pop', f.max_pop_24h, 'tmfc', f.issued_at,
                                      'pcp_hi', f.max_pcp_hi, 'snow_hi', f.max_snow_hi) end
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
    new.fc_pcp_hi := (f ->> 'pcp_hi')::double precision; new.fc_snow_hi := (f ->> 'snow_hi')::double precision;
    new.fc_tmfc := (f ->> 'tmfc')::timestamptz; new.fc_at := now();
  elsif not new.confirmed then
    new.warn_level := null; new.warn_zones := null; new.warn_base := null; new.warn_note := null; new.warn_at := null;
    new.fc_snow := null; new.fc_pcp := null; new.fc_tmin := null; new.fc_tmin_at := null; new.fc_pop := null; new.fc_tmfc := null; new.fc_at := null;
    new.fc_pcp_hi := null; new.fc_snow_hi := null;
  else
    new.warn_level := old.warn_level; new.warn_zones := old.warn_zones; new.warn_base := old.warn_base;
    new.warn_note := old.warn_note; new.warn_at := old.warn_at;
    new.fc_snow := old.fc_snow; new.fc_pcp := old.fc_pcp; new.fc_tmin := old.fc_tmin; new.fc_tmin_at := old.fc_tmin_at; new.fc_pop := old.fc_pop;
    new.fc_pcp_hi := old.fc_pcp_hi; new.fc_snow_hi := old.fc_snow_hi;
    new.fc_tmfc := old.fc_tmfc; new.fc_at := old.fc_at;
  end if;
  return new;
end $$;

-- 6) 지금 발표분에도 강수형태를 바로 받도록: 끝난 표시만 풀어 둠(다음 예약 때 강수형태 27줄만 더 받고 다시 끝남)
update public.forecast_runs set done_at = null where tmfc = (select max(tmfc) from public.forecast_runs) and core_at is not null;
select private.fc_refresh();
