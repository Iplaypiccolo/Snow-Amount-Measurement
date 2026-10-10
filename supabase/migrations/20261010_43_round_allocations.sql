-- ============================================================
-- 43. 기관별 배정 + 기계화부(지원장비 계정)의 첫날 지사 지정 (2026-10-10 사용자 결정, Claude Code)
--  업무 순서: ① 지사 요청 → ② 관리자 편성 확정 → ③ 지원/미지원 → ④ 관리자가 "어느 기관이 어느 지사에 몇 대"(여기) → ⑤ 기계화부가 "어느 장비가 어느 지사로"
--  * round_allocations : (기준일자, 지원 기관, 피지원 지사) → 제설차·제설기 대수. 관리자(equip.edit.all)만 쓰고, 로그인한 사람은 모두 읽음.
--    기준일자 전체에 한 번(첫날 기준). 이동정비차는 배정하지 않음 — 기계화부가 자기 기관이 배정받은 지사 중에서 알아서 보냄.
--  * 기계화부(equip.edit.own)가 할 수 있는 일이 늘어남: 자기 기관 장비의 **기준일자 첫날** 경로를 **한 곳**으로 정하거나 지움(최초 지원만).
--      - 고를 수 있는 지사 = 관리자가 자기 기관에 배정한 지사(제설차는 제설차 대수가 있는 지사, 제설기는 제설기 대수가 있는 지사, 이동정비차는 배정받은 아무 지사)
--      - 배정 대수를 넘기면 거절(한 번의 [확정] 안에서 서로 바꾸는 것은 됨 — 끝에서 한 번에 셈)
--      - 둘째 날부터, 하루 여러 곳(지사 사이 이동), 수정본은 지금처럼 관리자만. 관리자가 넣은 여러 곳·수정본 경로는 기계화부가 못 바꿈(도착 시각만).
--  * 관리자가 배정을 나중에 줄이면 이미 정한 경로는 지우지 않음 — 화면이 '배정 초과'로 표시하고 기계화부가 고침.
--  * 거절 번호: SA001 배정받지 않은 지사 · SA002 배정 대수 초과 · SA003 첫날 한 곳(최초 지원)만
--  * 시험: supabase/tests/allocation_test.sql
-- ============================================================

-- 1) 표
create table if not exists public.round_allocations (
  round_id   bigint  not null references public.support_rounds(id) on delete cascade,
  org        text    not null references public.equip_orgs(name),
  branch_id  text    not null references public.branches(id),
  truck      integer not null default 0 check (truck between 0 and 99),
  blower     integer not null default 0 check (blower between 0 and 99),
  updated_by uuid, updated_at timestamptz not null default now(),
  primary key (round_id, org, branch_id),
  constraint round_allocations_some check (truck + blower > 0)
);
comment on table public.round_allocations is '기준일자별 기관 → 지사 배정 대수(제설차·제설기). 관리자가 정하고 기계화부가 이 안에서 장비별 지사를 고름';

drop trigger if exists stamp_round_allocations on public.round_allocations;
create trigger stamp_round_allocations before insert or update on public.round_allocations for each row execute function private.stamp('updated_by', 'updated_at');
drop trigger if exists audit_round_allocations on public.round_allocations;
create trigger audit_round_allocations after insert or update or delete on public.round_allocations
  for each row execute function private.audit_row('round_id', 'org', 'branch_id');

-- 2) 권한 규칙(RLS): 읽기 = 로그인한 사람, 쓰기 = 관리자(equip.edit.all)
alter table public.round_allocations enable row level security;
revoke all on public.round_allocations from anon, public;
grant select, insert, update, delete on public.round_allocations to authenticated;
drop policy if exists round_allocations_read on public.round_allocations;
drop policy if exists round_allocations_ins on public.round_allocations;
drop policy if exists round_allocations_upd on public.round_allocations;
drop policy if exists round_allocations_del on public.round_allocations;
create policy round_allocations_read on public.round_allocations for select to authenticated using ((select private.my_role()) is not null);
create policy round_allocations_ins on public.round_allocations for insert to authenticated with check ((select private.has_perm('equip.edit.all')));
create policy round_allocations_upd on public.round_allocations for update to authenticated
  using ((select private.has_perm('equip.edit.all'))) with check ((select private.has_perm('equip.edit.all')));
create policy round_allocations_del on public.round_allocations for delete to authenticated using ((select private.has_perm('equip.edit.all')));

-- 3) 저장 함수(관리자): 바뀐 칸만 받아 한 번에. 둘 다 0 이면 그 줄을 지움. 편성이 확정된 지사만 배정 가능
create or replace function public.save_allocations(p_round bigint, p_rows jsonb) returns jsonb
language plpgsql set search_path = ''
as $$
declare r jsonb; c int; nu int := 0; nd int := 0; t int; b int;
begin
  if jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows) = 0 then raise exception 'nothing to save' using errcode = '22023'; end if;
  if jsonb_array_length(p_rows) > 2000 then raise exception 'too many rows' using errcode = '54000'; end if;
  if not exists (select 1 from public.support_rounds where id = p_round) then raise exception 'unknown round' using errcode = '23503'; end if;
  for r in select * from jsonb_array_elements(p_rows) loop
    if jsonb_typeof(r) is distinct from 'object' or not (r ? 'org') or not (r ? 'branch_id') then raise exception 'bad row' using errcode = '22023'; end if;
    t := coalesce((r ->> 'truck')::int, 0); b := coalesce((r ->> 'blower')::int, 0);
    if t = 0 and b = 0 then
      delete from public.round_allocations a where a.round_id = p_round and a.org = r ->> 'org' and a.branch_id = r ->> 'branch_id';
      get diagnostics c = row_count; nd := nd + c;
    else
      if not exists (select 1 from public.round_requests q where q.round_id = p_round and q.branch_id = r ->> 'branch_id' and q.confirmed) then
        raise exception 'branch is not confirmed in this round' using errcode = '23514';
      end if;
      insert into public.round_allocations as a (round_id, org, branch_id, truck, blower) values (p_round, r ->> 'org', r ->> 'branch_id', t, b)
      on conflict (round_id, org, branch_id) do update set truck = excluded.truck, blower = excluded.blower
        where (a.truck, a.blower) is distinct from (excluded.truck, excluded.blower);       -- 권한이 없으면 규칙(RLS)이 거절
      get diagnostics c = row_count; nu := nu + c;
    end if;
  end loop;
  if nu + nd = 0 and not (select private.has_perm('equip.edit.all')) then raise exception 'not allowed' using errcode = '42501'; end if;
  return jsonb_build_object('saved', nu, 'deleted', nd);
end $$;
revoke all on function public.save_allocations(bigint, jsonb) from public, anon;
grant execute on function public.save_allocations(bigint, jsonb) to authenticated;

-- 4) 경로 표 권한 규칙(RLS): 기계화부도 자기 기관 장비의 경로를 넣고 지울 수 있게(무엇을 넣을 수 있는지는 아래 5) 가 정함)
drop policy if exists vehicle_routes_ins on public.vehicle_routes;
create policy vehicle_routes_ins on public.vehicle_routes for insert to authenticated with check (
  (select private.has_perm('equip.edit.all'))
  or ((select private.has_perm('equip.edit.own')) and exists (select 1 from public.vehicles v where v.id = vehicle_routes.vehicle_id and v.org = (select private.my_org()))));
drop policy if exists vehicle_routes_del on public.vehicle_routes;
create policy vehicle_routes_del on public.vehicle_routes for delete to authenticated using (
  (select private.has_perm('equip.edit.all'))
  or ((select private.has_perm('equip.edit.own')) and exists (select 1 from public.vehicles v where v.id = vehicle_routes.vehicle_id and v.org = (select private.my_org()))));

-- 5) 기계화부가 경로에 할 수 있는 일(관리자는 모두 통과)
create or replace function private.vehicle_routes_guard() returns trigger
language plpgsql set search_path = ''
as $$
declare d date; st date; v public.vehicles; a public.round_allocations;
begin
  if (select auth.uid()) is null or private.has_perm('equip.edit.all') then return coalesce(new, old); end if;   -- 로그인 사용자가 아닌 서버 안 작업(관리용)과 관리자는 통과
  if not private.has_perm('equip.edit.own') or not exists (select 1 from public.vehicles x where x.id = coalesce(new.vehicle_id, old.vehicle_id) and x.org = private.my_org()) then
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
  select * into v from public.vehicles where id = new.vehicle_id;
  select * into a from public.round_allocations x where x.round_id = private.governing_round(d) and x.org = v.org and x.branch_id = new.stops[1];
  if not found or (v.type = '제설차' and a.truck = 0) or (v.type = '제설기' and a.blower = 0) then
    raise exception 'branch is not allocated to this org' using errcode = 'SA001';
  end if;
  return new;
end $$;
revoke all on function private.vehicle_routes_guard() from public, anon;
drop trigger if exists aa_vehicle_routes_guard on public.vehicle_routes;
create trigger aa_vehicle_routes_guard before insert or update or delete on public.vehicle_routes for each row execute function private.vehicle_routes_guard();

-- 6) 배정 대수 넘김 검사: 저장이 끝날 때 한 번에(서로 바꾸는 경우를 위해 미룸). 관리자·이동정비차는 세지 않음
create or replace function private.route_alloc_cap() returns trigger
language plpgsql set search_path = ''
as $$
declare rid bigint; st date; v public.vehicles; cap int; n int;
begin
  if (select auth.uid()) is null or private.has_perm('equip.edit.all') then return null; end if;
  select * into v from public.vehicles where id = new.vehicle_id;
  if v.type = '이동정비차' then return null; end if;
  rid := private.governing_round(new.date);
  select start_date into st from public.support_rounds where id = rid;
  if st is distinct from new.date then return null; end if;
  if not exists (select 1 from public.vehicle_routes x where x.date = new.date and x.vehicle_id = new.vehicle_id and x.stops[1] = new.stops[1]) then return null; end if;   -- 그 뒤에 또 바뀐 줄
  select case when v.type = '제설차' then a.truck else a.blower end into cap
    from public.round_allocations a where a.round_id = rid and a.org = v.org and a.branch_id = new.stops[1];
  select count(*) into n from public.vehicle_routes x join public.vehicles y on y.id = x.vehicle_id
   where x.date = new.date and y.org = v.org and y.type = v.type and x.stops[1] = new.stops[1];
  if n > coalesce(cap, 0) then raise exception 'more vehicles than allocated' using errcode = 'SA002'; end if;
  return null;
end $$;
revoke all on function private.route_alloc_cap() from public, anon;
drop trigger if exists vehicle_routes_alloc_cap_ins on public.vehicle_routes;
create constraint trigger vehicle_routes_alloc_cap_ins after insert on public.vehicle_routes
  deferrable initially deferred for each row execute function private.route_alloc_cap();
drop trigger if exists vehicle_routes_alloc_cap_upd on public.vehicle_routes;
create constraint trigger vehicle_routes_alloc_cap_upd after update on public.vehicle_routes
  deferrable initially deferred for each row when (old.stops is distinct from new.stops) execute function private.route_alloc_cap();

-- 7) 기관별 장비 [확정] 함수: 기계화부의 경로 줄도 받음(지사 지정·지우기는 위 5)·6) 이 검사, 시각만 고치는 것은 예전과 같음)
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
revoke all on function public.save_fleet(jsonb, jsonb, bigint, jsonb) from public, anon;
grant execute on function public.save_fleet(jsonb, jsonb, bigint, jsonb) to authenticated;
