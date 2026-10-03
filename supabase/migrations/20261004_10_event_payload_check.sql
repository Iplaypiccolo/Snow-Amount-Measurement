-- ============================================================
-- 관할 변경 이력(jurisdiction_events)에 들어오는 값 검사
--  * 이력은 지울 수 없으므로, 잘못된 값이 처음부터 들어오지 못하게 DB 가 막는다(화면 검사와 별개).
--  * 신설 기관(addBranch): 번호 B000 형식, 이름 1~20자이고 < > " ' & ` 금지, 본부는 실제 본부 이름.
--  * 본부 이동(moveHq): 본부는 실제 본부 이름.  메모(note)는 200자 이내.
--  * 새로 들어오는 줄만 검사한다(이미 저장된 줄은 그대로. 예전 신설 기관 '영암'·'민자'는 번호 없이 저장되어 있음).
-- ============================================================
create or replace function private.check_jurisdiction_event() returns trigger
language plpgsql set search_path = ''
as $$
declare p jsonb := new.payload;
begin
  if jsonb_typeof(p) <> 'object' then raise exception 'payload must be an object' using errcode = '23514'; end if;
  if new.note is not null and length(new.note) > 200 then raise exception 'note too long' using errcode = '23514'; end if;
  if new.kind = 'addBranch' then
    if coalesce(p ->> 'id', '') !~ '^B[0-9]{3}$' then raise exception 'addBranch id must look like B060' using errcode = '23514'; end if;
    if coalesce(p ->> 'name', '') !~ '^[^<>"''&`]{1,20}$' or btrim(p ->> 'name') = '' then raise exception 'addBranch name invalid' using errcode = '23514'; end if;
    if not exists (select 1 from public.hqs h where h.name = p ->> 'hq') then raise exception 'unknown hq' using errcode = '23514'; end if;
  elsif new.kind = 'moveHq' then
    if not exists (select 1 from public.hqs h where h.name = p ->> 'hq') then raise exception 'unknown hq' using errcode = '23514'; end if;
  elsif new.kind = 'move' then
    if jsonb_typeof(p -> 'sections') <> 'array' or jsonb_array_length(p -> 'sections') = 0 then raise exception 'move needs sections' using errcode = '23514'; end if;
  end if;
  return new;
end $$;
revoke all on function private.check_jurisdiction_event() from public, anon;
create trigger check_jurisdiction_event before insert on public.jurisdiction_events for each row execute function private.check_jurisdiction_event();
