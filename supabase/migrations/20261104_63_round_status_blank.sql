-- ============================================================
-- 63. 새 기준일자를 만들면 지원 여부는 빈칸 — 단, 새 기준일자 기간에 이미 경로가 잡힌 장비는 '지원' 유지 (2026-11-04 사용자 결정)
--  * 사용자: "미정은 빼자, 새 기준일자가 들어오면 모든 장비는 빈칸으로" → 질문에 "빈칸, 단 경로 있는 장비는 지원 유지" 선택
--  * 지금까지(38·48): 이전 기준일자의 지원 여부를 모두 이어받음(지원 불가 시작일이 지났으면 지원 불가)
--  * 바꿈: 모두 ''(빈칸). 예외 = 이전 기준일자에서 '지원'이었고 새 기준일자 시작일 이후(그날 포함)에 경로(들르는 지사 1곳 이상)가 이미 있는 장비
--          → '지원' 유지(지원 불가 시작일도 그대로, 그 시작일 전 날짜의 경로가 있을 때만). 겹치는 날 잡아 둔 경로가 지원 불가로 바뀌지 않게
--  * 기계화부·지사 장비(round_vehicle_status)와 강원 신속대응팀(gw_team_status) 모두 같은 규칙. 지역본부 장비는 원래 줄이 없음(그대로)
--  * 이미 만든 기준일자의 값은 그대로. 표·권한 규칙·수정 기록 방식 그대로(자동으로 만드는 줄은 기록 안 함)
--  * 시험: supabase/tests/round_status_test.sql, gw_team_test.sql (되돌림)
-- ============================================================
create or replace function public.create_round(p_date date, p_days integer default 10) returns jsonb
language plpgsql security definer set search_path = ''
as $function$
declare rid bigint; prev bigint; n int;
begin
  if not (select private.has_perm('req.confirm')) then raise exception 'create_round needs req.confirm' using errcode = '42501'; end if;
  if p_date is null or p_days is null or p_days not between 1 and 10 then raise exception 'bad input' using errcode = '22023'; end if;
  if exists (select 1 from public.support_rounds where start_date >= p_date) then raise exception 'round must start after the latest one' using errcode = '23514'; end if;
  select id into prev from public.support_rounds order by start_date desc limit 1;
  insert into public.support_rounds (name, start_date, days) values (p_date::text || ' 기준', p_date, p_days) returning id into rid;
  perform set_config('private.carry', '1', true);          -- 자동으로 만드는 줄은 수정 기록에서 뺌
  insert into public.round_vehicle_status (round_id, vehicle_id, status, off_from)
  select rid, v.id, case when k.keep then 'O' else '' end, case when k.keep and s.off_from > p_date then s.off_from end
    from public.vehicles v
    left join public.round_vehicle_status s on s.round_id = prev and s.vehicle_id = v.id
    cross join lateral (select coalesce(s.status = 'O' and exists (
             select 1 from public.vehicle_routes r where r.vehicle_id = v.id and r.date >= p_date and cardinality(r.stops) > 0
                and (s.off_from is null or r.date < s.off_from)), false) as keep) k      -- 63: 새 기간에 경로가 잡힌 '지원' 장비만 유지, 나머지 빈칸
   where v.active and v.round_id is null and (v.hidden_after is null or p_date <= v.hidden_after);
  get diagnostics n = row_count;
  perform set_config('private.carry', '', true);
  return jsonb_build_object('id', rid, 'name', p_date::text || ' 기준', 'start_date', p_date, 'days', p_days, 'carried', n);
end $function$;

create or replace function private.gw_team_carry() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare prev bigint; was text := current_setting('private.carry', true);
begin
  select id into prev from public.support_rounds where start_date < new.start_date order by start_date desc limit 1;
  perform set_config('private.carry', '1', true);
  insert into public.gw_team_status (round_id, team_id, status, off_from)
  select new.id, t.id, case when k.keep then 'O' else '' end, case when k.keep and s.off_from > new.start_date then s.off_from end
    from public.gw_team t
    left join public.gw_team_status s on s.round_id = prev and s.team_id = t.id
    cross join lateral (select coalesce(s.status = 'O' and exists (
             select 1 from public.gw_team_routes r where r.team_id = t.id and r.date >= new.start_date and cardinality(r.stops) > 0
                and (s.off_from is null or r.date < s.off_from)), false) as keep) k      -- 63: 같은 규칙
  on conflict do nothing;
  perform set_config('private.carry', coalesce(was, ''), true);
  return null;
end $$;
revoke all on function private.gw_team_carry() from public, anon;
