-- 기준일자별 운전원/정비원 코드(합계 최대 두 명). 실제 성명/전화번호는 저장하지 않음.
-- 기존 지원 여부/경로/이력과 RLS 권한은 유지. 이전 기준일자와 다른 인원 배정 허용.
begin;
do $$ begin
if (select md5(replace(pg_get_functiondef('public.save_fleet(jsonb,jsonb,bigint,jsonb)'::regprocedure),E'\r\n',E'\n'))) <> '87bc51518afc31d931ba13d15b389d13' then raise exception 'save_fleet changed since review'; end if;
if (select md5(replace(pg_get_functiondef('public.create_round(date,integer)'::regprocedure),E'\r\n',E'\n'))) <> '24cf098775d07f7452c5a34e614deb5a' then raise exception 'create_round changed since review'; end if;
end $$;
alter table public.round_vehicle_status add column crew text[] not null default '{}';
alter table public.round_vehicle_status add constraint rvs_crew_valid check (
 cardinality(crew) between 0 and 2
 and crew <@ array['a','b','c','d','e','f','g','h','i','j','k','l','m','n','o','p','q','r','s','t','u','v','w','x','y','z','가','나','다','라','마','바','사','아','자','차','카','타','파','하']::text[]
 and array_position(crew,null) is null
 and coalesce(array_ndims(crew),1)=1 and coalesce(array_lower(crew,1),1)=1
 and (cardinality(crew)<2 or crew[1]<>crew[2])
);
comment on column public.round_vehicle_status.crew is '기준일자별 인원 코드 0~2개: 운전원 a~z, 정비원 가~하. 신규 기준일자는 이전 배정을 복사하고 이후 독립적으로 변경 가능.';
CREATE OR REPLACE FUNCTION public.save_fleet(p_vehicles jsonb DEFAULT '[]'::jsonb, p_routes jsonb DEFAULT '[]'::jsonb, p_round bigint DEFAULT NULL::bigint, p_status jsonb DEFAULT '[]'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare r jsonb; c int; nv int := 0; nu int := 0; nd int := 0; ns int := 0; vid text; tms text[]; stp text[]; st text; d date;
        v_all boolean := (select private.has_perm('equip.route'));              -- 지원일 칸 전부(관리자). 2026-11-02 equip.edit.all 에서 바꿈
begin
  set constraints all deferred;                        -- 배정 대수 검사는 이 함수 끝에서 한 번에(서로 바꾸는 저장을 위해)
  if jsonb_typeof(p_vehicles) is distinct from 'array' or jsonb_typeof(p_routes) is distinct from 'array' or jsonb_typeof(p_status) is distinct from 'array' then raise exception 'bad input' using errcode = '22023'; end if;
  if jsonb_array_length(p_vehicles) + jsonb_array_length(p_routes) + jsonb_array_length(p_status) = 0 then raise exception 'nothing to save' using errcode = '22023'; end if;
  if jsonb_array_length(p_vehicles) > 500 or jsonb_array_length(p_routes) > 5000 or jsonb_array_length(p_status) > 2000 then raise exception 'too many rows' using errcode = '54000'; end if;
  if jsonb_array_length(p_routes) + jsonb_array_length(p_status) > 0 then
    if p_round is null then raise exception 'round required' using errcode = '22023'; end if;
    if not exists (select 1 from public.support_rounds where id = p_round) then raise exception 'unknown round' using errcode = '23503'; end if;
  end if;
  for r in select * from jsonb_array_elements(p_vehicles) loop
    if jsonb_typeof(r) is distinct from 'object' or not (r ? 'id') then raise exception 'bad vehicle' using errcode = '22023'; end if;
    if r ? 'status' then raise exception 'status moved to p_status' using errcode = '22023'; end if;
    update public.vehicles v set plate = case when r ? 'plate' then r ->> 'plate' else v.plate end,
                                 rented = case when r ? 'rented' then coalesce((r ->> 'rented')::boolean, false) else v.rented end,
                                 blower_s = case when r ? 'blower_s' then coalesce((r ->> 'blower_s')::boolean, false) else v.blower_s end,
                                 blower_l = case when r ? 'blower_l' then coalesce((r ->> 'blower_l')::boolean, false) else v.blower_l end
     where v.id = r ->> 'id';
    get diagnostics c = row_count;
    if c = 0 then raise exception 'vehicle not allowed: %', r ->> 'id' using errcode = '42501'; end if;
    nv := nv + 1;
  end loop;
  for r in select * from jsonb_array_elements(p_status) loop
    if jsonb_typeof(r) is distinct from 'object' or not (r ? 'vehicle_id') then raise exception 'bad status' using errcode = '22023'; end if;
    vid := r ->> 'vehicle_id'; st := coalesce(r ->> 'status', '');
    if st not in ('', 'O', 'X', 'M') then raise exception 'bad status value' using errcode = '22023'; end if;
    if r ? 'crew' and jsonb_typeof(r -> 'crew') is distinct from 'array' then
      raise exception 'crew must be an array' using errcode='23514';
    end if;
    insert into public.round_vehicle_status as s (round_id, vehicle_id, status, off_from, crew)
    values (p_round, vid, st, nullif(r ->> 'off_from', '')::date,
            case when r ? 'crew' then array(select jsonb_array_elements_text(r -> 'crew')) else '{}'::text[] end)
    on conflict (round_id, vehicle_id) do update set status = excluded.status, off_from = excluded.off_from,
      crew = case when r ? 'crew' then excluded.crew else s.crew end
      where (s.status, s.off_from) is distinct from (excluded.status, excluded.off_from)
         or (r ? 'crew' and s.crew is distinct from excluded.crew);       -- 권한이 없으면 규칙(RLS)이 거절
    get diagnostics c = row_count; ns := ns + c;
  end loop;
  for r in select * from jsonb_array_elements(p_routes) loop
    if jsonb_typeof(r) is distinct from 'object' or not (r ? 'date') or not (r ? 'vehicle_id') or jsonb_typeof(coalesce(r -> 'stops', '[]'::jsonb)) is distinct from 'array'
       or (r ? 'times' and jsonb_typeof(r -> 'times') not in ('array', 'null')) then
      raise exception 'bad route' using errcode = '22023';
    end if;
    vid := r ->> 'vehicle_id'; d := (r ->> 'date')::date;
    if private.governing_round(d) is distinct from p_round then raise exception 'date is owned by another round' using errcode = '23514'; end if;
    stp := array(select jsonb_array_elements_text(r -> 'stops'));
    tms := case when jsonb_typeof(r -> 'times') = 'array' then array(select jsonb_array_elements_text(r -> 'times')) end;   -- JSON null 은 SQL null 로
    if not v_all then
      -- 지사 계정 = 자기 지사 지역본부 장비 / 기계화부(지원장비) = 자기 기관 장비('모든 기관' 권한이 있어도).
      -- 같은 지사 목록이면 시각만, 아니면 첫날 한 곳 지정·지우기(트리거 vehicle_routes_guard 가 배정·자기 지사 등을 검사)
      if exists (select 1 from public.vehicles v where v.id = vid and v.org = '지역본부') then
        if not (select private.has_perm('req.edit.own')) or not exists (select 1 from public.vehicles v where v.id = vid and v.home_branch = (select private.my_branch())) then
          raise exception 'route not allowed: %', vid using errcode = '42501';
        end if;
      elsif not ((select private.has_perm('equip.edit.own')) or (select private.has_perm('equip.edit.all'))) or not exists (select 1 from public.vehicles v where v.id = vid and v.org = (select private.my_org())) then
        raise exception 'route not allowed: %', vid using errcode = '42501';
      end if;
      if cardinality(stp) = 0 then
        delete from public.vehicle_routes x where x.date = d and x.vehicle_id = vid;
        get diagnostics c = row_count; nd := nd + c;
      elsif exists (select 1 from public.vehicle_routes x where x.date = d and x.vehicle_id = vid and x.stops = stp) then
        update public.vehicle_routes x set times = tms where x.date = d and x.vehicle_id = vid and x.times is distinct from tms;
        get diagnostics c = row_count; nu := nu + c;
      else
        insert into public.vehicle_routes as x (date, vehicle_id, stops, revised, times) values (d, vid, stp, false, tms)
        on conflict (date, vehicle_id) do update set stops = excluded.stops, times = excluded.times;
        get diagnostics c = row_count; nu := nu + c;
      end if;
      continue;
    end if;
    if cardinality(stp) = 0 then
      delete from public.vehicle_routes x where x.date = d and x.vehicle_id = vid;
      get diagnostics c = row_count; nd := nd + c;
    else
      insert into public.vehicle_routes as x (date, vehicle_id, stops, revised, times)
      values (d, vid, stp, coalesce((r ->> 'revised')::boolean, false), tms)
      on conflict (date, vehicle_id) do update set stops = excluded.stops, revised = excluded.revised, times = excluded.times
        where (x.stops, x.revised, x.times) is distinct from (excluded.stops, excluded.revised, excluded.times);
      get diagnostics c = row_count; nu := nu + c;
    end if;
  end loop;
  set constraints all immediate;                       -- 배정 대수 넘김 검사를 여기서 한 번에(이 함수 안에서 오류로 돌려주려고)
  return jsonb_build_object('vehicles', nv, 'status', ns, 'routes_saved', nu, 'routes_deleted', nd);
end $function$;
CREATE OR REPLACE FUNCTION public.create_round(p_date date, p_days integer DEFAULT 10)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare rid bigint; prev bigint; n int;
begin
  if not (select private.has_perm('req.confirm')) then raise exception 'create_round needs req.confirm' using errcode = '42501'; end if;
  if p_date is null or p_days is null or p_days not between 1 and 10 then raise exception 'bad input' using errcode = '22023'; end if;
  if exists (select 1 from public.support_rounds where start_date >= p_date) then raise exception 'round must start after the latest one' using errcode = '23514'; end if;
  select id into prev from public.support_rounds order by start_date desc limit 1;
  insert into public.support_rounds (name, start_date, days) values (p_date::text || ' 기준', p_date, p_days) returning id into rid;
  perform set_config('private.carry', '1', true);          -- 자동으로 만드는 줄은 수정 기록에서 뺌
  insert into public.round_vehicle_status (round_id, vehicle_id, status, off_from, crew)
  select rid, v.id, case when k.keep then 'O' else '' end, case when k.keep and s.off_from > p_date then s.off_from end, coalesce(s.crew, '{}'::text[])
    from public.vehicles v
    left join public.round_vehicle_status s on s.round_id = prev and s.vehicle_id = v.id
    cross join lateral (select coalesce(s.status = 'O' and exists (
             select 1 from public.vehicle_routes r where r.vehicle_id = v.id and r.date >= p_date and cardinality(r.stops) > 0
                and (s.off_from is null or r.date < s.off_from)), false) as keep) k      -- 63: 새 기간에 경로가 잡힌 '지원' 장비만 유지, 나머지 빈칸
   where v.active and v.round_id is null and (v.hidden_after is null or p_date <= v.hidden_after);
  get diagnostics n = row_count;
  perform set_config('private.carry', '', true);
  return jsonb_build_object('id', rid, 'name', p_date::text || ' 기준', 'start_date', p_date, 'days', p_days, 'carried', n);
end $function$;
commit;
