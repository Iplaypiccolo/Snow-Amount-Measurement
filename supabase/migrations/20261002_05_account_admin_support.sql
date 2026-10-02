-- ============================================================
-- 계정 관리 지원
--  * admin_revoke_sessions: 비활성화·비밀번호 초기화 때 그 계정의 모든 로그인을 끊는 함수 (서버 함수(service_role)만 호출 가능)
--  * credentials: 임시 비밀번호 CSV 를 담는 "비공개" 저장소. 로그인 사용자·비로그인은 접근할 수 없고 대시보드(소유자)와 서버 함수만 읽음
-- ============================================================
create or replace function public.admin_revoke_sessions(uid uuid) returns void
language sql security definer set search_path = ''
as $$ delete from auth.sessions where user_id = uid $$;
revoke all on function public.admin_revoke_sessions(uuid) from public, anon, authenticated;
grant execute on function public.admin_revoke_sessions(uuid) to service_role;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('credentials', 'credentials', false, 1048576, array['text/csv'])
on conflict (id) do nothing;
