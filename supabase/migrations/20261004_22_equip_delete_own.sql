-- 지원장비 계정(각 지역본부 장비 담당, equip.edit.own)도 자기 기관 장비를 삭제할 수 있게(사용자 결정 2026-10-04)
-- 장비를 지우면 그 장비의 날짜별 경로도 함께 지워짐(지운 내용은 수정 기록에 남음)
drop policy if exists vehicles_del on public.vehicles;
create policy vehicles_del on public.vehicles for delete to authenticated
  using ((select private.has_perm('equip.edit.all')) or ((select private.has_perm('equip.edit.own')) and org = (select private.my_org())));
update public.permissions set label = '자기 기관 장비 추가·삭제·도공번호·지원 여부·도착 시각',
  description = '장비 지원 > 기관별 장비에서 자기 출발 기관 장비를 추가·삭제하고 도공번호·지원 여부, 정해진 경로의 도착 예상 시각을 고침(경로 지사는 관리자)' where key = 'equip.edit.own';
