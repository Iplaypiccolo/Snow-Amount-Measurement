-- 검토용75: 중기 수집 전용 예약. 사용자 승인 전 운영 적용 금지.
-- 74의 최신 캐시에서 아직 없는 종류만 수집한다. 기존 예보 예약/함수/권한은 수정하지 않는다.
-- 새 함수의 서울 외부연결 실패/도쿄 정상 응답을 실제 확인해 수집 함수만 도쿄로 지정한다. DB는서울유지.
begin;
do $$ begin
  if exists(select 1 from cron.job where jobname='collect-midterm') then
    raise exception 'collect-midterm schedule already exists';
  end if;
end $$;

-- 기온은아침/낮의서로다른시간대값이다.74에서두값의순서만으로거부한조건을제거한다.
-- 기존 함수 본문이 검토본 그대로일 때만 고치며, 허용 범위/권한/입력 계약은 유지한다.
do $temperature_fix$
declare definition text; old_clause text:='or (v->>''tmin'')::numeric>(v->>''tmax'')::numeric';
begin
  if (select md5(replace(prosrc,E'\r\n',E'\n')) from pg_proc
      where oid='public.forecast_midterm_put(text,timestamptz,jsonb)'::regprocedure)<>'3a5d0141ae983903ac0677c4d89c4bd9' then
    raise exception 'midterm ingest changed since review';
  end if;
  definition:=pg_get_functiondef('public.forecast_midterm_put(text,timestamptz,jsonb)'::regprocedure);
  if strpos(definition,old_clause)=0 then raise exception 'temperature clause not found'; end if;
  execute replace(definition,old_clause,'');
end $temperature_fix$;

create function private.kick_midterm() returns bigint
language plpgsql security definer set search_path='' as $$
declare wall timestamp; target timestamptz; kinds jsonb; request_id bigint;
begin
  if not pg_try_advisory_xact_lock(hashtextextended('snow-midterm-kick',0)) then return null; end if;
  wall:=(now() at time zone 'Asia/Seoul')-interval '15 minutes';
  target:=(date_trunc('day',wall)+case
    when extract(hour from wall)>=18 then interval '18 hours'
    when extract(hour from wall)>=6 then interval '6 hours'
    else interval '-6 hours' end) at time zone 'Asia/Seoul';
  select jsonb_agg(k.kind order by k.kind) into kinds
  from (values('land'),('temperature')) k(kind)
  where not exists(select 1 from private.forecast_midterm_cache c where c.kind=k.kind and c.issued_at>=target);
  if kinds is null then return null; end if;
  if coalesce((select started_at from public.collector_state where job='midterm_kick'),'epoch')>now()-interval '3 minutes' then
    return null;
  end if;
  if not exists(select 1 from private.collector_token where id=1 and length(token)>0) then
    raise exception 'collector token unavailable';
  end if;
  insert into public.collector_state(job,started_at) values('midterm_kick',now())
  on conflict(job) do update set started_at=excluded.started_at;
  request_id:=net.http_post(
    url:='https://yzwbnohzhnctdvufntig.supabase.co/functions/v1/collect-midterm',
    headers:=jsonb_build_object('Content-Type','application/json','x-region','ap-northeast-1','x-collector-token',(select token from private.collector_token where id=1)),
    body:=jsonb_build_object('issue',to_char(target at time zone 'Asia/Seoul','YYYYMMDDHH24'),'kinds',kinds),
    timeout_milliseconds:=150000);
  return request_id;
end $$;
revoke all on function private.kick_midterm() from public,anon,authenticated,service_role;

-- 06/18시 발표의15분 후부터 시도. 자료가 완료되면 DB 안에서 종료하며 Edge/API를 호출하지 않는다.
-- 미제공/통신 장애/중단 때만20분마다 재시도하고, 다음 시간에도 이어서 복구한다.
select cron.schedule('collect-midterm','15,35,55 * * * *','select private.kick_midterm()');
select private.kick_midterm();
commit;
