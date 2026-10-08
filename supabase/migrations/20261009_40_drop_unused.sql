-- ============================================================
-- 40. 안 쓰는 DB 표·칸 정리 (2026-10-09 사용자 결정 '지워', Claude Code)
--  * 지우는 것(모두 비어 있음을 실서버에서 확인: 두 표 0줄, 두 칸은 값이 든 줄 0):
--      - 표 public.warnings_history (특보 지난 기록 — 24 이후 아무도 안 씀)
--      - 표 public.cell_zone       (격자→특보구역 — 특보를 구역 이름으로 맞추게 바뀐 뒤 안 씀)
--      - 칸 round_requests.snow_cm·warning (예전 '예상 적설'·'특보' 손입력 — 지금은 wx_*·warn_* 칸을 씀)
--  * 위 두 칸을 읽던 save_requests·round_requests_guard 를 그 칸 없이 다시 만든 뒤 지움.
--    (save_requests 는 snow_cm·warning 을 보내도 그냥 무시 — 예전 화면이 캐시에 남아 있어도 저장은 됨)
--  * 지난 수정 기록(변경 이력)에 남은 snow_cm·warning 항목은 건드리지 않음(화면은 '예상 적설'·'특보'로 계속 보임).
--  * 남기는 것: private.warn_needed() — 늘 true 지만 특보·예보 수집 7곳이 쓰는 '켜고 끄는 스위치'라 그대로 둠.
--    vehicles.status — 채팅 쪽이 남은 일로 잡아 둔 것(번호는 41 로).
-- ============================================================
create or replace function private.round_requests_guard() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and (new.round_id, new.branch_id) is distinct from (old.round_id, old.branch_id) then
    raise exception 'round_id/branch_id cannot be changed' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and old.confirmed
     and (new.req_truck, new.req_blower, new.assigned_truck, new.assigned_blower, new.arrive_at, new.reason,
          new.wx_manual, new.wx_snow, new.wx_pcp, new.wx_tmin, new.wx_tmin_at, new.wx_level, new.wx_fc, new.wx_ef)
         is distinct from
         (old.req_truck, old.req_blower, old.assigned_truck, old.assigned_blower, old.arrive_at, old.reason,
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
      insert into public.round_requests (round_id, branch_id, req_truck, req_blower, assigned_truck, assigned_blower, arrive_at, reason, confirmed,
                                         wx_manual, wx_snow, wx_pcp, wx_tmin, wx_tmin_at, wx_level, wx_fc, wx_ef)
      values (p_round, b,
              coalesce((r ->> 'req_truck')::int, 0), coalesce((r ->> 'req_blower')::int, 0),
              coalesce((r ->> 'assigned_truck')::int, 0), coalesce((r ->> 'assigned_blower')::int, 0),
              (r ->> 'arrive_at')::timestamptz, nullif(r ->> 'reason', ''), coalesce((r ->> 'confirmed')::boolean, false),
              coalesce((r ->> 'wx_manual')::boolean, false), (r ->> 'wx_snow')::double precision, (r ->> 'wx_pcp')::double precision,
              (r ->> 'wx_tmin')::double precision, (r ->> 'wx_tmin_at')::timestamptz,
              nullif(r ->> 'wx_level', ''), (r ->> 'wx_fc')::timestamptz, (r ->> 'wx_ef')::timestamptz);
    end if;
    n := n + 1;
  end loop;
  return jsonb_build_object('rows', n);
end $$;

alter table public.round_requests drop column snow_cm, drop column warning;
drop table public.warnings_history;
drop table public.cell_zone;
