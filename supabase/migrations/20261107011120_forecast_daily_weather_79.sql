-- 검토용79: 사용자 승인 전 운영 적용 금지.
-- 가까운 날: 공식 지역대표 오전/오후 날씨·확률 + 기존 격자 TMN/TMX.
-- 먼 날: 기존 중기 캐시. 원자료가 없으면 null, 추정/최고확률 집계 없음.
-- 새 최신 캐시 1행만 유지. 기존 예보/업무 자료와 예약은 수정하지 않는다.
-- 05/11/17/23시30분부터 최신 자료 확인: 정상 하루4회(API 발표횟수의 단정 아님).
-- 실패 때만 같은 시간40/50분 재시도. 성공한 확인 구간에는 Edge/API 호출 없음.
begin;

create table private.forecast_daily_weather_cache (
  id integer primary key check(id=1),
  issued_at timestamptz not null,
  checked_slot timestamptz not null,
  payload jsonb not null check(jsonb_typeof(payload)='array'),
  updated_at timestamptz not null default now()
);
alter table private.forecast_daily_weather_cache enable row level security;
revoke all on private.forecast_daily_weather_cache from public,anon,authenticated,service_role;

create function private.fc_daily_weather_slot() returns timestamptz
language sql stable set search_path='' as $$
  select(date_trunc('day',w)+case
    when extract(hour from w)>=23 then interval '23 hours'
    when extract(hour from w)>=17 then interval '17 hours'
    when extract(hour from w)>=11 then interval '11 hours'
    when extract(hour from w)>=5 then interval '5 hours'
    else interval '-1 hour' end) at time zone 'Asia/Seoul'
  from(select(now() at time zone 'Asia/Seoul')-interval '30 minutes' w)s
$$;

create function public.forecast_daily_weather_plan() returns jsonb
language sql stable security definer set search_path='' as $$
  select jsonb_build_object('slot',private.fc_daily_weather_slot(),
    'done',exists(select 1 from private.forecast_daily_weather_cache
      where checked_slot>=private.fc_daily_weather_slot()),
    'region_ids',coalesce((select jsonb_agg(v->>'reg_id' order by v->>'reg_id')
      from private.forecast_midterm_cache c cross join lateral jsonb_array_elements(c.payload)v
      where c.kind='regions' and c.issued_at>=now()-interval '7 days'
        and v->>'type'='C' and(v->>'valid_from')::timestamptz<=now()
        and(v->>'valid_to')::timestamptz>now()),'[]'::jsonb))
$$;

create function public.forecast_daily_weather_put(p_slot timestamptz,p_issued_at timestamptz,p_payload jsonb)
returns boolean language plpgsql security definer set search_path='' as $$
declare ids jsonb; v jsonb; at_time timestamptz; k text; seen text[]:=array[]::text[];
  periods timestamptz[]; n integer; changed integer;
begin
  if p_slot is distinct from private.fc_daily_weather_slot()
    or p_issued_at is null or p_issued_at<>date_trunc('hour',p_issued_at)
    or p_issued_at>now()+interval '5 minutes' or p_issued_at<now()-interval '36 hours'
    or jsonb_typeof(p_payload) is distinct from 'array' then
    raise exception 'bad daily weather batch' using errcode='22023';
  end if;
  if jsonb_array_length(p_payload) not between 1 and 3000 or pg_column_size(p_payload)>2097152 then
    raise exception 'bad daily weather size' using errcode='22023';
  end if;
  ids:=public.forecast_daily_weather_plan()->'region_ids';
  if jsonb_array_length(ids) not between 150 and 300 then
    raise exception 'daily region catalog unavailable' using errcode='22023';
  end if;
  for v in select value from jsonb_array_elements(p_payload) loop
    if jsonb_typeof(v) is distinct from 'object' or not v ?& array['reg_id','forecast_at','period_hours','sky','precip','pop','weather']
      or exists(select 1 from jsonb_object_keys(v)x where x<>all(array['reg_id','forecast_at','period_hours','sky','precip','pop','weather']))
      or jsonb_typeof(v->'reg_id') is distinct from 'string' or not ids ? (v->>'reg_id')
      or v->'period_hours' is distinct from '12'::jsonb
      or jsonb_typeof(v->'forecast_at') is distinct from 'string'
      or(v->>'forecast_at')!~'^\d{4}-\d{2}-\d{2}T\d{2}:00:00(\.000)?(Z|[+-]\d{2}:\d{2})$'
      or jsonb_typeof(v->'weather') is distinct from 'string' or length(v->>'weather') not between 1 and 120
      or(v->'sky'<>'null'::jsonb and coalesce(v->>'sky','') not in('DB01','DB02','DB03','DB04'))
      or(v->'precip'<>'null'::jsonb and coalesce(v->>'precip','') not in('0','1','2','3','4'))
      or(v->'pop'<>'null'::jsonb and(jsonb_typeof(v->'pop') is distinct from 'number'
        or(v->>'pop')::numeric not between 0 and 100 or(v->>'pop')::numeric<>trunc((v->>'pop')::numeric))) then
      raise exception 'bad daily weather row' using errcode='22023';
    end if;
    at_time:=(v->>'forecast_at')::timestamptz;
    if at_time<>date_trunc('hour',at_time)
      or extract(hour from at_time at time zone 'Asia/Seoul') not in(0,12)
      or(at_time at time zone 'Asia/Seoul')::date not between(p_issued_at at time zone 'Asia/Seoul')::date
        and(p_issued_at at time zone 'Asia/Seoul')::date+4 then
      raise exception 'bad daily weather period' using errcode='22023';
    end if;
    k:=(v->>'reg_id')||'|'||at_time::text;
    if k=any(seen) then raise exception 'duplicate daily weather row' using errcode='22023'; end if;
    seen:=array_append(seen,k);
  end loop;
  select array_agg(t order by t) into periods from(
    select distinct(value->>'forecast_at')::timestamptz t from jsonb_array_elements(p_payload))s;
  n:=cardinality(periods);
  if n not between 7 and 10 or jsonb_array_length(p_payload)<>n*jsonb_array_length(ids)
    or(periods[1] at time zone 'Asia/Seoul')::date<>(p_issued_at at time zone 'Asia/Seoul')::date
    or exists(select 1 from generate_subscripts(periods,1)i
      where periods[i]<>periods[1]+(i-1)*interval '12 hours') then
    raise exception 'incomplete daily weather' using errcode='22023';
  end if;
  insert into private.forecast_daily_weather_cache as old(id,issued_at,checked_slot,payload)
    values(1,p_issued_at,p_slot,p_payload)
  on conflict(id)do update set issued_at=excluded.issued_at,checked_slot=greatest(old.checked_slot,excluded.checked_slot),
    payload=excluded.payload,updated_at=now() where excluded.issued_at>=old.issued_at;
  get diagnostics changed=row_count;
  return changed=1;
end $$;

-- 한 격자/오늘 포함7일만 반환. 전국 원자료/예보관 정보는 브라우저에 보내지 않는다.
create function public.forecast_daily_cell(p_nx integer,p_ny integer) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare region jsonb; aux jsonb; days jsonb; today date:=(now() at time zone 'Asia/Seoul')::date;
begin
  -- 기존 함수의 로그인/현재 편입격자 검사를 그대로 통과해야 한다.
  aux:=public.forecast_daily_aux_cell(p_nx,p_ny);
  region:=private.fc_daily_region(p_nx,p_ny);
  if region->>'status'='ok' then
    region:=region||jsonb_build_object(
      'short_land_name',(select v->>'name' from private.forecast_midterm_cache c
        cross join lateral jsonb_array_elements(c.payload)v
        where c.kind='regions' and v->>'reg_id'=region->>'temp_id' limit 1),
      'midterm_land_name',(select v->>'name' from private.forecast_midterm_cache c
        cross join lateral jsonb_array_elements(c.payload)v
        where c.kind='regions' and v->>'reg_id'=region->>'land_id' limit 1));
  end if;
  with near_weather as materialized(
    select v,c.issued_at from private.forecast_daily_weather_cache c
      cross join lateral jsonb_array_elements(c.payload)v
    where c.issued_at>=now()-interval '36 hours' and v->>'reg_id'=region->>'temp_id'),
  far_weather as materialized(
    select v,c.issued_at from private.forecast_midterm_cache c
      cross join lateral jsonb_array_elements(c.payload)v
    where c.kind='land' and c.issued_at>=now()-interval '36 hours' and v->>'reg_id'=region->>'land_id'),
  far_temps as materialized(
    select v,c.issued_at from private.forecast_midterm_cache c
      cross join lateral jsonb_array_elements(c.payload)v
    where c.kind='temperature' and c.issued_at>=now()-interval '36 hours' and v->>'reg_id'=region->>'temp_id'),
  calendar as(select today+i d from generate_series(0,6)i),
  combined as(
    select d,
      (select jsonb_agg(w.r order by w.t)from(
        select distinct on(t) t,r from(
          select(v->>'forecast_at')::timestamptz t,0 priority,
            v||jsonb_build_object('source','short_land','issued_at',issued_at)r from near_weather
          union all select(v->>'forecast_at')::timestamptz,1,
            v||jsonb_build_object('source','midterm_land','issued_at',issued_at)from far_weather
        )all_weather where(t at time zone 'Asia/Seoul')::date=d order by t,priority
      )w) periods,
      (select v from jsonb_array_elements(aux->'temperatures')v where(v->>'date')::date=d) nt,
      (select v||jsonb_build_object('issued_at',issued_at)from far_temps where(v->>'date')::date=d) ft,
      exists(select 1 from near_weather where((v->>'forecast_at')::timestamptz at time zone 'Asia/Seoul')::date=d) near_day
    from calendar)
  select jsonb_agg(jsonb_build_object('date',d,'periods',coalesce(periods,'[]'::jsonb),
    'tmin',case when nt is not null or near_day then nt->'tmin' else ft->'tmin'end,
    'tmax',case when nt is not null or near_day then nt->'tmax' else ft->'tmax'end,
    'tmin_issued_at',case when nt is not null or near_day then nt->'tmin_issued_at' else ft->'issued_at'end,
    'tmax_issued_at',case when nt is not null or near_day then nt->'tmax_issued_at' else ft->'issued_at'end,
    'temperature_source',case when nt is not null or near_day then 'grid_aux'
      when ft is not null then 'midterm_temperature' else null end)order by d) into days from combined;
  return jsonb_build_object('nx',p_nx,'ny',p_ny,'region',region,'days',days,
    'status',case when exists(select 1 from jsonb_array_elements(days)x
      where jsonb_array_length(x->'periods')>0 or x->'tmin'<>'null'::jsonb or x->'tmax'<>'null'::jsonb)
      then 'ok' else 'no_data'end);
end $$;

create function private.kick_daily_weather() returns bigint
language plpgsql security definer set search_path='' as $$
declare request_id bigint;
begin
  if not pg_try_advisory_xact_lock(hashtextextended('snow-daily-weather-kick',0)) then return null; end if;
  if(public.forecast_daily_weather_plan()->>'done')::boolean then return null; end if;
  if coalesce((select started_at from public.collector_state where job='daily_weather_kick'),'epoch')>now()-interval '3 minutes' then return null; end if;
  if not exists(select 1 from private.collector_token where id=1 and length(token)>0)then
    raise exception 'collector token unavailable'; end if;
  insert into public.collector_state(job,started_at)values('daily_weather_kick',now())
    on conflict(job)do update set started_at=excluded.started_at;
  request_id:=net.http_post(url:='https://yzwbnohzhnctdvufntig.supabase.co/functions/v1/collect-daily-weather',
    headers:=jsonb_build_object('Content-Type','application/json','x-region','ap-northeast-1',
      'x-collector-token',(select token from private.collector_token where id=1)),body:='{}'::jsonb,timeout_milliseconds:=120000);
  return request_id;
end $$;

revoke all on function private.fc_daily_weather_slot(),private.kick_daily_weather(),
  public.forecast_daily_weather_plan(),public.forecast_daily_weather_put(timestamptz,timestamptz,jsonb),
  public.forecast_daily_cell(integer,integer)from public,anon,authenticated,service_role;
grant execute on function public.forecast_daily_weather_plan(),
  public.forecast_daily_weather_put(timestamptz,timestamptz,jsonb)to service_role;
grant execute on function public.forecast_daily_cell(integer,integer)to authenticated;

do $$begin
  if coalesce(current_setting('cron.timezone',true),'GMT') not in('GMT','UTC','Etc/UTC')then
    raise exception 'daily weather schedule requires UTC cron timezone'; end if;
  if exists(select 1 from cron.job where jobname='collect-daily-weather')then
    raise exception 'daily weather schedule already exists'; end if;
end $$;
-- pg_cron은 GMT(UTC). 아래 02/08/14/20 UTC = 한국 11/17/23/다음날05시.
select cron.schedule('collect-daily-weather','30,40,50 2,8,14,20 * * *','select private.kick_daily_weather()');
-- 초기 수집은 이 SQL 승인/적용과 수집 함수 배포 후 별도로 실행·검증한다.
commit;
