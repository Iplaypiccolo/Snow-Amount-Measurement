-- ============================================================
-- 47. 적설 시즌 = 첫눈 ~ 마지막 눈 (2026-10-18·30 사용자 결정)
--  * 수집 기간: 11.1 ~ 익년 4.30 (예전 11.15 ~ 3.15). 매일 수집(collect-snow)·예약도 4월까지
--  * 눈 온 날 = 관할 관측소(stations, 260곳) 중 한 곳이라도 일 신적설 0.1cm 이상
--  * 시즌 기간 = 그 수집 기간의 첫눈 ~ 마지막 눈. 오늘(한국)이 수집 기간 안이면 '진행 중' → 첫눈 ~ 자료가 있는 마지막 날
--    첫눈 전에는 그 시즌이 목록에 없음(화면은 지난 시즌을 보여 줌)
--  * 시즌 이름 'YYYY-YY'(예: 2025-26). 요약본 'snow:2025-26'. 예전 이름('snow:2025-11-15~2026-03-15' 등) 요약본은 다시 만들 때 지워짐
--  * 목록('snow')에 시즌마다 start·end(YYYYMMDD)·ongoing, 최근 사흘 중 24시각을 다 못 받은 날(partial, 화면에 '수집 중')
--  * 하루를 다 받으면(24시각) 새 값이 없어도 요약본을 다시 만듦 — '수집 중' 표시를 지우려고
--  * 지난 시즌의 빠진 기간(11.1~11.14, 3.16~4.30, 2017-18 ~ 2025-26 시즌, 540일)을 1분마다 하루씩 받음(snow-backfill, 다 받으면 예약을 스스로 지움)
--  * 관리 콘솔 '적설 자료' 탭을 없애므로 손으로 넣는 함수(admin_import_snow)와 권한 'snow.upload' 를 지움. 수집 기록(snow_uploads)은 관리자만 읽음
-- ============================================================
create or replace function private.snow_in_season(d date) returns boolean
language sql immutable set search_path = ''
as $$ select extract(month from d) in (11, 12, 1, 2, 3, 4) $$;
revoke all on function private.snow_in_season(date) from public, anon, authenticated;

create or replace function public.admin_rebuild_snow_snapshot() returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare n_seasons int; n_values int; n_changed int := 0; idx jsonb; r record; today date := (now() at time zone 'Asia/Seoul')::date;
begin
  drop table if exists _ss;
  create temp table _ss on commit drop as
  with v as (                                    -- 관할 관측소(260곳)의 수집 기간 값
    select s.date, s.station_id, s.value,
           case when extract(month from s.date) >= 11 then extract(year from s.date)::int else extract(year from s.date)::int - 1 end as y
    from public.snow_daily s
    where private.snow_in_season(s.date) and exists (select 1 from public.stations t where t.id = s.station_id)
  ), b as (                                      -- 시즌 기간: 첫눈 ~ 마지막 눈(진행 중이면 자료가 있는 마지막 날)
    select y, today between make_date(y, 11, 1) and make_date(y + 1, 4, 30) as ongoing,
           min(date) filter (where value >= 0.1) as d0, max(date) filter (where value >= 0.1) as d_last, max(date) as d_data
    from v group by y
  ), bb as (
    select y, ongoing, d0, case when ongoing then d_data else d_last end as d1 from b where d0 is not null
  ), days as (
    select bb.y, g::date as date, row_number() over (partition by bb.y order by g) as i
    from bb, generate_series(bb.d0, bb.d1, interval '1 day') g
  ), vals as (
    select d.y, v.station_id, d.i, v.value from v join days d on d.date = v.date
  ), st as (                                     -- 시즌·관측소별 값 배열(날짜 순서, 없는 날은 null)
    select x.y, x.station_id, jsonb_agg(z.value order by dd.i) as arr
    from (select distinct y, station_id from vals) x
    join days dd on dd.y = x.y
    left join vals z on z.y = x.y and z.station_id = x.station_id and z.i = dd.i
    group by x.y, x.station_id
  )
  select bb.y, bb.y || '-' || lpad(((bb.y + 1) % 100)::text, 2, '0') as label, bb.d0, bb.d1, bb.ongoing,
    jsonb_build_object(
      'dates', (select jsonb_agg(to_char(date, 'YYYYMMDD') order by i) from days where days.y = bb.y),
      'st', coalesce((select jsonb_object_agg(station_id::text, arr) from st where st.y = bb.y), '{}'::jsonb)) as body,
    (select count(*) from days where days.y = bb.y)::int as n_days,
    (select count(distinct i) from vals where vals.y = bb.y)::int as n_data_days,
    (select count(*) from st where st.y = bb.y)::int as n_stations,
    (select jsonb_agg(to_char(c.date, 'YYYYMMDD') order by c.date) from public.snow_collect c
      where c.date between greatest(bb.d0, today - 3) and bb.d1 and cardinality(c.hours) < 24) as partial
  from bb;

  for r in select * from _ss loop
    insert into public.snapshots (key, version, built_at, body) values ('snow:' || r.label, 1, now(), r.body)
      on conflict (key) do update set version = public.snapshots.version + 1, built_at = now(), body = excluded.body
      where public.snapshots.body is distinct from excluded.body;
    if found then n_changed := n_changed + 1; end if;
  end loop;
  delete from public.snapshots s where s.key like 'snow:%' and substr(s.key, 6) not in (select label from _ss);

  select coalesce(jsonb_agg(jsonb_build_object('label', label, 'start', to_char(d0, 'YYYYMMDD'), 'end', to_char(d1, 'YYYYMMDD'), 'ongoing', ongoing,
           'days', n_days, 'data_days', n_data_days, 'stations', n_stations, 'partial', partial) order by y), '[]'::jsonb), count(*)
    into idx, n_seasons from _ss;
  insert into public.snapshots (key, version, built_at, body) values ('snow', 3, now(), jsonb_build_object('version', 3, 'seasons', idx))
    on conflict (key) do update set version = public.snapshots.version + 1, built_at = now(), body = excluded.body
    where public.snapshots.body is distinct from excluded.body;

  select count(*) into n_values from public.snow_daily;
  insert into public.audit_log (username, kind, tab, target, to_val)
    values ('collect-snow', '적설요약갱신', 'snapshots', 'snapshots:snow', jsonb_build_object('seasons', n_seasons, 'changed', n_changed, 'values', n_values));
  return jsonb_build_object('seasons', n_seasons, 'changed', n_changed, 'values', n_values);
end $$;
revoke all on function public.admin_rebuild_snow_snapshot() from public, anon, authenticated;
grant execute on function public.admin_rebuild_snow_snapshot() to service_role;

-- 지난 시즌 빠진 날 목록(다 받으면 done_at)
create table if not exists private.snow_backfill (
  date date primary key,
  tries int not null default 0,
  last_at timestamptz,
  done_at timestamptz
);
revoke all on private.snow_backfill from public, anon, authenticated;
insert into private.snow_backfill (date)
  select g::date from generate_series(2017, 2025) y, generate_series(make_date(y, 11, 1), make_date(y, 11, 14), interval '1 day') g
  union all
  select g::date from generate_series(2018, 2026) y, generate_series(make_date(y, 3, 16), make_date(y, 4, 30), interval '1 day') g
  on conflict do nothing;

-- 한 시각치 넣기(32와 같음) + 빠진 날을 다 받았으면 표시
create or replace function public.snow_put(p_date date, p_hour int, p_vals jsonb, p_dry boolean default false) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare n_new int; n_up int; n_same int; n_low int; n_written int := 0;
begin
  if p_hour < 0 or p_hour > 23 or jsonb_typeof(p_vals) <> 'object' then raise exception 'bad input' using errcode = '22023'; end if;
  if not private.snow_in_season(p_date) then raise exception 'out of season' using errcode = '22023'; end if;
  drop table if exists _sp;
  create temp table _sp on commit drop as
    select k::int as station_id, (v #>> '{}')::double precision as value
    from jsonb_each(p_vals) e(k, v)
    where k ~ '^[0-9]{1,6}$' and jsonb_typeof(v) = 'number' and (v #>> '{}')::double precision >= 0;   -- 결측(-99.9 등) 제외
  select count(*) filter (where d.station_id is null), count(*) filter (where d.value < i.value),
         count(*) filter (where d.value = i.value), count(*) filter (where d.value > i.value)
    into n_new, n_up, n_same, n_low
    from _sp i left join public.snow_daily d on d.date = p_date and d.station_id = i.station_id;
  if not p_dry then
    insert into public.snow_daily (date, station_id, value) select p_date, station_id, value from _sp
      on conflict (date, station_id) do update set value = excluded.value where public.snow_daily.value < excluded.value;
    get diagnostics n_written = row_count;
    insert into public.snow_collect as c (date, hours, updated_at) values (p_date, array[p_hour], now())
      on conflict (date) do update set hours = (select array_agg(distinct x order by x) from unnest(c.hours || p_hour) x), updated_at = now();
    update public.snow_collect set done_at = now() where date = p_date and cardinality(hours) = 24 and done_at is null;
    update private.snow_backfill set done_at = now() where date = p_date and done_at is null
      and exists (select 1 from public.snow_collect where date = p_date and cardinality(hours) = 24);
    delete from public.snow_collect where date < p_date - 14;
  end if;
  return jsonb_build_object('new', n_new, 'higher', n_up, 'same', n_same, 'lower', n_low, 'written', n_written, 'dry', p_dry);
end $$;
revoke all on function public.snow_put(date, int, jsonb, boolean) from public, anon, authenticated;
grant execute on function public.snow_put(date, int, jsonb, boolean) to service_role;

-- 하루를 마칠 때: 새 값이 있었거나 하루를 다 받았으면 요약본 다시 만들기 + 수집 기록
create or replace function public.snow_finish(p_date date, p_hours int, p_written int, p_note text) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare r jsonb := null;
begin
  if p_written > 0 or p_hours = 24 then r := public.admin_rebuild_snow_snapshot(); end if;
  insert into public.snow_uploads (date_from, date_to, stations, rows_written, ok, note)
    values (p_date, p_date, null, p_written, p_hours = 24, left(p_note, 300));
  insert into public.collector_state as s (job, cursor, started_at, finished_at, ok, note) values ('snow', to_char(p_date, 'YYYYMMDD'), now(), now(), p_hours = 24, left(p_note, 500))
  on conflict (job) do update set cursor = excluded.cursor, finished_at = now(), ok = excluded.ok, note = excluded.note;
  insert into public.collector_runs (job, started_at, finished_at, ok, calls, error) values ('snow', now(), now(), p_hours = 24, p_hours, case when p_hours = 24 then null else left(p_note, 500) end);
  delete from public.collector_runs where job = 'snow' and started_at < now() - interval '30 days';
  return jsonb_build_object('snapshot', r);
end $$;
revoke all on function public.snow_finish(date, int, int, text) from public, anon, authenticated;
grant execute on function public.snow_finish(date, int, int, text) to service_role;

-- 빠진 날 하루씩: 받는 중인 날이 있으면(2분 안) 기다림, 매일 수집(어제)을 아직 못 마쳤으면 양보, 한 날은 4번까지. 남은 날이 없으면 예약을 지움
create or replace function private.kick_snow_backfill() returns bigint
language plpgsql security definer set search_path = ''
as $$
declare d date; y date := (now() at time zone 'Asia/Seoul')::date - 1;
begin
  if exists (select 1 from private.snow_backfill where done_at is null and last_at > now() - interval '2 minutes') then return null; end if;
  if private.snow_in_season(y) and not exists (select 1 from public.snow_collect where date = y and cardinality(hours) = 24)
     and extract(hour from (now() at time zone 'Asia/Seoul')) between 1 and 11 then return null; end if;
  select date into d from private.snow_backfill where done_at is null and tries < 4 order by date limit 1;
  if d is null then perform cron.unschedule('snow-backfill'); return null; end if;
  update private.snow_backfill set tries = tries + 1, last_at = now() where date = d;
  return net.http_post(
    url := 'https://yzwbnohzhnctdvufntig.supabase.co/functions/v1/collect-snow',
    body := jsonb_build_object('date', to_char(d, 'YYYYMMDD')),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-collector-token', (select token from private.collector_token where id = 1)),
    timeout_milliseconds := 150000);
end $$;
revoke all on function private.kick_snow_backfill() from public, anon, authenticated;

-- 예약: 매일 수집은 4월까지(한국 01:10~11:40 30분마다), 빠진 날 받기는 1분마다
select cron.unschedule(jobid) from cron.job where jobname in ('collect-snow', 'snow-backfill');
select cron.schedule('collect-snow', '10,40 0-2,16-23 * 1,2,3,4,11,12 *', 'select private.kick_snow()');
select cron.schedule('snow-backfill', '* * * * *', 'select private.kick_snow_backfill()');

-- 손으로 넣기 없앰(관리 콘솔 '적설 자료' 탭과 함께)
drop function if exists public.admin_import_snow(jsonb, boolean, boolean);
update public.profiles set perms = array_remove(perms, 'snow.upload') where 'snow.upload' = any(perms);
delete from public.permissions where key = 'snow.upload';
drop policy if exists snow_uploads_read on public.snow_uploads;
create policy snow_uploads_read on public.snow_uploads for select to authenticated using ((select private.my_role()) = 'admin');
drop policy if exists snow_uploads_ins on public.snow_uploads;

select public.admin_rebuild_snow_snapshot();
