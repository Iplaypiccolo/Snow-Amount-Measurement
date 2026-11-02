-- ============================================================
-- 53. 기계화부·지사도 관리자가 정한 모든 지원일에서 피지원 지사를 고름 (2026-11-02 사용자 요청, Claude 채팅)
--  · 예전(43·49): 관리자(equip.route)가 아니면 기준일자 '첫날(지원일 1)'만 → 이제 그 기준일자의 모든 지원일(start_date ~ start_date + days - 1, private.governing_round 가 있는 날)
--  · 나머지 규칙은 그대로: 하루 한 곳, 수정본 아님, 관리자가 넣은 여러 곳·수정본은 못 바꿈(SA003), 관리자가 그 기관에 배정한 지사만(SA001),
--    지역본부 장비는 자기 지사로 못 보냄(SA005), 배정 대수는 '그날' 그 지사로 보낸 같은 기관·종류 장비 수로 셈(SA002, 예전엔 첫날만 셈)
--  · 지원일 범위 밖 날짜는 SA003. 저장 함수 save_fleet·권한 규칙(RLS)은 그대로(날짜 검사는 트리거에만 있었음)
--  * 시험: supabase/tests/route_alldays_test.sql
-- ============================================================
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
  if st is null then raise exception 'date is outside the support days of any round' using errcode = 'SA003'; end if;   -- 2026-11-02: 첫날만 → 기준일자의 모든 지원일(start_date ~ start_date + days - 1)
  if tg_op in ('UPDATE', 'DELETE') and (old.revised or cardinality(old.stops) <> 1) then
    raise exception 'this route was set by the admin' using errcode = 'SA003';     -- 관리자가 넣은 여러 곳·수정본은 못 바꿈
  end if;
  if tg_op = 'DELETE' then return old; end if;
  if new.revised or cardinality(new.stops) <> 1 then raise exception 'one branch per day, first assignment only' using errcode = 'SA003'; end if;
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
  if rid is null then return null; end if;                       -- 2026-11-02: 첫날만이 아니라 지원일마다 그날 대수를 셈
  if not exists (select 1 from public.vehicle_routes x where x.date = new.date and x.vehicle_id = new.vehicle_id and x.stops[1] = new.stops[1]) then return null; end if;   -- 그 뒤에 또 바뀐 줄
  select case when v.type = '제설차' then a.truck else a.blower end into cap
    from public.round_allocations a where a.round_id = rid and a.org = v.org and a.branch_id = new.stops[1];
  select count(*) into n from public.vehicle_routes x join public.vehicles y on y.id = x.vehicle_id
   where x.date = new.date and y.org = v.org and y.type = v.type and x.stops[1] = new.stops[1];
  if n > coalesce(cap, 0) then raise exception 'more vehicles than allocated' using errcode = 'SA002'; end if;
  return null;
end $function$;

