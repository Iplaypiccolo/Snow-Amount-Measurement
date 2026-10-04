-- ============================================================
-- 세부 권한(2단계): 역할(묶음) + 계정마다 켜고 끄는 권한
--  * 역할: admin(관리자, 모든 권한) / branch(지사) / equip(지원장비 — 출발 기관에 묶임) / hq(지역본부 — 본부에 묶임) / viewer(보기 전용)
--  * 권한 목록은 표 permissions 에 있고(화면이 읽어 체크칸을 그림), 계정의 perms 배열에 켠 권한만 들어 있음. 관리자는 perms 와 관계없이 모든 권한.
--  * 서버 규칙(RLS)은 이제 역할이 아니라 private.has_perm('권한') 으로 검사한다.
--  * 관리자 계정을 새로 만드는 기능은 두지 않는다(사용자 결정 2026-10-04). 계정 관리(accounts)는 관리자 역할 전용.
-- ============================================================

-- 1) 권한 목록
create table if not exists public.permissions (
  key text primary key check (key ~ '^[a-z]+(\.[a-z]+)+$'),
  label text not null, description text not null default '',
  default_roles text[] not null default '{}',          -- 이 역할로 계정을 만들면 기본으로 켜지는 권한
  sort integer not null
);
insert into public.permissions (key, label, description, default_roles, sort) values
  ('juris.request',  '관할 구간 변경 요청',        '관할 고속도로 탭에서 자기 지사 구간을 다른 기관으로 옮겨 달라고 요청',   '{branch}', 10),
  ('juris.edit',     '관할 변경 저장·요청 승인',    '관할 고속도로 탭에서 구간 이동·신설 기관·본부 이동을 저장하고 지사 요청을 승인·반려', '{}', 20),
  ('grid.edit',      '예보 격자 편입',             '예보 격자 편입 탭을 보고 칸 편입·제외를 저장',                         '{}', 30),
  ('snow.upload',    '적설 자료 올리기',           '관리 콘솔 적설 자료 탭에서 기상청 메모장 파일을 서버에 저장',            '{}', 40),
  ('req.edit.own',   '자기 지사 요청 입력',         '장비 지원 > 지사별 요청·편성에서 자기 지사 행의 요청을 입력',            '{branch}', 50),
  ('req.edit.hq',    '자기 본부 지사 요청 입력',     '장비 지원 > 지사별 요청·편성에서 자기 본부 모든 지사 행의 요청을 입력',    '{hq}', 60),
  ('req.confirm',    '요청 확정·편성·기준일자',      '장비 지원 > 지사별 요청·편성에서 기준일자를 만들고 편성 대수를 정하고 확정', '{}', 70),
  ('equip.edit.own', '자기 기관 장비·경로 입력',     '장비 지원 > 기관별 장비에서 자기 출발 기관 장비의 차량번호·지원 여부·날짜별 경로를 입력하고 확정', '{equip}', 80),
  ('equip.edit.all', '모든 기관 장비·경로 입력',     '모든 출발 기관 장비를 입력·확정하고, 장비를 추가·삭제하고, 지원일 1을 바꿈', '{}', 90),
  ('hq.supply.edit', '지역본부 지원 가능 장비 입력', '(준비 중) 지역본부 탭에서 지사별 지원 가능 장비를 입력',                 '{hq}', 100),
  ('log.view',       '접속·수정 기록 보기',          '관리 콘솔 접속 로그와 장비 지원 로그 기록, 수정 기록 말풍선',            '{}', 110)
on conflict (key) do update set label = excluded.label, description = excluded.description, default_roles = excluded.default_roles, sort = excluded.sort;
alter table public.permissions enable row level security;
create policy permissions_read on public.permissions for select to authenticated using ((select private.my_role()) is not null);
revoke insert, update, delete, truncate on public.permissions from authenticated;

-- 2) 출발 기관(장비 보유) 4곳
insert into public.equip_orgs (name) values ('서울경기'), ('충북'), ('전북'), ('대구경북') on conflict do nothing;

-- 3) 계정: 역할 추가, 권한·출발 기관·본부·목록 순서
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check check (role in ('admin','branch','equip','hq','viewer'));
alter table public.profiles add column if not exists perms  text[] not null default '{}';
alter table public.profiles add column if not exists org    text references public.equip_orgs(name);
alter table public.profiles add column if not exists hq_id  text references public.hqs(id);
alter table public.profiles add column if not exists sort   integer;
alter table public.profiles add constraint equip_role_needs_org check ((role = 'equip') = (org is not null));
alter table public.profiles add constraint hq_role_needs_hq   check ((role = 'hq') = (hq_id is not null));
create index if not exists profiles_org_idx on public.profiles(org);
create index if not exists profiles_hq_idx  on public.profiles(hq_id);

-- 권한 값은 목록에 있는 것만
create or replace function private.check_profile_perms() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if exists (select 1 from unnest(new.perms) p where not exists (select 1 from public.permissions x where x.key = p)) then
    raise exception 'unknown permission' using errcode = '23514';
  end if;
  return new;
end $$;
revoke all on function private.check_profile_perms() from public, anon;
create trigger check_profile_perms before insert or update of perms on public.profiles for each row execute function private.check_profile_perms();

-- 기존 지사 계정에 지사 기본 권한
update public.profiles set perms = array(select key from public.permissions where 'branch' = any(default_roles) order by sort)
 where role = 'branch' and perms = '{}';

-- 4) 권한 검사 함수 (관리자는 모든 권한)
create or replace function private.has_perm(p text) returns boolean
language sql stable security definer set search_path = ''
as $$ select exists (select 1 from public.profiles x where x.id = (select auth.uid()) and not x.disabled and not x.must_change and (x.role = 'admin' or p = any(x.perms))) $$;
create or replace function private.my_org() returns text
language sql stable security definer set search_path = ''
as $$ select x.org from public.profiles x where x.id = (select auth.uid()) and not x.disabled and not x.must_change $$;
create or replace function private.my_hq() returns text
language sql stable security definer set search_path = ''
as $$ select coalesce(x.hq_id, (select b.hq_id from public.branches b where b.id = x.branch_id)) from public.profiles x where x.id = (select auth.uid()) and not x.disabled and not x.must_change $$;
revoke all on function private.has_perm(text), private.my_org(), private.my_hq() from public, anon;
grant execute on function private.has_perm(text), private.my_org(), private.my_hq() to authenticated;

-- 5) 기존 규칙을 권한 검사로
-- 관할 변경 이력·격자 이력
drop policy if exists jurisdiction_events_ins on public.jurisdiction_events;
create policy jurisdiction_events_ins on public.jurisdiction_events for insert to authenticated with check ((select private.has_perm('juris.edit')));
drop policy if exists grid_events_ins on public.grid_events;
create policy grid_events_ins on public.grid_events for insert to authenticated with check ((select private.has_perm('grid.edit')));
-- 신설 기관 자동 등록: 관할 변경 권한만 있는 계정도 기관 목록(관리자 전용 표)에 넣을 수 있게 함수 권한으로 실행
alter function private.sync_branch_registry() security definer;

-- 구간 변경 요청
drop policy if exists jr_req_read on public.jurisdiction_requests;
create policy jr_req_read on public.jurisdiction_requests for select to authenticated
  using ((select private.has_perm('juris.edit')) or ((select private.has_perm('juris.request')) and branch_id = (select private.my_branch())));
drop policy if exists jr_req_ins on public.jurisdiction_requests;
create policy jr_req_ins on public.jurisdiction_requests for insert to authenticated
  with check ((select private.has_perm('juris.request')) and branch_id = (select private.my_branch()));
drop policy if exists jr_req_upd on public.jurisdiction_requests;
create policy jr_req_upd on public.jurisdiction_requests for update to authenticated
  using ((select private.has_perm('juris.edit')) or ((select private.has_perm('juris.request')) and branch_id = (select private.my_branch()) and requested_by = (select auth.uid())))
  with check ((select private.has_perm('juris.edit')) or ((select private.has_perm('juris.request')) and branch_id = (select private.my_branch())));
create or replace function private.jr_req_before_update() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare can_edit boolean := private.has_perm('juris.edit');
begin
  if (new.branch_id, new.section_ids, new.snapshot, new.to_branch_id, new.reason, new.requested_by, new.created_at)
     is distinct from (old.branch_id, old.section_ids, old.snapshot, old.to_branch_id, old.reason, old.requested_by, old.created_at) then
    raise exception 'request content cannot be changed' using errcode = '42501';
  end if;
  if old.status <> 'pending' then raise exception 'request already resolved' using errcode = '42501'; end if;
  if can_edit and new.status in ('approved','rejected') then null;
  elsif new.status = 'cancelled' and old.requested_by = (select auth.uid()) then new.resolution_note := null;
  else raise exception 'not allowed' using errcode = '42501'; end if;
  new.resolved_by := (select auth.uid()); new.resolved_at := now();
  return new;
end $$;

-- 기록 보기
drop policy if exists audit_log_read on public.audit_log;
create policy audit_log_read on public.audit_log for select to authenticated using ((select private.has_perm('log.view')));
-- 적설 업로드 기록
drop policy if exists snow_uploads_read on public.snow_uploads;
create policy snow_uploads_read on public.snow_uploads for select to authenticated using ((select private.has_perm('snow.upload')));
drop policy if exists snow_uploads_ins on public.snow_uploads;
create policy snow_uploads_ins on public.snow_uploads for insert to authenticated with check ((select private.has_perm('snow.upload')));
