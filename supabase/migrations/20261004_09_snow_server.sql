-- ============================================================
-- 적설(일 신적설)을 서버에 저장하고, 화면은 요약본(snapshots 'snow') 한 줄만 읽는다.
--  * 원자료: snow_daily(date, station_id, value) — 관측소별 하루 값. 기상청 결측 표시(-99.9 등 음수)는 넣지 않는다.
--  * 관측소는 자료가 있는 680곳 전부를 받는다. 좌표가 있는 관측소(stations)는 260곳뿐이라 외래키를 푼다
--    (나머지는 관할이 바뀌어 새로 편입될 때 쓰일 수 있는 자료).
--  * 요약본: 시즌(11.15~익년 3.15)별 { dates:[YYYYMMDD…], st:{관측소번호:[값|null…]} }. 지사별 값(최댓값)은 화면이 관할에 맞춰 계산한다.
--  * 넣기·요약본 만들기는 서버 함수(import-snow, service_role)만 호출할 수 있다.
-- ============================================================
alter table public.snow_daily drop constraint if exists snow_daily_station_id_fkey;

-- 넣기: p = { "관측소번호": { "YYYYMMDD": 값, … }, … }
--   overwrite = false 면 이미 있는 값은 그대로 두고 새 값만 넣음, true 면 다른 값은 바꿈
--   dry = true 면 아무것도 바꾸지 않고 개수만 셈(검사)
create or replace function public.admin_import_snow(p jsonb, overwrite boolean default false, dry boolean default true) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare r jsonb; n_new int; n_changed int; n_same int; n_skip int; n_out int; n_written int := 0;
begin
  if jsonb_typeof(p) <> 'object' then raise exception 'bad payload' using errcode = '22023'; end if;
  create temp table _in on commit drop as
    select s.key::int as station_id, to_date(d.key, 'YYYYMMDD') as date, (d.value #>> '{}')::double precision as value
    from jsonb_each(p) s, jsonb_each(s.value) d
    where s.key ~ '^[0-9]{1,6}$' and d.key ~ '^[0-9]{8}$' and jsonb_typeof(d.value) = 'number';
  select count(*) filter (where value < 0) into n_skip from _in;                                      -- 결측 표시(-99.9)
  select count(*) filter (where value >= 0 and not (
      (extract(month from date) = 11 and extract(day from date) >= 15) or extract(month from date) in (12, 1, 2)
      or (extract(month from date) = 3 and extract(day from date) <= 15))) into n_out from _in;       -- 시즌(11.15~3.15) 밖
  delete from _in where value < 0 or not (
      (extract(month from date) = 11 and extract(day from date) >= 15) or extract(month from date) in (12, 1, 2)
      or (extract(month from date) = 3 and extract(day from date) <= 15));
  select count(*) filter (where d.station_id is null),
         count(*) filter (where d.station_id is not null and d.value is distinct from i.value),
         count(*) filter (where d.station_id is not null and d.value is not distinct from i.value)
    into n_new, n_changed, n_same
    from _in i left join public.snow_daily d on d.date = i.date and d.station_id = i.station_id;
  if not dry then
    if overwrite then
      insert into public.snow_daily (date, station_id, value) select date, station_id, value from _in
        on conflict (date, station_id) do update set value = excluded.value where public.snow_daily.value is distinct from excluded.value;
    else
      insert into public.snow_daily (date, station_id, value) select date, station_id, value from _in
        on conflict (date, station_id) do nothing;
    end if;
    get diagnostics n_written = row_count;
  end if;
  return jsonb_build_object('new', n_new, 'changed', n_changed, 'same', n_same, 'skipped_missing', n_skip, 'skipped_out_of_season', n_out,
                            'written', n_written, 'dry', dry, 'overwrite', overwrite);
end $$;
revoke all on function public.admin_import_snow(jsonb, boolean, boolean) from public, anon, authenticated;
grant execute on function public.admin_import_snow(jsonb, boolean, boolean) to service_role;

-- 요약본 만들기: snow_daily 전체 → snapshots('snow'). 넣기가 끝날 때마다 한 번 부른다.
create or replace function public.admin_rebuild_snow_snapshot() returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare b jsonb; n_seasons int; n_values int;
begin
  with yrs as (
    select distinct case when extract(month from date) >= 11 then extract(year from date)::int else extract(year from date)::int - 1 end as y
    from public.snow_daily
  ), days as (
    select y, g::date as date, row_number() over (partition by y order by g) as i
    from yrs, generate_series(make_date(y, 11, 15), make_date(y + 1, 3, 15), interval '1 day') g
  ), vals as (
    select d.y, s.station_id, d.i, s.value
    from public.snow_daily s join days d on d.date = s.date
  ), st as (                                     -- 시즌·관측소별 값 배열(날짜 순서, 없는 날은 null)
    select v.y, v.station_id, jsonb_agg(x.value order by dd.i) as arr
    from (select distinct y, station_id from vals) v
    join days dd on dd.y = v.y
    left join vals x on x.y = v.y and x.station_id = v.station_id and x.i = dd.i
    group by v.y, v.station_id
  ), seasons as (
    select y,
      jsonb_build_object(
        'dates', (select jsonb_agg(to_char(date, 'YYYYMMDD') order by i) from days where days.y = yrs.y),
        'st', coalesce((select jsonb_object_agg(station_id::text, arr) from st where st.y = yrs.y), '{}'::jsonb)) as body
    from yrs
  )
  select jsonb_build_object('version', 1, 'seasons', coalesce(jsonb_object_agg(y || '-11-15~' || (y + 1) || '-03-15', body), '{}'::jsonb)), count(*)
    into b, n_seasons from seasons;
  insert into public.snapshots (key, version, built_at, body) values ('snow', 1, now(), b)
    on conflict (key) do update set version = public.snapshots.version + 1, built_at = now(), body = excluded.body;
  select count(*) into n_values from public.snow_daily;
  insert into public.audit_log (username, kind, tab, target, to_val)
    values ('import-snow', '적설요약갱신', 'snapshots', 'snapshots:snow', jsonb_build_object('seasons', n_seasons, 'values', n_values));
  return jsonb_build_object('seasons', n_seasons, 'values', n_values);
end $$;
revoke all on function public.admin_rebuild_snow_snapshot() from public, anon, authenticated;
grant execute on function public.admin_rebuild_snow_snapshot() to service_role;
