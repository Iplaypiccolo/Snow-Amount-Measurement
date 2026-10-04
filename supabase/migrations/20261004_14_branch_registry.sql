-- ============================================================
-- 신설 기관 "정상 등록 루트" + 영암·민자 정식 번호 + 기관 순서
--  1) 관리자가 관할 화면에서 신설 기관을 저장하면(이력 addBranch), 같은 저장 안에서 기관 목록(branches)에도 자동 등록한다.
--     본부 이동(moveHq)도 기관 목록의 본부를 함께 바꾼다. → 지사 요청·계정이 새 기관을 바로 가리킬 수 있다(외래키 오류 없음).
--  2) 예전 버그로 번호 없이 저장된 신설 기관(서버 줄 10 = 영암, 11 = 민자)을 정식 번호 B060·B061 로 기관 목록에 등록한다.
--     지울 수 없는 이력은 그대로 두고, 화면이 읽을 때 10→B060, 11→B061 로 바꿔 읽는다(auth/events.js).
--  3) 기관 순서: 번호(id)는 이름표일 뿐 순서가 아니다. 순서는 이력 "orderBranch"(○○ 다음에 두기)와
--     신설 시 "after"(○○ 다음에 만들기)로 정한다. 중간에 끼워도 다른 기관 번호는 바뀌지 않는다.
-- ============================================================

-- 1) 이력 종류에 orderBranch 추가
do $$
declare c text;
begin
  select conname into c from pg_constraint
   where conrelid = 'public.jurisdiction_events'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%kind%';
  if c is not null then execute format('alter table public.jurisdiction_events drop constraint %I', c); end if;
end $$;
alter table public.jurisdiction_events add constraint jurisdiction_events_kind_check
  check (kind in ('move','addBranch','moveHq','orderBranch'));

-- 2) 값 검사(마이그레이션 10)에 orderBranch·after 추가
create or replace function private.check_jurisdiction_event() returns trigger
language plpgsql set search_path = ''
as $$
declare p jsonb := new.payload;
begin
  if jsonb_typeof(p) <> 'object' then raise exception 'payload must be an object' using errcode = '23514'; end if;
  if new.note is not null and length(new.note) > 200 then raise exception 'note too long' using errcode = '23514'; end if;
  if p ? 'after' and jsonb_typeof(p -> 'after') not in ('string', 'null') then raise exception 'after must be a branch id' using errcode = '23514'; end if;
  if new.kind = 'addBranch' then
    if coalesce(p ->> 'id', '') !~ '^B[0-9]{3}$' then raise exception 'addBranch id must look like B060' using errcode = '23514'; end if;
    if coalesce(p ->> 'name', '') !~ '^[^<>"''&`]{1,20}$' or btrim(p ->> 'name') = '' then raise exception 'addBranch name invalid' using errcode = '23514'; end if;
    if not exists (select 1 from public.hqs h where h.name = p ->> 'hq') then raise exception 'unknown hq' using errcode = '23514'; end if;
  elsif new.kind = 'moveHq' then
    if not exists (select 1 from public.hqs h where h.name = p ->> 'hq') then raise exception 'unknown hq' using errcode = '23514'; end if;
  elsif new.kind = 'move' then
    if jsonb_typeof(p -> 'sections') <> 'array' or jsonb_array_length(p -> 'sections') = 0 then raise exception 'move needs sections' using errcode = '23514'; end if;
  elsif new.kind = 'orderBranch' then
    if coalesce(p ->> 'branch', '') = '' then raise exception 'orderBranch needs branch' using errcode = '23514'; end if;
  end if;
  return new;
end $$;

-- 3) 저장과 함께 기관 목록 맞추기 (같은 트랜잭션: 등록이 안 되면 이력 저장도 취소)
create or replace function private.sync_branch_registry() returns trigger
language plpgsql set search_path = ''
as $$
declare p jsonb := new.payload; hq text;
begin
  if new.kind = 'addBranch' then
    select h.id into hq from public.hqs h where h.name = p ->> 'hq';
    insert into public.branches (id, hq_id, name, status) values (p ->> 'id', hq, btrim(p ->> 'name'), 'new')
      on conflict (id) do nothing;
  elsif new.kind = 'moveHq' then
    select h.id into hq from public.hqs h where h.name = p ->> 'hq';
    update public.branches set hq_id = hq where id = p ->> 'branch' and hq_id is distinct from hq;
  end if;
  return new;
end $$;
revoke all on function private.sync_branch_registry() from public, anon;
create trigger sync_branch_registry after insert on public.jurisdiction_events for each row execute function private.sync_branch_registry();

-- 4) 예전 신설 기관(번호 없이 저장된 서버 줄 10·11)을 정식 번호로 등록
insert into public.branches (id, hq_id, name, status) values
  ('B060', (select id from public.hqs where name = '광주전남'), '영암', 'new'),
  ('B061', (select id from public.hqs where name = '민자'), '민자', 'new')
on conflict (id) do nothing;
