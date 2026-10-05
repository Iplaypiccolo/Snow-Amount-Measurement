-- ============================================================
-- 33. 지사별 요청·편성: 기상현황 직접입력 (2026-10-05 사용자 결정)
--  * 적설·강수·대설특보가 제때 들어오지 않았을 수 있어 지사가 직접 넣을 수 있게. [기상현황 직접입력] 체크칸을 켜면
--    화면은 자동 값 대신 직접 넣은 값(wx_*)을 보이고, 확정해도 그대로 남음(자동 값 고정 warn_*·fc_* 는 지금처럼 따로 남음)
--  * 고칠 수 있는 사람은 지사 요청과 같음(save_requests 를 부른 사람 권한 = RLS·round_requests_guard)
-- ============================================================
alter table public.round_requests
  add column if not exists wx_manual boolean not null default false,
  add column if not exists wx_snow  double precision check (wx_snow is null or (wx_snow >= 0 and wx_snow <= 999)),   -- 적설 cm
  add column if not exists wx_pcp   double precision check (wx_pcp is null or (wx_pcp >= 0 and wx_pcp <= 999)),     -- 강수 mm
  add column if not exists wx_level text check (wx_level is null or wx_level in ('예비', '주의', '경보')),            -- 대설특보 단계(없으면 null)
  add column if not exists wx_fc    timestamptz,                                                                       -- 특보 발표 시각
  add column if not exists wx_ef    timestamptz;                                                                       -- 특보 발효 시각

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
        snow_cm         = case when r ? 'snow_cm'         then (r ->> 'snow_cm')::double precision      else q.snow_cm end,
        warning         = case when r ? 'warning'         then coalesce((r ->> 'warning')::boolean, false) else q.warning end,
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
        wx_level        = case when r ? 'wx_level'        then nullif(r ->> 'wx_level', '')              else q.wx_level end,
        wx_fc           = case when r ? 'wx_fc'           then (r ->> 'wx_fc')::timestamptz             else q.wx_fc end,
        wx_ef           = case when r ? 'wx_ef'           then (r ->> 'wx_ef')::timestamptz             else q.wx_ef end
      where q.round_id = p_round and q.branch_id = b;
      get diagnostics c = row_count;
      if c = 0 then raise exception 'row not allowed: %', b using errcode = '42501'; end if;
    else
      insert into public.round_requests (round_id, branch_id, snow_cm, warning, req_truck, req_blower, assigned_truck, assigned_blower, arrive_at, reason, confirmed,
                                         wx_manual, wx_snow, wx_pcp, wx_level, wx_fc, wx_ef)
      values (p_round, b, (r ->> 'snow_cm')::double precision, coalesce((r ->> 'warning')::boolean, false),
              coalesce((r ->> 'req_truck')::int, 0), coalesce((r ->> 'req_blower')::int, 0),
              coalesce((r ->> 'assigned_truck')::int, 0), coalesce((r ->> 'assigned_blower')::int, 0),
              (r ->> 'arrive_at')::timestamptz, nullif(r ->> 'reason', ''), coalesce((r ->> 'confirmed')::boolean, false),
              coalesce((r ->> 'wx_manual')::boolean, false), (r ->> 'wx_snow')::double precision, (r ->> 'wx_pcp')::double precision,
              nullif(r ->> 'wx_level', ''), (r ->> 'wx_fc')::timestamptz, (r ->> 'wx_ef')::timestamptz);
    end if;
    n := n + 1;
  end loop;
  return jsonb_build_object('rows', n);
end $$;
