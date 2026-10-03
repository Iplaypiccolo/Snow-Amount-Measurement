-- ============================================================
-- 구간 변경 요청 (피지원지사 → 관리자)
--  * 지사가 "이 구간을 다른 기관으로 옮겨 달라"고 관리자에게 요청하고, 관리자가 승인/반려한다.
--  * 요청 지사·작성자·상태는 DB 가 정함(화면이 속일 수 없음). 지사 계정만 요청할 수 있고, 자기 지사의 요청만 읽는다. 관리자는 모두 읽고 처리한다.
--  * 구간 번호(S0001…)는 아직 파일(data/sections.json)에 있어서 외래키 없이 형식만 검사하고, 요청 시점의 구간 정보를 snapshot 으로 함께 저장한다.
-- ============================================================
create table public.jurisdiction_requests (
  id              bigint generated always as identity primary key,
  created_at      timestamptz not null default now(),
  requested_by    uuid,
  branch_id       text not null references public.branches(id),
  section_ids     text[] not null
                  check (cardinality(section_ids) between 1 and 60 and array_to_string(section_ids, ',') ~ '^S[0-9]{4}(,S[0-9]{4})*$'),
  snapshot        jsonb not null default '[]'::jsonb check (jsonb_typeof(snapshot) = 'array' and jsonb_array_length(snapshot) <= 60),
  to_branch_id    text references public.branches(id),            -- 요청한 도착 지사 (null = 관리자가 정해 달라)
  reason          text check (reason is null or length(reason) <= 200),
  status          text not null default 'pending' check (status in ('pending','approved','rejected','cancelled')),
  resolved_by     uuid,
  resolved_at     timestamptz,
  resolution_note text check (resolution_note is null or length(resolution_note) <= 200)
);
create index jurisdiction_requests_status_idx on public.jurisdiction_requests(status, id);
create index jurisdiction_requests_branch_idx on public.jurisdiction_requests(branch_id);
create index jurisdiction_requests_to_idx     on public.jurisdiction_requests(to_branch_id);

-- 입력할 때: 요청 지사·작성자·상태를 DB 가 정하고, 한 지사가 처리 대기 요청을 20개 넘게 쌓지 못하게 함
create or replace function private.jr_req_before_insert() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  new.requested_by := (select auth.uid());
  new.branch_id := private.my_branch();
  new.status := 'pending'; new.resolved_by := null; new.resolved_at := null; new.resolution_note := null;
  new.created_at := now();
  if new.branch_id is not null and (select count(*) from public.jurisdiction_requests r where r.branch_id = new.branch_id and r.status = 'pending') >= 20 then
    raise exception 'too many pending requests' using errcode = '54000';
  end if;
  return new;
end $$;
revoke all on function private.jr_req_before_insert() from public, anon;
create trigger jr_req_before_insert before insert on public.jurisdiction_requests for each row execute function private.jr_req_before_insert();

-- 고칠 때: 처리 대기 → 승인/반려(관리자) 또는 취소(요청한 지사)만 가능, 내용은 바꿀 수 없고, 처리자·시각은 DB 가 채움
create or replace function private.jr_req_before_update() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare r text := private.my_role();
begin
  if (new.branch_id, new.section_ids, new.snapshot, new.to_branch_id, new.reason, new.requested_by, new.created_at)
     is distinct from (old.branch_id, old.section_ids, old.snapshot, old.to_branch_id, old.reason, old.requested_by, old.created_at) then
    raise exception 'request content cannot be changed' using errcode = '42501';
  end if;
  if old.status <> 'pending' then raise exception 'request already resolved' using errcode = '42501'; end if;
  if r = 'admin' and new.status in ('approved','rejected') then null;
  elsif r = 'branch' and new.status = 'cancelled' then new.resolution_note := null;
  else raise exception 'not allowed' using errcode = '42501'; end if;
  new.resolved_by := (select auth.uid()); new.resolved_at := now();
  return new;
end $$;
revoke all on function private.jr_req_before_update() from public, anon;
create trigger jr_req_before_update before update on public.jurisdiction_requests for each row execute function private.jr_req_before_update();

create trigger audit_jurisdiction_requests after insert or update on public.jurisdiction_requests for each row execute function private.audit_row('id');

-- 행 단위 권한
alter table public.jurisdiction_requests enable row level security;
create policy jr_req_read on public.jurisdiction_requests for select to authenticated
  using ((select private.my_role()) = 'admin' or ((select private.my_role()) = 'branch' and branch_id = (select private.my_branch())));
create policy jr_req_ins on public.jurisdiction_requests for insert to authenticated
  with check ((select private.my_role()) = 'branch' and branch_id = (select private.my_branch()));
create policy jr_req_upd on public.jurisdiction_requests for update to authenticated
  using ((select private.my_role()) = 'admin' or ((select private.my_role()) = 'branch' and branch_id = (select private.my_branch()) and requested_by = (select auth.uid())))
  with check ((select private.my_role()) = 'admin' or ((select private.my_role()) = 'branch' and branch_id = (select private.my_branch())));
-- 삭제 정책 없음: 요청 기록은 지울 수 없다
