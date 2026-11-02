-- ============================================================
-- 56. [확정] 때 값이 바뀌었는지 확인 + 지사·본부 첫 저장 충돌 해결 (2026-11-03 사용자 요청)
--  ① 확정: 화면이 줄과 함께 '내가 본 수정 시각'(expect_at)을 보냄 → 그사이 누가 고쳤으면 SA007 로 거절(묶음이면 전부 취소), 화면이 다시 읽음.
--     expect_at 을 보내지 않으면 예전과 같음(지사·본부 저장, 열어 둔 옛 화면). 줄을 잠그고 비교하므로 동시에 눌려도 어긋나지 않음
--  ② 첫 저장: 그 기준일자에 그 지사 줄이 아직 없을 때 동시에 저장하면 한쪽이 23505 로 실패하던 것 → 한쪽이 먼저 만들면 다른 쪽은 그 줄을 수정
--  ③ 돌려주는 값에 versions(지사 → 저장 뒤 수정 시각)를 더함 → 화면이 자기 저장 뒤의 수정 시각을 알아 다음 확정이 잘못 거절되지 않음
--  표·권한 규칙(RLS)·트리거는 그대로. 함수 본문은 서버에 있던 그대로에서 위 세 가지만 바꿈
--  * 시험: supabase/tests/save_requests_expect_test.sql
-- ============================================================
create or replace function public.save_requests(p_round bigint, p_rows jsonb)
 returns jsonb
 language plpgsql
 set search_path to ''
as $function$
declare r jsonb; c int; n int := 0; b text; sv boolean; cur timestamptz; upd timestamptz; vers jsonb := '{}'::jsonb;
        lv text := case when (select private.has_perm('req.confirm')) then 'admin'
                        when (select private.has_perm('req.edit.hq')) then 'hq'
                        else 'branch' end;
begin
  if jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows) = 0 then raise exception 'nothing to save' using errcode = '22023'; end if;
  if jsonb_array_length(p_rows) > 500 then raise exception 'too many rows' using errcode = '54000'; end if;
  if not exists (select 1 from public.support_rounds s where s.id = p_round) then raise exception 'unknown round' using errcode = '23503'; end if;
  for r in select * from jsonb_array_elements(p_rows) loop
    if jsonb_typeof(r) is distinct from 'object' or not (r ? 'branch_id') then raise exception 'bad row' using errcode = '22023'; end if;
    b := r ->> 'branch_id';
    sv := not (r ? 'confirmed') or exists (select 1 from jsonb_object_keys(r) k where k not in ('branch_id', 'confirmed', 'expect_at'));
    <<one_row>>
    loop
      if exists (select 1 from public.round_requests q where q.round_id = p_round and q.branch_id = b) then
        if r ? 'expect_at' then                                -- ① 확정: 내가 본 뒤로 바뀌었으면 거절(줄을 잠그고 비교)
          select q.updated_at into cur from public.round_requests q where q.round_id = p_round and q.branch_id = b for update;
          if cur is distinct from (r ->> 'expect_at')::timestamptz then raise exception 'row changed: %', b using errcode = 'SA007'; end if;
        end if;
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
        where q.round_id = p_round and q.branch_id = b
        returning q.updated_at into upd;
        get diagnostics c = row_count;
        if c = 0 then raise exception 'row not allowed: %', b using errcode = '42501'; end if;
        exit one_row;
      end if;
      if (r ->> 'expect_at') is not null then raise exception 'row changed: %', b using errcode = 'SA007'; end if;     -- 내가 본 줄이 사라짐
      begin
        insert into public.round_requests as q (round_id, branch_id, req_truck, req_blower, assigned_truck, assigned_blower, offer_truck, arrive_at, reason, confirmed,
                                           wx_manual, wx_snow, wx_pcp, wx_tmin, wx_tmin_at, wx_level, wx_fc, wx_ef, saved_at, saved_by, saved_lv)
        values (p_round, b,
                coalesce((r ->> 'req_truck')::int, 0), coalesce((r ->> 'req_blower')::int, 0),
                coalesce((r ->> 'assigned_truck')::int, 0), coalesce((r ->> 'assigned_blower')::int, 0), coalesce((r ->> 'offer_truck')::int, 0),
                (r ->> 'arrive_at')::timestamptz, nullif(r ->> 'reason', ''), coalesce((r ->> 'confirmed')::boolean, false),
                coalesce((r ->> 'wx_manual')::boolean, false), (r ->> 'wx_snow')::double precision, (r ->> 'wx_pcp')::double precision,
                (r ->> 'wx_tmin')::double precision, (r ->> 'wx_tmin_at')::timestamptz,
                nullif(r ->> 'wx_level', ''), (r ->> 'wx_fc')::timestamptz, (r ->> 'wx_ef')::timestamptz,
                case when sv then now() end, case when sv then (select auth.uid()) end, case when sv then lv end)
        returning q.updated_at into upd;
        exit one_row;
      exception when unique_violation then
        null;                                                  -- ② 다른 사람이 방금 이 줄을 만듦 → 위로 돌아가 그 줄을 수정(확정이면 SA007)
      end;
    end loop;
    vers := vers || jsonb_build_object(b, upd);
    n := n + 1;
  end loop;
  return jsonb_build_object('rows', n, 'versions', vers);
end $function$;
