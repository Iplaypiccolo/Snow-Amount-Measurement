-- ============================================================
-- 장비 지원 고침(사용자 결정 2026-10-04, 네 번째)
--  1) 도착 예상 시각은 직접 입력(시·분) → 10분 단위 제한을 풀고 HH:MM(00:00~23:59)
--  2) 지원장비 계정(equip.edit.own)도 자기 기관 장비의 "이미 정해진 경로"의 도착 예상 시각은 고칠 수 있음
--     (경로의 지사·날짜·최초/수정본은 그대로 관리자만 — 트리거가 시각 말고 다른 값이 바뀌면 거절)
-- ============================================================
create or replace function private.check_route() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if exists (select 1 from unnest(new.stops) s where not exists (select 1 from public.branches b where b.id = s)) then
    raise exception 'unknown branch in stops' using errcode = '23503';
  end if;
  if cardinality(new.stops) <> (select count(distinct s) from unnest(new.stops) s) then
    raise exception 'duplicate stop' using errcode = '23514';
  end if;
  if new.times is not null then
    if cardinality(new.times) <> cardinality(new.stops) then raise exception 'times must match stops' using errcode = '23514'; end if;
    if exists (select 1 from unnest(new.times) t where t is not null and t !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$') then
      raise exception 'time must be HH:MM' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;

-- 수정: 관리자(모든 장비) 또는 지원장비(자기 기관 장비)
drop policy if exists vehicle_routes_upd on public.vehicle_routes;
create policy vehicle_routes_upd on public.vehicle_routes for update to authenticated
  using ((select private.has_perm('equip.edit.all')) or ((select private.has_perm('equip.edit.own')) and exists (select 1 from public.vehicles v where v.id = vehicle_id and v.org = (select private.my_org()))))
  with check ((select private.has_perm('equip.edit.all')) or ((select private.has_perm('equip.edit.own')) and exists (select 1 from public.vehicles v where v.id = vehicle_id and v.org = (select private.my_org()))));

-- 지원장비 계정은 도착 예상 시각만 바꿀 수 있음
create or replace function private.vehicle_routes_guard() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if not private.has_perm('equip.edit.all') and (new.date, new.vehicle_id, new.stops, new.revised) is distinct from (old.date, old.vehicle_id, old.stops, old.revised) then
    raise exception 'only times can be changed' using errcode = '42501';
  end if;
  return new;
end $$;
revoke all on function private.vehicle_routes_guard() from public, anon;
drop trigger if exists vehicle_routes_guard on public.vehicle_routes;
drop trigger if exists aa_vehicle_routes_guard on public.vehicle_routes;
-- 이름 순서대로 실행되므로 'aa_' 로 값 검사(check_route)보다 먼저 권한을 봄
create trigger aa_vehicle_routes_guard before update on public.vehicle_routes for each row execute function private.vehicle_routes_guard();

create or replace function public.save_fleet(p_vehicles jsonb default '[]'::jsonb, p_routes jsonb default '[]'::jsonb)
returns jsonb language plpgsql security invoker set search_path = ''
as $$
declare r jsonb; c int; nv int := 0; nu int := 0; nd int := 0; vid text; tms text[]; stp text[]; v_all boolean := (select private.has_perm('equip.edit.all'));
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
    if jsonb_typeof(r) is distinct from 'object' or not (r ? 'date') or not (r ? 'vehicle_id') or jsonb_typeof(coalesce(r -> 'stops', '[]'::jsonb)) is distinct from 'array'
       or (r ? 'times' and jsonb_typeof(r -> 'times') not in ('array', 'null')) then
      raise exception 'bad route' using errcode = '22023';
    end if;
    vid := r ->> 'vehicle_id';
    stp := array(select jsonb_array_elements_text(r -> 'stops'));
    tms := case when jsonb_typeof(r -> 'times') = 'array' then array(select jsonb_array_elements_text(r -> 'times')) end;   -- JSON null 은 SQL null 로
    if not v_all then
      -- 지원장비: 같은 지사 목록의 기존 경로에서 시각만
      if not (select private.has_perm('equip.edit.own')) or cardinality(stp) = 0
         or not exists (select 1 from public.vehicles v where v.id = vid and v.org = (select private.my_org()))
         or not exists (select 1 from public.vehicle_routes x where x.date = (r ->> 'date')::date and x.vehicle_id = vid and x.stops = stp) then
        raise exception 'route not allowed: %', vid using errcode = '42501';
      end if;
      update public.vehicle_routes x set times = tms where x.date = (r ->> 'date')::date and x.vehicle_id = vid and x.times is distinct from tms;
      get diagnostics c = row_count; nu := nu + c;
      continue;
    end if;
    if cardinality(stp) = 0 then
      delete from public.vehicle_routes x where x.date = (r ->> 'date')::date and x.vehicle_id = vid;
      get diagnostics c = row_count; nd := nd + c;
    else
      insert into public.vehicle_routes as x (date, vehicle_id, stops, revised, times)
      values ((r ->> 'date')::date, vid, stp, coalesce((r ->> 'revised')::boolean, false), tms)
      on conflict (date, vehicle_id) do update set stops = excluded.stops, revised = excluded.revised, times = excluded.times
        where (x.stops, x.revised, x.times) is distinct from (excluded.stops, excluded.revised, excluded.times);
      get diagnostics c = row_count; nu := nu + c;
    end if;
  end loop;
  return jsonb_build_object('vehicles', nv, 'routes_saved', nu, 'routes_deleted', nd);
end $$;

update public.permissions set label = '자기 기관 장비 추가·도공번호·지원 여부·도착 시각',
  description = '장비 지원 > 기관별 장비에서 자기 출발 기관 장비를 추가하고 도공번호·지원 여부, 정해진 경로의 도착 예상 시각을 고침(경로 지사는 관리자)' where key = 'equip.edit.own';
