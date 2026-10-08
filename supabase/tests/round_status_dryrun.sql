-- 파일 버전: v4 (2026-10-08 17:35) — 시험 앞부분이 "담당 기준일자가 없는 경로가 남아 있지 않음" 이면 최신입니다
-- ============================================================
-- [롤백 시험] 마이그레이션 38 + 기준일자별 지원 여부 시험을 한 번에 — SQL Editor 에 통째로 붙여넣고 실행
-- 맨 끝에서 일부러 오류를 내므로 서버에는 아무것도 남지 않습니다(전부 되돌려짐).
-- 결과는 빨간 오류 칸에 "기준일자별 지원 여부 시험 — 전체 N, 실패 0 (모두 통과)" 로 나와야 합니다.
-- ※ 이 파일은 마이그레이션 38 과 supabase/tests/round_status_test.sql 을 이어 붙인 것입니다(내용 수정 시 둘을 고치고 다시 이어 붙일 것).
-- ============================================================
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
--  * 정리: 이 SQL 을 실행하는 시점에 기준일자가 하나도 없어(사용자가 2026-10-08 16:53 에 10.7 기준일자를 삭제함) 담당 기준일자가 없는 경로 8줄(모두 시험 자료)을 지움 — 사용자 확인함(선택지 B).
--    (실제로는 적용 전에 사용자가 장비 6대와 기준일자를 직접 삭제해 경로도 이미 0줄이 됨 — 이 삭제문은 그래도 안전하게 둠)
--    지운 줄은 수정 기록(audit_log)에도 남음. 복구가 필요하면(기준일자를 만든 뒤 해당 날짜가 그 기간에 들어와야 들어감):
--      insert into public.vehicle_routes (date, vehicle_id, stops, times) values
--        ('2026-10-05','V001','{B001}','{01:35}'), ('2026-10-07','V001','{B004}','{05:35}'), ('2026-10-07','V002','{B007}','{12:11}'),
--        ('2026-10-07','V003','{B012}','{13:00}'), ('2026-10-07','V004','{B002}','{17:00}'), ('2026-10-07','V006','{B019}','{01:35}'),
--        ('2026-10-08','V001','{B002}',null), ('2026-10-09','V001','{B002}',null);
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

-- 6) 정리: 기준일자가 하나도 없거나 첫 기준일자보다 앞선 경로 삭제 (사용자 확인함: 지금은 기준일자가 0개라 경로 8줄 전부)
delete from public.vehicle_routes
 where not exists (select 1 from public.support_rounds) or date < (select min(start_date) from public.support_rounds);
do $$ begin
  if exists (select 1 from public.vehicle_routes where private.governing_round(date) is null) then
    raise exception '담당 기준일자가 없는 경로가 남아 있어 중단합니다(전부 취소됨). 기준일자(예: 10.7)를 먼저 만든 뒤 다시 실행하세요';
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
         case when s.status = 'O' and s.off_from is not null and s.off_from <= p_date then 'X' else coalesce(s.status, case when prev is null then v.status else '' end) end,   -- 기준일자가 하나도 없을 때는 옛 열(vehicles.status)을 이어받음
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

-- ============================================================
-- 기준일자별 지원 여부(마이그레이션 38) 시험 — SQL Editor 에 통째로 붙여넣고 실행
-- 마지막에 일부러 오류를 내서 시험 자료(2099·2100년 기준일자, V9001~V9003 장비)를 전부 되돌립니다. "전체 N, 실패 0" 이어야 합니다.
-- ※ 마이그레이션 38 을 적용한 뒤에 실행합니다. (적용 전 롤백 시험은 마이그레이션 SQL 뒤에 이 파일을 이어 붙여 한 번에 실행)
-- ============================================================
create temp table if not exists _t (n serial, name text, got text, want text, ok boolean);
create or replace function pg_temp.run_as(rl text, uid uuid, stmt text) returns text language plpgsql as $f$
declare n bigint;
begin
  perform set_config('request.jwt.claims', case when uid is null then '' else json_build_object('sub', uid, 'role', rl)::text end, true);
  if rl <> 'postgres' then execute format('set local role %I', rl); end if;
  begin execute stmt; get diagnostics n = row_count; execute 'reset role'; return 'ok:' || n;
  exception when others then execute 'reset role'; return 'err:' || sqlstate; end;
end $f$;
create or replace function pg_temp.chk(name text, rl text, uid uuid, stmt text, want text) returns void language plpgsql as $f$
declare got text := pg_temp.run_as(rl, uid, stmt); begin insert into _t(name, got, want, ok) values (name, got, want, got = want); end $f$;
create or replace function pg_temp.yes(name text, cond boolean, info text default '') returns void language plpgsql as $f$
begin insert into _t(name, got, want, ok) values (name, case when cond then 'true' else 'false ' || info end, 'true', coalesce(cond, false)); end $f$;
do $t$
declare a uuid := gen_random_uuid(); e uuid := gen_random_uuid(); r1 bigint; r2 bigint; r3 bigint; r4 bigint; r5 bigint; r6 bigint; r7 bigint; c bigint; nveh bigint; c0 bigint; noprev boolean;
begin
  insert into auth.users (id, aud, role, email) values (a,'authenticated','authenticated','ra@t.test'),(e,'authenticated','authenticated','re@t.test');
  insert into public.profiles (id,username,display_name,role,branch_id,org,hq_id,perms,must_change) values
    (a,'rs-adm','관리자','admin',null,null,null,'{}',false),(e,'rs-eq','장비','equip',null,'서울경기',null,'{equip.edit.own}',false);
  insert into public.vehicles (id,org,type,plate) values ('V9001','서울경기','제설차','서울경기9901'),('V9002','충북','제설기','충북9902'),('V9003','충북','제설차','충북9903');
  insert into public.vehicles (id,org,type,plate,status) values ('V9004','서울경기','제설차','서울경기9904','M');

  select count(*) into c0 from public.audit_log where tab = 'round_vehicle_status';
  -- 0. 마이그레이션 직후 상태(실제 자료)
  perform pg_temp.yes('담당 기준일자가 없는 경로가 남아 있지 않음', not exists (select 1 from public.vehicle_routes where private.governing_round(date) is null));
  select count(*) = 0 into noprev from public.support_rounds;     -- 기준일자가 하나도 없는 상태에서 처음 만드는 경우인지

  perform pg_temp.chk('지원장비 계정은 기준일자를 못 만든다','authenticated',e,'select public.create_round(''2099-12-01'')','err:42501');
  perform pg_temp.chk('직접 insert 는 막힘','authenticated',a,'insert into public.support_rounds (name, start_date) values (''x'', ''2099-01-01'')','err:42501');
  perform pg_temp.chk('관리자: 새 기준일자 2099-12-01','authenticated',a,'select public.create_round(''2099-12-01'')','ok:1');
  select id into r1 from public.support_rounds where start_date = '2099-12-01';
  perform pg_temp.chk('마지막 기준일자보다 앞 날짜는 거절','authenticated',a,'select public.create_round(''2020-01-01'')','err:23514');
  select count(*) into nveh from public.vehicles where active;
  perform pg_temp.yes('전체 장비가 넘어옴', (select count(*) from public.round_vehicle_status where round_id = r1) = nveh, 'rows=' || (select count(*) from public.round_vehicle_status where round_id = r1) || ' veh=' || nveh);
  perform pg_temp.yes('정비중(V9004)도 그대로 넘어옴(기준일자가 없던 상태에서 처음 만들면 옛 열 값)', not noprev or (select status from public.round_vehicle_status where round_id = r1 and vehicle_id = 'V9004') = 'M');
  perform pg_temp.yes('자동으로 넘긴 줄은 수정 기록에 없음', (select count(*) from public.audit_log where tab = 'round_vehicle_status') = c0);
  perform pg_temp.yes('새 V9001 은 미정', (select status from public.round_vehicle_status where round_id = r1 and vehicle_id = 'V9001') = '');

  -- 2. 지원 여부 저장 (자기 기관만)
  perform pg_temp.chk('지원장비: 자기 장비 지원 가능','authenticated',e,format('select public.save_fleet(''[]'', ''[]'', %s, ''[{"vehicle_id":"V9001","status":"O"}]'')', r1),'ok:1');
  perform pg_temp.chk('지원장비: 다른 기관 장비는 거절','authenticated',e,format('select public.save_fleet(''[]'', ''[]'', %s, ''[{"vehicle_id":"V9002","status":"O"}]'')', r1),'err:42501');
  perform pg_temp.chk('기준일자 번호 없이 지원 여부 거절','authenticated',e,'select public.save_fleet(''[]'', ''[]'', null, ''[{"vehicle_id":"V9001","status":"O"}]'')','err:22023');
  perform pg_temp.chk('장비 줄에 status 를 넣으면 거절','authenticated',e,'select public.save_fleet(''[{"id":"V9001","status":"O"}]'', ''[]'')','err:22023');
  perform pg_temp.yes('사람이 고친 줄은 수정 기록에 남음', (select count(*) from public.audit_log where tab = 'round_vehicle_status') = c0 + 1);

  -- 3. 경로
  perform pg_temp.chk('관리자: 경로 12/2','authenticated',a,format('select public.save_fleet(''[]'', ''[{"date":"2099-12-02","vehicle_id":"V9001","stops":["B001","B002"],"times":["03:50","07:30"]}]'', %s)', r1),'ok:1');
  perform pg_temp.chk('기준일자 이전 날짜(담당 없음)는 거절','authenticated',a,format('select public.save_fleet(''[]'', ''[{"date":"2099-11-30","vehicle_id":"V9001","stops":["B001"]}]'', %s)', r1),'err:23514');
  perform pg_temp.chk('지원 가능이 아닌 장비의 경로는 거절','authenticated',a,format('select public.save_fleet(''[]'', ''[{"date":"2099-12-02","vehicle_id":"V9002","stops":["B001"]}]'', %s)', r1),'err:23514');
  perform pg_temp.chk('지원장비: 경로 지사 바꾸기 거절','authenticated',e,format('select public.save_fleet(''[]'', ''[{"date":"2099-12-02","vehicle_id":"V9001","stops":["B003"]}]'', %s)', r1),'err:42501');
  perform pg_temp.chk('관리자: 지원 여부와 경로를 한 번에','authenticated',a,format('select public.save_fleet(''[]'', ''[{"date":"2099-12-03","vehicle_id":"V9002","stops":["B001"]}]'', %s, ''[{"vehicle_id":"V9002","status":"O"}]'')', r1),'ok:1');

  -- 4. 새 기준일자(12/3 시작): 겹치는 날짜는 새 기준일자가 맡음
  perform pg_temp.chk('새 기준일자 2099-12-03','authenticated',a,'select public.create_round(''2099-12-03'')','ok:1');
  select id into r2 from public.support_rounds where start_date = '2099-12-03';
  perform pg_temp.yes('지원 가능 장비가 그대로 넘어옴', (select count(*) = 2 from public.round_vehicle_status where round_id = r2 and vehicle_id in ('V9001','V9002') and status = 'O'));
  perform pg_temp.yes('경로는 복사되지 않고 공유(12/3 한 줄 그대로)', (select count(*) = 1 from public.vehicle_routes where date = '2099-12-03'));
  perform pg_temp.chk('옛 기준일자에서 새 기준일자가 맡은 날짜(12/4)는 거절','authenticated',a,format('select public.save_fleet(''[]'', ''[{"date":"2099-12-04","vehicle_id":"V9001","stops":["B001"]}]'', %s)', r1),'err:23514');
  perform pg_temp.chk('옛 기준일자에서 12/3 지우기도 거절','authenticated',a,format('select public.save_fleet(''[]'', ''[{"date":"2099-12-03","vehicle_id":"V9002","stops":[]}]'', %s)', r1),'err:23514');
  perform pg_temp.chk('새 기준일자에서 12/4','authenticated',a,format('select public.save_fleet(''[]'', ''[{"date":"2099-12-04","vehicle_id":"V9001","stops":["B001"]}]'', %s)', r2),'ok:1');
  perform pg_temp.yes('12/2 는 옛 기준일자가 맡음', private.governing_round('2099-12-02') = r1 and private.governing_round('2099-12-03') = r2);

  -- 5. 지원 불가: 겹치는 날짜가 지원 불가로 바뀜(경로는 남김)
  perform pg_temp.chk('새 기준일자에서 V9001 지원 불가','authenticated',e,format('select public.save_fleet(''[]'', ''[]'', %s, ''[{"vehicle_id":"V9001","status":"X"}]'')', r2),'ok:1');
  perform pg_temp.yes('12/2 는 가능, 12/4 는 불가', private.vehicle_avail('V9001', '2099-12-02') and not private.vehicle_avail('V9001', '2099-12-04'));
  perform pg_temp.yes('저장된 경로는 지워지지 않음', exists (select 1 from public.vehicle_routes where date = '2099-12-04' and vehicle_id = 'V9001'));
  perform pg_temp.chk('불가인 날 새 경로 거절','authenticated',a,format('select public.save_fleet(''[]'', ''[{"date":"2099-12-05","vehicle_id":"V9001","stops":["B001"]}]'', %s)', r2),'err:23514');
  perform pg_temp.chk('불가인 날 도착 시각 고치기도 거절','authenticated',e,format('select public.save_fleet(''[]'', ''[{"date":"2099-12-04","vehicle_id":"V9001","stops":["B001"],"times":["06:40"]}]'', %s)', r2),'err:23514');
  perform pg_temp.chk('다시 지원 가능 + 12/5 부터 불가','authenticated',e,format('select public.save_fleet(''[]'', ''[]'', %s, ''[{"vehicle_id":"V9001","status":"O","off_from":"2099-12-05"}]'')', r2),'ok:1');
  perform pg_temp.yes('12/4 가능, 12/5 불가(그날부터)', private.vehicle_avail('V9001', '2099-12-04') and not private.vehicle_avail('V9001', '2099-12-05'));
  perform pg_temp.chk('불가 시작일이 기준일자 시작일보다 앞이면 거절','authenticated',e,format('select public.save_fleet(''[]'', ''[]'', %s, ''[{"vehicle_id":"V9001","status":"O","off_from":"2099-12-02"}]'')', r2),'err:23514');
  perform pg_temp.chk('불가 시작일은 지원 가능일 때만(X 이면 비움)','authenticated',a,format('select public.save_fleet(''[]'', ''[]'', %s, ''[{"vehicle_id":"V9003","status":"X","off_from":"2099-12-05"}]'')', r2),'ok:1');
  perform pg_temp.yes('X 이면 불가 시작일 비워짐', (select off_from is null from public.round_vehicle_status where round_id = r2 and vehicle_id = 'V9003'));

  -- 6. 이어받기: 불가 시작일 처리
  perform pg_temp.chk('새 기준일자 2099-12-05(불가 시작일 당일)','authenticated',a,'select public.create_round(''2099-12-05'')','ok:1');
  select id into r3 from public.support_rounds where start_date = '2099-12-05';
  perform pg_temp.yes('이미 불가가 시작된 장비는 지원 불가로 넘어옴', (select status = 'X' and off_from is null from public.round_vehicle_status where round_id = r3 and vehicle_id = 'V9001'));
  perform pg_temp.chk('V9002 를 12/7 부터 불가로','authenticated',a,format('select public.save_fleet(''[]'', ''[]'', %s, ''[{"vehicle_id":"V9002","status":"O","off_from":"2099-12-07"}]'')', r3),'ok:1');
  perform pg_temp.chk('새 기준일자 2099-12-06','authenticated',a,'select public.create_round(''2099-12-06'')','ok:1');
  select id into r4 from public.support_rounds where start_date = '2099-12-06';
  perform pg_temp.yes('아직 시작 안 된 불가 시작일은 그대로 넘어옴', (select status = 'O' and off_from = '2099-12-07' from public.round_vehicle_status where round_id = r4 and vehicle_id = 'V9002'));

  -- 7. 기준일자 삭제
  perform pg_temp.chk('마지막이 아닌 기준일자 삭제 거절','authenticated',a,format('delete from public.support_rounds where id = %s', r3),'err:23514');
  perform pg_temp.chk('지원장비 계정은 삭제 못 함','authenticated',e,format('delete from public.support_rounds where id = %s', r4),'ok:0');
  perform pg_temp.chk('마지막 기준일자(경로 없음) 삭제','authenticated',a,format('delete from public.support_rounds where id = %s', r4),'ok:1');
  perform pg_temp.chk('마지막이 아닌 옛 기준일자 삭제 거절','authenticated',a,format('delete from public.support_rounds where id = %s', r1),'err:23514');
  perform pg_temp.yes('삭제하면 그 지원 여부 줄도 함께 사라짐', not exists (select 1 from public.round_vehicle_status where round_id = r4));

  -- 8. 숨기기·삭제
  perform pg_temp.chk('지원장비 계정은 숨기기 못 함','authenticated',e,'update public.vehicles set hidden_after = ''2099-12-03'' where id = ''V9001''','err:42501');
  perform pg_temp.chk('관리자: V9002 숨기기(12/3 이후 기준일자부터)','authenticated',a,'update public.vehicles set hidden_after = ''2099-12-03'' where id = ''V9002''','ok:1');
  perform pg_temp.chk('새 기준일자 2099-12-20','authenticated',a,'select public.create_round(''2099-12-20'')','ok:1');
  select id into r5 from public.support_rounds where start_date = '2099-12-20';
  perform pg_temp.yes('숨긴 장비는 새 기준일자에 안 넘어옴, 나머지는 넘어옴', not exists (select 1 from public.round_vehicle_status where round_id = r5 and vehicle_id = 'V9002') and exists (select 1 from public.round_vehicle_status where round_id = r5 and vehicle_id = 'V9001'));
  perform pg_temp.yes('숨겨도 이전 기준일자 기록은 그대로', exists (select 1 from public.round_vehicle_status where round_id = r1 and vehicle_id = 'V9002') and exists (select 1 from public.vehicle_routes where vehicle_id = 'V9002'));
  perform pg_temp.chk('경로 기록이 있는 장비는 삭제 거절(숨기기를 쓰라는 뜻)','authenticated',a,'delete from public.vehicles where id = ''V9002''','err:23503');
  perform pg_temp.chk('기록 없는 장비는 삭제 가능','authenticated',a,'delete from public.vehicles where id = ''V9003''','ok:1');
  perform pg_temp.chk('지원장비 계정은 장비 삭제 못 함','authenticated',e,'delete from public.vehicles where id = ''V9001''','ok:0');
  perform pg_temp.chk('숨김 취소','authenticated',a,'update public.vehicles set hidden_after = null where id = ''V9002''','ok:1');

  -- 9. 연말(12월 → 1월)
  perform pg_temp.chk('새 기준일자 2099-12-30','authenticated',a,'select public.create_round(''2099-12-30'')','ok:1');
  select id into r6 from public.support_rounds where start_date = '2099-12-30';
  perform pg_temp.yes('12/30 기준일자가 1/2 까지 맡음', private.governing_round('2099-12-31') = r6 and private.governing_round('2100-01-02') = r6 and private.governing_round('2100-01-03') is null);
  perform pg_temp.chk('새 기준일자 2100-01-01 (연도가 넘어가도 더 나중)','authenticated',a,'select public.create_round(''2100-01-01'')','ok:1');
  select id into r7 from public.support_rounds where start_date = '2100-01-01';
  perform pg_temp.yes('1/2 는 새 기준일자(2100-01-01)가 맡고 12/31 은 12/30 기준일자', private.governing_round('2100-01-02') = r7 and private.governing_round('2099-12-31') = r6);
  perform pg_temp.chk('2099-12-31 기준일자는 이제 거절(마지막보다 앞)','authenticated',a,'select public.create_round(''2099-12-31'')','err:23514');

  select count(*), count(*) filter (where not ok) into c, nveh from _t;
  raise exception E'기준일자별 지원 여부 시험 — 전체 %, 실패 %\n%', c, nveh, coalesce((select string_agg('FAIL ' || name || ' → ' || got || ' / ' || want, E'\n' order by n) from _t where not ok), '(모두 통과)');
end $t$;
