-- ============================================================
-- 보안: 역할 도우미 함수, 행 단위 권한(RLS), 접속·수정 기록(트리거)
-- 역할: admin(관리자) / branch(피지원지사: 본인 지사 행만) / equip(지원장비)
-- 원칙: ① 기본은 "아무것도 못 함", 필요한 것만 허용 ② 비로그인(anon)은 전부 차단
--       ③ 기록(audit_log)은 DB 트리거만 쓰고 아무도 고치거나 지울 수 없음 ④ 작성자(by_user 등)는 클라이언트가 속일 수 없게 DB가 채움
-- ============================================================

/* ---------- 1. 도우미 함수 (private 스키마: API 로 노출되지 않음) ---------- */
create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated;

create or replace function private.my_role() returns text
language sql stable security definer set search_path = ''
as $$ select p.role from public.profiles p where p.id = (select auth.uid()) and not p.disabled $$;

create or replace function private.my_branch() returns text
language sql stable security definer set search_path = ''
as $$ select p.branch_id from public.profiles p where p.id = (select auth.uid()) and not p.disabled $$;

revoke all on function private.my_role(), private.my_branch() from public, anon;
grant execute on function private.my_role(), private.my_branch() to authenticated;

/* ---------- 2. 기본 권한 정리: 비로그인(anon)은 아무 표도 못 봄, 로그인 사용자도 TRUNCATE 등 위험한 권한 제거 ---------- */
revoke all on all tables    in schema public from anon;
revoke all on all sequences in schema public from anon;
revoke all on all functions in schema public from anon;
alter default privileges in schema public revoke all on tables    from anon;
alter default privileges in schema public revoke all on sequences from anon;
alter default privileges in schema public revoke all on functions from anon;
revoke truncate, references, trigger on all tables in schema public from authenticated;
alter default privileges in schema public revoke truncate, references, trigger on tables from authenticated;
-- 서버(수집 함수)만 쓰는 표: 로그인 사용자의 쓰기 권한 자체를 없앰
revoke insert, update, delete on public.audit_log, public.collector_state, public.collector_runs,
  public.forecast_cells, public.branch_forecast, public.warnings_active, public.warnings_history from authenticated;

/* ---------- 3. 작성자·시각을 DB가 채우는 트리거 (클라이언트가 속일 수 없게) ---------- */
create or replace function private.stamp() returns trigger
language plpgsql set search_path = ''
as $$
declare j jsonb := jsonb_build_object(tg_argv[0], (select auth.uid()));
begin
  if tg_nargs > 1 then j := j || jsonb_build_object(tg_argv[1], now()); end if;
  new := jsonb_populate_record(new, j);
  return new;
end $$;
revoke all on function private.stamp() from public, anon;

create trigger stamp_support_rounds     before insert           on public.support_rounds       for each row execute function private.stamp('created_by');
create trigger stamp_round_requests     before insert or update on public.round_requests      for each row execute function private.stamp('updated_by', 'updated_at');
create trigger stamp_snow_uploads       before insert           on public.snow_uploads         for each row execute function private.stamp('by_user');
create trigger stamp_jurisdiction_events before insert          on public.jurisdiction_events  for each row execute function private.stamp('by_user');
create trigger stamp_grid_events        before insert           on public.grid_events          for each row execute function private.stamp('by_user');

/* ---------- 4. 접속·수정 기록: 누가·언제·무엇을·어디서(IP). DB가 직접 기록 ---------- */
create or replace function private.audit_row() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  newj jsonb; oldj jsonb; fromj jsonb := '{}'::jsonb; toj jsonb := '{}'::jsonb;
  k text := ''; i int; col text; uname text; urole text; h jsonb; ip text;
begin
  if tg_op <> 'INSERT' then oldj := to_jsonb(old); end if;
  if tg_op <> 'DELETE' then newj := to_jsonb(new); end if;
  for i in 0 .. tg_nargs - 1 loop
    k := k || case when k = '' then '' else ',' end || coalesce(coalesce(newj, oldj) ->> tg_argv[i], '');
  end loop;
  if tg_op = 'UPDATE' then
    for col in select jsonb_object_keys(newj) loop
      if (oldj -> col) is distinct from (newj -> col) and col not in ('updated_at', 'updated_by') then
        fromj := fromj || jsonb_build_object(col, oldj -> col);
        toj   := toj   || jsonb_build_object(col, newj -> col);
      end if;
    end loop;
    if toj = '{}'::jsonb then return new; end if;          -- 의미 있는 변경이 없으면 기록하지 않음
  elsif tg_op = 'INSERT' then toj := newj;
  else fromj := oldj;
  end if;
  select p.username, p.role into uname, urole from public.profiles p where p.id = (select auth.uid());
  h := nullif(current_setting('request.headers', true), '')::jsonb;
  ip := coalesce(h ->> 'cf-connecting-ip', nullif(split_part(coalesce(h ->> 'x-forwarded-for', ''), ',', 1), ''));
  insert into public.audit_log (user_id, username, role, kind, tab, target, from_val, to_val, ip)
  values ((select auth.uid()), coalesce(uname, current_user), urole,
          case tg_op when 'INSERT' then '추가' when 'UPDATE' then '수정' else '삭제' end,
          tg_table_name, tg_table_name || ':' || k, nullif(fromj, '{}'::jsonb), nullif(toj, '{}'::jsonb), ip);
  return coalesce(new, old);
end $$;
revoke all on function private.audit_row() from public, anon;

create trigger audit_vehicles            after insert or update or delete on public.vehicles            for each row execute function private.audit_row('plate');
create trigger audit_support_rounds      after insert or update or delete on public.support_rounds      for each row execute function private.audit_row('id');
create trigger audit_round_vehicles      after insert or update or delete on public.round_vehicles      for each row execute function private.audit_row('round_id', 'plate');
create trigger audit_round_vehicle_days  after insert or update or delete on public.round_vehicle_days  for each row execute function private.audit_row('round_id', 'plate', 'date', 'seq');
create trigger audit_round_requests      after insert or update or delete on public.round_requests      for each row execute function private.audit_row('round_id', 'branch_id');
create trigger audit_branches            after insert or update or delete on public.branches            for each row execute function private.audit_row('id');
create trigger audit_hqs                 after insert or update or delete on public.hqs                 for each row execute function private.audit_row('id');
create trigger audit_profiles            after insert or update or delete on public.profiles            for each row execute function private.audit_row('id');
create trigger audit_snow_uploads        after insert                     on public.snow_uploads        for each row execute function private.audit_row('id');
create trigger audit_jurisdiction_events after insert                     on public.jurisdiction_events for each row execute function private.audit_row('id');
create trigger audit_grid_events         after insert                     on public.grid_events         for each row execute function private.audit_row('id');

-- 기록은 누구도(관리자·서버 포함) 고치거나 지울 수 없음
create or replace function private.audit_immutable() returns trigger
language plpgsql set search_path = ''
as $$ begin raise exception 'audit_log is append-only' using errcode = '42501'; end $$;
revoke all on function private.audit_immutable() from public, anon;
create trigger audit_log_no_change before update or delete on public.audit_log for each row execute function private.audit_immutable();
create trigger audit_log_no_truncate before truncate on public.audit_log for each statement execute function private.audit_immutable();

/* ---------- 5. 행 단위 권한(RLS) ---------- */
do $$
declare t text;
begin
  -- (가) 기준정보·요약본: 로그인한 활성 사용자는 읽기, 관리자만 쓰기
  foreach t in array array['hqs','branches','sections','stations','branch_stations','grid_assign','warning_zones','cell_zone',
                           'equip_orgs','support_rounds','snapshots','snow_daily','settings'] loop
    execute format('alter table public.%I enable row level security', t);
    if t = 'settings' then   -- 설정은 관리자만 읽고 쓴다
      execute format('create policy %I on public.%I for select to authenticated using ((select private.my_role()) = %L)', t || '_read', t, 'admin');
    else
      execute format('create policy %I on public.%I for select to authenticated using ((select private.my_role()) is not null)', t || '_read', t);
    end if;
    execute format('create policy %I on public.%I for insert to authenticated with check ((select private.my_role()) = %L)', t || '_ins', t, 'admin');
    execute format('create policy %I on public.%I for update to authenticated using ((select private.my_role()) = %L) with check ((select private.my_role()) = %L)', t || '_upd', t, 'admin', 'admin');
    execute format('create policy %I on public.%I for delete to authenticated using ((select private.my_role()) = %L)', t || '_del', t, 'admin');
  end loop;

  -- (나) 장비: 관리자·지원장비가 수정
  foreach t in array array['vehicles','round_vehicles','round_vehicle_days'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy %I on public.%I for select to authenticated using ((select private.my_role()) is not null)', t || '_read', t);
    execute format('create policy %I on public.%I for insert to authenticated with check ((select private.my_role()) in (%L, %L))', t || '_ins', t, 'admin', 'equip');
    execute format('create policy %I on public.%I for update to authenticated using ((select private.my_role()) in (%L, %L)) with check ((select private.my_role()) in (%L, %L))', t || '_upd', t, 'admin', 'equip', 'admin', 'equip');
    execute format('create policy %I on public.%I for delete to authenticated using ((select private.my_role()) in (%L, %L))', t || '_del', t, 'admin', 'equip');
  end loop;

  -- (다) 변경 이력·읽기 전용 기상 데이터: 모두 읽기, 이력은 관리자만 추가, 기상 데이터는 서버(service role)만 씀
  foreach t in array array['jurisdiction_events','grid_events'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy %I on public.%I for select to authenticated using ((select private.my_role()) is not null)', t || '_read', t);
    execute format('create policy %I on public.%I for insert to authenticated with check ((select private.my_role()) = %L)', t || '_ins', t, 'admin');
  end loop;
  foreach t in array array['forecast_cells','branch_forecast','warnings_active','warnings_history'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy %I on public.%I for select to authenticated using ((select private.my_role()) is not null)', t || '_read', t);
  end loop;

  -- (라) 관리자만 읽는 표
  foreach t in array array['collector_state','collector_runs','audit_log'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy %I on public.%I for select to authenticated using ((select private.my_role()) = %L)', t || '_read', t, 'admin');
  end loop;
  alter table public.snow_uploads enable row level security;
  create policy snow_uploads_read on public.snow_uploads for select to authenticated using ((select private.my_role()) = 'admin');
  create policy snow_uploads_ins  on public.snow_uploads for insert to authenticated with check ((select private.my_role()) = 'admin');
end $$;

-- 지사별 요청·편성: 관리자는 전체, 피지원지사는 "본인 지사" 행만 (읽기는 모두)
alter table public.round_requests enable row level security;
create policy round_requests_read on public.round_requests for select to authenticated using ((select private.my_role()) is not null);
create policy round_requests_ins  on public.round_requests for insert to authenticated
  with check ((select private.my_role()) = 'admin' or ((select private.my_role()) = 'branch' and branch_id = (select private.my_branch())));
create policy round_requests_upd  on public.round_requests for update to authenticated
  using      ((select private.my_role()) = 'admin' or ((select private.my_role()) = 'branch' and branch_id = (select private.my_branch())))
  with check ((select private.my_role()) = 'admin' or ((select private.my_role()) = 'branch' and branch_id = (select private.my_branch())));
create policy round_requests_del  on public.round_requests for delete to authenticated using ((select private.my_role()) = 'admin');

-- 계정(profiles): 본인 것만 읽기(관리자는 전체), 만들기·고치기·지우기는 관리자만 → 본인이 역할을 바꿀 수 없음
alter table public.profiles enable row level security;
create policy profiles_read on public.profiles for select to authenticated using (id = (select auth.uid()) or (select private.my_role()) = 'admin');
create policy profiles_ins  on public.profiles for insert to authenticated with check ((select private.my_role()) = 'admin');
create policy profiles_upd  on public.profiles for update to authenticated using ((select private.my_role()) = 'admin') with check ((select private.my_role()) = 'admin');
create policy profiles_del  on public.profiles for delete to authenticated using ((select private.my_role()) = 'admin');
