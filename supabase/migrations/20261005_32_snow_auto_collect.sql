-- ============================================================
-- 32. 일 신적설 자동 수집 (2026-10-05 사용자 요청 — 기상청 API허브 콘솔에서 손으로 받던 것을 서버가 매일)
--  * 방법은 손으로 받던 콘솔 스크립트와 같음: kma_snow1.php?sd=day 를 그날 00~23시 24번 받아 관측소별 "그날 최댓값" = 일 신적설
--    (요청 1번 = 전국 적설 관측소 전부, 약 57KB. 하루 24번, 시즌 121일이면 약 2,900번)
--  * 시즌(11.15~3.15)에만: 한국 시각 01:10 에 "어제"를 받음. 기상청 응답이 늦어 못 받은 시각이 있으면 30분마다(11:40까지) 그 시각만 다시
--    (하루치를 다 받으면 그 뒤 예약은 함수를 부르지 않음)
--  * 저장: snow_daily 에 "더 큰 값만" 반영(같은 날을 나눠 받거나 다시 받아도 최댓값이 됨). 끝나면 요약본(시즌별) 다시 만들기
--  * 받은 시각 기록: snow_collect(날짜, 받은 시각들) — 최근 14일치만 남김
--  * 함수(collect-snow)는 서버 안 전용 토큰(pg_net) 또는 관리자 로그인으로만 부를 수 있음. 기상청 키는 함수 비밀값 KMA_AUTH_KEY
-- ============================================================
create table if not exists public.snow_collect (
  date date primary key,
  hours int[] not null default '{}',
  done_at timestamptz,
  updated_at timestamptz not null default now()
);
alter table public.snow_collect enable row level security;
drop policy if exists snow_collect_read on public.snow_collect;
create policy snow_collect_read on public.snow_collect for select to authenticated using ((select private.my_role()) = 'admin');
revoke insert, update, delete on public.snow_collect from anon, authenticated;

create or replace function private.snow_in_season(d date) returns boolean
language sql immutable set search_path = ''
as $$ select (extract(month from d) = 11 and extract(day from d) >= 15) or extract(month from d) in (12, 1, 2)
          or (extract(month from d) = 3 and extract(day from d) <= 15) $$;
revoke all on function private.snow_in_season(date) from public, anon, authenticated;

-- 무엇을 받을지: 날짜(없으면 한국 시각 어제), 시즌인지, 이미 받은 시각
create or replace function public.snow_plan(p_date date default null) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare d date := coalesce(p_date, ((now() at time zone 'Asia/Seoul')::date - 1)); h int[];
begin
  select hours into h from public.snow_collect where date = d;
  return jsonb_build_object('date', to_char(d, 'YYYYMMDD'), 'in_season', private.snow_in_season(d), 'done', to_jsonb(coalesce(h, '{}'::int[])));
end $$;
revoke all on function public.snow_plan(date) from public, anon, authenticated;
grant execute on function public.snow_plan(date) to service_role;

-- 한 시각치 넣기: p_vals = { "관측소번호": 값 } (그 시각의 일 신적설). 더 큰 값만 반영. p_dry = true 면 개수만 셈
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
    delete from public.snow_collect where date < p_date - 14;
  end if;
  return jsonb_build_object('new', n_new, 'higher', n_up, 'same', n_same, 'lower', n_low, 'written', n_written, 'dry', p_dry);
end $$;
revoke all on function public.snow_put(date, int, jsonb, boolean) from public, anon, authenticated;
grant execute on function public.snow_put(date, int, jsonb, boolean) to service_role;

-- 하루를 마칠 때(새 값이 있었으면): 요약본 다시 만들기 + 올리기 기록
create or replace function public.snow_finish(p_date date, p_hours int, p_written int, p_note text) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare r jsonb := null;
begin
  if p_written > 0 then r := public.admin_rebuild_snow_snapshot(); end if;
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

-- 예약에서 부름: 시즌이고, 어제 24시각을 다 받지 못했을 때만 함수 호출
create or replace function private.kick_snow() returns bigint
language plpgsql security definer set search_path = ''
as $$
declare d date := (now() at time zone 'Asia/Seoul')::date - 1;
begin
  if not private.snow_in_season(d) then return null; end if;
  if exists (select 1 from public.snow_collect where date = d and cardinality(hours) = 24) then return null; end if;
  return net.http_post(
    url := 'https://yzwbnohzhnctdvufntig.supabase.co/functions/v1/collect-snow',
    body := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-collector-token', (select token from private.collector_token where id = 1)),
    timeout_milliseconds := 150000);
end $$;
revoke all on function private.kick_snow() from public, anon, authenticated;

-- 한국 01:10~11:40 30분마다 = UTC 16:10~02:40. 시즌 달(11·12·1·2·3월)에만(시즌 밖 날짜는 kick_snow 가 걸러 냄)
select cron.unschedule(jobid) from cron.job where jobname = 'collect-snow';
select cron.schedule('collect-snow', '10,40 0-2,16-23 * 1,2,3,11,12 *', 'select private.kick_snow()');
