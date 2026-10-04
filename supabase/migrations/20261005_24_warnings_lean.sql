-- ============================================================
-- 24. 특보 수집 줄이기 + 특보 종류 스위치 (2026-10-05 사용자 요청)
--  * 받는 때: 10분마다(매시 01·11·21·31·41·51분 — 특보는 정해진 갱신 주기 없이 아무 때나 발표되고, 발표는 대개 정각·30분이라 그 1분 뒤)
--    그리고 "받을 필요가 있을 때만"(private.warn_needed):
--      기준일자 당일 0시(한국)부터 기준일자 +2일까지, 그 기준일자에 확정을 기다리는 지사가 있을 때
--      (= 아직 아무 지사도 확정 안 됨, 또는 요청을 넣고 확정 안 된 지사가 있음). 모두 확정하면 멈춤.
--    필요 없으면 pg_cron 이 DB 안에서 바로 끝냄(Edge Function 호출·기상청 요청 없음).
--    기준일자를 만들거나 지사 요청이 들어올 때 자료가 15분 넘게 묵었으면 바로 한 번 받음.
--  * 저장 줄이기: 고를 종류만 저장(아래 스위치), 수집 기록은 실패·변화가 있을 때만(7일 보관), pg_cron 실행 기록 2일 보관,
--    특보구역 목록은 매주 월요일 한 번.
--  * 특보 종류 스위치: settings 'warnings' = {"kinds":"all"} 이면 모든 특보(확인용), {"kinds":["대설"]} 이면 대설만(기본).
--    지금은 확인용으로 "all". 대설만으로 돌리기:  update public.settings set value = '{"kinds":["대설"]}' where key = 'warnings';
--  * 관리자 확인용: public.warning_active_list() — 지금 받아 둔 특보 전체(전국)와 수집 상태
-- ============================================================

/* ---------- 1. 특보 종류 스위치 ---------- */
insert into public.settings (key, value) values ('warnings', '{"kinds":"all"}')
on conflict (key) do update set value = excluded.value, updated_at = now();

-- null = 모든 종류
create or replace function private.warn_kinds() returns text[]
language sql stable security definer set search_path = ''
as $$
  select case when (select s.value ->> 'kinds' from public.settings s where s.key = 'warnings') = 'all' then null
              else coalesce((select array(select jsonb_array_elements_text(s.value -> 'kinds')) from public.settings s
                              where s.key = 'warnings' and jsonb_typeof(s.value -> 'kinds') = 'array'), array['대설']) end
$$;
create or replace function private.warn_kind_ok(k text) returns boolean
language sql stable security definer set search_path = ''
as $$ select private.warn_kinds() is null or k = any(private.warn_kinds()) $$;

/* ---------- 2. 받을 필요가 있는지 ---------- */
create or replace function private.warn_needed() returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.support_rounds s
     where s.start_date <= (now() at time zone 'Asia/Seoul')::date
       and s.start_date >= (now() at time zone 'Asia/Seoul')::date - 2
       and (not exists (select 1 from public.round_requests q where q.round_id = s.id and q.confirmed)
            or exists (select 1 from public.round_requests q where q.round_id = s.id and not q.confirmed
                        and (q.req_truck + q.req_blower > 0 or q.snow_cm is not null or q.arrive_at is not null or q.reason is not null))))
$$;

-- 필요할 때만 Edge Function 호출(zones = 특보구역 목록도). 필요 없으면 아무것도 하지 않음
create or replace function private.kick_warnings(p_zones boolean default false) returns bigint
language plpgsql security definer set search_path = ''
as $$
begin
  if not p_zones and not private.warn_needed() then return null; end if;
  insert into public.collector_state as s (job, started_at) values ('warnings_kick', now())
  on conflict (job) do update set started_at = now();
  return net.http_post(
    url := 'https://yzwbnohzhnctdvufntig.supabase.co/functions/v1/collect-warnings',
    body := jsonb_build_object('zones', p_zones),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-collector-token', (select token from private.collector_token where id = 1)),
    timeout_milliseconds := 30000);
end $$;
revoke all on function private.kick_warnings(boolean) from public, anon, authenticated;

-- 기준일자·지사 요청이 바뀔 때: 받을 필요가 생겼는데 자료가 15분 넘게 묵었으면 바로 한 번(2분 안에 두 번은 안 함)
create or replace function private.warn_kick_if_stale() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if private.warn_needed()
     and coalesce((select finished_at from public.collector_state where job = 'warnings'), 'epoch') < now() - interval '15 minutes'
     and coalesce((select started_at from public.collector_state where job = 'warnings_kick'), 'epoch') < now() - interval '2 minutes' then
    perform private.kick_warnings(false);
  end if;
  return null;
end $$;
revoke all on function private.warn_kick_if_stale() from public, anon, authenticated;
drop trigger if exists zz_support_rounds_warn_kick on public.support_rounds;
create trigger zz_support_rounds_warn_kick after insert or update on public.support_rounds for each statement execute function private.warn_kick_if_stale();
drop trigger if exists zz_round_requests_warn_kick on public.round_requests;
create trigger zz_round_requests_warn_kick after insert or update on public.round_requests for each statement execute function private.warn_kick_if_stale();

/* ---------- 3. 넣기: 고른 종류만, 기록은 실패·변화 때만 ---------- */
create or replace function public.ingest_warnings(p jsonb) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare t0 timestamptz := now(); nadd int := 0; ndel int := 0; nupd int := 0; nskip int := 0;
begin
  delete from public.collector_runs where job = 'warnings' and started_at < now() - interval '7 days';
  if not coalesce((p ->> 'ok')::boolean, false) then
    insert into public.collector_runs (job, started_at, finished_at, ok, http_status, ms, calls, error)
    values ('warnings', t0, now(), false, (p ->> 'http')::int, (p ->> 'ms')::int, 1, left(p ->> 'error', 500));
    insert into public.collector_state as s (job, started_at, ok, note) values ('warnings', t0, false, left(p ->> 'error', 500))
    on conflict (job) do update set started_at = t0, ok = false, note = left(p ->> 'error', 500);   -- 마지막 성공 시각(finished_at)은 그대로
    return jsonb_build_object('ok', false);
  end if;
  if jsonb_typeof(p -> 'rows') is distinct from 'array' or jsonb_array_length(p -> 'rows') > 3000 then raise exception 'bad rows' using errcode = '22023'; end if;

  delete from public.warnings_active a where not private.warn_kind_ok(a.kind);          -- 스위치로 뺀 종류는 기록 없이 지움
  drop table if exists _w;
  create temp table _w on commit drop as
    select distinct on (r ->> 'zone', r ->> 'kind', r ->> 'level')
           r ->> 'zone' as zone_code, r ->> 'kind' as kind, r ->> 'level' as level,
           (r ->> 'tm_fc')::timestamptz as issued_at, (r ->> 'tm_ef')::timestamptz as tm_ef, r ->> 'cmd' as cmd, nullif(r ->> 'ed_tm', '') as ed_tm
      from jsonb_array_elements(p -> 'rows') r
     where r ->> 'level' in ('예비', '주의', '경보') and coalesce(r ->> 'zone', '') <> '' and coalesce(r ->> 'kind', '') <> ''
     order by r ->> 'zone', r ->> 'kind', r ->> 'level', r ->> 'tm_fc' desc;
  delete from _w where not private.warn_kind_ok(_w.kind);
  get diagnostics nskip = row_count;

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

  if nadd + ndel + nupd > 0 then                     -- 바뀐 게 없으면 수집 기록을 남기지 않음(상태만 갱신)
    insert into public.collector_runs (job, started_at, finished_at, ok, http_status, ms, calls, error)
    values ('warnings', t0, now(), true, (p ->> 'http')::int, (p ->> 'ms')::int, 1, null);
  end if;
  insert into public.collector_state as s (job, cursor, started_at, finished_at, ok, note) values ('warnings', p ->> 'base', t0, now(), true, null)
  on conflict (job) do update set cursor = excluded.cursor, started_at = t0, finished_at = now(), ok = true, note = null;
  return jsonb_build_object('ok', true, 'added', nadd, 'removed', ndel, 'changed', nupd, 'skipped_kinds', nskip);
end $$;
revoke all on function public.ingest_warnings(jsonb) from public, anon, authenticated;
grant execute on function public.ingest_warnings(jsonb) to service_role;

/* ---------- 4. 지사별 특보(종류 포함) ---------- */
-- 지사·구역·종류마다 가장 높은 단계 한 줄
create or replace function private.warn_rows()
returns table (branch_id text, zone_code text, name text, kind text, level text)
language sql stable security definer set search_path = ''
as $$
  select bz.branch_id, a.zone_code, coalesce(w.name, a.zone_code), a.kind,
         (array_agg(a.level order by private.warn_rank(a.level) desc))[1]
    from (select distinct z.branch_id, z.zone_code from private.branch_zones() z) bz
    join public.warnings_active a on a.zone_code = bz.zone_code and private.warn_kind_ok(a.kind)
    left join public.warning_zones w on w.zone_code = a.zone_code
   group by bz.branch_id, a.zone_code, w.name, a.kind
$$;
revoke all on function private.warn_rows() from public, anon, authenticated;

create or replace function private.warn_note(st public.collector_state) returns text
language sql stable set search_path = ''
as $$
  select case when st.finished_at is not null and st.finished_at >= now() - interval '30 minutes' then null
              when not private.warn_needed() then '수집 쉬는 중 — 확정을 기다리는 기준일자가 없음'
              when st.finished_at is null then '기상청 자료를 아직 받지 못함'
              else '기상청 자료를 30분 넘게 받지 못함' end
$$;
revoke all on function private.warn_note(public.collector_state), private.warn_kinds(), private.warn_kind_ok(text), private.warn_needed() from public, anon, authenticated;

-- 한 지사의 지금 특보 { level, kind, zones:[[코드, 이름, 단계, 종류]…], base, note }
create or replace function private.branch_warn(p_branch text) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare st public.collector_state; z jsonb; n text;
begin
  select * into st from public.collector_state where job = 'warnings';
  n := private.warn_note(st);
  if n is not null then return jsonb_build_object('level', null, 'kind', null, 'zones', '[]'::jsonb, 'base', st.cursor, 'note', n); end if;
  select coalesce(jsonb_agg(jsonb_build_array(x.zone_code, x.name, x.level, x.kind) order by private.warn_rank(x.level) desc, x.kind <> '대설', x.kind, x.name), '[]'::jsonb)
    into z from private.warn_rows() x where x.branch_id = p_branch;
  return jsonb_build_object('level', z -> 0 ->> 2, 'kind', z -> 0 ->> 3, 'zones', z, 'base', st.cursor, 'note', null);
end $$;
revoke all on function private.branch_warn(text) from public, anon;

create or replace function public.warning_status() returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare st public.collector_state; br jsonb; n text; need boolean := private.warn_needed(); allk boolean := private.warn_kinds() is null;
begin
  if (select private.my_role()) is null then raise exception 'login required' using errcode = '42501'; end if;
  select * into st from public.collector_state where job = 'warnings';
  n := private.warn_note(st);
  if n is not null then
    return jsonb_build_object('ok', false, 'paused', not need, 'all', allk, 'base', st.cursor, 'fetched_at', st.finished_at, 'branches', '{}'::jsonb, 'note', n);
  end if;
  select coalesce(jsonb_object_agg(b.branch_id, jsonb_build_object('level', b.zones -> 0 ->> 2, 'kind', b.zones -> 0 ->> 3, 'zones', b.zones)), '{}'::jsonb) into br
    from (select x.branch_id, jsonb_agg(jsonb_build_array(x.zone_code, x.name, x.level, x.kind) order by private.warn_rank(x.level) desc, x.kind <> '대설', x.kind, x.name) as zones
            from private.warn_rows() x group by x.branch_id) b;
  return jsonb_build_object('ok', true, 'paused', not need, 'all', allk, 'base', st.cursor, 'fetched_at', st.finished_at, 'branches', br, 'note', null);
end $$;
revoke all on function public.warning_status() from public, anon;
grant execute on function public.warning_status() to authenticated;

-- 관리자 확인용: 지금 받아 둔 특보 전체(전국, 지사와 이어지지 않은 구역 포함)와 수집 상태
create or replace function public.warning_active_list() returns jsonb
language sql stable security definer set search_path = ''
as $$
  select case when (select private.my_role()) <> 'admin' then null else jsonb_build_object(
    'state', (select jsonb_build_object('base', s.cursor, 'fetched_at', s.finished_at, 'ok', s.ok, 'note', s.note) from public.collector_state s where s.job = 'warnings'),
    'needed', private.warn_needed(), 'all', private.warn_kinds() is null,
    'rows', coalesce((select jsonb_agg(jsonb_build_object('zone', a.zone_code, 'name', coalesce(w.name, a.zone_code), 'kind', a.kind, 'level', a.level,
                                                         'tm_fc', a.issued_at, 'tm_ef', a.tm_ef, 'cmd', a.cmd,
                                                         'branches', (select coalesce(jsonb_agg(distinct z.branch_id), '[]'::jsonb) from private.branch_zones() z where z.zone_code = a.zone_code))
                                      order by private.warn_rank(a.level) desc, a.kind, w.name)
                        from public.warnings_active a left join public.warning_zones w on w.zone_code = a.zone_code), '[]'::jsonb)) end
$$;
revoke all on function public.warning_active_list() from public, anon;
grant execute on function public.warning_active_list() to authenticated;

/* ---------- 5. 예약 다시 잡기 ---------- */
select cron.unschedule(jobid) from cron.job where jobname in ('collect-warnings', 'collect-warning-zones', 'cron-history-cleanup');
select cron.schedule('collect-warnings', '1-59/10 * * * *', 'select private.kick_warnings(false)');
select cron.schedule('collect-warning-zones', '17 4 * * 1', 'select private.kick_warnings(true)');            -- 특보구역 목록: 매주 월요일
select cron.schedule('cron-history-cleanup', '23 3 * * *', $$delete from cron.job_run_details where end_time < now() - interval '2 days'$$);
