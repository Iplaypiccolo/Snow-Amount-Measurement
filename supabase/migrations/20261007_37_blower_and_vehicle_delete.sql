-- ============================================================
-- 37. 블로워(소·대) 열 + 장비 삭제는 관리자(모든 장비 권한)만 (2026-10-07 사용자 요청, Claude 채팅)
--  * vehicles.blower_s / blower_l : 제설기에 달린 블로워 소·대(둘 다 꺼질 수 있음). 제설기가 아니면 둘 다 false 여야 함.
--  * save_fleet : 장비 항목에 blower_s·blower_l 도 받음(자기 기관 장비를 고치는 계정도 가능 — 차량번호·지원 여부와 같은 줄)
--  * vehicles_del : 예전(마이그레이션 22)에는 지원장비 계정(equip.edit.own)이 자기 기관 장비를 지울 수 있었으나,
--    이제 equip.edit.all(= 관리자 기본)만. 따로 권한을 만들지 않고 equip.edit.all 에 합침(이미 '장비 삭제'를 포함하던 권한).
--  * 권한 이름·설명만 고침(권한 값 자체는 그대로, 계정별 권한 변경 없음)
-- ============================================================
alter table public.vehicles add column if not exists blower_s boolean not null default false;
alter table public.vehicles add column if not exists blower_l boolean not null default false;
alter table public.vehicles drop constraint if exists vehicles_blower_only_blower_machine;
alter table public.vehicles add constraint vehicles_blower_only_blower_machine check (type = '제설기' or (not blower_s and not blower_l));
comment on column public.vehicles.blower_s is '블로워 소 달림(제설기만)';
comment on column public.vehicles.blower_l is '블로워 대 달림(제설기만)';

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
                                 status = case when r ? 'status' then coalesce(r ->> 'status', '') else v.status end,
                                 blower_s = case when r ? 'blower_s' then coalesce((r ->> 'blower_s')::boolean, false) else v.blower_s end,
                                 blower_l = case when r ? 'blower_l' then coalesce((r ->> 'blower_l')::boolean, false) else v.blower_l end
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
revoke all on function public.save_fleet(jsonb, jsonb) from public, anon;
grant execute on function public.save_fleet(jsonb, jsonb) to authenticated;

-- 장비 삭제: 관리자(equip.edit.all)만
drop policy if exists vehicles_del on public.vehicles;
create policy vehicles_del on public.vehicles for delete to authenticated using ((select private.has_perm('equip.edit.all')));

update public.permissions set label = '자기 기관 장비 추가·도공번호·지원 여부·블로워·도착 시각',
  description = '장비 지원 > 기관별 장비에서 자기 출발 기관 장비를 추가하고 도공번호·지원 여부·블로워(소·대), 정해진 경로의 도착 예상 시각을 고침(삭제·경로 지사는 관리자)' where key = 'equip.edit.own';
update public.permissions set label = '모든 기관 장비·경로 입력·장비 삭제',
  description = '모든 출발 기관 장비를 입력·확정하고, 장비를 추가하고 [삭제]하고(관리자만), 지원일 1을 바꿈' where key = 'equip.edit.all';
