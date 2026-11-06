-- 검토용78. 사용자 확인 전 운영 적용 금지.
-- 일별 최저/최고 보강만 자동수집. 기존 예보/중기 예약은 변경하지 않는다.
-- 매시00/20/40분 확인하며 완료된 자료는 Edge/KMA를 호출하지 않는다.
-- sky:false 고정. DB는서울, 수집 함수 실행만도쿄로지정한다.
begin;
do $$ begin
  if exists(select 1 from cron.job where jobname='collect-daily-aux')then
    raise exception 'collect-daily-aux schedule already exists';
  end if;
end $$;

create function private.kick_daily_aux() returns bigint
language plpgsql security definer set search_path='' as $$
declare plan jsonb; request_id bigint;
begin
  if not pg_try_advisory_xact_lock(hashtextextended('snow-daily-aux-kick',0))then return null;end if;
  plan:=public.forecast_daily_aux_plan(false);
  if jsonb_typeof(plan->'missing')is distinct from 'array'then
    raise exception 'daily aux plan unavailable';
  end if;
  if jsonb_array_length(plan->'missing')=0 then return null;end if;
  if coalesce((select started_at from public.collector_state where job='daily_aux_kick'),'epoch')>now()-interval '3 minutes'then
    return null;
  end if;
  if not exists(select 1 from private.collector_token where id=1 and length(token)>0)then
    raise exception 'collector token unavailable';
  end if;
  insert into public.collector_state(job,started_at)values('daily_aux_kick',now())
  on conflict(job)do update set started_at=excluded.started_at;
  request_id:=net.http_post(
    url:='https://yzwbnohzhnctdvufntig.supabase.co/functions/v1/collect-daily-aux',
    headers:=jsonb_build_object('Content-Type','application/json','x-region','ap-northeast-1',
      'x-collector-token',(select token from private.collector_token where id=1)),
    body:=jsonb_build_object('sky',false),timeout_milliseconds:=150000);
  return request_id;
end $$;
revoke all on function private.kick_daily_aux()from public,anon,authenticated,service_role;
select cron.schedule('collect-daily-aux','0,20,40 * * * *','select private.kick_daily_aux()');
select private.kick_daily_aux();
commit;
