-- ============================================================
-- 66. 지원 여부 = 빈칸 · 지원만 (2026-11-04 사용자 요청, Claude Code)
--  · 기관별 장비·강원 신속대응팀: '지원 불가'(X)·'정비중'(M)과 '지원 불가(이날부터)'(off_from) 없앰
--  · 적용 전 서버 자료: round_vehicle_status 빈칸 5·지원 6, gw_team_status 빈칸 4, off_from 있는 줄 0 → 바꿀 자료 없음
--  · 함수(save_fleet·save_gw_team·create_round 등)는 그대로 — 표의 규칙(check)이 X·M·off_from 을 막음(오류 23514)
-- ============================================================
alter table public.round_vehicle_status drop constraint if exists round_vehicle_status_status_check;
alter table public.round_vehicle_status add constraint round_vehicle_status_status_check check (status in ('', 'O'));
alter table public.round_vehicle_status add constraint round_vehicle_status_no_off check (off_from is null);
alter table public.gw_team_status drop constraint if exists gw_team_status_status_check;
alter table public.gw_team_status add constraint gw_team_status_status_check check (status in ('', 'O'));
alter table public.gw_team_status add constraint gw_team_status_no_off check (off_from is null);
