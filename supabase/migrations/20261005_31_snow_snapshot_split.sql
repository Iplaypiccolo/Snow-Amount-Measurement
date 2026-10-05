-- ============================================================
-- 31. 적설 요약본을 시즌별로 나누고, 화면이 쓰는 관측소만 담기 (2026-10-05 사용자 결정 — 내려받는 양 줄이기)
--  * 예전: snapshots 'snow' 한 줄에 9시즌 · 관측소 670곳 전부(약 1.4MB) → 접속할 때마다(바뀌었을 때) 통째로 받음
--  * 지금: 'snow'        = 목록만 { version:2, seasons:[{label, days, data_days, stations}] } (1KB 안팎)
--          'snow:<시즌>' = 그 시즌 { dates, st } — 좌표가 있어 화면이 쓰는 관측소(public.stations, 260곳)만
--    화면은 최근 시즌 하나만 먼저 받고, 다른 시즌은 고를 때(또는 관할 미리보기·엑셀 받기 때) 받음
--  * 원자료(snow_daily)는 670곳 전부 그대로 둠(나중에 관측소를 더 쓰면 요약본에 다시 넣으면 됨)
--  * 다시 만들 때 내용이 같은 시즌은 built_at 을 바꾸지 않음 → 브라우저에 보관한 것을 다시 받지 않음
-- ============================================================
create or replace function public.admin_rebuild_snow_snapshot() returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare n_seasons int; n_values int; n_changed int := 0; idx jsonb; r record;
begin
  drop table if exists _ss;
  create temp table _ss on commit drop as
  with yrs as (
    select distinct case when extract(month from date) >= 11 then extract(year from date)::int else extract(year from date)::int - 1 end as y
    from public.snow_daily
  ), days as (
    select y, g::date as date, row_number() over (partition by y order by g) as i
    from yrs, generate_series(make_date(y, 11, 15), make_date(y + 1, 3, 15), interval '1 day') g
  ), vals as (                                   -- 화면이 쓰는 관측소(좌표 있는 260곳)만
    select d.y, s.station_id, d.i, s.value
    from public.snow_daily s join days d on d.date = s.date
    where exists (select 1 from public.stations t where t.id = s.station_id)
  ), st as (                                     -- 시즌·관측소별 값 배열(날짜 순서, 없는 날은 null)
    select v.y, v.station_id, jsonb_agg(x.value order by dd.i) as arr
    from (select distinct y, station_id from vals) v
    join days dd on dd.y = v.y
    left join vals x on x.y = v.y and x.station_id = v.station_id and x.i = dd.i
    group by v.y, v.station_id
  )
  select y, y || '-11-15~' || (y + 1) || '-03-15' as label,
    jsonb_build_object(
      'dates', (select jsonb_agg(to_char(date, 'YYYYMMDD') order by i) from days where days.y = yrs.y),
      'st', coalesce((select jsonb_object_agg(station_id::text, arr) from st where st.y = yrs.y), '{}'::jsonb)) as body,
    (select count(*) from days where days.y = yrs.y)::int as n_days,
    (select count(distinct i) from vals where vals.y = yrs.y)::int as n_data_days,
    (select count(*) from st where st.y = yrs.y)::int as n_stations
  from yrs;

  for r in select * from _ss loop
    insert into public.snapshots (key, version, built_at, body) values ('snow:' || r.label, 1, now(), r.body)
      on conflict (key) do update set version = public.snapshots.version + 1, built_at = now(), body = excluded.body
      where public.snapshots.body is distinct from excluded.body;
    if found then n_changed := n_changed + 1; end if;
  end loop;
  delete from public.snapshots s where s.key like 'snow:%' and substr(s.key, 6) not in (select label from _ss);

  select coalesce(jsonb_agg(jsonb_build_object('label', label, 'days', n_days, 'data_days', n_data_days, 'stations', n_stations) order by y), '[]'::jsonb), count(*)
    into idx, n_seasons from _ss;
  insert into public.snapshots (key, version, built_at, body) values ('snow', 2, now(), jsonb_build_object('version', 2, 'seasons', idx))
    on conflict (key) do update set version = public.snapshots.version + 1, built_at = now(), body = excluded.body
    where public.snapshots.body is distinct from excluded.body;

  select count(*) into n_values from public.snow_daily;
  insert into public.audit_log (username, kind, tab, target, to_val)
    values ('import-snow', '적설요약갱신', 'snapshots', 'snapshots:snow', jsonb_build_object('seasons', n_seasons, 'changed', n_changed, 'values', n_values));
  return jsonb_build_object('seasons', n_seasons, 'changed', n_changed, 'values', n_values);
end $$;
revoke all on function public.admin_rebuild_snow_snapshot() from public, anon, authenticated;
grant execute on function public.admin_rebuild_snow_snapshot() to service_role;

select public.admin_rebuild_snow_snapshot();
