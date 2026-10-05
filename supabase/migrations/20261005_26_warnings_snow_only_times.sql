-- ============================================================
-- 26. 지사별 요청·편성은 대설특보(예비·주의보·경보)만 + 발표·발효 시각 (2026-10-05 사용자 결정)
--  * 저장은 settings('warnings') 스위치대로(지금 "all" — 관리자 [특보구역 관리]의 '지금 받은 특보' 종류별 탭에 씀)
--  * 지사별 표시·확정 고정은 항상 대설만(private.warn_rows)
--  * 구역 줄 = [코드, 이름, 단계, 종류, 발표 시각, 발효 시각] (예비특보의 발효 시각은 기상청 약속 시각: 05:58 = 새벽(00~06시) 등)
--  * 지난 특보(warnings_history)에는 대설만 남김(DB 절약)
-- ============================================================
drop function if exists private.warn_rows();          -- 돌려주는 열이 늘어 새로 만듦
create or replace function private.warn_rows()
returns table (branch_id text, zone_code text, name text, kind text, level text, tm_fc timestamptz, tm_ef timestamptz)
language sql stable security definer set search_path = ''
as $$
  select bz.branch_id, a.zone_code, coalesce(w.name, a.zone_code), a.kind,
         (array_agg(a.level order by private.warn_rank(a.level) desc))[1],
         (array_agg(a.issued_at order by private.warn_rank(a.level) desc))[1],
         (array_agg(a.tm_ef order by private.warn_rank(a.level) desc))[1]
    from (select distinct z.branch_id, z.zone_code from private.branch_zones() z) bz
    join public.warnings_active a on a.zone_code = bz.zone_code and a.kind = '대설'
    left join public.warning_zones w on w.zone_code = a.zone_code
   group by bz.branch_id, a.zone_code, w.name, a.kind
$$;
revoke all on function private.warn_rows() from public, anon, authenticated;

create or replace function private.branch_warn(p_branch text) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare st public.collector_state; z jsonb; n text;
begin
  select * into st from public.collector_state where job = 'warnings';
  n := private.warn_note(st);
  if n is not null then return jsonb_build_object('level', null, 'kind', null, 'zones', '[]'::jsonb, 'base', st.cursor, 'note', n); end if;
  select coalesce(jsonb_agg(jsonb_build_array(x.zone_code, x.name, x.level, x.kind, x.tm_fc, x.tm_ef) order by private.warn_rank(x.level) desc, x.tm_fc desc nulls last, x.name), '[]'::jsonb)
    into z from private.warn_rows() x where x.branch_id = p_branch;
  return jsonb_build_object('level', z -> 0 ->> 2, 'kind', z -> 0 ->> 3, 'zones', z, 'base', st.cursor, 'note', null);
end $$;
revoke all on function private.branch_warn(text) from public, anon;

create or replace function public.warning_status() returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare st public.collector_state; br jsonb; n text; need boolean := private.warn_needed();
begin
  if (select private.my_role()) is null then raise exception 'login required' using errcode = '42501'; end if;
  select * into st from public.collector_state where job = 'warnings';
  n := private.warn_note(st);
  if n is not null then
    return jsonb_build_object('ok', false, 'paused', not need, 'all', false, 'base', st.cursor, 'fetched_at', st.finished_at, 'branches', '{}'::jsonb, 'note', n);
  end if;
  select coalesce(jsonb_object_agg(b.branch_id, jsonb_build_object('level', b.zones -> 0 ->> 2, 'kind', b.zones -> 0 ->> 3, 'zones', b.zones)), '{}'::jsonb) into br
    from (select x.branch_id, jsonb_agg(jsonb_build_array(x.zone_code, x.name, x.level, x.kind, x.tm_fc, x.tm_ef) order by private.warn_rank(x.level) desc, x.tm_fc desc nulls last, x.name) as zones
            from private.warn_rows() x group by x.branch_id) b;
  return jsonb_build_object('ok', true, 'paused', not need, 'all', false, 'base', st.cursor, 'fetched_at', st.finished_at, 'branches', br, 'note', null);
end $$;
revoke all on function public.warning_status() from public, anon;
grant execute on function public.warning_status() to authenticated;

-- 지난 특보는 대설만
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
    on conflict (job) do update set started_at = t0, ok = false, note = left(p ->> 'error', 500);
    return jsonb_build_object('ok', false);
  end if;
  if jsonb_typeof(p -> 'rows') is distinct from 'array' or jsonb_array_length(p -> 'rows') > 3000 then raise exception 'bad rows' using errcode = '22023'; end if;

  delete from public.warnings_active a where not private.warn_kind_ok(a.kind);
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
  select zone_code, kind, level, first_seen, now(), issued_at from gone where kind = '대설';
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

  if nadd + ndel + nupd > 0 then
    insert into public.collector_runs (job, started_at, finished_at, ok, http_status, ms, calls, error)
    values ('warnings', t0, now(), true, (p ->> 'http')::int, (p ->> 'ms')::int, 1, null);
  end if;
  insert into public.collector_state as s (job, cursor, started_at, finished_at, ok, note) values ('warnings', p ->> 'base', t0, now(), true, null)
  on conflict (job) do update set cursor = excluded.cursor, started_at = t0, finished_at = now(), ok = true, note = null;
  return jsonb_build_object('ok', true, 'added', nadd, 'removed', ndel, 'changed', nupd, 'skipped_kinds', nskip);
end $$;
revoke all on function public.ingest_warnings(jsonb) from public, anon, authenticated;
grant execute on function public.ingest_warnings(jsonb) to service_role;
