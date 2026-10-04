-- ============================================================
-- 25. 특보 받는 기간 = 기준일자를 "만든 그 시각"부터 확정까지 (2026-10-05 사용자 결정)
--  예) 10.5 기준일자를 10.4 10:37 에 만들면 → 10:37 바로 한 번 받고, 그 뒤 10:41, 10:51 … (매시 01·11·21…분)
--  * 받을 필요(private.warn_needed): 만든 기준일자 중 확정을 기다리는 지사가 있는 것
--      (= 아직 아무 지사도 확정 안 됨, 또는 요청을 넣고 확정 안 된 지사가 있음). 모두 확정하면 멈춤.
--      기준일자가 지나고 2일이 넘으면(확정을 잊은 경우) 그만 받음.
--  * 기준일자를 만들면 그 자리에서 바로 한 번 받음(1분 안에 두 번은 안 함). 지사 요청이 들어올 때는 자료가 15분 넘게 묵었을 때만.
-- ============================================================
create or replace function private.warn_needed() returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.support_rounds s
     where s.created_at <= now()
       and s.start_date >= (now() at time zone 'Asia/Seoul')::date - 2
       and (not exists (select 1 from public.round_requests q where q.round_id = s.id and q.confirmed)
            or exists (select 1 from public.round_requests q where q.round_id = s.id and not q.confirmed
                        and (q.req_truck + q.req_blower > 0 or q.snow_cm is not null or q.arrive_at is not null or q.reason is not null))))
$$;
revoke all on function private.warn_needed() from public, anon, authenticated;

-- 기준일자를 만들면 바로 한 번
create or replace function private.warn_kick_on_round() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if private.warn_needed()
     and coalesce((select started_at from public.collector_state where job = 'warnings_kick'), 'epoch') < now() - interval '1 minute' then
    perform private.kick_warnings(false);
  end if;
  return null;
end $$;
revoke all on function private.warn_kick_on_round() from public, anon, authenticated;
drop trigger if exists zz_support_rounds_warn_kick on public.support_rounds;
create trigger zz_support_rounds_warn_kick after insert on public.support_rounds for each statement execute function private.warn_kick_on_round();
-- 지사 요청이 들어올 때는 그대로(자료가 15분 넘게 묵었을 때만, zz_round_requests_warn_kick)
