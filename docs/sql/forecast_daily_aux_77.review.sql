-- 검토용77. 운영 미적용: 일별예보의 SKY/TMN/TMX 보강 원자료 캐시.
-- 기존 1시간/3시간 수집 계획·완료 판정·예보값은 변경하지 않는다.
-- 이 SQL만으로 수집 예약이나 기상청 호출이 추가되지는 않는다.
-- 기본 계획은 공식 최저/최고기온만. SKY 수집은 서버가 명시적으로 선택해야 한다.
-- 48시간 지난 새 보강 캐시만 정리하며 기존 업무/예보 표를 삭제하지 않는다.
begin;

create table private.forecast_daily_aux_hours (
  tmfc timestamptz not null references public.forecast_runs(tmfc) on delete cascade,
  var text not null check(var in('SKY','TMN','TMX')),
  tmef timestamptz not null check(tmef=date_trunc('hour',tmef)),
  vals real[],
  is_empty boolean not null default false,
  empty_attempts integer not null default 0 check(empty_attempts between 0 and 3),
  updated_at timestamptz not null default now(),
  primary key(tmfc,var,tmef),
  check((is_empty and vals is null)or(not is_empty and vals is not null))
);
alter table private.forecast_daily_aux_hours enable row level security;
revoke all on private.forecast_daily_aux_hours from public,anon,authenticated,service_role;

create function private.fc_daily_aux_targets(p_tmfc timestamptz,p_sky boolean default false)
returns table(var text,tmef timestamptz)
language sql stable set search_path='' as $$
  with run as(select * from public.forecast_runs where tmfc=p_tmfc),
  days as(select d from run r cross join lateral generate_series(
    date_trunc('day',r.tmfc at time zone 'Asia/Seoul'),
    date_trunc('day',coalesce(r.end_at,private.fc_end(r.tmfc)) at time zone 'Asia/Seoul'),
    interval '1 day') d)
  select v.var,(d.d+v.h*interval '1 hour') at time zone 'Asia/Seoul'
    from days d cross join(values('TMN',6),('TMX',15))v(var,h) cross join run r
   where (d.d+v.h*interval '1 hour') at time zone 'Asia/Seoul'>r.tmfc
     and (d.d+v.h*interval '1 hour') at time zone 'Asia/Seoul'<=coalesce(r.end_at,private.fc_end(r.tmfc))
  union all
  select 'SKY',h.tmef from public.forecast_hours h join run r on r.tmfc=h.tmfc
   where p_sky and h.var='TMP' and not h.is_empty
     and h.tmef>=r.start_at and h.tmef<=coalesce(r.end_at,private.fc_end(r.tmfc))
$$;

create function public.forecast_daily_aux_plan(p_sky boolean default false)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.forecast_runs; pending jsonb;
begin
  if p_sky is null then raise exception 'bad mode' using errcode='22023'; end if;
  delete from private.forecast_daily_aux_hours where tmfc<now()-interval '48 hours';
  select * into r from public.forecast_runs order by tmfc desc limit 1;
  if not found or r.tmfc<now()-interval '48 hours' then
    return jsonb_build_object('done',false,'waiting',true,'missing','[]'::jsonb);
  end if;
  select coalesce(jsonb_agg(jsonb_build_array(t.var,t.tmef) order by
    case when t.var in('TMN','TMX')then 0 else 1 end,t.tmef,t.var),'[]'::jsonb)
    into pending from private.fc_daily_aux_targets(r.tmfc,p_sky) t
   where not exists(select 1 from private.forecast_daily_aux_hours h
      where h.tmfc=r.tmfc and h.var=t.var and h.tmef=t.tmef
        and(not h.is_empty or h.empty_attempts>=3 or h.updated_at>now()-interval '30 minutes'));
  return jsonb_build_object('tmfc',r.tmfc,'cells',r.cells,'sky',p_sky,'missing',pending,
    'done',jsonb_array_length(pending)=0 and r.done_at is not null,
    'waiting',jsonb_array_length(pending)=0 and r.done_at is null);
end $$;

-- p_empty=true is only for a worker-verified national numeric missing grid.
-- HTTP/API errors or timeouts must not be recorded as a successful empty grid.
create function public.forecast_daily_aux_put(p_tmfc timestamptz,p_var text,p_tmef timestamptz,
  p_vals real[],p_empty boolean default false)
returns boolean language plpgsql security definer set search_path='' as $$
declare r public.forecast_runs;
begin
  select * into r from public.forecast_runs where tmfc=p_tmfc for key share;
  if not found or r.tmfc<now()-interval '48 hours' or p_empty is null
    or p_var is null or p_tmef is null
    or not exists(select 1 from private.fc_daily_aux_targets(p_tmfc,true) t
       where t.var=p_var and t.tmef=p_tmef) then
    raise exception 'bad daily target' using errcode='22023';
  end if;
  if p_empty then
    if p_vals is not null then raise exception 'empty grid has values' using errcode='22023'; end if;
  elsif array_ndims(p_vals) is distinct from 1 or array_lower(p_vals,1) is distinct from 1
    or array_length(p_vals,1) is distinct from jsonb_array_length(r.cells)
    or exists(select 1 from unnest(p_vals) x where x is not null and
      (x in('NaN'::real,'Infinity'::real,'-Infinity'::real)
       or(p_var='SKY'and x not in(1,3,4))or(p_var in('TMN','TMX')and(x<=-90 or x>70)))) then
    raise exception 'bad daily values' using errcode='22023';
  end if;
  -- Do not replace a received valid array with a later empty response.
  insert into private.forecast_daily_aux_hours as old(tmfc,var,tmef,vals,is_empty,empty_attempts)
  values(p_tmfc,p_var,p_tmef,p_vals,p_empty,case when p_empty then 1 else 0 end)
  on conflict(tmfc,var,tmef) do update set vals=excluded.vals,is_empty=excluded.is_empty,
    empty_attempts=case when excluded.is_empty then least(3,old.empty_attempts+1)else 0 end,
    updated_at=now()
  where old.is_empty or not excluded.is_empty;
  return true;
end $$;

create function public.forecast_daily_aux_cell(p_nx integer,p_ny integer)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb; today date:=(now() at time zone 'Asia/Seoul')::date;
begin
  if (select private.my_role()) is null then
    raise exception 'login required' using errcode='42501';
  end if;
  if p_nx is null or p_ny is null or p_nx not between 1 and 149 or p_ny not between 1 and 253
    or not exists(select 1 from private.grid_effective()g where g.nx=p_nx and g.ny=p_ny) then
    raise exception 'bad cell' using errcode='22023';
  end if;
  with ix as materialized(
    select r.tmfc,min(j.ordinality)::int i from public.forecast_runs r
    cross join lateral jsonb_array_elements(r.cells)with ordinality j
    where r.tmfc>=now()-interval '48 hours' and j.value=jsonb_build_array(p_nx,p_ny)
    group by r.tmfc),
  chosen as materialized(
    select distinct on(h.var,h.tmef)h.var,h.tmef,h.tmfc,h.vals[ix.i] v
      from private.forecast_daily_aux_hours h join ix on ix.tmfc=h.tmfc
     where not h.is_empty and h.vals[ix.i] is not null
       and(h.tmef at time zone 'Asia/Seoul')::date between today and today+4
     order by h.var,h.tmef,h.tmfc desc),
  temps as(
    select(tmef at time zone 'Asia/Seoul')::date forecast_date,
      max(v)filter(where var='TMN') tmin,max(v)filter(where var='TMX') tmax,
      max(tmfc)filter(where var='TMN') tmin_issue,max(tmfc)filter(where var='TMX') tmax_issue
      from chosen where var in('TMN','TMX')group by forecast_date)
  select jsonb_build_object('nx',p_nx,'ny',p_ny,
    'temperatures',coalesce((select jsonb_agg(jsonb_build_object('date',forecast_date,'tmin',tmin,'tmax',tmax,
      'tmin_issued_at',tmin_issue,'tmax_issued_at',tmax_issue)order by forecast_date)from temps),'[]'::jsonb),
    'sky',coalesce((select jsonb_agg(jsonb_build_object('forecast_at',tmef,'sky',v,'issued_at',tmfc)order by tmef)
      from chosen where var='SKY'and tmef>=date_trunc('hour',now())+interval '1 hour'),'[]'::jsonb)) into result;
  return result||jsonb_build_object('status',case when jsonb_array_length(result->'temperatures')>0
    or jsonb_array_length(result->'sky')>0 then 'ok'else 'no_data'end);
end $$;

revoke all on function private.fc_daily_aux_targets(timestamptz,boolean),
  public.forecast_daily_aux_plan(boolean),
  public.forecast_daily_aux_put(timestamptz,text,timestamptz,real[],boolean),
  public.forecast_daily_aux_cell(integer,integer)from public,anon,authenticated,service_role;
grant execute on function public.forecast_daily_aux_plan(boolean),
  public.forecast_daily_aux_put(timestamptz,text,timestamptz,real[],boolean)to service_role;
grant execute on function public.forecast_daily_aux_cell(integer,integer)to authenticated;
commit;
