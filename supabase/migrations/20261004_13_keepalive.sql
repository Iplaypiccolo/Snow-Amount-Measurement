-- ============================================================
-- 서버 깨우기용 함수: 무료 플랜은 1주일 동안 쓰지 않으면 자동 정지되므로, GitHub Actions 가 주 2회 이 함수를 부른다.
--  * 비밀값 없이(공개 키만으로) 부를 수 있도록 비로그인(anon)에게도 실행을 허용한다.
--  * 하는 일은 "지금 시각을 돌려주기"뿐이다. 어떤 표도 읽거나 쓰지 않으므로 드러나는 자료가 없다.
-- ============================================================
create or replace function public.keepalive() returns timestamptz
language sql stable security invoker set search_path = ''
as $$ select now() $$;
revoke all on function public.keepalive() from public;
grant execute on function public.keepalive() to anon, authenticated;
