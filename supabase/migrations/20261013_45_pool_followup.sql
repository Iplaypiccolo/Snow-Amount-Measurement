-- ============================================================
-- 45. 지역본부 장비 후속 고침 — 코드 검토(2026-10-13)에서 나온 것, 사용자 확인 (Claude Code)
--  ① 장비 번호 자동 매김: lpad(n, 3, '0') 은 네 자리 숫자를 세 자리로 잘라 1000번째 장비가 'V100' 이 됨(이미 있는 번호와 겹쳐 등록 불가)
--     → 1000번부터는 네·다섯 자리 그대로(V1000 …, 번호 검사 `^V[0-9]{3,5}$` 안).
--  ② 44번이 모든 장비의 기관(org) 변경을 막아, 예전에 되던 "관리자가 기계화부 장비를 다른 기관으로 옮기기"가 막혔음
--     → 지역본부 장비(또는 지역본부로 바꾸려는 경우)만 기관·기준일자·출발 지사를 못 바꾸게. 기계화부 장비는 예전 규칙(vehicles_guard: 관리자만)대로.
--  ③ 기준일자 삭제 검사: "그 기간에 경로가 있으면 못 지움"에서, **다른 기준일자에 딸린 지역본부 장비의 경로는 세지 않음**.
--     (앞 기준일자 A 의 지역본부 장비 경로가 새 기준일자 B 기간에 남아 있을 때, 그 장비는 B 화면에 나오지 않고 A 화면에서는 그 날짜가 잠겨 있어
--      경로를 지울 방법이 없었음 → B 를 잘못 만들어도 지울 수 없었음. B 를 지우면 그 날짜는 다시 A 가 맡아 경로가 그대로 되살아남)
--  * 시험: supabase/tests/pool_test.sql 끝부분
-- ============================================================

-- ①·② 지역본부 장비 규칙(넣을 때·고칠 때)
create or replace function private.vehicles_pool_guard() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare bname text; pfx text; n int;
begin
  if tg_op = 'INSERT' and new.id is null then          -- 번호를 주지 않으면 서버가 다음 번호를 매김(여러 계정이 동시에 넣어도 겹치지 않게)
    perform pg_advisory_xact_lock(hashtext('public.vehicles.id'));
    select coalesce(max(substr(v.id, 2)::int), 0) + 1 into n from public.vehicles v;
    new.id := 'V' || lpad(n::text, greatest(3, length(n::text)), '0');     -- V001 … V999, V1000 …(lpad 는 길이를 넘으면 잘라 버리므로 길이를 숫자에 맞춤)
  end if;
  if tg_op = 'UPDATE' and '지역본부' in (old.org, new.org)
     and (new.org, new.round_id, new.home_branch) is distinct from (old.org, old.round_id, old.home_branch) then
    raise exception 'org / round / home branch of a pool vehicle cannot be changed' using errcode = '42501';   -- 기계화부 장비의 기관 변경은 vehicles_guard 가 판단(관리자만)
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

-- ③ 기준일자 삭제 검사: 다른 기준일자에 딸린 지역본부 장비의 경로는 세지 않음
create or replace function private.rounds_del_guard() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if exists (select 1 from public.support_rounds where start_date > old.start_date) then raise exception 'only the latest round can be deleted' using errcode = '23514'; end if;
  if exists (select 1 from public.vehicle_routes x join public.vehicles v on v.id = x.vehicle_id
              where x.date >= old.start_date and x.date < old.start_date + old.days
                and (v.round_id is null or v.round_id = old.id)) then
    raise exception 'round has routes' using errcode = '23514';
  end if;
  return old;
end $$;
