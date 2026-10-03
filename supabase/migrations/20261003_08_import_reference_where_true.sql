-- Supabase 의 API 경로에는 "WHERE 없는 DELETE 금지(pg_safeupdate)" 안전장치가 있어서, 전체 교체용 삭제에 `where true` 를 붙인다. (의미는 같음: 전부 삭제)
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

  delete from public.grid_assign where true;           -- 자식 → 부모 순서로 지우고
  delete from public.branch_stations where true;
  delete from public.sections where true;
  delete from public.stations where true;

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
