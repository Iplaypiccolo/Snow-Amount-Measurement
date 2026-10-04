-- ============================================================
-- 장비 지원을 서버에 저장 (예전 설계의 빈 표를 새 설계로 바꿈 — 바꾸기 전 모두 0건 확인)
--  * vehicles       : 장비. 고유 번호 id(V001…)는 바뀌지 않고, 차량번호(plate)는 고칠 수 있음. 지원 여부 '' 미정 / O 지원 / X 지원 불가 / M 정비중(지원 불가)
--  * vehicle_routes : 날짜별 경로 — (날짜, 장비)마다 한 줄, 그날 들르는 지사 번호 목록. [확정]할 때만 저장. 다른 날짜를 확정해도 이전 날짜 줄은 그대로(기록이 사라지지 않음)
--                     줄을 고치거나 지우면 접속·수정 기록(audit_log)에 이전 값이 남음
--  * support_rounds : 기준일자(지원 회차). start_date = 기준일자(하루에 하나)
--  * round_requests : 기준일자별 지사 요청·편성. confirmed = 편성 확정(확정된 지사만 경로의 피지원 기관으로 고를 수 있음)
-- 권한(마이그레이션 15의 permissions):
--  equip.edit.all = 모든 장비·경로 / equip.edit.own = 자기 출발 기관 장비만(차량번호·지원 여부·경로) / req.confirm = 기준일자·편성·확정 /
--  req.edit.own = 자기 지사 요청 / req.edit.hq = 자기 본부 지사들 요청
-- ============================================================
drop table if exists public.round_vehicle_days cascade;
drop table if exists public.round_vehicles cascade;
drop table if exists public.vehicles cascade;

create table public.vehicles (
  id     text primary key check (id ~ '^V[0-9]{3,5}$'),
  org    text not null references public.equip_orgs(name),
  type   text not null check (type in ('제설차','제설기','이동정비차')),
  plate  text not null unique check (plate ~ '^[0-9]{2,3}[가-힣][0-9]{4}$'),
  status text not null default '' check (status in ('','O','X','M')),
  sort   integer not null default 0,
  active boolean not null default true,
  updated_by uuid, updated_at timestamptz not null default now()
);
create index vehicles_org_idx on public.vehicles(org);

create table public.vehicle_routes (
  date date not null,
  vehicle_id text not null references public.vehicles(id) on delete cascade,
  stops text[] not null check (cardinality(stops) between 1 and 5),
  confirmed_by uuid, confirmed_at timestamptz not null default now(),
  primary key (date, vehicle_id)
);
create index vehicle_routes_vehicle_idx on public.vehicle_routes(vehicle_id, date);

alter table public.support_rounds add constraint support_rounds_start_unique unique (start_date);
alter table public.round_requests add column if not exists confirmed boolean not null default false;

-- 작성자·시각은 DB 가 채움
create trigger stamp_vehicles        before insert or update on public.vehicles       for each row execute function private.stamp('updated_by', 'updated_at');
create trigger stamp_vehicle_routes  before insert or update on public.vehicle_routes for each row execute function private.stamp('confirmed_by', 'confirmed_at');
create trigger audit_vehicles        after insert or update or delete on public.vehicles       for each row execute function private.audit_row('id');
create trigger audit_vehicle_routes  after insert or update or delete on public.vehicle_routes for each row execute function private.audit_row('date', 'vehicle_id');

-- 경로의 지사 번호는 실제 기관이어야 하고 같은 날 같은 지사는 한 번만
-- (보는 사람 권한과 관계없이 전체 기관 목록으로 검사 — 함수 권한으로 실행)
create or replace function private.check_route() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if exists (select 1 from unnest(new.stops) s where not exists (select 1 from public.branches b where b.id = s)) then
    raise exception 'unknown branch in stops' using errcode = '23503';
  end if;
  if cardinality(new.stops) <> (select count(distinct s) from unnest(new.stops) s) then
    raise exception 'duplicate stop' using errcode = '23514';
  end if;
  return new;
end $$;
revoke all on function private.check_route() from public, anon;
create trigger check_route before insert or update on public.vehicle_routes for each row execute function private.check_route();

-- 자기 기관 장비만 고치는 계정은 차량번호·지원 여부만(기관·종류·순서는 못 바꿈)
create or replace function private.vehicles_guard() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if not private.has_perm('equip.edit.all') and (new.id, new.org, new.type, new.sort, new.active) is distinct from (old.id, old.org, old.type, old.sort, old.active) then
    raise exception 'only plate and status can be changed' using errcode = '42501';
  end if;
  return new;
end $$;
revoke all on function private.vehicles_guard() from public, anon;
create trigger vehicles_guard before update on public.vehicles for each row execute function private.vehicles_guard();

-- 요청: 편성 대수·확정은 req.confirm 만
create or replace function private.round_requests_guard() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if private.has_perm('req.confirm') then return new; end if;
  if tg_op = 'INSERT' then
    if new.assigned_truck <> 0 or new.assigned_blower <> 0 or new.confirmed then raise exception 'assignment needs req.confirm' using errcode = '42501'; end if;
  elsif (new.assigned_truck, new.assigned_blower, new.confirmed) is distinct from (old.assigned_truck, old.assigned_blower, old.confirmed) then
    raise exception 'assignment needs req.confirm' using errcode = '42501';
  end if;
  return new;
end $$;
revoke all on function private.round_requests_guard() from public, anon;
create trigger round_requests_guard before insert or update on public.round_requests for each row execute function private.round_requests_guard();

-- 권한 규칙
alter table public.vehicles enable row level security;
create policy vehicles_read on public.vehicles for select to authenticated using ((select private.my_role()) is not null);
create policy vehicles_ins  on public.vehicles for insert to authenticated with check ((select private.has_perm('equip.edit.all')));
create policy vehicles_upd  on public.vehicles for update to authenticated
  using ((select private.has_perm('equip.edit.all')) or ((select private.has_perm('equip.edit.own')) and org = (select private.my_org())))
  with check ((select private.has_perm('equip.edit.all')) or ((select private.has_perm('equip.edit.own')) and org = (select private.my_org())));
create policy vehicles_del  on public.vehicles for delete to authenticated using ((select private.has_perm('equip.edit.all')));

alter table public.vehicle_routes enable row level security;
create policy vehicle_routes_read on public.vehicle_routes for select to authenticated using ((select private.my_role()) is not null);
create policy vehicle_routes_write on public.vehicle_routes for all to authenticated
  using ((select private.has_perm('equip.edit.all')) or ((select private.has_perm('equip.edit.own')) and exists (select 1 from public.vehicles v where v.id = vehicle_id and v.org = (select private.my_org()))))
  with check ((select private.has_perm('equip.edit.all')) or ((select private.has_perm('equip.edit.own')) and exists (select 1 from public.vehicles v where v.id = vehicle_id and v.org = (select private.my_org()))));

drop policy if exists support_rounds_ins on public.support_rounds;
drop policy if exists support_rounds_upd on public.support_rounds;
drop policy if exists support_rounds_del on public.support_rounds;
create policy support_rounds_ins on public.support_rounds for insert to authenticated with check ((select private.has_perm('req.confirm')));
create policy support_rounds_upd on public.support_rounds for update to authenticated using ((select private.has_perm('req.confirm'))) with check ((select private.has_perm('req.confirm')));
create policy support_rounds_del on public.support_rounds for delete to authenticated using ((select private.has_perm('req.confirm')));

drop policy if exists round_requests_ins on public.round_requests;
drop policy if exists round_requests_upd on public.round_requests;
drop policy if exists round_requests_del on public.round_requests;
create policy round_requests_ins on public.round_requests for insert to authenticated with check (
  (select private.has_perm('req.confirm'))
  or ((select private.has_perm('req.edit.own')) and branch_id = (select private.my_branch()))
  or ((select private.has_perm('req.edit.hq')) and exists (select 1 from public.branches b where b.id = branch_id and b.hq_id = (select private.my_hq()))));
create policy round_requests_upd on public.round_requests for update to authenticated
  using ((select private.has_perm('req.confirm'))
    or ((select private.has_perm('req.edit.own')) and branch_id = (select private.my_branch()))
    or ((select private.has_perm('req.edit.hq')) and exists (select 1 from public.branches b where b.id = branch_id and b.hq_id = (select private.my_hq()))))
  with check ((select private.has_perm('req.confirm'))
    or ((select private.has_perm('req.edit.own')) and branch_id = (select private.my_branch()))
    or ((select private.has_perm('req.edit.hq')) and exists (select 1 from public.branches b where b.id = branch_id and b.hq_id = (select private.my_hq()))));
create policy round_requests_del on public.round_requests for delete to authenticated using ((select private.has_perm('req.confirm')));
