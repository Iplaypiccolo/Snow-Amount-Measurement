-- ============================================================
-- 38. 지원 여부를 기준일자별로 저장 + 장비 숨기기 (2026-10-08 사용자 결정, Claude 채팅)
--
-- 규칙(한 줄 요약): "어떤 날짜의 지원 여부는, 그 날짜를 기간 안에 둔 기준일자 중 시작일이 가장 늦은 것이 정한다."
--  * 기준일자(support_rounds)에 기간 길이 days(기본 4일) 추가. 기준일자 R 의 기간 = 시작일 ~ 시작일 + days - 1
--  * round_vehicle_status : (기준일자, 장비) → 지원 여부(status ''/O/X/M) + 불가 시작일(off_from, status=O 일 때만 의미).
--      "그 날짜부터 지원 불가"는 off_from 으로 저장. 지원 여부 X 는 "기준일자 시작일부터 불가"와 같음.
--      줄이 없으면 미정(''), 줄은 새 기준일자를 만들 때 이전 기준일자에서 서버가 전체 장비를 넘겨 줌(정비중·지원 불가 포함).
--  * 경로(vehicle_routes)는 지금처럼 (날짜, 장비) 한 줄을 모든 기준일자가 공유 — 기준일자마다 복사하지 않음.
--      날짜가 담당 기준일자가 없거나, 그 날짜에 장비가 지원 가능이 아니면 경로를 새로 넣거나 고칠 수 없음(트리거).
--      이미 저장된 경로는 지원 여부가 바뀌어도 지우지 않음(화면이 숨겨 보여 주고, 다시 지원 가능으로 하면 되살아남).
--  * save_fleet : 기준일자 번호(p_round)를 함께 받음 — 그 기준일자가 맡은 날짜의 경로·지원 여부만 고칠 수 있음.
--      지원 여부는 이제 p_status 로 보냄(장비 줄 p_vehicles 에 status 를 넣으면 거절).
--  * create_round(날짜, 기간) : 새 기준일자 만들기 + 전체 장비 지원 여부 이어받기(서버 함수, 한 번에 성공하거나 전부 취소).
--      가장 마지막 기준일자보다 늦은 날짜만 허용. 직접 insert 는 막음(support_rounds_ins 삭제).
--  * 기준일자 삭제는 가장 마지막 것이고 그 기간에 경로가 없을 때만.
--  * vehicles.hidden_after : "이 날짜보다 늦게 시작하는 기준일자부터 안 보임"(숨기기). 지우기와 달리 이전 기준일자의 기록은 그대로.
--      숨기기·숨김 취소는 장비 지우기와 같은 권한(equip.edit.all)만.
--  * 장비 지우기는 경로 기록이 있는 장비는 거절(숨기기를 쓰라는 뜻). 기록이 없는 장비만 지울 수 있음.
--  * 옛 열 vehicles.status 는 당분간 남김(화면이 새 표를 읽는 것을 확인한 뒤 따로 지움).
--  * 정리: 첫 기준일자(2026-10-07)보다 앞선 경로 1줄(2026-10-05 · V001 · B001 · 01:35)을 지움 — 사용자 확인함.
--    지운 줄은 수정 기록(audit_log)에도 남음. 복구 필요 시: insert into vehicle_routes(date,vehicle_id,stops,times) values ('2026-10-05','V001','{B001}','{01:35}')
--  * 자동으로 넘기는 줄은 수정 기록에 남기지 않음(기록 양 절약) — 사람이 고친 것만 기록.
-- ============================================================

-- 1) 기준일자 기간 길이, 장비 숨기기
alter table public.support_rounds add column if not exists days integer not null default 4 check (days between 1 and 10);
alter table public.vehicles add column if not exists hidden_after date;
comment on column public.support_rounds.days is '기준일자의 기간(일). 기간 = 시작일 ~ 시작일 + days - 1';
comment on column public.vehicles.hidden_after is '이 날짜보다 늦게 시작하는 기준일자부터 안 보임(숨기기). null = 숨기지 않음';
comment on column public.vehicles.status is '(쓰지 않음) 지원 여부는 round_vehicle_status 로 옮김. 화면 확인 뒤 삭제 예정';

-- 2) 기준일자 × 장비 지원 여부
create table if not exists public.round_vehicle_status (
  round_id   bigint not null references public.support_rounds(id) on delete cascade,
  vehicle_id text   not null references public.vehicles(id) on delete cascade,
  status     text   not null default '' check (status in ('', 'O', 'X', 'M')),
  off_from   date,
  updated_by uuid, updated_at timestamptz not null default now(),
  primary key (round_id, vehicle_id)
);
create index if not exists round_vehicle_status_vehicle_idx on public.round_vehicle_status(vehicle_id);
comment on table public.round_vehicle_status is '기준일자별 장비 지원 여부. off_from = 그 날짜부터 지원 불가(status=O 일 때만)';

-- 3) 날짜를 맡은 기준일자, 날짜별 장비 지원 가능 여부
create or replace function private.governing_round(p_date date) returns bigint
language sql stable security definer set search_path = ''
as $$ select id from public.support_rounds where start_date <= p_date and p_date < start_date + days order by start_date desc limit 1 $$;

create or replace function private.vehicle_avail(p_vehicle text, p_date date) returns boolean
language sql stable security definer set search_path = ''
as $$ select coalesce((select s.status = 'O' and (s.off_from is null or p_date < s.off_from)
                         from public.round_vehicle_status s where s.round_id = private.governing_round(p_date) and s.vehicle_id = p_vehicle), false) $$;
revoke all on function private.governing_round(date), private.vehicle_avail(text, date) from public, anon;
grant execute on function private.governing_round(date), private.vehicle_avail(text, date) to authenticated;

-- 4) 지원 여부 줄 검사·작성자·수정 기록
create or replace function private.rvs_check() returns trigger
language plpgsql set search_path = ''
as $$
declare st date;
begin
  new.off_from := case when new.status = 'O' then new.off_from else null end;
  if new.off_from is not null then
    select start_date into st from public.support_rounds where id = new.round_id;
    if new.off_from < st then raise exception 'off_from is before the round start' using errcode = '23514'; end if;
  end if;
  return new;
end $$;
revoke all on function private.rvs_check() from public, anon;
drop trigger if exists rvs_check on public.round_vehicle_status;
create trigger rvs_check before insert or update on public.round_vehicle_status for each row execute function private.rvs_check();
drop trigger if exists stamp_rvs on public.round_vehicle_status;
create trigger stamp_rvs before insert or update on public.round_vehicle_status for each row execute function private.stamp('updated_by', 'updated_at');
drop trigger if exists audit_rvs on public.round_vehicle_status;
create trigger audit_rvs after insert or update or delete on public.round_vehicle_status
  for each row when (current_setting('private.carry', true) is distinct from '1') execute function private.audit_row('round_id', 'vehicle_id');

alter table public.round_vehicle_status enable row level security;
drop policy if exists rvs_read on public.round_vehicle_status;
drop policy if exists rvs_ins on public.round_vehicle_status;
drop policy if exists rvs_upd on public.round_vehicle_status;
drop policy if exists rvs_del on public.round_vehicle_status;
create policy rvs_read on public.round_vehicle_status for select to authenticated using ((select private.my_role()) is not null);
create policy rvs_ins on public.round_vehicle_status for insert to authenticated with check (
  (select private.has_perm('equip.edit.all'))
  or ((select private.has_perm('equip.edit.own')) and exists (select 1 from public.vehicles v where v.id = vehicle_id and v.org = (select private.my_org()))));
create policy rvs_upd on public.round_vehicle_status for update to authenticated
  using ((select private.has_perm('equip.edit.all'))
    or ((select private.has_perm('equip.edit.own')) and exists (select 1 from public.vehicles v where v.id = vehicle_id and v.org = (select private.my_org()))))
  with check ((select private.has_perm('equip.edit.all'))
    or ((select private.has_perm('equip.edit.own')) and exists (select 1 from public.vehicles v where v.id = vehicle_id and v.org = (select private.my_org()))));
create policy rvs_del on public.round_vehicle_status for delete to authenticated using ((select private.has_perm('equip.edit.all')));

-- 5) 옛 지원 여부(vehicles.status)를 첫 기준일자로 옮김 (넘기는 줄이라 수정 기록은 생략)
select set_config('private.carry', '1', true);
insert into public.round_vehicle_status (round_id, vehicle_id, status)
select r.id, v.id, v.status from public.support_rounds r cross join public.vehicles v
 where r.start_date = (select min(start_date) from public.support_rounds)
on conflict (round_id, vehicle_id) do nothing;
select set_config('private.carry', '', true);

-- 6) 정리: 첫 기준일자보다 앞선 경로 삭제 (사용자 확인함: 2026-10-05 · V001 한 줄)
delete from public.vehicle_routes
 where date = '2026-10-05' and vehicle_id = 'V001' and date < (select min(start_date) from public.support_rounds);
do $$ begin
  if exists (select 1 from public.vehicle_routes where private.governing_round(date) is null) then
    raise exception '담당 기준일자가 없는 경로가 남아 있어 중단합니다(전부 취소됨)';
  end if;
end $$;

-- 7) 경로: 담당 기준일자가 있고 그날 장비가 지원 가능일 때만 넣거나 고칠 수 있음 (이미 있는 경로는 지우지 않음)
create or replace function private.check_route_avail() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if private.governing_round(new.date) is null then raise exception 'date is not inside any round' using errcode = '23514'; end if;
  if not private.vehicle_avail(new.vehicle_id, new.date) then raise exception 'vehicle is not available on this date' using errcode = '23514'; end if;
  return new;
end $$;
revoke all on function private.check_route_avail() from public, anon;
drop trigger if exists check_route_avail on public.vehicle_routes;
create trigger check_route_avail before insert or update of stops, times, revised on public.vehicle_routes for each row execute function private.check_route_avail();

-- 8) 기준일자: 직접 insert 막고 create_round 로만, 삭제는 마지막 기준일자이고 경로가 없을 때만
drop policy if exists support_rounds_ins on public.support_rounds;

create or replace function private.rounds_del_guard() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if exists (select 1 from public.support_rounds where start_date > old.start_date) then raise exception 'only the latest round can be deleted' using errcode = '23514'; end if;
  if exists (select 1 from public.vehicle_routes where date >= old.start_date and date < old.start_date + old.days) then raise exception 'round has routes' using errcode = '23514'; end if;
  return old;
end $$;
revoke all on function private.rounds_del_guard() from public, anon;
drop trigger if exists rounds_del_guard on public.support_rounds;
create trigger rounds_del_guard before delete on public.support_rounds for each row execute function private.rounds_del_guard();

create or replace function public.create_round(p_date date, p_days integer default 4) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare rid bigint; prev bigint; n int;
begin
  if not (select private.has_perm('req.confirm')) then raise exception 'create_round needs req.confirm' using errcode = '42501'; end if;
  if p_date is null or p_days is null or p_days not between 1 and 10 then raise exception 'bad input' using errcode = '22023'; end if;
  if exists (select 1 from public.support_rounds where start_date >= p_date) then raise exception 'round must start after the latest one' using errcode = '23514'; end if;
  select id into prev from public.support_rounds order by start_date desc limit 1;
  insert into public.support_rounds (name, start_date, days) values (p_date::text || ' 기준', p_date, p_days) returning id into rid;
  perform set_config('private.carry', '1', true);          -- 자동으로 넘기는 줄은 수정 기록에서 뺌
  insert into public.round_vehicle_status (round_id, vehicle_id, status, off_from)
  select rid, v.id,
         case when s.status = 'O' and s.off_from is not null and s.off_from <= p_date then 'X' else coalesce(s.status, '') end,
         case when s.status = 'O' and s.off_from is not null and s.off_from > p_date then s.off_from end
    from public.vehicles v left join public.round_vehicle_status s on s.round_id = prev and s.vehicle_id = v.id
   where v.active and (v.hidden_after is null or p_date <= v.hidden_after);
  get diagnostics n = row_count;
  perform set_config('private.carry', '', true);
  return jsonb_build_object('id', rid, 'name', p_date::text || ' 기준', 'start_date', p_date, 'days', p_days, 'carried', n);
end $$;
revoke all on function public.create_round(date, integer) from public, anon;
grant execute on function public.create_round(date, integer) to authenticated;

-- 9) 장비: 숨기기는 관리자(equip.edit.all)만, 경로 기록이 있는 장비는 지울 수 없음(숨기기를 쓰라는 뜻)
create or replace function private.vehicles_guard() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if not private.has_perm('equip.edit.all') and (new.id, new.org, new.type, new.sort, new.active, new.hidden_after) is distinct from (old.id, old.org, old.type, old.sort, old.active, old.hidden_after) then
    raise exception 'only plate, blower and status can be changed' using errcode = '42501';
  end if;
  return new;
end $$;

create or replace function private.vehicles_del_guard() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if exists (select 1 from public.vehicle_routes where vehicle_id = old.id) then raise exception 'vehicle has route history; hide it instead' using errcode = '23503'; end if;
  return old;
end $$;
revoke all on function private.vehicles_del_guard() from public, anon;
drop trigger if exists vehicles_del_guard on public.vehicles;
create trigger vehicles_del_guard before delete on public.vehicles for each row execute function private.vehicles_del_guard();

-- 10) 저장 함수: 기준일자 번호와 지원 여부(p_status)를 함께 받음
drop function if exists public.save_fleet(jsonb, jsonb);
create or replace function public.save_fleet(p_vehicles jsonb default '[]'::jsonb, p_routes jsonb default '[]'::jsonb, p_round bigint default null, p_status jsonb default '[]'::jsonb)
returns jsonb language plpgsql security invoker set search_path = ''
as $$
declare r jsonb; c int; nv int := 0; nu int := 0; nd int := 0; ns int := 0; vid text; tms text[]; stp text[]; st text; d date;
        v_all boolean := (select private.has_perm('equip.edit.all'));
begin
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
    insert into public.round_vehicle_status as s (round_id, vehicle_id, status, off_from)
    values (p_round, vid, st, nullif(r ->> 'off_from', '')::date)
    on conflict (round_id, vehicle_id) do update set status = excluded.status, off_from = excluded.off_from
      where (s.status, s.off_from) is distinct from (excluded.status, excluded.off_from);       -- 권한이 없으면 규칙(RLS)이 거절
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
      -- 지원장비: 같은 지사 목록의 기존 경로에서 시각만
      if not (select private.has_perm('equip.edit.own')) or cardinality(stp) = 0
         or not exists (select 1 from public.vehicles v where v.id = vid and v.org = (select private.my_org()))
         or not exists (select 1 from public.vehicle_routes x where x.date = d and x.vehicle_id = vid and x.stops = stp) then
        raise exception 'route not allowed: %', vid using errcode = '42501';
      end if;
      update public.vehicle_routes x set times = tms where x.date = d and x.vehicle_id = vid and x.times is distinct from tms;
      get diagnostics c = row_count; nu := nu + c;
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
  return jsonb_build_object('vehicles', nv, 'status', ns, 'routes_saved', nu, 'routes_deleted', nd);
end $$;
revoke all on function public.save_fleet(jsonb, jsonb, bigint, jsonb) from public, anon;
grant execute on function public.save_fleet(jsonb, jsonb, bigint, jsonb) to authenticated;

-- 11) 권한 이름·설명만 고침 (권한 값 자체는 그대로)
update public.permissions set label = '자기 기관 장비 추가·도공번호·기준일자별 지원 여부·블로워·도착 시각',
  description = '장비 지원 > 기관별 장비에서 자기 출발 기관 장비를 추가하고 도공번호·블로워(소·대)·기준일자별 지원 여부(지원 불가 시작일 포함), 정해진 경로의 도착 예상 시각을 고침(삭제·숨기기·경로 지사는 관리자)'
 where key = 'equip.edit.own';
update public.permissions set label = '모든 기관 장비·경로 입력·장비 삭제·숨기기',
  description = '모든 출발 기관 장비를 입력·확정하고, 장비를 추가하고 [삭제]·[숨기기]하고(관리자만), 지원일 1을 바꿈'
 where key = 'equip.edit.all';
