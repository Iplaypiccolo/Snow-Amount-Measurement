-- ============================================================
-- 29. 특보·예상 적설/강수를 항상 받기 + 지난 특보 기록 안 남김 (2026-10-05 사용자 결정)
--  * 기준일자·확정과 관계없이 늘 받음: 특보 10분마다(01·11…분), 예보는 단기예보 발표마다(02·05…시 15분, 못 받은 시각은 25·35·45분)
--    → 서버가 늘 움직이므로 무료 플랜 7일 휴면 정지도 막는 효과(깨우기 예약은 보험으로 그대로 둠)
--  * 저장은 "지금 값"만: warnings_active·forecast_cells·branch_forecast 는 덮어쓰고, 지난 특보(warnings_history)는 남기지 않음
--    확정할 때의 값은 round_requests(warn_*·fc_*)에 고정(그대로)
--  * private.warn_needed() 를 늘 참으로(받을지 판단하던 함수. 부르는 곳은 그대로 둠)
-- ============================================================
create or replace function private.warn_needed() returns boolean
language sql stable security definer set search_path = ''
as $$ select true $$;
revoke all on function private.warn_needed() from public, anon, authenticated;

-- 끝난 특보는 기록 없이 지움(이전 내역 저장 안 함)
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

  delete from public.warnings_active a
   where not exists (select 1 from _w where _w.zone_code = a.zone_code and _w.kind = a.kind and _w.level = a.level);
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

delete from public.warnings_history;
