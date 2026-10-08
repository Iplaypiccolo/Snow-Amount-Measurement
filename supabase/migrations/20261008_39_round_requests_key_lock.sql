-- ============================================================
-- 39. 지사별 요청·편성 줄의 이름표(기준일자 round_id·지사 branch_id)는 누구도 바꿀 수 없음 (2026-10-08 사용자 결정, Claude Code)
--  * 코드 검토에서 찾은 권한 구멍: 확정 잠금(35)이 이름표 칸을 막지 않아, 확정 권한이 없는 지사 계정이 확정된 줄을
--    다른 기준일자로, 본부 계정이 같은 본부 다른 지사로 옮겨 '관리자 확정 없이 확정된 줄'을 만들 수 있었음(실서버 되돌리기 시험으로 확인)
--  * 관리자 포함 전부 막음(사용자 결정): 화면 어디에서도 이름표를 바꾸지 않고, 옮기면 확정 때 남긴 그 지사의 특보·예보 값이
--    다른 지사에 붙고 수정 기록이 끊김. 잘못 넣은 줄은 취소·지우고 맞는 지사 줄에 새로 넣으면 됨
--  * 시험: supabase/tests/confirm_lock_test.sql (실서버 되돌리기 시험 13/13)
--  * 참고: 채팅 쪽 handoff 의 '남은 일 — vehicles.status 삭제(migration 39)'는 번호가 겹치므로 40 으로
-- ============================================================
create or replace function private.round_requests_guard() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and (new.round_id, new.branch_id) is distinct from (old.round_id, old.branch_id) then
    raise exception 'round_id/branch_id cannot be changed' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and old.confirmed
     and (new.snow_cm, new.warning, new.req_truck, new.req_blower, new.assigned_truck, new.assigned_blower, new.arrive_at, new.reason,
          new.wx_manual, new.wx_snow, new.wx_pcp, new.wx_tmin, new.wx_tmin_at, new.wx_level, new.wx_fc, new.wx_ef)
         is distinct from
         (old.snow_cm, old.warning, old.req_truck, old.req_blower, old.assigned_truck, old.assigned_blower, old.arrive_at, old.reason,
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
