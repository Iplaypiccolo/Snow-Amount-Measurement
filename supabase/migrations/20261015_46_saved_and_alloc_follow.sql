-- ============================================================
-- 46. 지사 요청 '저장 완료' + 기관별 배정이 편성을 따라감 (2026-10-15 사용자 결정, Claude Code)
--  ① round_requests.saved_at · saved_by : 지사·본부 계정(req.confirm 권한이 없는 계정)이 그 줄을 저장한 시각·계정.
--     요청·지원 가능 대수가 모두 0이어도 [저장]하면 남음 → 화면에 '저장 완료'("요청 안 함"과 "아직 안 냄"을 구분). 관리자 저장·확정은 남기지 않음.
--  ② 기관별 배정 합계(그 지사의 모든 기관, 제설차·제설기 따로)는 편성 대수를 넘을 수 없음(SA006).
--     단, 이미 넘어 있는 배정을 줄이는 저장은 받음(한 번에 다 못 줄여도 됨).
--  ③ 편성이 '확정'될 때(확정 안 됨 → 확정) 배정이 편성보다 많으면:
--       - 편성 0 → 그 종류 배정을 모두 지움(두 종류 모두 0 이면 줄도 지움 → 기관별 배정 표에서 빠짐)
--       - 그 종류를 배정받은 기관이 하나뿐 → 그 기관 배정을 편성 대수로 줄임
--       - 여러 기관에 나뉘어 있으면 자동으로 줄이지 않음(화면에 '편성보다 많음' 표시, 관리자가 줄임)
--     확정만 취소한 동안에는 배정을 건드리지 않음. 기계화부가 이미 지정한 장비(지원일 1 경로)는 지우지 않음('배정 초과' 표시).
--  * 거절 번호: SA006 편성보다 많은 배정
--  * 시험: supabase/tests/saved_alloc_test.sql
-- ============================================================

-- ① 저장 완료
alter table public.round_requests add column if not exists saved_at timestamptz;
alter table public.round_requests add column if not exists saved_by uuid;
comment on column public.round_requests.saved_at is '지사·본부 계정이 이 줄을 저장한 마지막 시각(0이어도 저장하면 남음) — 화면의 저장 완료';

create or replace function public.save_requests(p_round bigint, p_rows jsonb) returns jsonb
language plpgsql set search_path = ''
as $$
declare r jsonb; c int; n int := 0; b text;
        sv boolean := not (select private.has_perm('req.confirm'));     -- 지사·본부 계정의 저장이면 '저장 완료'로 남김
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
        wx_ef           = case when r ? 'wx_ef'           then (r ->> 'wx_ef')::timestamptz             else q.wx_ef end,
        saved_at        = case when sv then now() else q.saved_at end,
        saved_by        = case when sv then (select auth.uid()) else q.saved_by end
      where q.round_id = p_round and q.branch_id = b;
      get diagnostics c = row_count;
      if c = 0 then raise exception 'row not allowed: %', b using errcode = '42501'; end if;
    else
      insert into public.round_requests (round_id, branch_id, req_truck, req_blower, assigned_truck, assigned_blower, offer_truck, arrive_at, reason, confirmed,
                                         wx_manual, wx_snow, wx_pcp, wx_tmin, wx_tmin_at, wx_level, wx_fc, wx_ef, saved_at, saved_by)
      values (p_round, b,
              coalesce((r ->> 'req_truck')::int, 0), coalesce((r ->> 'req_blower')::int, 0),
              coalesce((r ->> 'assigned_truck')::int, 0), coalesce((r ->> 'assigned_blower')::int, 0), coalesce((r ->> 'offer_truck')::int, 0),
              (r ->> 'arrive_at')::timestamptz, nullif(r ->> 'reason', ''), coalesce((r ->> 'confirmed')::boolean, false),
              coalesce((r ->> 'wx_manual')::boolean, false), (r ->> 'wx_snow')::double precision, (r ->> 'wx_pcp')::double precision,
              (r ->> 'wx_tmin')::double precision, (r ->> 'wx_tmin_at')::timestamptz,
              nullif(r ->> 'wx_level', ''), (r ->> 'wx_fc')::timestamptz, (r ->> 'wx_ef')::timestamptz,
              case when sv then now() end, case when sv then (select auth.uid()) end);
    end if;
    n := n + 1;
  end loop;
  return jsonb_build_object('rows', n);
end $$;

-- ② 기관별 배정 저장: 그 지사의 배정 합계가 편성을 넘으면 거절(이미 넘어 있던 것을 줄이는 저장은 받음)
create or replace function public.save_allocations(p_round bigint, p_rows jsonb) returns jsonb
language plpgsql set search_path = ''
as $$
declare r jsonb; c int; nu int := 0; nd int := 0; t int; bl int; br text; bef jsonb; st int; sb int; qt int; qb int;
begin
  if jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows) = 0 then raise exception 'nothing to save' using errcode = '22023'; end if;
  if jsonb_array_length(p_rows) > 2000 then raise exception 'too many rows' using errcode = '54000'; end if;
  if not exists (select 1 from public.support_rounds where id = p_round) then raise exception 'unknown round' using errcode = '23503'; end if;
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
  if nu + nd = 0 and not (select private.has_perm('equip.edit.all')) then raise exception 'not allowed' using errcode = '42501'; end if;
  for br in select distinct e ->> 'branch_id' from jsonb_array_elements(p_rows) e loop
    select coalesce(sum(a.truck), 0), coalesce(sum(a.blower), 0) into st, sb from public.round_allocations a where a.round_id = p_round and a.branch_id = br;
    select coalesce(max(q.assigned_truck), 0), coalesce(max(q.assigned_blower), 0) into qt, qb from public.round_requests q where q.round_id = p_round and q.branch_id = br;
    if (st > qt and st > coalesce((bef -> br ->> 0)::int, 0)) or (sb > qb and sb > coalesce((bef -> br ->> 1)::int, 0)) then
      raise exception 'allocation exceeds the assigned number' using errcode = 'SA006';
    end if;
  end loop;
  return jsonb_build_object('saved', nu, 'deleted', nd);
end $$;
revoke all on function public.save_allocations(bigint, jsonb) from public, anon;
grant execute on function public.save_allocations(bigint, jsonb) to authenticated;

-- ③ 편성이 확정되면 배정이 따라감
create or replace function private.alloc_follow_assign() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare n int; s int;
begin
  -- 제설차
  select count(*) filter (where a.truck > 0), coalesce(sum(a.truck), 0) into n, s from public.round_allocations a where a.round_id = new.round_id and a.branch_id = new.branch_id;
  if s > new.assigned_truck then
    if new.assigned_truck = 0 then
      delete from public.round_allocations a where a.round_id = new.round_id and a.branch_id = new.branch_id and a.truck > 0 and a.blower = 0;
      update public.round_allocations a set truck = 0 where a.round_id = new.round_id and a.branch_id = new.branch_id and a.truck > 0;
    elsif n = 1 then
      update public.round_allocations a set truck = new.assigned_truck where a.round_id = new.round_id and a.branch_id = new.branch_id and a.truck > 0;
    end if;
  end if;
  -- 제설기
  select count(*) filter (where a.blower > 0), coalesce(sum(a.blower), 0) into n, s from public.round_allocations a where a.round_id = new.round_id and a.branch_id = new.branch_id;
  if s > new.assigned_blower then
    if new.assigned_blower = 0 then
      delete from public.round_allocations a where a.round_id = new.round_id and a.branch_id = new.branch_id and a.blower > 0 and a.truck = 0;
      update public.round_allocations a set blower = 0 where a.round_id = new.round_id and a.branch_id = new.branch_id and a.blower > 0;
    elsif n = 1 then
      update public.round_allocations a set blower = new.assigned_blower where a.round_id = new.round_id and a.branch_id = new.branch_id and a.blower > 0;
    end if;
  end if;
  return null;
end $$;
revoke all on function private.alloc_follow_assign() from public, anon;
drop trigger if exists zz_round_requests_alloc_follow_ins on public.round_requests;
create trigger zz_round_requests_alloc_follow_ins after insert on public.round_requests
  for each row when (new.confirmed) execute function private.alloc_follow_assign();
drop trigger if exists zz_round_requests_alloc_follow_upd on public.round_requests;
create trigger zz_round_requests_alloc_follow_upd after update of confirmed on public.round_requests
  for each row when (new.confirmed and not old.confirmed) execute function private.alloc_follow_assign();
