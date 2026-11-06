-- 73: 정성 예보의 코드 강도를 추가 반환. 기존 정량 합계·수집·권한·저장 자료 불변.
begin;
do $$ begin
 if md5(replace(pg_get_functiondef('public.forecast_cell_tail(integer,integer)'::regprocedure),E'\r\n',E'\n')) <> '6e46abc5af0fab8bf6ec316a1ea8f9d1' then
  raise exception 'forecast_cell_tail changed since review';
 end if;
end $$;
CREATE OR REPLACE FUNCTION public.forecast_cell_tail(p_nx integer, p_ny integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
        case when not q.quantity and q.s[ix.i] in (0,1,2) then q.s[ix.i]::int end sc,
        case when not q.quantity and q.p[ix.i] in (0,1,2,3) then q.p[ix.i]::int end pc,
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
        max(sc) sc,max(pc) pc,count(sc)::int scn,count(pc)::int pcn,
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
        'snow_code',case when hours>quantity_hours and scn=hours-quantity_hours then sc end,
        'pcp_code',case when hours>quantity_hours and pcn=hours-quantity_hours then pc end,
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
end $function$;
commit;
