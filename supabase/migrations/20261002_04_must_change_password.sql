-- ============================================================
-- 임시 비밀번호(must_change) 지원
--  * 관리자가 임시 비밀번호로 계정을 만들거나 초기화하면 must_change = true
--  * must_change 인 동안은 "내 계정 정보 보기"를 빼고 아무 자료도 읽거나 쓸 수 없음 (my_role/my_branch 가 비어 있게 됨)
--  * 사용자가 비밀번호를 바꾸면(Supabase Auth 가 auth.users.encrypted_password 를 바꿀 때) DB 트리거가 자동으로 해제
--  * 사용자는 본인 must_change 를 스스로 해제할 수 없음 (profiles 수정은 관리자만)
-- ============================================================
alter table public.profiles add column must_change boolean not null default false;

create or replace function private.my_role() returns text
language sql stable security definer set search_path = ''
as $$ select p.role from public.profiles p where p.id = (select auth.uid()) and not p.disabled and not p.must_change $$;

create or replace function private.my_branch() returns text
language sql stable security definer set search_path = ''
as $$ select p.branch_id from public.profiles p where p.id = (select auth.uid()) and not p.disabled and not p.must_change $$;

create or replace function private.clear_must_change() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.encrypted_password is distinct from old.encrypted_password then
    update public.profiles set must_change = false where id = new.id and must_change;
  end if;
  return new;
end $$;
revoke all on function private.clear_must_change() from public, anon, authenticated;

create trigger on_auth_user_password_changed
  after update of encrypted_password on auth.users
  for each row execute function private.clear_must_change();
