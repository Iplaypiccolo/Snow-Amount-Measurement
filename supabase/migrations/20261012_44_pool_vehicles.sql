-- ============================================================
-- 44. 지역본부 장비 (2026-10-12 사용자 결정, Claude Code)
--  다른 지사를 도울 수 있는 지사가 "타지사 지원 가능 대수"를 내고(지사별 요청·편성), 관리자가 확정하면
--  그 지사가 그 기준일자에 보낼 제설차를 등록한다. 어느 지사로 보낼지는 관리자가 정한다.
--  * round_requests.offer_truck : 타지사 지원 가능 대수(제설차만, 0~99). 지사·본부·관리자가 넣고, 확정하면 줄의 다른 칸과 함께 잠김.
--  * vehicles 에 지역본부 장비용 칸: round_id(기준일자) · home_branch(출발 지사) · rented(임차). org = '지역본부', type = '제설차'.
--      - 기준일자에 딸린 장비: 그 기준일자에서만 쓰임. 새 기준일자로 이어받지 않음(다시 등록).
--      - 이름(plate) = 지사 이름 + [임차] + 숫자(예: 인천252, 인천임차1). 화면은 '인천 252호' / '인천 임차 1호'로 보여 줌.
--        같은 기준일자 안에서만 중복 불가(다른 기준일자에서는 같은 이름을 다시 쓸 수 있음).
--      - 등록 = 그 지사 계정(req.edit.own + 자기 지사)과 관리자. 본부·기계화부 계정은 못 함.
--        그 기준일자에 그 지사의 지원 가능 대수가 1 이상으로 '확정'돼 있어야 함(아니면 SA004). 등록 대수는 막지 않음.
--      - 지원 여부는 늘 '지원'(등록하면 자동으로 생김, 다른 값으로 못 바꿈).
--      - 경로(피지원 지사)는 관리자만. 지사는 정해진 경로의 도착 예상 시각만. 자기 지사로는 못 보냄(SA005).
--      - 삭제 = 그 지사 계정과 관리자(경로가 있으면 못 지움 — 경로를 먼저 지움).
--  * 기관 목록(equip_orgs)에 '지역본부' 추가 → 기관별 배정(round_allocations)에 '지역본부' 칸(제설차만). 계정의 출발 기관으로는 못 씀.
--  * 거절 번호: SA004 지원 가능 대수 확정 전 등록 · SA005 자기 지사로 보냄
--  * 시험: supabase/tests/pool_test.sql
-- ============================================================

-- 1) 지사 요청 표: 타지사 지원 가능 대수
alter table public.round_requests add column if not exists offer_truck integer not null default 0;
alter table public.round_requests drop constraint if exists round_requests_offer_truck_check;
alter table public.round_requests add constraint round_requests_offer_truck_check check (offer_truck between 0 and 99);
comment on column public.round_requests.offer_truck is '타지사 지원 가능 대수(제설차). 확정되면 그 지사가 지역본부 장비를 등록할 수 있음';

-- 2) 기관 목록에 '지역본부'(기관별 배정·장비의 출발 기관용). 계정 소속으로는 쓸 수 없음. 배정은 제설차만
insert into public.equip_orgs (name) values ('지역본부') on conflict do nothing;
alter table public.profiles drop constraint if exists profiles_org_not_pool;
alter table public.profiles add constraint profiles_org_not_pool check (org is distinct from '지역본부');
alter table public.round_allocations drop constraint if exists round_allocations_pool_truck_only;
alter table public.round_allocations add constraint round_allocations_pool_truck_only check (org <> '지역본부' or blower = 0);

-- 3) 장비 표: 지역본부 장비용 칸
alter table public.vehicles add column if not exists round_id    bigint references public.support_rounds(id) on delete cascade;
alter table public.vehicles add column if not exists home_branch text   references public.branches(id);
alter table public.vehicles add column if not exists rented      boolean not null default false;
comment on column public.vehicles.round_id is '지역본부 장비만: 이 장비가 딸린 기준일자(그 기준일자에서만 쓰임)';
comment on column public.vehicles.home_branch is '지역본부 장비만: 출발 지사';
alter table public.vehicles drop constraint if exists vehicles_pool_shape;
alter table public.vehicles add constraint vehicles_pool_shape check (
  case when org = '지역본부' then round_id is not null and home_branch is not null and type = '제설차' and hidden_after is null
       else round_id is null and home_branch is null and not rented end);
-- 이름 형식: 기계화부 장비는 예전 그대로, 지역본부 장비는 아래 4) 가 검사
alter table public.vehicles drop constraint if exists vehicles_plate_check;
alter table public.vehicles add constraint vehicles_plate_check check (
  org = '지역본부' or plate ~ ('^' || org || '[0-9]{1,5}$') or plate ~ '^[0-9]{2,3}[가-힣][0-9]{4}$');
-- 이름 중복: 기계화부 장비는 전체에서 하나, 지역본부 장비는 같은 기준일자 안에서 하나
alter table public.vehicles drop constraint if exists vehicles_plate_key;
drop index if exists public.vehicles_plate_key;
create unique index vehicles_plate_key on public.vehicles (plate) where round_id is null;
create unique index if not exists vehicles_pool_plate_key on public.vehicles (round_id, plate) where round_id is not null;

-- 4) 지역본부 장비 규칙(넣을 때·고칠 때)
create or replace function private.vehicles_pool_guard() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare bname text; pfx text; n int;
begin
  if tg_op = 'INSERT' and new.id is null then          -- 번호를 주지 않으면 서버가 다음 번호를 매김(여러 지사가 동시에 등록해도 겹치지 않게)
    perform pg_advisory_xact_lock(hashtext('public.vehicles.id'));
    select coalesce(max(substr(v.id, 2)::int), 0) + 1 into n from public.vehicles v;
    new.id := 'V' || lpad(n::text, 3, '0');
  end if;
  if tg_op = 'UPDATE' and (new.org, new.round_id, new.home_branch) is distinct from (old.org, old.round_id, old.home_branch) then
    raise exception 'org / round / home branch cannot be changed' using errcode = '42501';
  end if;
  if new.org <> '지역본부' then return new; end if;
  select b.name into bname from public.branches b where b.id = new.home_branch;
  pfx := bname || case when new.rented then '임차' else '' end;
  if bname is null or left(new.plate, length(pfx)) <> pfx or substr(new.plate, length(pfx) + 1) !~ '^[0-9]{1,5}$' then
    raise exception 'name must be <branch name>[임차]<number>' using errcode = '23514';
  end if;
  if tg_op = 'INSERT' and (select auth.uid()) is not null then
    if not (private.has_perm('equip.edit.all') or (private.has_perm('req.edit.own') and new.home_branch = private.my_branch())) then
      raise exception 'not allowed' using errcode = '42501';
    end if;
    if not exists (select 1 from public.round_requests q where q.round_id = new.round_id and q.branch_id = new.home_branch and q.confirmed and q.offer_truck >= 1) then
      raise exception 'the offer of this branch is not confirmed in this round' using errcode = 'SA004';
    end if;
  end if;
  return new;
end $$;
revoke all on function private.vehicles_pool_guard() from public, anon;
drop trigger if exists aa_vehicles_pool_guard on public.vehicles;
create trigger aa_vehicles_pool_guard before insert or update on public.vehicles for each row execute function private.vehicles_pool_guard();

-- 등록하면 그 기준일자의 지원 여부 '지원'이 자동으로 생김(자동 줄은 수정 기록에서 뺌)
create or replace function private.vehicles_pool_status() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  perform set_config('private.carry', '1', true);
  insert into public.round_vehicle_status (round_id, vehicle_id, status) values (new.round_id, new.id, 'O') on conflict do nothing;
  perform set_config('private.carry', '', true);
  return null;
end $$;
revoke all on function private.vehicles_pool_status() from public, anon;
drop trigger if exists vehicles_pool_status on public.vehicles;
create trigger vehicles_pool_status after insert on public.vehicles for each row when (new.org = '지역본부') execute function private.vehicles_pool_status();

-- 지원 여부 검사: 지역본부 장비는 자기 기준일자에서 늘 '지원'
create or replace function private.rvs_check() returns trigger
language plpgsql set search_path = ''
as $$
declare st date; v public.vehicles;
begin
  new.off_from := case when new.status = 'O' then new.off_from else null end;
  select * into v from public.vehicles x where x.id = new.vehicle_id;
  if v.org = '지역본부' and (new.round_id <> v.round_id or new.status <> 'O' or new.off_from is not null) then
    raise exception 'a pool vehicle is always available in its own round' using errcode = '23514';
  end if;
  if new.off_from is not null then
    select start_date into st from public.support_rounds where id = new.round_id;
    if new.off_from < st then raise exception 'off_from is before the round start' using errcode = '23514'; end if;
  end if;
  return new;
end $$;

-- 5) 장비 표 권한 규칙(RLS): 지사 계정도 자기 지사의 지역본부 장비를 넣고·고치고·지울 수 있게
drop policy if exists vehicles_ins on public.vehicles;
create policy vehicles_ins on public.vehicles for insert to authenticated with check (
  (select private.has_perm('equip.edit.all'))
  or ((select private.has_perm('equip.edit.own')) and org = (select private.my_org()))
  or ((select private.has_perm('req.edit.own')) and org = '지역본부' and home_branch = (select private.my_branch())));
drop policy if exists vehicles_upd on public.vehicles;
create policy vehicles_upd on public.vehicles for update to authenticated
  using ((select private.has_perm('equip.edit.all'))
         or ((select private.has_perm('equip.edit.own')) and org = (select private.my_org()))
         or ((select private.has_perm('req.edit.own')) and org = '지역본부' and home_branch = (select private.my_branch())))
  with check ((select private.has_perm('equip.edit.all'))
         or ((select private.has_perm('equip.edit.own')) and org = (select private.my_org()))
         or ((select private.has_perm('req.edit.own')) and org = '지역본부' and home_branch = (select private.my_branch())));
drop policy if exists vehicles_del on public.vehicles;
create policy vehicles_del on public.vehicles for delete to authenticated using (
  (select private.has_perm('equip.edit.all'))
  or ((select private.has_perm('req.edit.own')) and org = '지역본부' and home_branch = (select private.my_branch())));

-- 6) 경로 표 권한 규칙(RLS): 지사 계정은 자기 지사 지역본부 장비의 경로를 '고치기'만(무엇을 고칠 수 있는지는 아래 7) — 도착 예상 시각만)
drop policy if exists vehicle_routes_upd on public.vehicle_routes;
create policy vehicle_routes_upd on public.vehicle_routes for update to authenticated
  using ((select private.has_perm('equip.edit.all'))
         or ((select private.has_perm('equip.edit.own')) and exists (select 1 from public.vehicles v where v.id = vehicle_routes.vehicle_id and v.org = (select private.my_org())))
         or ((select private.has_perm('req.edit.own')) and exists (select 1 from public.vehicles v where v.id = vehicle_routes.vehicle_id and v.org = '지역본부' and v.home_branch = (select private.my_branch()))))
  with check ((select private.has_perm('equip.edit.all'))
         or ((select private.has_perm('equip.edit.own')) and exists (select 1 from public.vehicles v where v.id = vehicle_routes.vehicle_id and v.org = (select private.my_org())))
         or ((select private.has_perm('req.edit.own')) and exists (select 1 from public.vehicles v where v.id = vehicle_routes.vehicle_id and v.org = '지역본부' and v.home_branch = (select private.my_branch()))));

-- 7) 관리자가 아닌 계정이 경로에 할 수 있는 일(관리자는 모두 통과). 지역본부 장비 = 그 지사 계정이 도착 예상 시각만
create or replace function private.vehicle_routes_guard() returns trigger
language plpgsql set search_path = ''
as $$
declare d date; st date; v public.vehicles; a public.round_allocations;
begin
  if (select auth.uid()) is null or private.has_perm('equip.edit.all') then return coalesce(new, old); end if;   -- 로그인 사용자가 아닌 서버 안 작업(관리용)과 관리자는 통과
  select * into v from public.vehicles x where x.id = coalesce(new.vehicle_id, old.vehicle_id);
  if v.org = '지역본부' then
    if private.has_perm('req.edit.own') and v.home_branch = private.my_branch() and tg_op = 'UPDATE'
       and (new.date, new.vehicle_id, new.stops, new.revised) is not distinct from (old.date, old.vehicle_id, old.stops, old.revised) then
      return new;                                            -- 그 지사 계정: 도착 예상 시각만
    end if;
    raise exception 'only the admin sets the route of a pool vehicle' using errcode = '42501';
  end if;
  if not private.has_perm('equip.edit.own') or v.org is distinct from private.my_org() then
    raise exception 'not allowed' using errcode = '42501';   -- 자기 기관 장비가 아니거나 권한이 없음(권한 규칙과 같은 번호로)
  end if;
  if tg_op = 'UPDATE' and (new.date, new.vehicle_id, new.stops, new.revised) is not distinct from (old.date, old.vehicle_id, old.stops, old.revised) then
    return new;                                              -- 도착 예상 시각만 고침(예전과 같음)
  end if;
  if tg_op = 'UPDATE' and (new.date, new.vehicle_id) is distinct from (old.date, old.vehicle_id) then
    raise exception 'date/vehicle cannot be changed' using errcode = '42501';
  end if;
  d := case when tg_op = 'DELETE' then old.date else new.date end;
  select start_date into st from public.support_rounds where id = private.governing_round(d);
  if st is null or d <> st then raise exception 'only the first day of the round can be assigned' using errcode = 'SA003'; end if;
  if tg_op in ('UPDATE', 'DELETE') and (old.revised or cardinality(old.stops) <> 1) then
    raise exception 'this route was set by the admin' using errcode = 'SA003';     -- 관리자가 넣은 여러 곳·수정본은 못 바꿈
  end if;
  if tg_op = 'DELETE' then return old; end if;
  if new.revised or cardinality(new.stops) <> 1 then raise exception 'one branch, first assignment only' using errcode = 'SA003'; end if;
  select * into a from public.round_allocations x where x.round_id = private.governing_round(d) and x.org = v.org and x.branch_id = new.stops[1];
  if not found or (v.type = '제설차' and a.truck = 0) or (v.type = '제설기' and a.blower = 0) then
    raise exception 'branch is not allocated to this org' using errcode = 'SA001';
  end if;
  return new;
end $$;

-- 경로 모양 검사: 지역본부 장비는 자기(출발) 지사로 못 보냄
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
  if exists (select 1 from public.vehicles v where v.id = new.vehicle_id and v.home_branch = any(new.stops)) then
    raise exception 'a pool vehicle cannot be sent to its own branch' using errcode = 'SA005';
  end if;
  if new.times is not null then
    if cardinality(new.times) <> cardinality(new.stops) then raise exception 'times must match stops' using errcode = '23514'; end if;
    if exists (select 1 from unnest(new.times) t where t is not null and t !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$') then
      raise exception 'time must be HH:MM' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;

-- 8) 새 기준일자: 지역본부 장비는 이어받지 않음(새 기준일자부터 지원 없음 — 다시 등록)
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
   where v.active and v.round_id is null and (v.hidden_after is null or p_date <= v.hidden_after);
  get diagnostics n = row_count;
  perform set_config('private.carry', '', true);
  return jsonb_build_object('id', rid, 'name', p_date::text || ' 기준', 'start_date', p_date, 'days', p_days, 'carried', n);
end $$;

-- 9) 지사 요청: 확정한 줄은 지원 가능 대수도 잠김
create or replace function private.round_requests_guard() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and (new.round_id, new.branch_id) is distinct from (old.round_id, old.branch_id) then
    raise exception 'round_id/branch_id cannot be changed' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and old.confirmed
     and (new.req_truck, new.req_blower, new.assigned_truck, new.assigned_blower, new.arrive_at, new.reason, new.offer_truck,
          new.wx_manual, new.wx_snow, new.wx_pcp, new.wx_tmin, new.wx_tmin_at, new.wx_level, new.wx_fc, new.wx_ef)
         is distinct from
         (old.req_truck, old.req_blower, old.assigned_truck, old.assigned_blower, old.arrive_at, old.reason, old.offer_truck,
          old.wx_manual, old.wx_snow, old.wx_pcp, old.wx_tmin, old.wx_tmin_at, old.wx_level, old.wx_fc, old.wx_ef) then
    raise exception 'confirmed row is locked' using errcode = '55000';
  end if;
  if private.has_perm('req.confirm') then return new; end if;
  if tg_op = 'INSERT' then
    if new.assigned_truck <> 0 or new.assigned_blower <> 0 or new.confirmed then raise exception 'assignment needs req.confirm' using errcode = '42501'; end if;
  elsif (new.assigned_truck, new.assigned_blower, new.confirmed) is distinct from (old.assigned_truck, old.assigned_blower, old.confirmed) then
    raise exception 'assignment needs req.confirm' using errcode = '42501';
  end if;
  return new;
end $$;

-- 지사별 요청·편성 [저장] 함수: 지원 가능 대수(offer_truck)도 받음
create or replace function public.save_requests(p_round bigint, p_rows jsonb) returns jsonb
language plpgsql set search_path = ''
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
        req_truck       = case when r ? 'req_truck'       then coalesce((r ->> 'req_truck')::int, 0)       else q.req_truck end,
        req_blower      = case when r ? 'req_blower'      then coalesce((r ->> 'req_blower')::int, 0)      else q.req_blower end,
        assigned_truck  = case when r ? 'assigned_truck'  then coalesce((r ->> 'assigned_truck')::int, 0)  else q.assigned_truck end,
        assigned_blower = case when r ? 'assigned_blower' then coalesce((r ->> 'assigned_blower')::int, 0) else q.assigned_blower end,
        offer_truck     = case when r ? 'offer_truck'     then coalesce((r ->> 'offer_truck')::int, 0)     else q.offer_truck end,
        arrive_at       = case when r ? 'arrive_at'       then (r ->> 'arrive_at')::timestamptz          else q.arrive_at end,
        reason          = case when r ? 'reason'          then nullif(r ->> 'reason', '')                else q.reason end,
        confirmed       = case when r ? 'confirmed'       then coalesce((r ->> 'confirmed')::boolean, false) else q.confirmed end,
        wx_manual       = case when r ? 'wx_manual'       then coalesce((r ->> 'wx_manual')::boolean, false) else q.wx_manual end,
        wx_snow         = case when r ? 'wx_snow'         then (r ->> 'wx_snow')::double precision      else q.wx_snow end,
        wx_pcp          = case when r ? 'wx_pcp'          then (r ->> 'wx_pcp')::double precision       else q.wx_pcp end,
        wx_tmin         = case when r ? 'wx_tmin'         then (r ->> 'wx_tmin')::double precision      else q.wx_tmin end,
        wx_tmin_at      = case when r ? 'wx_tmin_at'      then (r ->> 'wx_tmin_at')::timestamptz        else q.wx_tmin_at end,
        wx_level        = case when r ? 'wx_level'        then nullif(r ->> 'wx_level', '')              else q.wx_level end,
        wx_fc           = case when r ? 'wx_fc'           then (r ->> 'wx_fc')::timestamptz             else q.wx_fc end,
        wx_ef           = case when r ? 'wx_ef'           then (r ->> 'wx_ef')::timestamptz             else q.wx_ef end
      where q.round_id = p_round and q.branch_id = b;
      get diagnostics c = row_count;
      if c = 0 then raise exception 'row not allowed: %', b using errcode = '42501'; end if;
    else
      insert into public.round_requests (round_id, branch_id, req_truck, req_blower, assigned_truck, assigned_blower, offer_truck, arrive_at, reason, confirmed,
                                         wx_manual, wx_snow, wx_pcp, wx_tmin, wx_tmin_at, wx_level, wx_fc, wx_ef)
      values (p_round, b,
              coalesce((r ->> 'req_truck')::int, 0), coalesce((r ->> 'req_blower')::int, 0),
              coalesce((r ->> 'assigned_truck')::int, 0), coalesce((r ->> 'assigned_blower')::int, 0), coalesce((r ->> 'offer_truck')::int, 0),
              (r ->> 'arrive_at')::timestamptz, nullif(r ->> 'reason', ''), coalesce((r ->> 'confirmed')::boolean, false),
              coalesce((r ->> 'wx_manual')::boolean, false), (r ->> 'wx_snow')::double precision, (r ->> 'wx_pcp')::double precision,
              (r ->> 'wx_tmin')::double precision, (r ->> 'wx_tmin_at')::timestamptz,
              nullif(r ->> 'wx_level', ''), (r ->> 'wx_fc')::timestamptz, (r ->> 'wx_ef')::timestamptz);
    end if;
    n := n + 1;
  end loop;
  return jsonb_build_object('rows', n);
end $$;

-- 10) 기관별 장비 [확정] 함수: 지역본부 장비의 임차 여부(rented)도 받고, 지사 계정은 자기 지사 지역본부 장비의 도착 예상 시각만
create or replace function public.save_fleet(p_vehicles jsonb default '[]'::jsonb, p_routes jsonb default '[]'::jsonb, p_round bigint default null, p_status jsonb default '[]'::jsonb) returns jsonb
language plpgsql set search_path = ''
as $$
declare r jsonb; c int; nv int := 0; nu int := 0; nd int := 0; ns int := 0; vid text; tms text[]; stp text[]; st text; d date;
        v_all boolean := (select private.has_perm('equip.edit.all'));
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
    if not v_all and exists (select 1 from public.vehicles v where v.id = vid and v.org = '지역본부') then
      -- 지사 계정: 자기 지사 지역본부 장비의 정해진 경로에 도착 예상 시각만
      if not (select private.has_perm('req.edit.own')) or not exists (select 1 from public.vehicles v where v.id = vid and v.home_branch = (select private.my_branch()))
         or not exists (select 1 from public.vehicle_routes x where x.date = d and x.vehicle_id = vid and x.stops = stp) then
        raise exception 'route not allowed: %', vid using errcode = '42501';
      end if;
      update public.vehicle_routes x set times = tms where x.date = d and x.vehicle_id = vid and x.times is distinct from tms;
      get diagnostics c = row_count; nu := nu + c;
      continue;
    end if;
    if not v_all then
      -- 기계화부(지원장비): 자기 기관 장비만. 같은 지사 목록이면 시각만, 아니면 첫날 한 곳 지정·지우기(트리거가 검사)
      if not (select private.has_perm('equip.edit.own')) or not exists (select 1 from public.vehicles v where v.id = vid and v.org = (select private.my_org())) then
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
end $$;
