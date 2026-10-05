-- ============================================================
-- 35. 확정한 지사 줄은 잠금 (2026-10-05 사용자 결정)
--  * 지사별 요청·편성에서 [확정]한 줄은 [취소]하기 전까지 요청·편성·도착 요청·기상현황 직접입력을 고칠 수 없음(관리자도)
--  * 확정 취소는 확정 열만 바꿔야 함(취소하면서 다른 값을 같이 바꾸는 것도 막음). 줄 지우기(기준일자 삭제)는 그대로
--  * 막히면 오류 코드 55000 → 화면 안내 "확정한 지사는 확정을 취소한 뒤에 고칠 수 있습니다"
-- ============================================================
create or replace function private.round_requests_guard() returns trigger
language plpgsql set search_path = ''
as $$
begin
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
