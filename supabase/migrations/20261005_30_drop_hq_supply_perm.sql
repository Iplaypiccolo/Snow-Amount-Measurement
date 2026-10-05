-- ============================================================
-- 30. 쓰이지 않는 권한 'hq.supply.edit'(지역본부 지원 가능 장비 입력, 준비 중이던 지역본부 탭용) 없앰 (2026-10-05 사용자 결정)
--  * 계정에서 먼저 빼고(수정 기록에 남음) 권한 목록에서 지움. 나중에 지역본부 탭을 만들면 그때 다시 만듦
-- ============================================================
update public.profiles set perms = array_remove(perms, 'hq.supply.edit') where 'hq.supply.edit' = any(perms);
delete from public.permissions where key = 'hq.supply.edit';
