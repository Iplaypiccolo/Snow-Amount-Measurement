-- 파일 버전: v2 (2026-11-02 12:40) — [롤백 시험] 마이그레이션 49 + supabase/tests/route_perm_test.sql 을 한 번에. 맨 끝에서 일부러 오류를 내므로 서버에는 아무것도 남지 않음
-- ============================================================
-- 49. 지원일 칸(날짜별 경로)은 관리자만 — 새 권한 equip.route (2026-11-02 사용자 요청, Claude 채팅)
--  배경: 지원장비 아이디 4개(exseoulgigyae·exchungbukgigyae·exjeonbukgigyae·exdaegugigyae)에 '모든 기관 장비…'(equip.edit.all)를 줌
--        → 모든 기관 장비 추가·삭제·숨기기는 필요하지만, 그 권한이 지원일 칸(경로)까지 열어 버림.
--  바꾸는 것: 지원일 칸의 "관리자 전용" 검사를 equip.edit.all → 새 권한 equip.route 로 옮김. 관리자는 모든 권한이라 그대로.
--   * equip.route 가 없는 계정은 '모든 기관' 권한이 있어도 지원일 칸은 예전 수준(사용자 결정):
--       기계화부 = 자기 기관 장비의 기준일자 첫날 지사 한 곳(배정 안, 최초 지원)·도착 예상 시각, 지원 불가는 지원 여부로
--       둘째 날·하루 여러 곳·수정본·지원일 1 날짜·초기화는 equip.route(관리자)만
--   * 고치는 곳: 경로 검사 트리거 2개(vehicle_routes_guard·route_alloc_cap), 저장 함수 save_fleet, 경로 표 권한 규칙(RLS) 3개
--     — 함수 본문은 2026-11-02 서버에 있던 그대로에서 권한 검사만 바꿈
--   * 장비 추가·삭제·숨기기는 그대로 equip.edit.all (기관별 배정은 아래 '추가' — equip.route)
--  추가(같은 날 사용자 결정): "관리자는 기관별 배정에서 대수만 정하고, 어떤 장비를 어느 지사로 보낼지는 그 기관(기계화부·지사)이 기관별 장비에서 정함"
--   * 기관별 배정(round_allocations) 쓰기 = equip.route(관리자). '모든 기관' 권한(equip.edit.all)으로는 못 고침(지금은 기계화부 4개가 고칠 수 있었음)
--   * 지사 계정(req.edit.own)도 자기 지사 지역본부 장비의 첫날 피지원 지사 한 곳을 정함 — 관리자가 '지역본부'에 배정한 지사·대수 안에서, 자기 지사는 안 됨(SA005).
--     예전(44)에는 지역본부 장비 경로는 관리자만이었음.
--  계정별 권한(profiles.perms)은 바꾸지 않음. equip.route 는 아무 역할에도 기본으로 주지 않음(관리 콘솔에서 줄 수 있음)
-- ============================================================

-- 1) 새 권한
insert into public.permissions (key, label, description, default_roles, sort) values
  ('equip.route', '기관별 배정 · 지원일 칸(경로) 전부 입력', '장비 지원 > 기관별 배정 대수를 정하고, 기관별 장비의 지원일 칸에서 모든 장비의 피지원 지사(둘째 날·하루 여러 곳·수정본 포함)·지원일 1 날짜·지원일 칸 수·초기화를 씀. 없으면 자기 기관(지사는 자기 지사 지역본부) 장비의 첫날 한 곳(배정 안)과 도착 시각만', '{}', 95)            -- sort 95 = '모든 기관…'(90) 바로 다음 칸
on conflict (key) do update set label = excluded.label, description = excluded.description;
update public.permissions set label = '모든 기관 장비 입력·장비 삭제·숨기기',
  description = '모든 출발 기관 장비를 추가·입력하고 [삭제]·[숨기기]. 기관별 배정·지원일 칸(경로)은 이 권한으로 열리지 않음(equip.route)'
 where key = 'equip.edit.all';

-- 2) 경로 검사 트리거: 관리자 통과 = equip.route. 기계화부 검사는 '자기 기관'(equip.edit.own 또는 equip.edit.all)
create or replace function private.vehicle_routes_guard()
 returns trigger
 language plpgsql
 set search_path to ''
as $function$
declare d date; st date; v public.vehicles; a public.round_allocations;
begin
  if (select auth.uid()) is null or private.has_perm('equip.route') then return coalesce(new, old); end if;   -- 로그인 사용자가 아닌 서버 안 작업(관리용)과 관리자는 통과
  select * into v from public.vehicles x where x.id = coalesce(new.vehicle_id, old.vehicle_id);
  if v.org = '지역본부' then                                  -- 지역본부 장비: 그 지사 계정(2026-11-02부터 첫날 한 곳도 — 아래 기계화부와 같은 규칙)
    if not (private.has_perm('req.edit.own') and v.home_branch = private.my_branch()) then
      raise exception 'not allowed' using errcode = '42501';
    end if;
  elsif not (private.has_perm('equip.edit.own') or private.has_perm('equip.edit.all')) or v.org is distinct from private.my_org() then
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
  if v.home_branch = new.stops[1] then raise exception 'a pool vehicle cannot be sent to its own branch' using errcode = 'SA005'; end if;
  select * into a from public.round_allocations x where x.round_id = private.governing_round(d) and x.org = v.org and x.branch_id = new.stops[1];
  if not found or (v.type = '제설차' and a.truck = 0) or (v.type = '제설기' and a.blower = 0) then
    raise exception 'branch is not allocated to this org' using errcode = 'SA001';
  end if;
  return new;
end $function$;

create or replace function private.route_alloc_cap()
 returns trigger
 language plpgsql
 set search_path to ''
as $function$
declare rid bigint; st date; v public.vehicles; cap int; n int;
begin
  if (select auth.uid()) is null or private.has_perm('equip.route') then return null; end if;
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
end $function$;

-- 3) 저장 함수: 경로 전부 = equip.route. 그 외에는 기계화부 길(자기 기관, equip.edit.own 또는 equip.edit.all)
create or replace function public.save_fleet(p_vehicles jsonb default '[]'::jsonb, p_routes jsonb default '[]'::jsonb, p_round bigint default null::bigint, p_status jsonb default '[]'::jsonb)
 returns jsonb
 language plpgsql
 set search_path to ''
as $function$
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

-- 4) 경로 표 권한 규칙(RLS): 전부 = equip.route, 아니면 자기 기관 장비(세부 검사는 위 트리거)
drop policy if exists vehicle_routes_ins on public.vehicle_routes;
drop policy if exists vehicle_routes_upd on public.vehicle_routes;
drop policy if exists vehicle_routes_del on public.vehicle_routes;
create policy vehicle_routes_ins on public.vehicle_routes for insert to authenticated with check (
  (select private.has_perm('equip.route'))
  or (((select private.has_perm('equip.edit.own')) or (select private.has_perm('equip.edit.all')))
      and exists (select 1 from public.vehicles v where v.id = vehicle_id and v.org = (select private.my_org())))
  or ((select private.has_perm('req.edit.own'))
      and exists (select 1 from public.vehicles v where v.id = vehicle_id and v.org = '지역본부' and v.home_branch = (select private.my_branch()))));
create policy vehicle_routes_del on public.vehicle_routes for delete to authenticated using (
  (select private.has_perm('equip.route'))
  or (((select private.has_perm('equip.edit.own')) or (select private.has_perm('equip.edit.all')))
      and exists (select 1 from public.vehicles v where v.id = vehicle_id and v.org = (select private.my_org())))
  or ((select private.has_perm('req.edit.own'))
      and exists (select 1 from public.vehicles v where v.id = vehicle_id and v.org = '지역본부' and v.home_branch = (select private.my_branch()))));
create policy vehicle_routes_upd on public.vehicle_routes for update to authenticated
  using ((select private.has_perm('equip.route'))
    or (((select private.has_perm('equip.edit.own')) or (select private.has_perm('equip.edit.all')))
        and exists (select 1 from public.vehicles v where v.id = vehicle_id and v.org = (select private.my_org())))
    or ((select private.has_perm('req.edit.own'))
        and exists (select 1 from public.vehicles v where v.id = vehicle_id and v.org = '지역본부' and v.home_branch = (select private.my_branch()))))
  with check ((select private.has_perm('equip.route'))
    or (((select private.has_perm('equip.edit.own')) or (select private.has_perm('equip.edit.all')))
        and exists (select 1 from public.vehicles v where v.id = vehicle_id and v.org = (select private.my_org())))
    or ((select private.has_perm('req.edit.own'))
        and exists (select 1 from public.vehicles v where v.id = vehicle_id and v.org = '지역본부' and v.home_branch = (select private.my_branch()))));

-- 5) 기관별 배정: 쓰기 = 관리자(equip.route). 저장 함수의 '권한 없음' 검사도 같이
drop policy if exists round_allocations_ins on public.round_allocations;
drop policy if exists round_allocations_upd on public.round_allocations;
drop policy if exists round_allocations_del on public.round_allocations;
create policy round_allocations_ins on public.round_allocations for insert to authenticated with check ((select private.has_perm('equip.route')));
create policy round_allocations_upd on public.round_allocations for update to authenticated
  using ((select private.has_perm('equip.route'))) with check ((select private.has_perm('equip.route')));
create policy round_allocations_del on public.round_allocations for delete to authenticated using ((select private.has_perm('equip.route')));

create or replace function public.save_allocations(p_round bigint, p_rows jsonb)
 returns jsonb
 language plpgsql
 set search_path to ''
as $function$
declare r jsonb; c int; nu int := 0; nd int := 0; t int; bl int; br text; bef jsonb; st int; sb int; qt int; qb int;
begin
  if jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows) = 0 then raise exception 'nothing to save' using errcode = '22023'; end if;
  if jsonb_array_length(p_rows) > 2000 then raise exception 'too many rows' using errcode = '54000'; end if;
  if not exists (select 1 from public.support_rounds where id = p_round) then raise exception 'unknown round' using errcode = '23503'; end if;
  if not (select private.has_perm('equip.route')) then raise exception 'not allowed' using errcode = '42501'; end if;      -- 2026-11-02: 배정은 관리자만(먼저 거절)
  select coalesce(jsonb_object_agg(x.branch_id, jsonb_build_array(x.t, x.b)), '{}'::jsonb) into bef          -- 저장 전 지사별 합계
    from (select a.branch_id, sum(a.truck) t, sum(a.blower) b from public.round_allocations a
           where a.round_id = p_round and a.branch_id in (select distinct e ->> 'branch_id' from jsonb_array_elements(p_rows) e) group by a.branch_id) x;
  for r in select * from jsonb_array_elements(p_rows) loop
    if jsonb_typeof(r) is distinct from 'object' or not (r ? 'org') or not (r ? 'branch_id') then raise exception 'bad row' using errcode = '22023'; end if;
    t := coalesce((r ->> 'truck')::int, 0); bl := coalesce((r ->> 'blower')::int, 0);
    if t = 0 and bl = 0 then
      delete from public.round_allocations a where a.round_id = p_round and a.org = r ->> 'org' and a.branch_id = r ->> 'branch_id';
      get diagnostics c = row_count; nd := nd + c;
    else
      if not exists (select 1 from public.round_requests q where q.round_id = p_round and q.branch_id = r ->> 'branch_id' and q.confirmed) then
        raise exception 'branch is not confirmed in this round' using errcode = '23514';
      end if;
      insert into public.round_allocations as a (round_id, org, branch_id, truck, blower) values (p_round, r ->> 'org', r ->> 'branch_id', t, bl)
      on conflict (round_id, org, branch_id) do update set truck = excluded.truck, blower = excluded.blower
        where (a.truck, a.blower) is distinct from (excluded.truck, excluded.blower);       -- 권한이 없으면 규칙(RLS)이 거절
      get diagnostics c = row_count; nu := nu + c;
    end if;
  end loop;
  for br in select distinct e ->> 'branch_id' from jsonb_array_elements(p_rows) e loop
    select coalesce(sum(a.truck), 0), coalesce(sum(a.blower), 0) into st, sb from public.round_allocations a where a.round_id = p_round and a.branch_id = br;
    select coalesce(max(q.assigned_truck), 0), coalesce(max(q.assigned_blower), 0) into qt, qb from public.round_requests q where q.round_id = p_round and q.branch_id = br;
    if (st > qt and st > coalesce((bef -> br ->> 0)::int, 0)) or (sb > qb and sb > coalesce((bef -> br ->> 1)::int, 0)) then
      raise exception 'allocation exceeds the assigned number' using errcode = 'SA006';
    end if;
  end loop;
  return jsonb_build_object('saved', nu, 'deleted', nd);
end $function$;

-- ============================================================
-- 지원일 칸·기관별 배정 = 관리자만, 지사는 자기 지사 지역본부 장비 첫날 한 곳(마이그레이션 49, equip.route) 시험 — SQL Editor 에 통째로 붙여넣고 실행
-- 마지막에 일부러 오류를 내서 시험 자료(2099년 기준일자, V9001·V9002, 시험 계정)를 전부 되돌립니다. "전체 N, 실패 0" 이어야 합니다.
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
declare a uuid := gen_random_uuid(); e1 uuid := gen_random_uuid(); e2 uuid := gen_random_uuid(); b uuid := gen_random_uuid(); cc uuid := gen_random_uuid(); rid bigint; c bigint; f bigint;
begin
  insert into auth.users (id, aud, role, email) values (a,'authenticated','authenticated','pa@t.test'),(e1,'authenticated','authenticated','pe1@t.test'),(e2,'authenticated','authenticated','pe2@t.test'),(b,'authenticated','authenticated','pb@t.test'),(cc,'authenticated','authenticated','pc@t.test');
  insert into public.profiles (id,username,display_name,role,branch_id,org,hq_id,perms,must_change) values
    (a,'rp-adm','관리자','admin',null,null,null,'{}',false),
    (e1,'rp-eq1','장비(자기 기관)','equip',null,'서울경기',null,'{equip.edit.own}',false),
    (e2,'rp-eq2','장비(모든 기관)','equip',null,'서울경기',null,'{equip.edit.own,equip.edit.all}',false),
    (b,'rp-br1','지사1','branch','B001',null,null,'{req.edit.own}',false),(cc,'rp-br2','지사2','branch','B002',null,null,'{req.edit.own}',false);
  insert into public.vehicles (id,org,type,plate) values ('V9001','서울경기','제설차','서울경기9901'),('V9002','충북','제설차','충북9902');
  insert into public.support_rounds (name,start_date,days) values ('t','2099-12-01',10) returning id into rid;
  insert into public.round_vehicle_status (round_id, vehicle_id, status) values (rid,'V9001','O'),(rid,'V9002','O');

  perform pg_temp.yes('새 권한 equip.route 있음, 기본으로 주는 역할 없음', exists (select 1 from public.permissions where key = 'equip.route' and default_roles = '{}'));
  perform pg_temp.yes('equip.edit.all 이름에서 경로가 빠짐', (select label not like '%경로%' from public.permissions where key = 'equip.edit.all'));
  -- 관리자: 지원일 칸 전부
  perform pg_temp.chk('관리자: 둘째 날 두 곳','authenticated',a,format('select public.save_fleet(''[]'', ''[{"date":"2099-12-02","vehicle_id":"V9001","stops":["B001","B002"]}]'', %s)', rid),'ok:1');
  perform pg_temp.chk('관리자: 다른 기관 장비도','authenticated',a,format('select public.save_fleet(''[]'', ''[{"date":"2099-12-03","vehicle_id":"V9002","stops":["B003"]}]'', %s)', rid),'ok:1');
  -- '모든 기관' 권한만 있는 지원장비: 지원일 칸은 예전 수준
  perform pg_temp.chk('모든 기관 지원장비: 둘째 날 경로 거절(첫날만)','authenticated',e2,format('select public.save_fleet(''[]'', ''[{"date":"2099-12-04","vehicle_id":"V9001","stops":["B001"]}]'', %s)', rid),'err:SA003');
  perform pg_temp.chk('모든 기관 지원장비: 관리자가 넣은 여러 곳 바꾸기 거절','authenticated',e2,format('select public.save_fleet(''[]'', ''[{"date":"2099-12-02","vehicle_id":"V9001","stops":["B001"]}]'', %s)', rid),'err:SA003');
  perform pg_temp.chk('모든 기관 지원장비: 관리자 경로 지우기 거절','authenticated',e2,format('select public.save_fleet(''[]'', ''[{"date":"2099-12-02","vehicle_id":"V9001","stops":[]}]'', %s)', rid),'err:SA003');
  perform pg_temp.chk('모든 기관 지원장비: 자기 기관 장비 도착 시각은 됨','authenticated',e2,format('select public.save_fleet(''[]'', ''[{"date":"2099-12-02","vehicle_id":"V9001","stops":["B001","B002"],"times":["06:10","09:20"]}]'', %s)', rid),'ok:1');
  perform pg_temp.chk('모든 기관 지원장비: 다른 기관 장비 경로 거절','authenticated',e2,format('select public.save_fleet(''[]'', ''[{"date":"2099-12-01","vehicle_id":"V9002","stops":["B001"]}]'', %s)', rid),'err:42501');
  perform pg_temp.chk('모든 기관 지원장비: 다른 기관 장비 도착 시각도 거절','authenticated',e2,format('select public.save_fleet(''[]'', ''[{"date":"2099-12-03","vehicle_id":"V9002","stops":["B003"],"times":["07:00"]}]'', %s)', rid),'err:42501');
  perform pg_temp.chk('모든 기관 지원장비: 표에 직접 넣기(다른 기관) 거절','authenticated',e2,'insert into public.vehicle_routes (date, vehicle_id, stops) values (''2099-12-05'', ''V9002'', ''{B001}'')','err:42501');
  perform pg_temp.chk('모든 기관 지원장비: 표에 직접 넣기(자기 기관 둘째 날) 거절','authenticated',e2,'insert into public.vehicle_routes (date, vehicle_id, stops) values (''2099-12-05'', ''V9001'', ''{B001}'')','err:SA003');
  perform pg_temp.chk('모든 기관 지원장비: 다른 기관 장비 지원 여부는 그대로 됨','authenticated',e2,format('select public.save_fleet(''[]'', ''[]'', %s, ''[{"vehicle_id":"V9002","status":"M"}]'')', rid),'ok:1');
  perform pg_temp.chk('모든 기관 지원장비: 다른 기관 장비 숨기기는 그대로 됨','authenticated',e2,'update public.vehicles set hidden_after = ''2099-11-30'' where id = ''V9002''','ok:1');
  -- 자기 기관 권한만: 예전과 같음
  perform pg_temp.chk('자기 기관 지원장비: 둘째 날 경로 거절','authenticated',e1,format('select public.save_fleet(''[]'', ''[{"date":"2099-12-06","vehicle_id":"V9001","stops":["B001"]}]'', %s)', rid),'err:SA003');
  perform pg_temp.chk('자기 기관 지원장비: 도착 시각은 됨','authenticated',e1,format('select public.save_fleet(''[]'', ''[{"date":"2099-12-02","vehicle_id":"V9001","stops":["B001","B002"],"times":["06:30","09:20"]}]'', %s)', rid),'ok:1');
  -- 지역본부 장비: 그 지사가 첫날 한 곳(관리자가 '지역본부'에 배정한 지사·대수 안, 자기 지사 안 됨)
  perform set_config('request.jwt.claims', '', true);          -- 아래 자료 넣기는 로그인 사용자 없이(서버 관리용 작업처럼)
  insert into public.vehicles (id,org,type,plate,round_id,home_branch) values
    ('V9003','지역본부','제설차',(select name from public.branches where id='B001')||'9901', rid, 'B001'),
    ('V9004','지역본부','제설차',(select name from public.branches where id='B001')||'9902', rid, 'B001');
  insert into public.round_vehicle_status (round_id, vehicle_id, status) values (rid,'V9003','O'),(rid,'V9004','O') on conflict do nothing;
  insert into public.round_allocations (round_id, org, branch_id, truck) values (rid, '지역본부', 'B002', 1);
  perform pg_temp.chk('지사: 자기 지역본부 장비 첫날 배정 지사로','authenticated',b,format('select public.save_fleet(''[]'', ''[{"date":"2099-12-01","vehicle_id":"V9003","stops":["B002"]}]'', %s)', rid),'ok:1');
  perform pg_temp.chk('지사: 배정 대수 넘김 거절','authenticated',b,format('select public.save_fleet(''[]'', ''[{"date":"2099-12-01","vehicle_id":"V9004","stops":["B002"]}]'', %s)', rid),'err:SA002');
  perform pg_temp.chk('지사: 자기 지사로는 거절','authenticated',b,format('select public.save_fleet(''[]'', ''[{"date":"2099-12-01","vehicle_id":"V9004","stops":["B001"]}]'', %s)', rid),'err:SA005');
  perform pg_temp.chk('지사: 배정받지 않은 지사 거절','authenticated',b,format('select public.save_fleet(''[]'', ''[{"date":"2099-12-01","vehicle_id":"V9004","stops":["B003"]}]'', %s)', rid),'err:SA001');
  perform pg_temp.chk('지사: 둘째 날은 거절','authenticated',b,format('select public.save_fleet(''[]'', ''[{"date":"2099-12-02","vehicle_id":"V9004","stops":["B002"]}]'', %s)', rid),'err:SA003');
  perform pg_temp.chk('다른 지사: 남의 지역본부 장비 거절','authenticated',cc,format('select public.save_fleet(''[]'', ''[{"date":"2099-12-01","vehicle_id":"V9003","stops":["B002"],"times":["07:00"]}]'', %s)', rid),'err:42501');
  perform pg_temp.chk('모든 기관 지원장비: 지역본부 장비 거절','authenticated',e2,format('select public.save_fleet(''[]'', ''[{"date":"2099-12-01","vehicle_id":"V9004","stops":["B002"]}]'', %s)', rid),'err:42501');
  perform pg_temp.chk('지사: 도착 시각','authenticated',b,format('select public.save_fleet(''[]'', ''[{"date":"2099-12-01","vehicle_id":"V9003","stops":["B002"],"times":["06:00"]}]'', %s)', rid),'ok:1');
  perform pg_temp.chk('지사: 자기가 정한 첫날 경로 지우기','authenticated',b,format('select public.save_fleet(''[]'', ''[{"date":"2099-12-01","vehicle_id":"V9003","stops":[]}]'', %s)', rid),'ok:1');
  -- 기관별 배정 = 관리자만
  perform pg_temp.chk('모든 기관 지원장비: 배정 저장 거절','authenticated',e2,format('select public.save_allocations(%s, ''[{"org":"서울경기","branch_id":"B002","truck":1}]'')', rid),'err:42501');
  perform pg_temp.chk('모든 기관 지원장비: 배정 표 직접 넣기 거절','authenticated',e2,format('insert into public.round_allocations (round_id, org, branch_id, truck) values (%s, ''서울경기'', ''B003'', 1)', rid),'err:42501');
  perform pg_temp.chk('모든 기관 지원장비: 배정 표 직접 고치기는 0줄','authenticated',e2,format('update public.round_allocations set truck = 3 where round_id = %s', rid),'ok:0');
  perform pg_temp.chk('관리자: 배정 표 고치기','authenticated',a,format('update public.round_allocations set truck = 2 where round_id = %s and org = ''지역본부''', rid),'ok:1');
  perform pg_temp.yes('관리자 경로는 그대로(지사 두 곳)', (select stops = '{B001,B002}' and times = '{06:30,09:20}' from public.vehicle_routes where vehicle_id = 'V9001' and date = '2099-12-02'));

  select count(*), count(*) filter (where not ok) into c, f from _t;
  raise exception E'지원일 칸 권한 시험 — 전체 %, 실패 %\n%', c, f, coalesce((select string_agg('FAIL ' || name || ' → ' || got || ' / ' || want, E'\n' order by n) from _t where not ok), '(모두 통과)');
end $t$;
