-- 검토용 74: 중기예보 최신 원자료 캐시. 아직 운영 서버에 적용하지 않았습니다.
-- 구역/날씨/기온 각 1행(최대 3행)만 보관합니다. 과거 자료를 계속 누적하지 않습니다.
-- 기존 예보/업무 자료·RLS·수집 일정·계산 함수는 변경하지 않습니다.
-- 새 표는 비공개이며 서버 수집 함수만 아래 RPC를 실행할 수 있습니다.
begin;

create table private.forecast_midterm_cache (
  kind text primary key check (kind in ('regions','land','temperature')),
  issued_at timestamptz not null,
  payload jsonb not null check (jsonb_typeof(payload)='array'),
  updated_at timestamptz not null default now()
);
alter table private.forecast_midterm_cache enable row level security;
revoke all on private.forecast_midterm_cache from public,anon,authenticated,service_role;

-- 호출 전 수집기는 API 정상 응답·끝 표식·전체 행 수를 검사하고 아래 형식으로 정규화합니다.
-- regions: reg_id,name,type(A/C/H/I/0),valid_from,valid_to
-- 실제 최신 목록에는 도움말에 없는 I(규슈)·0(통합구역)도 있어 그대로 보존합니다.
-- land: reg_id,forecast_at(ISO 한국시각 포함),period_hours(12/24),sky(WB01~04),precip(WB00/09/11/12/13),pop,weather
-- temperature: reg_id,date(YYYY-MM-DD),tmin,tmax
-- 기온/확률 결측은 null. regions의 issued_at은 목록 조회시각, 나머지는 기상청 발표시각입니다.
create function public.forecast_midterm_put(p_kind text,p_issued_at timestamptz,p_payload jsonb)
returns boolean language plpgsql security definer set search_path='' as $$
declare v jsonb; keys text[]; row_key text; seen text[]:=array[]::text[]; changed integer;
begin
  if p_kind is null or p_kind not in ('regions','land','temperature')
     or p_issued_at is null or p_issued_at>now()+interval '5 minutes'
     or p_issued_at<now()-interval '36 hours' then
    raise exception 'bad midterm batch' using errcode='22023';
  end if;
  if p_kind<>'regions' and (
    p_issued_at<>date_trunc('hour',p_issued_at)
    or extract(hour from p_issued_at at time zone 'Asia/Seoul') not in (6,18)) then
    raise exception 'bad midterm issue' using errcode='22023';
  end if;
  if jsonb_typeof(p_payload) is distinct from 'array' then
    raise exception 'bad midterm payload' using errcode='22023';
  end if;
  if jsonb_array_length(p_payload) not between 1 and 5000 or pg_column_size(p_payload)>2097152 then
    raise exception 'bad midterm size' using errcode='22023';
  end if;
  keys:=case p_kind
    when 'regions' then array['reg_id','name','type','valid_from','valid_to']
    when 'land' then array['reg_id','forecast_at','period_hours','sky','precip','pop','weather']
    else array['reg_id','date','tmin','tmax'] end;
  for v in select value from jsonb_array_elements(p_payload) loop
    if jsonb_typeof(v) is distinct from 'object' or (v->>'reg_id') is null
       or (v->>'reg_id')!~'^[0-9A-Z]{8}$' then
      raise exception 'bad midterm row' using errcode='22023';
    end if;
    if exists(select 1 from jsonb_object_keys(v) k where k<>all(keys)) or not v ?& keys then
      raise exception 'bad midterm fields' using errcode='22023';
    end if;
    if p_kind='regions' then
      if jsonb_typeof(v->'name') is distinct from 'string' or length(v->>'name') not between 1 and 120
         or coalesce(v->>'type','') not in ('A','C','H','I','0')
         or (v->>'valid_from') is null or (v->>'valid_to') is null
         or (v->>'valid_from')::timestamptz >= (v->>'valid_to')::timestamptz then
        raise exception 'bad midterm region' using errcode='22023';
      end if;
      row_key:=v->>'reg_id';
    elsif p_kind='land' then
      if (v->>'forecast_at') is null or (v->>'period_hours') is null
         or (v->>'period_hours')::integer not in (12,24)
         or (v->>'forecast_at')::timestamptz < p_issued_at
         or (v->>'forecast_at')::timestamptz > p_issued_at+interval '15 days'
         or (v->>'sky') not in ('WB01','WB02','WB03','WB04')
         or (v->>'precip') not in ('WB00','WB09','WB11','WB12','WB13')
         or (v->>'pop')::numeric not between 0 and 100
         or jsonb_typeof(v->'weather') is distinct from 'string' or length(v->>'weather')>120 then
        raise exception 'bad midterm land' using errcode='22023';
      end if;
      row_key:=(v->>'reg_id')||'|'||((v->>'forecast_at')::timestamptz)::text;
    else
      if coalesce(v->>'date','')!~'^\d{4}-\d{2}-\d{2}$'
         or (v->>'date')::date < (p_issued_at at time zone 'Asia/Seoul')::date
         or (v->>'date')::date > (p_issued_at at time zone 'Asia/Seoul')::date+15
         or (v->>'tmin')::numeric not between -70 and 60
         or (v->>'tmax')::numeric not between -70 and 60
         or (v->>'tmin')::numeric>(v->>'tmax')::numeric then
        raise exception 'bad midterm temperature' using errcode='22023';
      end if;
      row_key:=(v->>'reg_id')||'|'||(v->>'date');
    end if;
    if row_key=any(seen) then raise exception 'duplicate midterm row' using errcode='22023'; end if;
    seen:=array_append(seen,row_key);
  end loop;
  insert into private.forecast_midterm_cache(kind,issued_at,payload)
  values(p_kind,p_issued_at,p_payload)
  on conflict(kind) do update set issued_at=excluded.issued_at,payload=excluded.payload,updated_at=now()
  where excluded.issued_at>=forecast_midterm_cache.issued_at;
  get diagnostics changed=row_count;
  return changed=1;
end $$;
revoke all on function public.forecast_midterm_put(text,timestamptz,jsonb) from public,anon,authenticated;
grant execute on function public.forecast_midterm_put(text,timestamptz,jsonb) to service_role;

commit;
