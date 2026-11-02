-- ============================================================
-- 50. 지사 요청 줄 '누가 저장했는지' — 지사저장 / 본부저장 / 본사저장 (2026-11-02 사용자 결정, Claude 채팅)
--  · round_requests.saved_lv : 'branch'(지사 계정) | 'hq'(본부 계정, req.edit.hq) | 'admin'(관리자, req.confirm). 마지막에 저장한 쪽.
--  · 관리자 저장도 이제 '저장'으로 침(사용자 결정: 본사저장도 저장) → saved_at·saved_by·saved_lv 를 남김.
--    단, 확정·확정 취소만 한 줄(confirmed 가 있고 branch_id 말고 다른 칸이 없음)은 저장으로 치지 않음 → 예전 저장 표시가 그대로 남음.
--    고친 것 없이 [저장](branch_id 만)은 예전처럼 저장.
--  · 예전 줄(saved_at 있음, saved_lv 없음)은 저장한 계정의 역할로 채움(hq → 'hq', 나머지 → 'branch').
--  · 화면: 지사별 요청·편성 [저장] 칸에 '지사저장'·'본부저장'·'본사저장', [저장안함] 보기 = saved_at 없음.
--  * 시험: supabase/tests/saved_lv_test.sql
-- ============================================================
alter table public.round_requests add column if not exists saved_lv text;
alter table public.round_requests drop constraint if exists round_requests_saved_lv_check;
alter table public.round_requests add constraint round_requests_saved_lv_check check (saved_lv is null or saved_lv in ('branch', 'hq', 'admin'));
comment on column public.round_requests.saved_at is '이 줄을 마지막으로 저장한 시각(0이어도 저장하면 남음, 확정·취소만은 아님) — 화면의 지사저장/본부저장/본사저장';
comment on column public.round_requests.saved_lv is '마지막으로 저장한 쪽: branch = 지사저장, hq = 본부저장, admin = 본사저장';

update public.round_requests q set saved_lv = case when p.role = 'hq' then 'hq' when p.role = 'admin' then 'admin' else 'branch' end
  from public.profiles p where q.saved_at is not null and q.saved_lv is null and p.id = q.saved_by;
update public.round_requests q set saved_lv = 'branch' where q.saved_at is not null and q.saved_lv is null;

create or replace function public.save_requests(p_round bigint, p_rows jsonb) returns jsonb
language plpgsql set search_path = ''
as $$
declare r jsonb; c int; n int := 0; b text; sv boolean;
        lv text := case when (select private.has_perm('req.confirm')) then 'admin'      -- 누가 저장했는지: 관리자 = 본사저장
                        when (select private.has_perm('req.edit.hq')) then 'hq'          -- 본부 계정 = 본부저장
                        else 'branch' end;                                               -- 지사 계정 = 지사저장
begin
  if jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows) = 0 then raise exception 'nothing to save' using errcode = '22023'; end if;
  if jsonb_array_length(p_rows) > 500 then raise exception 'too many rows' using errcode = '54000'; end if;
  if not exists (select 1 from public.support_rounds s where s.id = p_round) then raise exception 'unknown round' using errcode = '23503'; end if;
  for r in select * from jsonb_array_elements(p_rows) loop
    if jsonb_typeof(r) is distinct from 'object' or not (r ? 'branch_id') then raise exception 'bad row' using errcode = '22023'; end if;
    b := r ->> 'branch_id';
    sv := not (r ? 'confirmed') or exists (select 1 from jsonb_object_keys(r) k where k not in ('branch_id', 'confirmed'));   -- 확정·확정 취소만 한 줄은 저장으로 치지 않음(고친 것 없이 [저장]은 저장)
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
        saved_by        = case when sv then (select auth.uid()) else q.saved_by end,
        saved_lv        = case when sv then lv else q.saved_lv end
      where q.round_id = p_round and q.branch_id = b;
      get diagnostics c = row_count;
      if c = 0 then raise exception 'row not allowed: %', b using errcode = '42501'; end if;
    else
      insert into public.round_requests (round_id, branch_id, req_truck, req_blower, assigned_truck, assigned_blower, offer_truck, arrive_at, reason, confirmed,
                                         wx_manual, wx_snow, wx_pcp, wx_tmin, wx_tmin_at, wx_level, wx_fc, wx_ef, saved_at, saved_by, saved_lv)
      values (p_round, b,
              coalesce((r ->> 'req_truck')::int, 0), coalesce((r ->> 'req_blower')::int, 0),
              coalesce((r ->> 'assigned_truck')::int, 0), coalesce((r ->> 'assigned_blower')::int, 0), coalesce((r ->> 'offer_truck')::int, 0),
              (r ->> 'arrive_at')::timestamptz, nullif(r ->> 'reason', ''), coalesce((r ->> 'confirmed')::boolean, false),
              coalesce((r ->> 'wx_manual')::boolean, false), (r ->> 'wx_snow')::double precision, (r ->> 'wx_pcp')::double precision,
              (r ->> 'wx_tmin')::double precision, (r ->> 'wx_tmin_at')::timestamptz,
              nullif(r ->> 'wx_level', ''), (r ->> 'wx_fc')::timestamptz, (r ->> 'wx_ef')::timestamptz,
              case when sv then now() end, case when sv then (select auth.uid()) end, case when sv then lv end);
    end if;
    n := n + 1;
  end loop;
  return jsonb_build_object('rows', n);
end $$;

revoke all on function public.save_requests(bigint, jsonb) from public, anon;
grant execute on function public.save_requests(bigint, jsonb) to authenticated;
