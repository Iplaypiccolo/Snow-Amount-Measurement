-- 검토용80: 사용자 승인 전 운영 적용 금지. 기존24시간/3시간 계산·수집·예약은 유지한다.
-- 기상청 추가 호출 없이 저장된25~48번째 시간의 원값을 선택한1격자에만 반환한다.
begin;
set local statement_timeout='45s';
set local lock_timeout='10s';
do $$begin
  if md5(replace(pg_get_functiondef('public.forecast_cell_tail(integer,integer)'::regprocedure),E'\r\n',E'\n'))<>'4b1a680806949b44a69bb26319afa940' then
    raise exception 'forecast_cell_tail changed since review'; end if;
end$$;

create function public.forecast_cell_detail(p_nx integer,p_ny integer)returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result jsonb; v_from timestamptz; v_to timestamptz; v_cap timestamptz; hourly jsonb;
begin
  -- 기존 조회 함수의 로그인/활성 계정/현재 유효 격자/예보 신선도 검사를 통과해야 한다.
  result:=public.forecast_cell_tail(p_nx,p_ny);
  if result->>'status'<>'ok' then return result||jsonb_build_object('hourly_tail',null);end if;
  v_from:=(result->'upper'->>'start_at')::timestamptz+interval '24 hours';
  v_to:=v_from+interval '23 hours';
  select r.tmfc into v_cap from public.forecast_runs r order by r.tmfc desc limit 1;
  v_cap:=coalesce(v_cap,(result->'upper'->>'tmfc')::timestamptz);
  with picked as materialized(
    select * from private.fc_hours(v_cap,v_from,v_to,true,p_nx,p_ny)),
  ix as materialized(
    select r.tmfc,min(j.ordinality)::int i from public.forecast_runs r
    join(select distinct tmfc from picked)k on k.tmfc=r.tmfc
    cross join lateral jsonb_array_elements(r.cells)with ordinality j
    where j.value=jsonb_build_array(p_nx,p_ny)group by r.tmfc),
  points as materialized(
    select q.tmef,
      case when q.quantity and q.s[ix.i] is not null then greatest(q.s[ix.i],0)end s,
      case when q.quantity and q.p[ix.i] is not null then greatest(q.p[ix.i],0)end p,
      case when q.t[ix.i]>-90 then q.t[ix.i]end t,
      case when q.o[ix.i]>=0 then least(q.o[ix.i],100)end o,
      case when q.quantity and q.s[ix.i] is not null then q.s[ix.i]=0 and q.y[ix.i] in(2,3,6,7)end sq,
      case when q.quantity and q.p[ix.i] is not null then q.p[ix.i]=0 and q.y[ix.i]>0 end pq
    from picked q join ix on ix.tmfc=q.tmfc),
  slots as(select t from generate_series(v_from,v_to,interval '1 hour')t)
  select jsonb_build_object('start_at',v_from,'end_at',v_to+interval '1 hour',
    'series',jsonb_build_object('s',jsonb_agg(p.s order by x.t),'p',jsonb_agg(p.p order by x.t),
      't',jsonb_agg(p.t order by x.t),'r',jsonb_agg(p.o order by x.t),
      'sq',jsonb_agg(p.sq order by x.t),'pq',jsonb_agg(p.pq order by x.t),'vn',0))
    into hourly from slots x left join points p on p.tmef=x.t;
  return result||jsonb_build_object('hourly_tail',hourly);
end$$;
revoke all on function public.forecast_cell_detail(integer,integer)from public,anon,authenticated,service_role;
grant execute on function public.forecast_cell_detail(integer,integer)to authenticated;
commit;
