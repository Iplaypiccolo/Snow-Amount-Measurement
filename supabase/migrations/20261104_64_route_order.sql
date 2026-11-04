-- ============================================================
-- 64. 하루 경로: 같은 지사 다시 들르기 허용(바로 연달아는 안 됨) + 도착 예상 시각은 앞 지사보다 늦게 (2026-11-04 사용자 요청)
--  * 사용자: "+ 로 아래에 추가한 기관은 이전 기관보다 이후 시각이어야 함", "인천 13시 → 시흥 15시 → 인천 17시처럼 같은 기관에 다시 갈 수 있음"
--  * 지금까지(16·44·48): 같은 지사가 두 번 들어가면 'duplicate stop'(23514)으로 거절, 시각은 형식만 검사
--  * 바꿈(일반 장비 private.check_route · 강원 신속대응팀 private.gw_route_check 둘 다):
--    ① 바로 연달아 같은 지사(인천 → 인천)만 거절(23514 'repeated stop'). 사이에 다른 지사가 있으면 허용
--    ② 시각이 있는 칸끼리, 앞에 입력된 시각보다 늦어야 함(같은 시각도 안 됨) — 아니면 SA008 'times must increase'
--       시각을 비운 칸은 건너뜀. 첫 지사가 '연속지원'(전날 마지막 지사 = 오늘 첫 지사)이면 첫 칸에 남은 예전 시각은 비교에서 뺌(화면이 그 시각을 숨김)
--  * 2026-11-04 서버에 저장된 경로 3건 모두 새 규칙에 맞음(확인). 표·권한 규칙은 그대로
--  * 시험: supabase/tests/route_order_test.sql (되돌림)
-- ============================================================
create or replace function private.route_times_ok(p_times text[], p_skip_first boolean) returns boolean
language sql immutable set search_path = ''
as $$
  select not exists (
    select 1 from (select t.v, lag(t.v) over (order by t.i) as pv
                     from unnest(p_times) with ordinality t(v, i)
                    where t.v is not null and not (p_skip_first and t.i = 1)) x
     where x.pv is not null and x.v <= x.pv);
$$;
revoke all on function private.route_times_ok(text[], boolean) from public, anon, authenticated;

create or replace function private.check_route() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare cont boolean;
begin
  if exists (select 1 from unnest(new.stops) s where not exists (select 1 from public.branches b where b.id = s)) then
    raise exception 'unknown branch in stops' using errcode = '23503';
  end if;
  if exists (select 1 from generate_subscripts(new.stops, 1) i where i > 1 and new.stops[i] = new.stops[i - 1]) then      -- 64: 바로 연달아 같은 지사만 거절
    raise exception 'repeated stop' using errcode = '23514';
  end if;
  if exists (select 1 from public.vehicles v where v.id = new.vehicle_id and v.home_branch = any(new.stops)) then
    raise exception 'a pool vehicle cannot be sent to its own branch' using errcode = 'SA005';
  end if;
  if new.times is not null then
    if cardinality(new.times) <> cardinality(new.stops) then raise exception 'times must match stops' using errcode = '23514'; end if;
    if exists (select 1 from unnest(new.times) t where t is not null and t !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$') then
      raise exception 'time must be HH:MM' using errcode = '23514';
    end if;
    cont := exists (select 1 from public.vehicle_routes p where p.vehicle_id = new.vehicle_id and p.date = new.date - 1
                       and cardinality(p.stops) > 0 and p.stops[cardinality(p.stops)] = new.stops[1]);      -- 첫 지사가 연속지원이면 첫 칸 시각은 숨김 → 비교에서 뺌
    if not private.route_times_ok(new.times, cont) then raise exception 'times must increase' using errcode = 'SA008'; end if;      -- 64
  end if;
  return new;
end $$;

create or replace function private.gw_route_check() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare rid bigint; s public.gw_team_status; cont boolean;
begin
  if exists (select 1 from unnest(new.stops) x where not exists (select 1 from public.branches b where b.id = x)) then
    raise exception 'unknown branch in stops' using errcode = '23503';
  end if;
  if exists (select 1 from generate_subscripts(new.stops, 1) i where i > 1 and new.stops[i] = new.stops[i - 1]) then raise exception 'repeated stop' using errcode = '23514'; end if;      -- 64
  if new.times is not null then
    if cardinality(new.times) <> cardinality(new.stops) then raise exception 'times must match stops' using errcode = '23514'; end if;
    if exists (select 1 from unnest(new.times) t where t is not null and t !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$') then
      raise exception 'time must be HH:MM' using errcode = '23514';
    end if;
    cont := exists (select 1 from public.gw_team_routes p where p.team_id = new.team_id and p.date = new.date - 1
                       and cardinality(p.stops) > 0 and p.stops[cardinality(p.stops)] = new.stops[1]);
    if not private.route_times_ok(new.times, cont) then raise exception 'times must increase' using errcode = 'SA008'; end if;      -- 64
  end if;
  rid := private.governing_round(new.date);
  if rid is null then raise exception 'date is not inside any round' using errcode = '23514'; end if;
  select * into s from public.gw_team_status x where x.round_id = rid and x.team_id = new.team_id;
  if not found or s.status <> 'O' or (s.off_from is not null and new.date >= s.off_from) then
    raise exception 'team vehicle is not available on this date' using errcode = '23514';
  end if;
  return new;
end $$;
revoke all on function private.check_route(), private.gw_route_check() from public, anon;
