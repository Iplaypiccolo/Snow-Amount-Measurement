-- 68. 사용자 승인 후2026-11-05 KST 적용 완료. 서버 이력 forecast_extended_68 / 20261104230414.
-- 앞 27시간 우선순위/24시간 저장 계산은 유지, 이후는 끝까지 저장만.
-- 기존 API/화면 계약 유지. 새 forecast_skip은 service_role만 호출.
begin;
set local lock_timeout='10s';
set local statement_timeout='45s';
do $lock$ begin
  if not pg_try_advisory_xact_lock(hashtext('ss_fc_apply')) then
    raise exception 'forecast calculation is busy; no changes made, retry later';
  end if;
end $lock$;
lock table public.forecast_runs,public.forecast_hours in access exclusive mode nowait;
do $guard$ begin
  if md5(pg_get_functiondef('private.fc_refresh()'::regprocedure)) <> 'f2fd0983a81d014916978a1c999e3520' then raise exception 'fc_refresh changed since review'; end if;
  if md5(pg_get_functiondef('public.forecast_plan()'::regprocedure)) <> '85a77f1ce0abee36da8dd210c30057de' then raise exception 'forecast_plan changed since review'; end if;
  if md5(pg_get_functiondef('public.forecast_put(timestamp with time zone, text, timestamp with time zone, real[])'::regprocedure)) <> 'ce4b29ba743eb1a366d4e1fa415b2fe7' then raise exception 'forecast_put changed since review'; end if;
  if md5(pg_get_functiondef('private.fc_roll()'::regprocedure)) <> 'd715050206d421a022c511f00dc0c510' then raise exception 'fc_roll changed since review'; end if;
  if md5(pg_get_functiondef('private.fc_apply(timestamp with time zone, timestamp with time zone)'::regprocedure)) <> '89e1730d8102df25ecf1fd91f50079a2' then raise exception 'fc_apply changed since review'; end if;
end $guard$;

alter table public.forecast_runs add column if not exists end_at timestamptz, add column if not exists aux_at timestamptz;
alter table public.forecast_hours add column if not exists is_empty boolean not null default false;
comment on column public.forecast_hours.is_empty is 'TMP 전국 37,697칸이 0인 시각. 같은 시각 5종 모두 제외';
-- Helpers are private and run inside existing security-definer RPCs.
create or replace function private.fc_end(p_tmfc timestamptz) returns timestamptz
language sql immutable set search_path = '' as $$
  select (date_trunc('day', p_tmfc at time zone 'Asia/Seoul')
    + case when extract(hour from p_tmfc at time zone 'Asia/Seoul') < 17
           then interval '4 days' else interval '5 days' end) at time zone 'Asia/Seoul'
$$;

-- 00시 값은 앞날의 마지막 1시간. 그 뒤는 연장 구간의 정성 정보로 취급.
create or replace function private.fc_quantity_end(p_tmfc timestamptz) returns timestamptz
language sql immutable set search_path = '' as $$
  select private.fc_end(p_tmfc) - interval '1 day'
$$;

-- 한 시각의 핵심 3종이 준비된 가장 최근 발표. 먼 표는 p_aux=true로 5종 완성본만 선택.
-- 각 발표의 cells 순서는 다를 수 있으므로 배열과 그 발표의 좌표 목록을 함께 반환.
create or replace function private.fc_hours(p_tmfc timestamptz, p_from timestamptz, p_to timestamptz, p_aux boolean default false)
returns table (tmfc timestamptz, tmef timestamptz, cells jsonb, s real[], p real[], t real[], o real[], y real[], quantity boolean)
language sql stable set search_path = '' as $$
  select distinct on (t.tmef) r.tmfc, t.tmef, r.cells, s.vals, p.vals, t.vals, o.vals, y.vals,
         t.tmef <= private.fc_quantity_end(r.tmfc)
    from public.forecast_runs r
    join public.forecast_hours t on t.tmfc=r.tmfc and t.var='TMP' and not t.is_empty
    join public.forecast_hours s on s.tmfc=r.tmfc and s.tmef=t.tmef and s.var='SNO' and not s.is_empty
    join public.forecast_hours p on p.tmfc=r.tmfc and p.tmef=t.tmef and p.var='PCP' and not p.is_empty
    left join public.forecast_hours o on o.tmfc=r.tmfc and o.tmef=t.tmef and o.var='POP' and not o.is_empty
    left join public.forecast_hours y on y.tmfc=r.tmfc and y.tmef=t.tmef and y.var='PTY' and not y.is_empty
   where r.tmfc <= p_tmfc and t.tmef >= p_from and t.tmef <= p_to
     and (not p_aux or (o.tmfc is not null and y.tmfc is not null))
   order by t.tmef, r.tmfc desc
$$;


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
  select count(*) into n from private.fc_hours(p_tmfc,p_start,p_start+interval '23 hours',false);
  if n=0 then return false; end if;
  select v.tmfc, v.cells into vt, vc from public.forecast_vsrt_runs v
   where v.done_at is not null and v.tmfc > now() - interval '3 hours' order by v.tmfc desc limit 1;      -- 섞을 초단기(없으면 단기만)

  drop table if exists _fh;
  create temp table _fh on commit drop as
    with cell as (
      select (c.value ->> 0)::int as nx, (c.value ->> 1)::int as ny, c.ordinality::int as i
        from jsonb_array_elements(r.cells) with ordinality c),
    picked as materialized (
      select * from private.fc_hours(p_tmfc,p_start,p_start+interval '23 hours',false)),
    source_cells as materialized (
      select rr.tmfc,(c.value->>0)::int nx,(c.value->>1)::int ny,c.ordinality::int i
        from public.forecast_runs rr cross join lateral jsonb_array_elements(rr.cells) with ordinality c
       where exists(select 1 from picked q where q.tmfc=rr.tmfc)),
    sh as (
      select cell.nx,cell.ny,h.tmef,
             case when q.quantity and q.s[sc.i] is not null then greatest(q.s[sc.i],0) end::double precision s,
             case when q.quantity and q.p[sc.i] is not null then greatest(q.p[sc.i],0) end::double precision p,
             case when q.t[sc.i]>-90 then q.t[sc.i] end::double precision t,
             case when q.o[sc.i]>=0 then least(q.o[sc.i],100) end::int o,
             case when q.y[sc.i]>=0 then q.y[sc.i] end::int y
        from cell cross join generate_series(p_start,p_start+interval '23 hours',interval '1 hour') h(tmef)
        left join picked q on q.tmef=h.tmef
        left join source_cells sc on sc.tmfc=q.tmfc and sc.nx=cell.nx and sc.ny=cell.ny),
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
create or replace function public.forecast_plan() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare t timestamptz := private.fc_latest_tmfc(); r public.forecast_runs;
begin
  -- A failing far-range download must not retain expired archives indefinitely.
  delete from public.forecast_runs where tmfc<>t and coalesce(end_at,private.fc_end(tmfc))<now();
  insert into public.forecast_runs(tmfc,start_at,cells,end_at)
  select t, date_trunc('hour',now()) + interval '1 hour',
         coalesce(jsonb_agg(jsonb_build_array(c.nx,c.ny) order by c.ny,c.nx),'[]'::jsonb),private.fc_end(t)
    from (select distinct e.nx,e.ny from private.grid_effective() e) c
  on conflict (tmfc) do nothing;
  select * into r from public.forecast_runs where tmfc=t;
  if r.done_at is not null then return jsonb_build_object('done',true,'tmfc',t); end if;
  return jsonb_build_object('done',false,'extended',true,'tmfc',r.tmfc,'start_at',r.start_at,
    'end_at',coalesce(r.end_at,private.fc_end(t)),'quantity_end',private.fc_quantity_end(t),'cells',r.cells,
    'missing',(select coalesce(jsonb_agg(jsonb_build_array(v,h) order by
        case when h < r.start_at+interval '27 hours' and v in ('TMP','SNO','PCP') then 0
             when h < r.start_at+interval '27 hours' then 1 else 2 end,
        h,case v when 'TMP' then 0 when 'SNO' then 1 when 'PCP' then 2 when 'POP' then 3 else 4 end),'[]'::jsonb)
      from generate_series(r.start_at,coalesce(r.end_at,private.fc_end(t)),interval '1 hour') h,
           unnest(array['TMP','SNO','PCP','POP','PTY']) v
      where not exists(select 1 from public.forecast_hours x where x.tmfc=r.tmfc and x.tmef=h and x.var=v)));
end $$;

-- The first 27-hour core/aux phases remain separate from the far-hour completion flag.
create or replace function private.fc_progress(p_tmfc timestamptz) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r public.forecast_runs; n int; np int; total int; expected int; w timestamptz; applied boolean := false;
begin
  select * into r from public.forecast_runs where tmfc=p_tmfc for update;
  if not found then raise exception 'unknown run' using errcode='23503'; end if;
  select count(*) filter(where var in ('TMP','SNO','PCP')),
         count(*) filter(where var in ('POP','PTY')) into n,np
    from public.forecast_hours where tmfc=p_tmfc and tmef>=r.start_at and tmef<r.start_at+interval '27 hours';
  w := least(greatest(date_trunc('hour',now())+interval '1 hour',r.start_at),r.start_at+interval '3 hours');
  if n>=81 and (r.core_at is null or (np>=54 and r.aux_at is null)) then
    applied := private.fc_apply(p_tmfc,w);
    if applied then
      update public.forecast_runs set core_at=coalesce(core_at,now()),
        aux_at=case when np>=54 then coalesce(aux_at,now()) else aux_at end where tmfc=p_tmfc;
      insert into public.collector_state as cs(job,cursor,started_at,finished_at,ok,note)
      values('forecast',to_char(p_tmfc at time zone 'Asia/Seoul','YYYYMMDDHH24'),r.created_at,now(),true,'먼 시각 수집 중')
      on conflict(job) do update set cursor=excluded.cursor,started_at=excluded.started_at,finished_at=now(),ok=true,note=excluded.note;
    end if;
  end if;
  expected := (extract(epoch from (coalesce(r.end_at,private.fc_end(p_tmfc))-r.start_at))/3600)::int+1;
  select count(*) into total from public.forecast_hours
    where tmfc=p_tmfc and tmef>=r.start_at and tmef<=coalesce(r.end_at,private.fc_end(p_tmfc));
  if total=expected*5 and exists(select 1 from public.forecast_runs where tmfc=p_tmfc and core_at is not null) then
    update public.forecast_runs set done_at=coalesce(done_at,now()) where tmfc=p_tmfc;
    update public.collector_state set finished_at=now(),ok=true,note=null where job='forecast';
    -- Only expired issue archives are removed, never a still-usable previous issue.
    delete from public.forecast_runs where tmfc<>p_tmfc and coalesce(end_at,private.fc_end(tmfc)) < now();
    return jsonb_build_object('ok',true,'done',true,'hours',total,'window',w);
  end if;
  return jsonb_build_object('ok',true,'done',false,'core',n>=81,'hours',total,'window',w);
end $$;

create or replace function public.forecast_put(p_tmfc timestamptz,p_var text,p_tmef timestamptz,p_vals real[]) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r public.forecast_runs;
begin
  select * into r from public.forecast_runs where tmfc=p_tmfc for update;
  if not found then raise exception 'unknown run' using errcode='23503'; end if;
  if r.done_at is not null then return jsonb_build_object('ok',true,'done',true); end if;
  if p_var is null or p_var not in ('SNO','PCP','TMP','POP','PTY')
     or p_tmef is null or p_tmef<>date_trunc('hour',p_tmef)
     or p_tmef<r.start_at or p_tmef>coalesce(r.end_at,private.fc_end(p_tmfc)) then
    raise exception 'bad var/time' using errcode='22023';
  end if;
  if array_ndims(p_vals) is distinct from 1 or array_lower(p_vals,1) is distinct from 1
     or array_length(p_vals,1) is distinct from jsonb_array_length(r.cells)
     or exists(select 1 from unnest(p_vals) x where x is null or x in ('NaN'::real,'Infinity'::real,'-Infinity'::real)) then
    raise exception 'bad vals' using errcode='22023';
  end if;
  insert into public.forecast_hours(tmfc,var,tmef,vals,is_empty) values(p_tmfc,p_var,p_tmef,p_vals,false)
  on conflict(tmfc,var,tmef) do update set vals=excluded.vals,is_empty=false;
  return private.fc_progress(p_tmfc);
end $$;

-- Called only after the worker verifies that ALL 37,697 national TMP cells are zero.
-- Record all five as skipped so the next plan does not download an invalid hour repeatedly.
create or replace function public.forecast_skip(p_tmfc timestamptz,p_tmef timestamptz) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r public.forecast_runs;
begin
  select * into r from public.forecast_runs where tmfc=p_tmfc for update;
  if not found then raise exception 'unknown run' using errcode='23503'; end if;
  if p_tmef is null or p_tmef<>date_trunc('hour',p_tmef) or p_tmef<r.start_at
     or p_tmef>coalesce(r.end_at,private.fc_end(p_tmfc)) then raise exception 'bad time' using errcode='22023'; end if;
  if r.done_at is not null then return jsonb_build_object('ok',true,'done',true); end if;
  insert into public.forecast_hours(tmfc,var,tmef,vals,is_empty)
  select p_tmfc,v,p_tmef,array_fill(0::real,array[jsonb_array_length(r.cells)]),true
    from unnest(array['SNO','PCP','TMP','POP','PTY']) v
  on conflict(tmfc,var,tmef) do update set vals=excluded.vals,is_empty=true;
  return private.fc_progress(p_tmfc);
end $$;

revoke all on function private.fc_end(timestamptz),private.fc_quantity_end(timestamptz),
  private.fc_hours(timestamptz,timestamptz,timestamptz,boolean),private.fc_progress(timestamptz) from public,anon,authenticated;
revoke all on function public.forecast_skip(timestamptz,timestamptz) from public,anon,authenticated;
grant execute on function public.forecast_skip(timestamptz,timestamptz) to service_role;

-- Small daily counters for operational forecast requests only; no keys/URLs/raw grids.
create table if not exists private.forecast_api_usage(
  usage_day date not null,
  vsrt boolean not null,
  calls bigint not null default 0,
  body_bytes bigint not null default 0,
  retries bigint not null default 0,
  primary key(usage_day,vsrt)
);
alter table private.forecast_api_usage enable row level security;
revoke all on table private.forecast_api_usage from public,anon,authenticated,service_role;
create or replace function public.forecast_usage(p_day date,p_vsrt boolean,p_calls int,p_bytes bigint,p_retries int) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_day is null or p_day<(now() at time zone 'Asia/Seoul')::date-1 or p_day>(now() at time zone 'Asia/Seoul')::date
     or p_vsrt is null or p_calls is null or p_calls<1 or p_calls>1000
     or p_bytes is null or p_bytes<0 or p_bytes>1000000000
     or p_retries is null or p_retries<0 or p_retries>p_calls then raise exception 'bad usage' using errcode='22023'; end if;
  insert into private.forecast_api_usage as u(usage_day,vsrt,calls,body_bytes,retries)
  values(p_day,p_vsrt,p_calls,p_bytes,p_retries)
  on conflict(usage_day,vsrt) do update set calls=u.calls+excluded.calls,body_bytes=u.body_bytes+excluded.body_bytes,retries=u.retries+excluded.retries;
  delete from private.forecast_api_usage where usage_day<(now() at time zone 'Asia/Seoul')::date-14;
end $$;
revoke all on function public.forecast_usage(date,boolean,int,bigint,int) from public,anon,authenticated;
grant execute on function public.forecast_usage(date,boolean,int,bigint,int) to service_role;

-- Completed 27-hour legacy runs still need the newly requested far hours.
update public.forecast_runs set end_at=private.fc_end(tmfc),aux_at=case when done_at is not null then done_at end,done_at=null;
do $refresh$ begin
  if private.fc_refresh() is distinct from true then raise exception 'current forecast refresh failed; rollback all'; end if;
end $refresh$;
commit;
