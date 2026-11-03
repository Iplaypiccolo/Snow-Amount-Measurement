-- ============================================================
-- 59. 기준일자 기간을 4일 → 10일로 (2026-11-03 사용자 결정)
--  * 지원일 칸은 10개까지 고를 수 있는데 기간이 4일이라 지원일 5부터 "어느 기준일자에도 없는 날짜"로 잠겼음
--  * 새 기준일자 기본값 10일 + 지금 있는 기준일자도 10일로. 날짜가 겹치면 지금 규칙대로 시작일이 늦은 기준일자가 맡음(private.governing_round 그대로)
--  * 표 구조·권한 규칙은 그대로(days 칸은 이미 1~10 허용). create_round 는 기본값만 바꾸고 본문은 서버에 있던 그대로
--  * 알아 둘 점: 삭제는 '그 기간에 경로가 없을 때만'이라 기간이 길어진 만큼 막히는 경우가 늘어남. 지원 여부는 다음 기준일자 전까지 최대 10일 적용
--  * 시험: supabase/tests/round_ten_days_test.sql
-- ============================================================
alter table public.support_rounds alter column days set default 10;
update public.support_rounds set days = 10 where days <> 10;

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
  perform set_config('private.carry', '1', true);          -- 자동으로 넘기는 줄은 수정 기록에서 뺌
  insert into public.round_vehicle_status (round_id, vehicle_id, status, off_from)
  select rid, v.id,
         case when s.status = 'O' and s.off_from is not null and s.off_from <= p_date then 'X' else coalesce(s.status, case when prev is null then v.status else '' end) end,   -- 기준일자가 하나도 없을 때는 옛 열(vehicles.status)을 이어받음
         case when s.status = 'O' and s.off_from is not null and s.off_from > p_date then s.off_from end
    from public.vehicles v left join public.round_vehicle_status s on s.round_id = prev and s.vehicle_id = v.id
   where v.active and v.round_id is null and (v.hidden_after is null or p_date <= v.hidden_after);
  get diagnostics n = row_count;
  perform set_config('private.carry', '', true);
  return jsonb_build_object('id', rid, 'name', p_date::text || ' 기준', 'start_date', p_date, 'days', p_days, 'carried', n);
end $function$;
