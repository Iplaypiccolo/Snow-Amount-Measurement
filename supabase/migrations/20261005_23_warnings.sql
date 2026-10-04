-- ============================================================
-- 23. 기상특보 연동 — 기상청 API허브 특보현황(wrn_now_data_new)을 5분마다 받아 지사별 대설 특보를 자동 표시
--  * 특보구역(warning_zones): 기상청 특보구역 목록(wrn_reg). 육상 구역만 쓰고, 끝 단계 구역(REG_SP 끝 13·14)이 실제 특보 단위
--  * 지사 ↔ 특보구역
--      section_zones        : 고속도로 구간이 지나는 특보구역(도로 좌표 × 시·군·구 경계로 미리 계산, tools/build_section_zones.py)
--                              → 지사 관할(sections.owner_id)이 바뀌면 지사 특보구역도 저절로 따라감
--      branch_zone_overrides: 관리자가 손으로 더하거나(include) 빼는(exclude) 구역
--  * 수집: Edge Function collect-warnings(기상청 키는 함수 비밀값 KMA_AUTH_KEY 에만 있음)
--      pg_cron 이 5분마다 private.kick_warnings() → pg_net 으로 함수 호출(서버 안 전용 토큰으로 확인)
--      함수가 public.ingest_warnings(p) 로 넣음: 바뀐 것만 고치고, 끝난 특보는 warnings_history 로
--  * 화면: public.warning_status() — 받은 시각과 지사별 최고 단계(예비 < 주의 < 경보)·구역 목록
--      마지막으로 받은 지 30분이 넘으면 "자료 없음" → 화면은 특보 없음으로 봄
--  * 확정 고정: round_requests.confirmed 가 거짓→참이 되는 순간 그 지사 특보를 warn_* 열에 복사(서버 트리거, 화면이 못 바꿈)
--      확정을 풀면 지워지고 다시 실시간 표시. 자료가 없으면 특보 없음(warn_level null)으로 고정하고 이유는 warn_note 에
-- ============================================================

/* ---------- 1. 특보구역 ---------- */
alter table public.warning_zones
  add column if not exists up_code    text,          -- 상위 구역(REG_UP)
  add column if not exists sp         text,          -- 구역 종류(REG_SP, 8자리). 끝 두 자리 13·14 = 특보를 내는 끝 단계, 03 = 나뉜 시·군의 묶음
  add column if not exists full_name  text,          -- REG_NAME(예: 강릉시평지)
  add column if not exists valid_from timestamptz,
  add column if not exists valid_to   timestamptz,
  add column if not exists updated_at timestamptz not null default now();

/* ---------- 2. 지사 ↔ 특보구역 ---------- */
create table if not exists public.section_zones (
  section_id text not null references public.sections(id) on delete cascade,
  zone_code  text not null references public.warning_zones(zone_code),
  km double precision,                               -- 그 구역 안을 지나는 도로 길이(대략)
  primary key (section_id, zone_code)
);
create index if not exists section_zones_zone_idx on public.section_zones(zone_code);

create table if not exists public.branch_zone_overrides (
  branch_id text not null references public.branches(id) on delete cascade,
  zone_code text not null references public.warning_zones(zone_code),
  include boolean not null,                          -- 참 = 더함, 거짓 = 자동 목록에서 뺌
  updated_by uuid, updated_at timestamptz not null default now(),
  primary key (branch_id, zone_code)
);
create index if not exists branch_zone_overrides_zone_idx on public.branch_zone_overrides(zone_code);

alter table public.section_zones enable row level security;
create policy section_zones_read on public.section_zones for select to authenticated using ((select private.my_role()) is not null);
create policy section_zones_ins  on public.section_zones for insert to authenticated with check ((select private.my_role()) = 'admin');
create policy section_zones_upd  on public.section_zones for update to authenticated using ((select private.my_role()) = 'admin') with check ((select private.my_role()) = 'admin');
create policy section_zones_del  on public.section_zones for delete to authenticated using ((select private.my_role()) = 'admin');
alter table public.branch_zone_overrides enable row level security;
create policy branch_zone_overrides_read on public.branch_zone_overrides for select to authenticated using ((select private.my_role()) is not null);
create policy branch_zone_overrides_ins  on public.branch_zone_overrides for insert to authenticated with check ((select private.my_role()) = 'admin');
create policy branch_zone_overrides_upd  on public.branch_zone_overrides for update to authenticated using ((select private.my_role()) = 'admin') with check ((select private.my_role()) = 'admin');
create policy branch_zone_overrides_del  on public.branch_zone_overrides for delete to authenticated using ((select private.my_role()) = 'admin');
create trigger stamp_branch_zone_overrides before insert or update on public.branch_zone_overrides for each row execute function private.stamp('updated_by', 'updated_at');
create trigger audit_branch_zone_overrides after insert or update or delete on public.branch_zone_overrides for each row execute function private.audit_row('branch_id', 'zone_code');

-- 지사별 실제 특보구역(자동 − 뺀 것 + 더한 것). src = auto / manual
create or replace function private.branch_zones()
returns table (branch_id text, zone_code text, src text)
language sql stable security definer set search_path = ''
as $$
  select s.owner_id, z.zone_code, 'auto'
    from public.sections s join public.section_zones z on z.section_id = s.id
   where s.owner_id is not null
     and not exists (select 1 from public.branch_zone_overrides o where o.branch_id = s.owner_id and o.zone_code = z.zone_code)
   group by s.owner_id, z.zone_code
  union all
  select o.branch_id, o.zone_code, 'manual' from public.branch_zone_overrides o where o.include
$$;
revoke all on function private.branch_zones() from public, anon;

/* ---------- 3. 지금 특보·지난 특보 ---------- */
-- 같은 구역에 주의보와 경보 예비특보가 함께 있을 수 있어 단계까지 키로
alter table public.warnings_active drop constraint if exists warnings_active_pkey;
alter table public.warnings_active
  add column if not exists tm_ef timestamptz,        -- 발효 시각(예비특보는 기상청 약속 시각: 05:59 = 새벽 등)
  add column if not exists cmd   text,               -- 발표·변경·연장 …
  add column if not exists ed_tm text,               -- 해제 예고(글)
  add column if not exists first_seen timestamptz not null default now();
alter table public.warnings_active add primary key (zone_code, kind, level);
alter table public.warnings_active add constraint warnings_active_level_check check (level in ('예비', '주의', '경보'));
alter table public.warnings_history add column if not exists issued_at timestamptz;
create index if not exists warnings_history_zone_idx on public.warnings_history(zone_code, ended_at);

create or replace function private.warn_rank(l text) returns int language sql immutable set search_path = ''
as $$ select case l when '예비' then 1 when '주의' then 2 when '경보' then 3 else 0 end $$;

-- 한 지사의 지금 대설 특보 { level, zones:[[코드, 이름, 단계]…], base, note } — 자료가 30분 넘게 없으면 level 없음 + note
create or replace function private.branch_warn(p_branch text) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare st public.collector_state; z jsonb; lv text;
begin
  select * into st from public.collector_state where job = 'warnings';
  if st.finished_at is null or st.finished_at < now() - interval '30 minutes' then
    return jsonb_build_object('level', null, 'zones', '[]'::jsonb, 'base', st.cursor,
                              'note', case when st.finished_at is null then '기상청 자료를 아직 받지 못함' else '기상청 자료를 30분 넘게 받지 못함' end);
  end if;
  select coalesce(jsonb_agg(jsonb_build_array(x.zone_code, x.name, x.level) order by private.warn_rank(x.level) desc, x.name), '[]'::jsonb),
         (array_agg(x.level order by private.warn_rank(x.level) desc))[1]
    into z, lv
    from (select a.zone_code, coalesce(w.name, a.zone_code) as name,
                 (array_agg(a.level order by private.warn_rank(a.level) desc))[1] as level
            from (select distinct bz.zone_code from private.branch_zones() bz where bz.branch_id = p_branch) b
            join public.warnings_active a on a.zone_code = b.zone_code and a.kind = '대설'
            left join public.warning_zones w on w.zone_code = a.zone_code
           group by a.zone_code, w.name) x;
  return jsonb_build_object('level', lv, 'zones', z, 'base', st.cursor, 'note', null);
end $$;
revoke all on function private.branch_warn(text) from public, anon;

-- 화면용: 받은 시각 + 대설 특보가 있는 지사만 { B015: {level, zones} }
create or replace function public.warning_status() returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare st public.collector_state; br jsonb;
begin
  if (select private.my_role()) is null then raise exception 'login required' using errcode = '42501'; end if;
  select * into st from public.collector_state where job = 'warnings';
  if st.finished_at is null or st.finished_at < now() - interval '30 minutes' then
    return jsonb_build_object('ok', false, 'base', st.cursor, 'fetched_at', st.finished_at, 'branches', '{}'::jsonb,
                              'note', case when st.finished_at is null then '기상청 자료를 아직 받지 못함' else '기상청 자료를 30분 넘게 받지 못함' end);
  end if;
  select coalesce(jsonb_object_agg(b.branch_id, jsonb_build_object('level', b.level, 'zones', b.zones)), '{}'::jsonb) into br
    from (select y.branch_id, (array_agg(y.level order by private.warn_rank(y.level) desc))[1] as level,
                 jsonb_agg(jsonb_build_array(y.zone_code, y.name, y.level) order by private.warn_rank(y.level) desc, y.name) as zones
            from (select bz.branch_id, a.zone_code, coalesce(w.name, a.zone_code) as name,
                         (array_agg(a.level order by private.warn_rank(a.level) desc))[1] as level
                    from (select distinct z.branch_id, z.zone_code from private.branch_zones() z) bz
                    join public.warnings_active a on a.zone_code = bz.zone_code and a.kind = '대설'
                    left join public.warning_zones w on w.zone_code = a.zone_code
                   group by bz.branch_id, a.zone_code, w.name) y
           group by y.branch_id) b;
  return jsonb_build_object('ok', true, 'base', st.cursor, 'fetched_at', st.finished_at, 'branches', br, 'note', null);
end $$;
revoke all on function public.warning_status() from public, anon;
grant execute on function public.warning_status() to authenticated;

-- 관리자 검토용: 지사별 특보구역 목록 { B015: [[코드, 이름, src]…] }
create or replace function public.branch_zone_list() returns jsonb
language sql stable security definer set search_path = ''
as $$
  select case when (select private.my_role()) is null then null else
    coalesce((select jsonb_object_agg(t.branch_id, t.zones) from (
      select z.branch_id, jsonb_agg(jsonb_build_array(z.zone_code, coalesce(w.name, z.zone_code), z.src) order by z.zone_code) as zones
        from (select bz.branch_id, bz.zone_code, min(bz.src) as src from private.branch_zones() bz group by 1, 2) z
        left join public.warning_zones w on w.zone_code = z.zone_code
       group by z.branch_id) t), '{}'::jsonb) end
$$;
revoke all on function public.branch_zone_list() from public, anon;
grant execute on function public.branch_zone_list() to authenticated;

/* ---------- 4. 확정할 때 특보 고정 ---------- */
alter table public.round_requests
  add column if not exists warn_level text check (warn_level is null or warn_level in ('예비', '주의', '경보')),
  add column if not exists warn_zones jsonb,         -- [[코드, 이름, 단계]…]
  add column if not exists warn_base  text,          -- 기상청 기준시각(YYYYMMDDHHMM)
  add column if not exists warn_at    timestamptz,   -- 고정한 시각
  add column if not exists warn_note  text;          -- 자료가 없어 특보 없음으로 고정한 이유 등

create or replace function private.round_requests_warn() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare w jsonb;
begin
  if new.confirmed and (tg_op = 'INSERT' or not old.confirmed) then
    w := private.branch_warn(new.branch_id);
    new.warn_level := w ->> 'level'; new.warn_zones := w -> 'zones'; new.warn_base := w ->> 'base';
    new.warn_note := w ->> 'note'; new.warn_at := now();
  elsif not new.confirmed then
    new.warn_level := null; new.warn_zones := null; new.warn_base := null; new.warn_note := null; new.warn_at := null;
  else                                               -- 확정 상태 그대로면 고정값을 아무도 못 바꿈
    new.warn_level := old.warn_level; new.warn_zones := old.warn_zones; new.warn_base := old.warn_base;
    new.warn_note := old.warn_note; new.warn_at := old.warn_at;
  end if;
  return new;
end $$;
revoke all on function private.round_requests_warn() from public, anon;
drop trigger if exists zz_round_requests_warn on public.round_requests;
create trigger zz_round_requests_warn before insert or update on public.round_requests for each row execute function private.round_requests_warn();

/* ---------- 5. 수집 함수가 부르는 DB 함수(서버 전용) ---------- */
-- p = { ok, base:"YYYYMMDDHHMM", http, ms, error, rows:[{zone, kind, level, tm_fc, tm_ef, cmd, ed_tm}] }
create or replace function public.ingest_warnings(p jsonb) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare t0 timestamptz := now(); nadd int := 0; ndel int := 0; nupd int := 0;
begin
  insert into public.collector_runs (job, started_at, finished_at, ok, http_status, ms, calls, error)
  values ('warnings', t0, now(), coalesce((p ->> 'ok')::boolean, false), (p ->> 'http')::int, (p ->> 'ms')::int, 1, left(p ->> 'error', 500));
  delete from public.collector_runs where job = 'warnings' and started_at < now() - interval '14 days';

  if not coalesce((p ->> 'ok')::boolean, false) then
    insert into public.collector_state as s (job, started_at, ok, note) values ('warnings', t0, false, left(p ->> 'error', 500))
    on conflict (job) do update set started_at = t0, ok = false, note = left(p ->> 'error', 500);   -- 마지막 성공 시각(finished_at)은 그대로
    return jsonb_build_object('ok', false);
  end if;
  if jsonb_typeof(p -> 'rows') is distinct from 'array' or jsonb_array_length(p -> 'rows') > 3000 then raise exception 'bad rows' using errcode = '22023'; end if;

  drop table if exists _w;
  create temp table _w on commit drop as
    select distinct on (r ->> 'zone', r ->> 'kind', r ->> 'level')
           r ->> 'zone' as zone_code, r ->> 'kind' as kind, r ->> 'level' as level,
           (r ->> 'tm_fc')::timestamptz as issued_at, (r ->> 'tm_ef')::timestamptz as tm_ef, r ->> 'cmd' as cmd, nullif(r ->> 'ed_tm', '') as ed_tm
      from jsonb_array_elements(p -> 'rows') r
     where r ->> 'level' in ('예비', '주의', '경보') and coalesce(r ->> 'zone', '') <> '' and coalesce(r ->> 'kind', '') <> ''
     order by r ->> 'zone', r ->> 'kind', r ->> 'level', r ->> 'tm_fc' desc;

  with gone as (
    delete from public.warnings_active a
     where not exists (select 1 from _w where _w.zone_code = a.zone_code and _w.kind = a.kind and _w.level = a.level)
    returning a.*)
  insert into public.warnings_history (zone_code, kind, level, started_at, ended_at, issued_at)
  select zone_code, kind, level, first_seen, now(), issued_at from gone;
  get diagnostics ndel = row_count;

  update public.warnings_active a set issued_at = w.issued_at, tm_ef = w.tm_ef, cmd = w.cmd, ed_tm = w.ed_tm, updated_at = now()
    from _w w
   where w.zone_code = a.zone_code and w.kind = a.kind and w.level = a.level
     and (a.issued_at, a.tm_ef, a.cmd, a.ed_tm) is distinct from (w.issued_at, w.tm_ef, w.cmd, w.ed_tm);
  get diagnostics nupd = row_count;

  insert into public.warnings_active (zone_code, kind, level, issued_at, tm_ef, cmd, ed_tm)
  select w.zone_code, w.kind, w.level, w.issued_at, w.tm_ef, w.cmd, w.ed_tm from _w w
   where not exists (select 1 from public.warnings_active a where a.zone_code = w.zone_code and a.kind = w.kind and a.level = w.level);
  get diagnostics nadd = row_count;

  insert into public.collector_state as s (job, cursor, started_at, finished_at, ok, note) values ('warnings', p ->> 'base', t0, now(), true, null)
  on conflict (job) do update set cursor = excluded.cursor, started_at = t0, finished_at = now(), ok = true, note = null;
  return jsonb_build_object('ok', true, 'added', nadd, 'removed', ndel, 'changed', nupd);
end $$;

-- p = [{code, up, ko, name, sp, tm_st, tm_ed}]  기상청 특보구역 목록을 그대로 맞춤(지우지는 않음 — 지난 특보·고정값이 가리킬 수 있으므로)
create or replace function public.ingest_warning_zones(p jsonb) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare n int;
begin
  if jsonb_typeof(p) is distinct from 'array' or jsonb_array_length(p) < 50 or jsonb_array_length(p) > 3000 then raise exception 'bad zones' using errcode = '22023'; end if;
  insert into public.warning_zones as z (zone_code, name, up_code, sp, full_name, valid_from, valid_to, updated_at)
  select r ->> 'code', r ->> 'ko', nullif(r ->> 'up', ''), r ->> 'sp', nullif(r ->> 'name', ''),
         (r ->> 'tm_st')::timestamptz, (r ->> 'tm_ed')::timestamptz, now()
    from jsonb_array_elements(p) r where coalesce(r ->> 'code', '') <> '' and coalesce(r ->> 'ko', '') <> ''
  on conflict (zone_code) do update set name = excluded.name, up_code = excluded.up_code, sp = excluded.sp, full_name = excluded.full_name,
     valid_from = excluded.valid_from, valid_to = excluded.valid_to, updated_at = now()
   where (z.name, z.up_code, z.sp, z.full_name, z.valid_from, z.valid_to) is distinct from (excluded.name, excluded.up_code, excluded.sp, excluded.full_name, excluded.valid_from, excluded.valid_to);
  get diagnostics n = row_count;
  insert into public.collector_state as s (job, finished_at, ok, note) values ('warning_zones', now(), true, n || '개 바뀜')
  on conflict (job) do update set finished_at = now(), ok = true, note = excluded.note;
  return jsonb_build_object('ok', true, 'changed', n);
end $$;

/* ---------- 6. 5분마다 자동 수집(pg_cron → pg_net → Edge Function) ---------- */
create extension if not exists pg_net;
create extension if not exists pg_cron;

-- 서버 안에서만 쓰는 호출 토큰(화면·API 로는 읽을 수 없는 private 스키마)
create table if not exists private.collector_token (id int primary key default 1 check (id = 1), token text not null);
insert into private.collector_token (token) values (encode(extensions.gen_random_bytes(24), 'hex')) on conflict (id) do nothing;
revoke all on private.collector_token from public, anon, authenticated;

create or replace function public.collector_token_ok(t text) returns boolean
language sql stable security definer set search_path = ''
as $$ select exists (select 1 from private.collector_token c where c.token = t) $$;

create or replace function private.kick_warnings(p_zones boolean default false) returns bigint
language sql security definer set search_path = ''
as $$
  select net.http_post(
    url := 'https://yzwbnohzhnctdvufntig.supabase.co/functions/v1/collect-warnings',
    body := jsonb_build_object('zones', p_zones),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-collector-token', (select token from private.collector_token where id = 1)),
    timeout_milliseconds := 30000)
$$;

revoke all on function public.ingest_warnings(jsonb), public.ingest_warning_zones(jsonb), public.collector_token_ok(text), private.kick_warnings(boolean) from public, anon, authenticated;
grant execute on function public.ingest_warnings(jsonb), public.ingest_warning_zones(jsonb), public.collector_token_ok(text) to service_role;

select cron.unschedule(jobid) from cron.job where jobname in ('collect-warnings', 'collect-warning-zones');
select cron.schedule('collect-warnings', '*/5 * * * *', 'select private.kick_warnings(false)');
select cron.schedule('collect-warning-zones', '17 4 * * *', 'select private.kick_warnings(true)');   -- 특보구역 목록은 하루 한 번
