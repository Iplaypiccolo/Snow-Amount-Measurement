-- ============================================================
-- 관할 변경 저장 + 지사 요청 승인을 "한 번에" (전부 성공하거나 전부 취소)
--  * 예전: ① 변경 이력 저장 → ② 요청 승인 을 따로 불러서, ②만 실패하면 이동은 됐는데 요청이 '대기'로 남았다.
--  * 이제: 화면이 이 함수 하나를 부른다. 승인할 요청 중 하나라도 이미 처리(취소·반려·승인)됐으면
--    변경도 저장하지 않고 오류를 돌려준다 → 관리자가 새로고침해서 최신 요청 상태를 보고 다시 판단.
--  * 권한은 그대로 DB 가 검사한다(security invoker): 이력 추가·요청 승인 모두 관리자만(RLS·트리거).
-- ============================================================
create or replace function public.save_jurisdiction(p_events jsonb, p_approve bigint[] default '{}', p_note text default null) returns jsonb
language plpgsql security invoker set search_path = ''
as $$
declare n_ev int; n_ap int; want int;
begin
  if jsonb_typeof(p_events) <> 'array' or jsonb_array_length(p_events) = 0 then raise exception 'no events' using errcode = '22023'; end if;
  insert into public.jurisdiction_events (kind, payload, note)
    select x.kind, x.payload, x.note from jsonb_to_recordset(p_events) as x(kind text, payload jsonb, note text);
  get diagnostics n_ev = row_count;
  want := (select count(distinct a) from unnest(coalesce(p_approve, '{}')) a);
  if want > 0 then
    update public.jurisdiction_requests set status = 'approved', resolution_note = coalesce(p_note, '관할 변경 저장 시 승인')
      where id = any(p_approve) and status = 'pending';
    get diagnostics n_ap = row_count;
    if n_ap <> want then raise exception 'request_not_pending' using errcode = '55000', hint = '승인하려던 요청 중 이미 처리된 것이 있습니다.'; end if;
  else n_ap := 0;
  end if;
  return jsonb_build_object('events', n_ev, 'approved', n_ap);
end $$;
revoke all on function public.save_jurisdiction(jsonb, bigint[], text) from public, anon;
grant execute on function public.save_jurisdiction(jsonb, bigint[], text) to authenticated;
