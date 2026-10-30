-- ============================================================
-- 48. 강원 신속대응팀(강원본부 지원장비) (2026-10-30 사용자 결정)
--  * 강원본부가 직접 보내는 제설차 4대(원주·홍천·대관령·강릉 — 이름 고정). 기관별 장비·기관별 배정과 따로 움직이는 독립 시스템:
--    지사의 요청·편성·배정 대수에 영향을 주지 않고, 요청이 없는 지사로도 보낼 수 있음(전국 모든 지사). 기준일자만 함께 씀.
--  * 고칠 수 있는 사람: 관리자(role admin)와 강원본부 계정(role hq, 본부 '강원'). 읽기는 로그인한 모든 계정(이동 현황에 보임)
--  * 표 3개(기존 장비 표와 섞지 않음)
--      gw_team         팀 장비 4대(고정, 화면에서 못 고침)
--      gw_team_status  기준일자별 지원 여부(지원/미정/지원 불가/정비중, 지원 불가 시작일) — 기관별 장비의 지원 여부와 같은 규칙
--      gw_team_routes  (날짜, 팀 장비)마다 들르는 지사·도착 예상 시각 — 그 날짜를 맡은 기준일자에서 '지원'인 날만
--  * 저장: save_gw_team(기준일자, 경로들, 지원 여부들) 한 번에 전부 되거나 전부 안 됨
--  * 기준일자를 새로 만들면 지원 여부를 이전 기준일자에서 이어받음(기관별 장비와 같게). 기준일자를 지우면 그 기간의 팀 경로·지원 여부도 함께 지움(사용자 결정)
--  * 바뀐 내용은 수정 기록(audit_log)에 남음 → 로그 기록 탭
-- ============================================================

-- 고칠 수 있는 계정: 관리자 또는 강원본부
create or replace function private.gw_team_editor() returns boolean
language sql stable security definer set search_path = ''
as $$ select exists (select 1 from public.profiles p where p.id = (select auth.uid()) and not p.disabled and not p.must_change
          and (p.role = 'admin' or (p.role = 'hq' and p.hq_id = (select h.id from public.hqs h where h.name = '강원')))) $$;
revoke all on function private.gw_team_editor() from public, anon;
grant execute on function private.gw_team_editor() to authenticated;        -- 권한 규칙(RLS)에서 부름

-- 1) 팀 장비(고정 4대)
create table if not exists public.gw_team (
  id   text primary key,
  name text not null unique,
  sort integer not null
);
insert into public.gw_team (id, name, sort) values ('GW1', '원주', 1), ('GW2', '홍천', 2), ('GW3', '대관령', 3), ('GW4', '강릉', 4)
  on conflict (id) do nothing;
alter table public.gw_team enable row level security;
revoke all on public.gw_team from anon, public;
grant select on public.gw_team to authenticated;
drop policy if exists gw_team_read on public.gw_team;
create policy gw_team_read on public.gw_team for select to authenticated using ((select private.my_role()) is not null);

-- 2) 기준일자별 지원 여부
create table if not exists public.gw_team_status (
  round_id   bigint not null references public.support_rounds(id) on delete cascade,
  team_id    text   not null references public.gw_team(id),
  status     text   not null default '' check (status in ('', 'O', 'X', 'M')),
  off_from   date,
  updated_by uuid,
  updated_at timestamptz not null default now(),
  primary key (round_id, team_id)
);
create or replace function private.gw_status_check() returns trigger
language plpgsql set search_path = ''
as $$
declare st date;
begin
  new.off_from := case when new.status = 'O' then new.off_from end;
  if new.off_from is not null then
    select start_date into st from public.support_rounds where id = new.round_id;
    if new.off_from < st then raise exception 'off_from is before the round start' using errcode = '23514'; end if;
  end if;
  return new;
end $$;
revoke all on function private.gw_status_check() from public, anon;
drop trigger if exists gw_status_check on public.gw_team_status;
create trigger gw_status_check before insert or update on public.gw_team_status for each row execute function private.gw_status_check();
drop trigger if exists stamp_gw_team_status on public.gw_team_status;
create trigger stamp_gw_team_status before insert or update on public.gw_team_status for each row execute function private.stamp('updated_by', 'updated_at');
drop trigger if exists audit_gw_team_status on public.gw_team_status;
create trigger audit_gw_team_status after insert or update or delete on public.gw_team_status
  for each row when (current_setting('private.carry', true) is distinct from '1') execute function private.audit_row('round_id', 'team_id');
alter table public.gw_team_status enable row level security;
revoke all on public.gw_team_status from anon, public;
grant select, insert, update, delete on public.gw_team_status to authenticated;
drop policy if exists gw_team_status_read on public.gw_team_status;
drop policy if exists gw_team_status_ins on public.gw_team_status;
drop policy if exists gw_team_status_upd on public.gw_team_status;
drop policy if exists gw_team_status_del on public.gw_team_status;
create policy gw_team_status_read on public.gw_team_status for select to authenticated using ((select private.my_role()) is not null);
create policy gw_team_status_ins on public.gw_team_status for insert to authenticated with check ((select private.gw_team_editor()));
create policy gw_team_status_upd on public.gw_team_status for update to authenticated using ((select private.gw_team_editor())) with check ((select private.gw_team_editor()));
create policy gw_team_status_del on public.gw_team_status for delete to authenticated using ((select private.gw_team_editor()));

-- 3) 날짜별 경로
create table if not exists public.gw_team_routes (
  date         date    not null,
  team_id      text    not null references public.gw_team(id),
  stops        text[]  not null check (cardinality(stops) between 1 and 5),
  times        text[],
  revised      boolean not null default false,
  confirmed_by uuid,
  confirmed_at timestamptz not null default now(),
  primary key (date, team_id)
);
-- 지사가 있는지·겹치지 않는지·시각 형식, 그 날짜를 맡은 기준일자가 있고 그 기준일자에서 '지원'(지원 불가 시작일 전)인지
create or replace function private.gw_route_check() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare rid bigint; s public.gw_team_status;
begin
  if exists (select 1 from unnest(new.stops) x where not exists (select 1 from public.branches b where b.id = x)) then
    raise exception 'unknown branch in stops' using errcode = '23503';
  end if;
  if cardinality(new.stops) <> (select count(distinct x) from unnest(new.stops) x) then raise exception 'duplicate stop' using errcode = '23514'; end if;
  if new.times is not null then
    if cardinality(new.times) <> cardinality(new.stops) then raise exception 'times must match stops' using errcode = '23514'; end if;
    if exists (select 1 from unnest(new.times) t where t is not null and t !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$') then
      raise exception 'time must be HH:MM' using errcode = '23514';
    end if;
  end if;
  rid := private.governing_round(new.date);
  if rid is null then raise exception 'date is not inside any round' using errcode = '23514'; end if;
  select * into s from public.gw_team_status x where x.round_id = rid and x.team_id = new.team_id;
  if not found or s.status <> 'O' or (s.off_from is not null and new.date >= s.off_from) then
    raise exception 'team vehicle is not available on this date' using errcode = '23514';
  end if;
  return new;
end $$;
revoke all on function private.gw_route_check() from public, anon;
drop trigger if exists gw_route_check on public.gw_team_routes;
create trigger gw_route_check before insert or update of stops, times, revised on public.gw_team_routes for each row execute function private.gw_route_check();
drop trigger if exists stamp_gw_team_routes on public.gw_team_routes;
create trigger stamp_gw_team_routes before insert or update on public.gw_team_routes for each row execute function private.stamp('confirmed_by', 'confirmed_at');
drop trigger if exists audit_gw_team_routes on public.gw_team_routes;
create trigger audit_gw_team_routes after insert or update or delete on public.gw_team_routes for each row execute function private.audit_row('date', 'team_id');
alter table public.gw_team_routes enable row level security;
revoke all on public.gw_team_routes from anon, public;
grant select, insert, update, delete on public.gw_team_routes to authenticated;
drop policy if exists gw_team_routes_read on public.gw_team_routes;
drop policy if exists gw_team_routes_ins on public.gw_team_routes;
drop policy if exists gw_team_routes_upd on public.gw_team_routes;
drop policy if exists gw_team_routes_del on public.gw_team_routes;
create policy gw_team_routes_read on public.gw_team_routes for select to authenticated using ((select private.my_role()) is not null);
create policy gw_team_routes_ins on public.gw_team_routes for insert to authenticated with check ((select private.gw_team_editor()));
create policy gw_team_routes_upd on public.gw_team_routes for update to authenticated using ((select private.gw_team_editor())) with check ((select private.gw_team_editor()));
create policy gw_team_routes_del on public.gw_team_routes for delete to authenticated using ((select private.gw_team_editor()));
create index if not exists gw_team_routes_team_idx on public.gw_team_routes (team_id, date);

-- 4) 저장: 지원 여부 먼저, 그다음 경로(경로 검사가 지원 여부를 봄). 하나라도 안 되면 전부 취소
create or replace function public.save_gw_team(p_round bigint, p_routes jsonb default '[]'::jsonb, p_status jsonb default '[]'::jsonb) returns jsonb
language plpgsql set search_path = ''
as $$
declare r jsonb; c int; ns int := 0; nu int := 0; nd int := 0; tid text; st text; d date; stp text[]; tms text[];
begin
  if not (select private.gw_team_editor()) then raise exception 'only the admin or the Gangwon HQ' using errcode = '42501'; end if;
  if jsonb_typeof(p_routes) is distinct from 'array' or jsonb_typeof(p_status) is distinct from 'array' then raise exception 'bad input' using errcode = '22023'; end if;
  if jsonb_array_length(p_routes) + jsonb_array_length(p_status) = 0 then raise exception 'nothing to save' using errcode = '22023'; end if;
  if jsonb_array_length(p_routes) > 500 or jsonb_array_length(p_status) > 50 then raise exception 'too many rows' using errcode = '54000'; end if;
  if p_round is null then raise exception 'round required' using errcode = '22023'; end if;
  if not exists (select 1 from public.support_rounds where id = p_round) then raise exception 'unknown round' using errcode = '23503'; end if;
  for r in select * from jsonb_array_elements(p_status) loop
    if jsonb_typeof(r) is distinct from 'object' or not (r ? 'team_id') then raise exception 'bad status' using errcode = '22023'; end if;
    tid := r ->> 'team_id'; st := coalesce(r ->> 'status', '');
    if st not in ('', 'O', 'X', 'M') then raise exception 'bad status value' using errcode = '22023'; end if;
    insert into public.gw_team_status as s (round_id, team_id, status, off_from) values (p_round, tid, st, nullif(r ->> 'off_from', '')::date)
    on conflict (round_id, team_id) do update set status = excluded.status, off_from = excluded.off_from
      where (s.status, s.off_from) is distinct from (excluded.status, excluded.off_from);
    get diagnostics c = row_count; ns := ns + c;
  end loop;
  for r in select * from jsonb_array_elements(p_routes) loop
    if jsonb_typeof(r) is distinct from 'object' or not (r ? 'date') or not (r ? 'team_id') or jsonb_typeof(coalesce(r -> 'stops', '[]'::jsonb)) is distinct from 'array'
       or (r ? 'times' and jsonb_typeof(r -> 'times') not in ('array', 'null')) then
      raise exception 'bad route' using errcode = '22023';
    end if;
    tid := r ->> 'team_id'; d := (r ->> 'date')::date;
    if private.governing_round(d) is distinct from p_round then raise exception 'date is owned by another round' using errcode = '23514'; end if;
    stp := array(select jsonb_array_elements_text(r -> 'stops'));
    tms := case when jsonb_typeof(r -> 'times') = 'array' then array(select jsonb_array_elements_text(r -> 'times')) end;
    if cardinality(stp) = 0 then
      delete from public.gw_team_routes x where x.date = d and x.team_id = tid;
      get diagnostics c = row_count; nd := nd + c;
    else
      insert into public.gw_team_routes as x (date, team_id, stops, revised, times) values (d, tid, stp, coalesce((r ->> 'revised')::boolean, false), tms)
      on conflict (date, team_id) do update set stops = excluded.stops, revised = excluded.revised, times = excluded.times
        where (x.stops, x.revised, x.times) is distinct from (excluded.stops, excluded.revised, excluded.times);
      get diagnostics c = row_count; nu := nu + c;
    end if;
  end loop;
  return jsonb_build_object('status', ns, 'routes_saved', nu, 'routes_deleted', nd);
end $$;
revoke all on function public.save_gw_team(bigint, jsonb, jsonb) from public, anon;
grant execute on function public.save_gw_team(bigint, jsonb, jsonb) to authenticated;

-- 5) 기준일자를 만들면 이전 기준일자의 지원 여부를 이어받음(지원 불가 시작일이 새 기준일자 이전이면 '지원 불가'). 수정 기록에는 남기지 않음
create or replace function private.gw_team_carry() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare prev bigint; was text := current_setting('private.carry', true);
begin
  select id into prev from public.support_rounds where start_date < new.start_date order by start_date desc limit 1;
  perform set_config('private.carry', '1', true);
  insert into public.gw_team_status (round_id, team_id, status, off_from)
  select new.id, t.id,
         case when s.status = 'O' and s.off_from is not null and s.off_from <= new.start_date then 'X' else coalesce(s.status, '') end,
         case when s.status = 'O' and s.off_from > new.start_date then s.off_from end
    from public.gw_team t left join public.gw_team_status s on s.round_id = prev and s.team_id = t.id
  on conflict do nothing;
  perform set_config('private.carry', coalesce(was, ''), true);
  return null;
end $$;
revoke all on function private.gw_team_carry() from public, anon;
drop trigger if exists zz_gw_team_carry on public.support_rounds;
create trigger zz_gw_team_carry after insert on public.support_rounds for each row execute function private.gw_team_carry();

-- 6) 기준일자를 지우면 그 기간의 팀 경로도 함께 지움(지원 여부는 외래키로 함께 지워짐). 기존 지우기 검사(rounds_del_guard) 뒤에
create or replace function private.gw_team_round_del() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  delete from public.gw_team_routes x where x.date >= old.start_date and x.date < old.start_date + old.days;
  return old;
end $$;
revoke all on function private.gw_team_round_del() from public, anon;
drop trigger if exists zz_gw_team_round_del on public.support_rounds;
create trigger zz_gw_team_round_del before delete on public.support_rounds for each row execute function private.gw_team_round_del();

-- 7) 지금 있는 기준일자들: 미정으로 한 줄씩(화면이 '미정'으로 보여 주던 것과 같음, 수정 기록 없음)
select set_config('private.carry', '1', true);
insert into public.gw_team_status (round_id, team_id, status) select r.id, t.id, '' from public.support_rounds r cross join public.gw_team t on conflict do nothing;
select set_config('private.carry', '', true);
