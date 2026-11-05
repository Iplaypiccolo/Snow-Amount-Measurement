-- 69. 격자 하나의 이후3시간 예보 조회 검토본. 운영 미적용. 사용자 SQL 확인 후 적용.
-- 저장 자료만 읽음. 기상청/수집 예약/기존24시간 캐시를 변경하지 않음.
begin;
set local lock_timeout='10s';
set local statement_timeout='45s';
do $guard$ begin
  if not pg_try_advisory_xact_lock(hashtext('ss_fc_apply')) then raise exception 'forecast busy; no changes made'; end if;
  if (select md5(replace(prosrc,E'\r\n',E'\n')) from pg_proc where oid='private.fc_hours(timestamptz,timestamptz,timestamptz,boolean)'::regprocedure)<>'8e06f5526f5809f39cbea00d2e681538' then raise exception 'fc_hours changed since review'; end if;
  if (select md5(replace(prosrc,E'\r\n',E'\n')) from pg_proc where oid='private.fc_quantity_end(timestamptz)'::regprocedure)<>'db1fdf813b28995c45d964299cfee731' then raise exception 'fc_quantity_end changed since review'; end if;
  if (select md5(replace(prosrc,E'\r\n',E'\n')) from pg_proc where oid='private.grid_effective()'::regprocedure)<>'f22ed69246381504eea6e0d415891a96' then raise exception 'grid_effective changed since review'; end if;
  if (select md5(replace(prosrc,E'\r\n',E'\n')) from pg_proc where oid='private.my_role()'::regprocedure)<>'6f7793a5da3732d988cea895bb650fa9' then raise exception 'my_role changed since review'; end if;
  if (select md5(replace(prosrc,E'\r\n',E'\n')) from pg_proc where oid='public.forecast_grid(text[],boolean)'::regprocedure)<>'1e5b110425e55529162bbc96299851ef' then raise exception 'forecast_grid changed since review'; end if;
  if (select md5(replace(prosrc,E'\r\n',E'\n')) from pg_proc where oid='private.fc_end(timestamptz)'::regprocedure)<>'0f2de695f421d3d54de28064a4b8c8f3' then raise exception 'fc_end changed since review'; end if;
  if to_regprocedure('public.forecast_cell_tail(integer,integer)') is not null
     or to_regprocedure('private.fc_hours(timestamptz,timestamptz,timestamptz,boolean,integer,integer)') is not null then
    raise exception '69 function already exists; inspect current definition';
  end if;
end $guard$;
-- Shared issue selection: NULL coordinates preserve the existing all-grid contract.
create function private.fc_hours(p_tmfc timestamptz,p_from timestamptz,p_to timestamptz,p_aux boolean,p_nx int,p_ny int)
returns table(tmfc timestamptz,tmef timestamptz,cells jsonb,s real[],p real[],t real[],o real[],y real[],quantity boolean)
language sql stable set search_path='' as $$
  with eligible as materialized(
    select r.tmfc,r.cells from public.forecast_runs r
     where r.tmfc<=p_tmfc and (p_nx is null or exists(
       select 1 from jsonb_array_elements(r.cells) c where c.value=jsonb_build_array(p_nx,p_ny)))
  ), chosen as materialized(
  select distinct on(t.tmef) r.tmfc,t.tmef
    from eligible r
    join public.forecast_hours t on t.tmfc=r.tmfc and t.var='TMP' and not t.is_empty
    join public.forecast_hours s on s.tmfc=r.tmfc and s.tmef=t.tmef and s.var='SNO' and not s.is_empty
    join public.forecast_hours p on p.tmfc=r.tmfc and p.tmef=t.tmef and p.var='PCP' and not p.is_empty
    left join public.forecast_hours o on o.tmfc=r.tmfc and o.tmef=t.tmef and o.var='POP' and not o.is_empty
    left join public.forecast_hours y on y.tmfc=r.tmfc and y.tmef=t.tmef and y.var='PTY' and not y.is_empty
   where t.tmef>=p_from and t.tmef<=p_to
     and (not p_aux or(o.tmfc is not null and y.tmfc is not null))
   order by t.tmef,r.tmfc desc)
  select h.tmfc,h.tmef,r.cells,s.vals,p.vals,t.vals,o.vals,y.vals,
         h.tmef<=private.fc_quantity_end(h.tmfc)
    from chosen h join eligible r on r.tmfc=h.tmfc
    join public.forecast_hours s on s.tmfc=h.tmfc and s.tmef=h.tmef and s.var='SNO'
    join public.forecast_hours p on p.tmfc=h.tmfc and p.tmef=h.tmef and p.var='PCP'
    join public.forecast_hours t on t.tmfc=h.tmfc and t.tmef=h.tmef and t.var='TMP'
    left join public.forecast_hours o on o.tmfc=h.tmfc and o.tmef=h.tmef and o.var='POP'
    left join public.forecast_hours y on y.tmfc=h.tmfc and y.tmef=h.tmef and y.var='PTY'
   order by h.tmef
$$;

create or replace function private.fc_hours(p_tmfc timestamptz,p_from timestamptz,p_to timestamptz,p_aux boolean default false)
returns table(tmfc timestamptz,tmef timestamptz,cells jsonb,s real[],p real[],t real[],o real[],y real[],quantity boolean)
language sql stable set search_path='' as $$
  select * from private.fc_hours(p_tmfc,p_from,p_to,p_aux,null::int,null::int)
$$;

create function public.forecast_cell_tail(p_nx int,p_ny int) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare
  c public.forecast_cells;
  v_start timestamptz; v_from timestamptz; v_to timestamptz; v_cap timestamptz;
  v_collecting boolean; v_tail jsonb;
begin
  if (select private.my_role()) is null then raise exception 'login required' using errcode='42501'; end if;
  if p_nx is null or p_ny is null or p_nx not between 1 and 149 or p_ny not between 1 and 253 then
    raise exception 'bad cell' using errcode='22023';
  end if;
  if not exists(select 1 from private.grid_effective() g where g.nx=p_nx and g.ny=p_ny) then
    raise exception 'bad cell' using errcode='22023';
  end if;
  select r.tmfc,r.done_at is null into v_cap,v_collecting from public.forecast_runs r order by r.tmfc desc limit 1;
  v_collecting:=coalesce(v_collecting,false);
  select * into c from public.forecast_cells where nx=p_nx and ny=p_ny;
  if not found then return jsonb_build_object('nx',p_nx,'ny',p_ny,'status','no_data','collecting',v_collecting,'upper',null,'tail',jsonb_build_object('bins','[]'::jsonb)); end if;
  if c.issued_at is null or c.issued_at<now()-interval '12 hours' then
    return jsonb_build_object('nx',p_nx,'ny',p_ny,'status','stale','collecting',v_collecting,'upper',null,'tail',jsonb_build_object('bins','[]'::jsonb));
  end if;
  select (b.detail->>'start_at')::timestamptz into v_start
    from public.branch_forecast b where b.issued_at=c.issued_at order by b.updated_at desc limit 1;
  if v_start is null or v_start<>date_trunc('hour',v_start)
    or jsonb_array_length(c.series->'s') is distinct from 24
    or jsonb_array_length(c.series->'p') is distinct from 24
    or jsonb_array_length(c.series->'t') is distinct from 24 then
    return jsonb_build_object('nx',p_nx,'ny',p_ny,'status','no_data','collecting',v_collecting,'upper',null,'tail',jsonb_build_object('bins','[]'::jsonb));
  end if;
  v_from:=v_start+interval '24 hours';
  v_cap:=coalesce(v_cap,c.issued_at);
  select least(max(coalesce(r.end_at,private.fc_end(r.tmfc))),v_start+interval '119 hours') into v_to
    from public.forecast_runs r where r.tmfc<=v_cap;
  v_tail:=jsonb_build_object('window_start_at',v_from,'first_at',null,'last_at',null,'bins','[]'::jsonb);
  if v_to is not null and v_to>=v_from then
    with picked as materialized(
      select * from private.fc_hours(v_cap,v_from,v_to,true,p_nx,p_ny)),
    ix as materialized(
      select r.tmfc,min(j.ordinality)::int i from public.forecast_runs r
      join(select distinct tmfc from picked) k on k.tmfc=r.tmfc
      cross join lateral jsonb_array_elements(r.cells) with ordinality j
      where j.value=jsonb_build_array(p_nx,p_ny) group by r.tmfc),
    points as materialized(
      select q.tmfc,q.tmef,q.quantity,
        case when q.s[ix.i] is not null then greatest(q.s[ix.i],0) end::double precision s,
        case when q.p[ix.i] is not null then greatest(q.p[ix.i],0) end::double precision p,
        case when q.t[ix.i]>-90 then q.t[ix.i] end::double precision t,
        case when q.o[ix.i]>=0 then least(q.o[ix.i],100) end::int o,
        case when q.y[ix.i]>=0 then q.y[ix.i] end::int y
      from picked q join ix on ix.tmfc=q.tmfc),
    framed as(
      select a.*,date_bin(interval '3 hours',a.tmef-interval '1 hour',timestamptz '2000-01-01 00:00+09')+interval '3 hours' slot_end,
        max(a.tmef) over() available_end
      from points a),
    grouped as(
      select slot_end,greatest(slot_end-interval '2 hours',v_from) first_at,least(slot_end,max(available_end)) last_at,
        count(*)::int hours,bool_and(quantity) all_numeric,count(*) filter(where quantity)::int quantity_hours,
        sum(s) s,sum(p) p,min(t) t,max(o) o,
        count(*) filter(where s=0 and y in(2,3,6,7))::int sq,
        count(*) filter(where p=0 and y>0)::int pq,
        jsonb_agg(tmef order by tmef) times
      from framed group by slot_end),
    bins as(
      select first_at,last_at,jsonb_build_object(
        'first_at',first_at,'last_at',last_at,'slot_end_at',slot_end,
        'expected_hours',(extract(epoch from(last_at-first_at))/3600)::int+1,
        'hours',hours,'times',times,
        'partial',hours<3 or last_at-first_at<interval '2 hours',
        'quantity_hours',quantity_hours,'code_hours',hours-quantity_hours,
        'amount_kind',case when all_numeric then 'numeric' when quantity_hours=0 then 'code' else 'mixed' end,
        'snow',case when all_numeric then round(s::numeric,1) end,
        'snow_hi',case when all_numeric then round((s+sq)::numeric,1) end,
        'pcp',case when all_numeric then round(p::numeric,1) end,
        'pcp_hi',case when all_numeric then round((p+pq)::numeric,1) end,
        'tmin',t,'pop',o) val from grouped)
    select jsonb_build_object('window_start_at',v_from,
      'first_at',(select min(tmef) from points),'last_at',(select max(tmef) from points),
      'bins',coalesce(jsonb_agg(val order by first_at),'[]'::jsonb)) into v_tail from bins;
  end if;
  return jsonb_build_object('nx',p_nx,'ny',p_ny,'status','ok','collecting',v_collecting,
    'upper',jsonb_build_object('tmfc',c.issued_at,'start_at',v_start,'end_at',v_from,'series',c.series),
    'tail',v_tail);
end $$;

revoke all on function private.fc_hours(timestamptz,timestamptz,timestamptz,boolean,int,int) from public,anon,authenticated,service_role;
revoke all on function public.forecast_cell_tail(int,int) from public,anon,authenticated;
grant execute on function public.forecast_cell_tail(int,int) to authenticated,service_role;

commit;
