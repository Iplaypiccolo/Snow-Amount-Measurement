-- ============================================================
-- 장비 지원 고침(사용자 결정 2026-10-04, 세 번째)
--  1) 도공번호 = 출발 기관 이름 + 숫자(예: 서울경기901). 화면은 기관 이름을 자동으로 붙이고 숫자만 입력.
--     기관 이름이 앞에 붙어야 함(다른 기관 이름이면 거절). 예전 차량번호 형식(12가3456)은 이미 넣은 장비를 위해 당분간 통과.
--  2) 날짜별 경로에 "최초 지원 / 수정본" 구분(revised)과 지사마다 "도착 예상 시각"(times, HH:MM, stops 와 같은 순서·개수, 빈 값 허용)
-- ============================================================
alter table public.vehicles drop constraint if exists vehicles_plate_check;
alter table public.vehicles add constraint vehicles_plate_check
  check (plate ~ ('^' || org || '[0-9]{1,5}$') or plate ~ '^[0-9]{2,3}[가-힣][0-9]{4}$');
comment on column public.vehicles.plate is '도공번호 = 출발 기관 이름 + 숫자(예: 서울경기901). 열 이름은 예전 차량번호(plate) 그대로';

alter table public.vehicle_routes add column if not exists revised boolean not null default false;
alter table public.vehicle_routes add column if not exists times text[];
comment on column public.vehicle_routes.revised is 'false = 최초 지원(확정된 지사 중에서), true = 수정본(모든 지사 중에서)';
comment on column public.vehicle_routes.times is '지사마다 도착 예상 시각 HH:MM(10분 단위), stops 와 같은 순서·개수, 모르면 null';

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
    if exists (select 1 from unnest(new.times) t where t is not null and t !~ '^([01][0-9]|2[0-3]):[0-5]0$') then
      raise exception 'time must be HH:M0' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;

create or replace function public.save_fleet(p_vehicles jsonb default '[]'::jsonb, p_routes jsonb default '[]'::jsonb)
returns jsonb language plpgsql security invoker set search_path = ''
as $$
declare r jsonb; c int; nv int := 0; nu int := 0; nd int := 0; vid text; tms text[];
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
    if jsonb_typeof(r) is distinct from 'object' or not (r ? 'date') or not (r ? 'vehicle_id') or jsonb_typeof(coalesce(r -> 'stops', '[]'::jsonb)) is distinct from 'array'
       or (r ? 'times' and jsonb_typeof(r -> 'times') not in ('array', 'null')) then
      raise exception 'bad route' using errcode = '22023';
    end if;
    vid := r ->> 'vehicle_id';
    if jsonb_array_length(coalesce(r -> 'stops', '[]'::jsonb)) = 0 then
      delete from public.vehicle_routes x where x.date = (r ->> 'date')::date and x.vehicle_id = vid;
      get diagnostics c = row_count; nd := nd + c;
    else
      tms := case when jsonb_typeof(r -> 'times') = 'array' then array(select jsonb_array_elements_text(r -> 'times')) end;   -- JSON null 은 SQL null 로
      insert into public.vehicle_routes as x (date, vehicle_id, stops, revised, times)
      values ((r ->> 'date')::date, vid, array(select jsonb_array_elements_text(r -> 'stops')), coalesce((r ->> 'revised')::boolean, false), tms)
      on conflict (date, vehicle_id) do update set stops = excluded.stops, revised = excluded.revised, times = excluded.times
        where (x.stops, x.revised, x.times) is distinct from (excluded.stops, excluded.revised, excluded.times);
      get diagnostics c = row_count; nu := nu + c;
    end if;
  end loop;
  return jsonb_build_object('vehicles', nv, 'routes_saved', nu, 'routes_deleted', nd);
end $$;
