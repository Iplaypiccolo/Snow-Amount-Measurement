-- ============================================================
-- 장비 지원 고침(사용자 결정 2026-10-04)
--  1) 차량번호 대신 "도공번호"(예: 서울경기-901). 열 이름은 plate 그대로 두고 값 형식만 바꿈.
--     이미 넣은 예전 차량번호 형식(12가3456)도 당분간 통과(그 장비의 지원 여부를 고칠 수 있게). 화면은 새 형식만 받음.
--  2) 지원장비 계정(equip.edit.own): 자기 기관 장비 "추가"·도공번호·지원 여부만.
--     날짜별 경로·장비 삭제·지원일 1은 equip.edit.all(관리자)만. 지사 계정은 이 탭에서 아무것도 못 고침(원래대로).
-- ============================================================
alter table public.vehicles drop constraint if exists vehicles_plate_check;
alter table public.vehicles add constraint vehicles_plate_check
  check (plate ~ '^[가-힣]{1,10}-[0-9]{1,5}$' or plate ~ '^[0-9]{2,3}[가-힣][0-9]{4}$');
comment on column public.vehicles.plate is '도공번호(예: 서울경기-901). 열 이름은 예전 차량번호(plate) 그대로';

-- 장비 추가: 모든 기관(equip.edit.all) 또는 자기 기관(equip.edit.own)
drop policy if exists vehicles_ins on public.vehicles;
create policy vehicles_ins on public.vehicles for insert to authenticated
  with check ((select private.has_perm('equip.edit.all')) or ((select private.has_perm('equip.edit.own')) and org = (select private.my_org())));

-- 날짜별 경로: equip.edit.all 만
drop policy if exists vehicle_routes_ins on public.vehicle_routes;
drop policy if exists vehicle_routes_upd on public.vehicle_routes;
drop policy if exists vehicle_routes_del on public.vehicle_routes;
create policy vehicle_routes_ins on public.vehicle_routes for insert to authenticated with check ((select private.has_perm('equip.edit.all')));
create policy vehicle_routes_upd on public.vehicle_routes for update to authenticated using ((select private.has_perm('equip.edit.all'))) with check ((select private.has_perm('equip.edit.all')));
create policy vehicle_routes_del on public.vehicle_routes for delete to authenticated using ((select private.has_perm('equip.edit.all')));

-- 저장 함수: 경로는 equip.edit.all 만(지우기도 미리 확인)
create or replace function public.save_fleet(p_vehicles jsonb default '[]'::jsonb, p_routes jsonb default '[]'::jsonb)
returns jsonb language plpgsql security invoker set search_path = ''
as $$
declare r jsonb; c int; nv int := 0; nu int := 0; nd int := 0; vid text;
begin
  if jsonb_typeof(p_vehicles) is distinct from 'array' or jsonb_typeof(p_routes) is distinct from 'array' then raise exception 'bad input' using errcode = '22023'; end if;
  if jsonb_array_length(p_vehicles) + jsonb_array_length(p_routes) = 0 then raise exception 'nothing to save' using errcode = '22023'; end if;
  if jsonb_array_length(p_vehicles) > 500 or jsonb_array_length(p_routes) > 5000 then raise exception 'too many rows' using errcode = '54000'; end if;
  if jsonb_array_length(p_routes) > 0 and not (select private.has_perm('equip.edit.all')) then raise exception 'routes need equip.edit.all' using errcode = '42501'; end if;
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

update public.permissions set label = '자기 기관 장비 추가·도공번호·지원 여부',
  description = '장비 지원 > 기관별 장비에서 자기 출발 기관 장비를 추가하고 도공번호·지원 여부를 고침(경로는 관리자)' where key = 'equip.edit.own';
update public.permissions set label = '모든 장비·날짜별 경로',
  description = '모든 출발 기관 장비와 날짜별 경로를 고치고 확정, 장비 삭제, 지원일 1 날짜, 초기화' where key = 'equip.edit.all';
