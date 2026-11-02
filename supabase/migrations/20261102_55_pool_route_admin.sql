-- ============================================================
-- 55. 지역본부 장비의 피지원 지사는 관리자만 정함, 지사는 도착 예상 시각만 (2026-11-02 사용자 요청)
--  · 예전(48~53): 지사 계정이 자기 지사 지역본부 장비의 지원일별 지사를 고름 → 이제 관리자(equip.route)만. 기계화부는 그대로(자기 기관 장비, 배정 안에서)
--  · 새 권한은 만들지 않음. 관리자는 이 검사 전에 통과하고, 기계화부 장비는 이 줄에 걸리지 않음
--  · 지사의 도착 예상 시각 고치기는 그대로(이 줄 앞의 '시각만 고침'에서 통과). 지사가 넣어 둔 경로는 그대로 남고, 고치는 것만 관리자
--  · 함수 본문은 2026-11-02 서버에 있던 그대로에서 한 줄만 더함. 저장 함수 save_fleet·권한 규칙(RLS)은 그대로
--  * 시험: supabase/tests/pool_route_admin_test.sql
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
  if v.org = '지역본부' then                                  -- 지역본부 장비: 그 지사 계정
    if not (private.has_perm('req.edit.own') and v.home_branch = private.my_branch()) then
      raise exception 'not allowed' using errcode = '42501';
    end if;
  elsif not (private.has_perm('equip.edit.own') or private.has_perm('equip.edit.all')) or v.org is distinct from private.my_org() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and (new.date, new.vehicle_id, new.stops, new.revised) is not distinct from (old.date, old.vehicle_id, old.stops, old.revised) then
    return new;                                              -- 도착 예상 시각만 고침
  end if;
  if v.org = '지역본부' then                                  -- 2026-11-02(55): 지역본부 장비의 피지원 지사는 관리자만(지사는 위의 시각만)
    raise exception 'pool vehicle route is set by the admin' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and (new.date, new.vehicle_id) is distinct from (old.date, old.vehicle_id) then
    raise exception 'date/vehicle cannot be changed' using errcode = '42501';
  end if;
  d := case when tg_op = 'DELETE' then old.date else new.date end;
  select start_date into st from public.support_rounds where id = private.governing_round(d);
  if st is null then raise exception 'date is outside the support days of any round' using errcode = 'SA003'; end if;   -- 2026-11-02(53): 첫날만 → 기준일자의 모든 지원일
  if tg_op in ('UPDATE', 'DELETE') and (old.revised or cardinality(old.stops) <> 1) then
    raise exception 'this route was set by the admin' using errcode = 'SA003';
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
