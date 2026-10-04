-- ============================================================
-- 장비 지원 저장 함수 2개 — 화면의 [확정]·[저장]을 "전부 되거나 전부 안 되게" 한 번에 처리
--  * 함수 권한이 아니라 부른 사람 권한으로 실행(security invoker) → 권한 규칙(RLS·트리거)이 그대로 적용됨
--  * save_fleet(p_vehicles, p_routes)
--      p_vehicles = [{id, plate?, status?}]           장비의 차량번호·지원 여부
--      p_routes   = [{date, vehicle_id, stops:[지사번호…]}]  그 날짜 경로를 확정(stops 가 빈 목록이면 그 날짜 경로를 지움)
--      권한이 없는 장비가 하나라도 있으면 전체 취소(42501). 같은 경로를 다시 확정하면 아무것도 바꾸지 않음(기록도 안 남음)
--  * save_requests(p_round, p_rows)
--      p_rows = [{branch_id, 바꾼 열만…}]  열: snow_cm, warning, req_truck, req_blower, assigned_truck, assigned_blower, arrive_at, reason, confirmed
--      보내지 않은 열은 그대로 둠. 편성·확정 열은 req.confirm 권한만(트리거가 막음)
-- ============================================================
create or replace function public.save_fleet(p_vehicles jsonb default '[]'::jsonb, p_routes jsonb default '[]'::jsonb)
returns jsonb language plpgsql security invoker set search_path = ''
as $$
declare r jsonb; c int; nv int := 0; nu int := 0; nd int := 0; vid text;
begin
  if jsonb_typeof(p_vehicles) is distinct from 'array' or jsonb_typeof(p_routes) is distinct from 'array' then raise exception 'bad input' using errcode = '22023'; end if;
  if jsonb_array_length(p_vehicles) + jsonb_array_length(p_routes) = 0 then raise exception 'nothing to save' using errcode = '22023'; end if;
  if jsonb_array_length(p_vehicles) > 500 or jsonb_array_length(p_routes) > 5000 then raise exception 'too many rows' using errcode = '54000'; end if;
  for r in select * from jsonb_array_elements(p_vehicles) loop
    if jsonb_typeof(r) is distinct from 'object' or not (r ? 'id') then raise exception 'bad vehicle' using errcode = '22023'; end if;
    update public.vehicles v set plate = case when r ? 'plate' then r ->> 'plate' else v.plate end,
                                 status = case when r ? 'status' then coalesce(r ->> 'status', '') else v.status end
     where v.id = r ->> 'id';
    get diagnostics c = row_count;
    if c = 0 then raise exception 'vehicle not allowed: %', r ->> 'id' using errcode = '42501'; end if;
    nv := nv + 1;
  end loop;
  for r in select * from jsonb_array_elements(p_routes) loop
    if jsonb_typeof(r) is distinct from 'object' or not (r ? 'date') or not (r ? 'vehicle_id') or jsonb_typeof(coalesce(r -> 'stops', '[]'::jsonb)) is distinct from 'array' then
      raise exception 'bad route' using errcode = '22023';
    end if;
    vid := r ->> 'vehicle_id';
    -- 지우기는 권한이 없어도 0건으로 조용히 끝나므로 먼저 확인
    if not ((select private.has_perm('equip.edit.all')) or ((select private.has_perm('equip.edit.own')) and exists (select 1 from public.vehicles v where v.id = vid and v.org = (select private.my_org())))) then
      raise exception 'route not allowed: %', vid using errcode = '42501';
    end if;
    if jsonb_array_length(coalesce(r -> 'stops', '[]'::jsonb)) = 0 then
      delete from public.vehicle_routes x where x.date = (r ->> 'date')::date and x.vehicle_id = vid;
      get diagnostics c = row_count; nd := nd + c;
    else
      insert into public.vehicle_routes as x (date, vehicle_id, stops)
      values ((r ->> 'date')::date, vid, array(select jsonb_array_elements_text(r -> 'stops')))
      on conflict (date, vehicle_id) do update set stops = excluded.stops where x.stops is distinct from excluded.stops;
      get diagnostics c = row_count; nu := nu + c;
    end if;
  end loop;
  return jsonb_build_object('vehicles', nv, 'routes_saved', nu, 'routes_deleted', nd);
end $$;

create or replace function public.save_requests(p_round bigint, p_rows jsonb)
returns jsonb language plpgsql security invoker set search_path = ''
as $$
declare r jsonb; c int; n int := 0; b text;
begin
  if jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows) = 0 then raise exception 'nothing to save' using errcode = '22023'; end if;
  if jsonb_array_length(p_rows) > 500 then raise exception 'too many rows' using errcode = '54000'; end if;
  if not exists (select 1 from public.support_rounds s where s.id = p_round) then raise exception 'unknown round' using errcode = '23503'; end if;
  for r in select * from jsonb_array_elements(p_rows) loop
    if jsonb_typeof(r) is distinct from 'object' or not (r ? 'branch_id') then raise exception 'bad row' using errcode = '22023'; end if;
    b := r ->> 'branch_id';
    if exists (select 1 from public.round_requests q where q.round_id = p_round and q.branch_id = b) then
      update public.round_requests q set
        snow_cm         = case when r ? 'snow_cm'         then (r ->> 'snow_cm')::double precision      else q.snow_cm end,
        warning         = case when r ? 'warning'         then coalesce((r ->> 'warning')::boolean, false) else q.warning end,
        req_truck       = case when r ? 'req_truck'       then coalesce((r ->> 'req_truck')::int, 0)       else q.req_truck end,
        req_blower      = case when r ? 'req_blower'      then coalesce((r ->> 'req_blower')::int, 0)      else q.req_blower end,
        assigned_truck  = case when r ? 'assigned_truck'  then coalesce((r ->> 'assigned_truck')::int, 0)  else q.assigned_truck end,
        assigned_blower = case when r ? 'assigned_blower' then coalesce((r ->> 'assigned_blower')::int, 0) else q.assigned_blower end,
        arrive_at       = case when r ? 'arrive_at'       then (r ->> 'arrive_at')::timestamptz          else q.arrive_at end,
        reason          = case when r ? 'reason'          then nullif(r ->> 'reason', '')                else q.reason end,
        confirmed       = case when r ? 'confirmed'       then coalesce((r ->> 'confirmed')::boolean, false) else q.confirmed end
      where q.round_id = p_round and q.branch_id = b;
      get diagnostics c = row_count;
      if c = 0 then raise exception 'row not allowed: %', b using errcode = '42501'; end if;
    else
      insert into public.round_requests (round_id, branch_id, snow_cm, warning, req_truck, req_blower, assigned_truck, assigned_blower, arrive_at, reason, confirmed)
      values (p_round, b, (r ->> 'snow_cm')::double precision, coalesce((r ->> 'warning')::boolean, false),
              coalesce((r ->> 'req_truck')::int, 0), coalesce((r ->> 'req_blower')::int, 0),
              coalesce((r ->> 'assigned_truck')::int, 0), coalesce((r ->> 'assigned_blower')::int, 0),
              (r ->> 'arrive_at')::timestamptz, nullif(r ->> 'reason', ''), coalesce((r ->> 'confirmed')::boolean, false));
    end if;
    n := n + 1;
  end loop;
  return jsonb_build_object('rows', n);
end $$;

revoke all on function public.save_fleet(jsonb, jsonb), public.save_requests(bigint, jsonb) from public, anon;
grant execute on function public.save_fleet(jsonb, jsonb), public.save_requests(bigint, jsonb) to authenticated;
