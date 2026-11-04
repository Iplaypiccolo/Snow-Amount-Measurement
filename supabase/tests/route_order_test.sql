-- ============================================================
-- 하루 경로 순서(마이그레이션 64) 시험 — 같은 지사 다시 들르기(연달아는 거절)·도착 시각은 앞 지사보다 늦게. 일반 장비·강원 신속대응팀
-- SQL Editor 에 통째로 붙여넣고 실행. 마지막에 일부러 오류를 내서 시험 자료(2099년 기준일자·장비·경로)를 전부 되돌립니다. "전체 N, 실패 0" 이어야 합니다.
-- ============================================================
create temp table if not exists _t (n serial, name text, got text, want text, ok boolean);
create or replace function pg_temp.try(name text, stmt text, want text) returns void language plpgsql as $f$
declare got text;
begin
  begin execute stmt; got := 'ok'; exception when others then got := 'err:' || sqlstate; end;
  insert into _t(name, got, want, ok) values (name, got, want, got = want);
end $f$;
do $t$
declare rid bigint; b1 text; b2 text; b3 text; cnt bigint; bad bigint;
  ins text := 'insert into public.vehicle_routes (date, vehicle_id, stops, times) values (%L, ''V9801'', %L::text[], %L::text[]) on conflict (date, vehicle_id) do update set stops = excluded.stops, times = excluded.times';
  gins text := 'insert into public.gw_team_routes (date, team_id, stops, times) values (%L, ''GW1'', %L::text[], %L::text[]) on conflict (date, team_id) do update set stops = excluded.stops, times = excluded.times';
begin
  select id into b1 from public.branches order by id limit 1; select id into b2 from public.branches order by id offset 1 limit 1; select id into b3 from public.branches order by id offset 2 limit 1;
  insert into public.support_rounds (name, start_date, days) values ('시험', '2099-12-01', 10) returning id into rid;
  insert into public.vehicles (id, org, type, plate) values ('V9801', '서울경기', '제설차', '서울경기9801');
  insert into public.round_vehicle_status (round_id, vehicle_id, status) values (rid, 'V9801', 'O') on conflict (round_id, vehicle_id) do update set status = 'O';
  update public.gw_team_status set status = 'O', off_from = null where round_id = rid and team_id = 'GW1';

  -- 일반 장비 (12/2 마지막 지사 = b1 이라 12/3 은 b1 로 시작하면 연속지원 → 순서 시험은 b2 로 시작)
  perform pg_temp.try('A→B→A (13·15·17시) 허용', format(ins, '2099-12-02', array[b1, b2, b1], array['13:00', '15:00', '17:00']), 'ok');
  perform pg_temp.try('A→A 연달아 같은 지사 거절', format(ins, '2099-12-03', array[b1, b1], array['13:00', '15:00']), 'err:23514');
  perform pg_temp.try('뒤 지사 시각이 앞보다 이르면 거절(13:00 → 11:00)', format(ins, '2099-12-03', array[b2, b3], array['13:00', '11:00']), 'err:SA008');
  perform pg_temp.try('같은 시각도 거절', format(ins, '2099-12-03', array[b2, b3], array['13:00', '13:00']), 'err:SA008');
  perform pg_temp.try('빈 칸은 건너뜀(13:00, -, 14:00)', format(ins, '2099-12-03', array[b1, b2, b3], array['13:00', null, '14:00']), 'ok');
  perform pg_temp.try('빈 칸 건너 앞 시각과 비교(13:00, -, 12:00 거절)', format(ins, '2099-12-04', array[b1, b2, b3], array['13:00', null, '12:00']), 'err:SA008');
  perform pg_temp.try('시각 없이 지사만 허용', format(ins, '2099-12-04', array[b2, b1, b2], null), 'ok');
  -- 연속지원: 12/4 마지막 = b2 → 12/5 첫 지사 b2 는 연속지원, 첫 칸에 남은 예전 시각(20:00)은 비교에서 뺌
  perform pg_temp.try('연속지원 첫 칸의 숨은 시각은 비교 안 함(20:00 → 09:00 허용)', format(ins, '2099-12-05', array[b2, b3], array['20:00', '09:00']), 'ok');
  perform pg_temp.try('연속지원이 아니면 같은 시각 순서는 거절(b1 20:00 → b3 09:00)', format(ins, '2099-12-05', array[b1, b3], array['20:00', '09:00']), 'err:SA008');
  perform pg_temp.try('시각 형식 검사는 그대로', format(ins, '2099-12-06', array[b1], array['25:00']), 'err:23514');

  -- 강원 신속대응팀
  perform pg_temp.try('팀: A→B→A 허용', format(gins, '2099-12-02', array[b1, b2, b1], array['13:00', '15:00', '17:00']), 'ok');
  perform pg_temp.try('팀: 연달아 같은 지사 거절', format(gins, '2099-12-03', array[b1, b1], null), 'err:23514');
  perform pg_temp.try('팀: 뒤 시각이 이르면 거절', format(gins, '2099-12-03', array[b2, b3], array['13:00', '11:00']), 'err:SA008');
  perform pg_temp.try('팀: 연속지원 첫 칸 시각은 비교 안 함', format(gins, '2099-12-03', array[b1, b3], array['23:00', '08:00']), 'ok');

  perform pg_temp.try('함수는 로그인 계정이 직접 못 부름', 'set local role authenticated; select private.route_times_ok(array[''1''], false)', 'err:42501');
  reset role;

  select count(*), count(*) filter (where not ok) into cnt, bad from _t;
  raise exception E'경로 순서 시험 — 전체 %, 실패 %\n%', cnt, bad, coalesce((select string_agg('FAIL ' || name || ' → ' || got || ' / ' || want, E'\n' order by n) from _t where not ok), '(모두 통과)');
end $t$;
