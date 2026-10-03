-- ============================================================
-- 기준정보 이전용 함수: 구간·관측소·지사별 관측소·예보 격자 편입의 "기본(baseline)" 자료를 한 번에, 전부 성공하거나 전부 취소되게 교체한다.
--  * 서버 함수(import-reference, service_role)만 호출할 수 있다. 로그인 사용자·비로그인은 호출 불가.
--  * 관할 변경 이력(jurisdiction_events)·격자 변경 이력(grid_events)은 건드리지 않는다(기본 자료 위에 쌓이는 변경이므로).
--  * 실행 기록은 접속·수정 기록(audit_log)에 남는다.
-- (처음 버전. API 경로의 "WHERE 없는 DELETE 금지" 안전장치 때문에 08 에서 `where true` 를 붙여 다시 정의함)
-- ============================================================
create or replace function public.admin_import_reference(payload jsonb) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare n_st int; n_sec int; n_bs int; n_gr int; counts jsonb;
begin
  if jsonb_typeof(payload) <> 'object'
     or jsonb_typeof(payload -> 'stations') <> 'array' or jsonb_typeof(payload -> 'sections') <> 'array'
     or jsonb_typeof(payload -> 'branch_stations') <> 'array' or jsonb_typeof(payload -> 'grid_assign') <> 'array' then
    raise exception 'bad payload' using errcode = '22023';
  end if;

  delete from public.grid_assign;           -- 자식 → 부모 순서로 지우고
  delete from public.branch_stations;
  delete from public.sections;
  delete from public.stations;

  insert into public.stations        select * from jsonb_populate_recordset(null::public.stations,        payload -> 'stations');        get diagnostics n_st  = row_count;   -- 부모 → 자식 순서로 넣는다
  insert into public.sections        select * from jsonb_populate_recordset(null::public.sections,        payload -> 'sections');        get diagnostics n_sec = row_count;
  insert into public.branch_stations select * from jsonb_populate_recordset(null::public.branch_stations, payload -> 'branch_stations'); get diagnostics n_bs  = row_count;
  insert into public.grid_assign     select * from jsonb_populate_recordset(null::public.grid_assign,     payload -> 'grid_assign');     get diagnostics n_gr  = row_count;

  counts := jsonb_build_object('stations', n_st, 'sections', n_sec, 'branch_stations', n_bs, 'grid_assign', n_gr);
  insert into public.audit_log (username, kind, tab, target, to_val) values ('import-reference', '기준정보이전', 'import', 'sections,stations,branch_stations,grid_assign', counts);
  return counts;
end $$;
revoke all on function public.admin_import_reference(jsonb) from public, anon, authenticated;
grant execute on function public.admin_import_reference(jsonb) to service_role;
