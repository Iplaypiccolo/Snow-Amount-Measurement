-- ============================================================
-- 기준일자별 지원 여부(마이그레이션 38) 시험 — SQL Editor 에 통째로 붙여넣고 실행
-- 마지막에 일부러 오류를 내서 시험 자료(2099·2100년 기준일자, V9001~V9003 장비)를 전부 되돌립니다. "전체 N, 실패 0" 이어야 합니다.
-- ※ 마이그레이션 38 을 적용한 뒤에 실행합니다. (적용 전 롤백 시험은 마이그레이션 SQL 뒤에 이 파일을 이어 붙여 한 번에 실행)
-- ============================================================
create temp table if not exists _t (n serial, name text, got text, want text, ok boolean);
create or replace function pg_temp.run_as(rl text, uid uuid, stmt text) returns text language plpgsql as $f$
declare n bigint;
begin
  perform set_config('request.jwt.claims', case when uid is null then '' else json_build_object('sub', uid, 'role', rl)::text end, true);
  if rl <> 'postgres' then execute format('set local role %I', rl); end if;
  begin execute stmt; get diagnostics n = row_count; execute 'reset role'; return 'ok:' || n;
  exception when others then execute 'reset role'; return 'err:' || sqlstate; end;
end $f$;
create or replace function pg_temp.chk(name text, rl text, uid uuid, stmt text, want text) returns void language plpgsql as $f$
declare got text := pg_temp.run_as(rl, uid, stmt); begin insert into _t(name, got, want, ok) values (name, got, want, got = want); end $f$;
create or replace function pg_temp.yes(name text, cond boolean, info text default '') returns void language plpgsql as $f$
begin insert into _t(name, got, want, ok) values (name, case when cond then 'true' else 'false ' || info end, 'true', coalesce(cond, false)); end $f$;
do $t$
declare a uuid := gen_random_uuid(); e uuid := gen_random_uuid(); r1 bigint; r2 bigint; r3 bigint; r4 bigint; r5 bigint; r6 bigint; r7 bigint; c bigint; nveh bigint; c0 bigint; exp5 text;
begin
  insert into auth.users (id, aud, role, email) values (a,'authenticated','authenticated','ra@t.test'),(e,'authenticated','authenticated','re@t.test');
  insert into public.profiles (id,username,display_name,role,branch_id,org,hq_id,perms,must_change) values
    (a,'rs-adm','관리자','admin',null,null,null,'{}',false),(e,'rs-eq','장비','equip',null,'서울경기',null,'{equip.edit.own}',false);
  insert into public.vehicles (id,org,type,plate) values ('V9001','서울경기','제설차','서울경기9901'),('V9002','충북','제설기','충북9902'),('V9003','충북','제설차','충북9903');

  select count(*) into c0 from public.audit_log where tab = 'round_vehicle_status';
  -- 0. 마이그레이션 직후 상태(실제 자료)
  perform pg_temp.yes('담당 기준일자가 없는 경로가 남아 있지 않음', not exists (select 1 from public.vehicle_routes where private.governing_round(date) is null));
  select coalesce((select s.status from public.round_vehicle_status s where s.vehicle_id = 'V005' and s.round_id = (select id from public.support_rounds order by start_date desc limit 1)),
                  (select status from public.vehicles where id = 'V005')) into exp5;

  perform pg_temp.chk('지원장비 계정은 기준일자를 못 만든다','authenticated',e,'select public.create_round(''2099-12-01'')','err:42501');
  perform pg_temp.chk('직접 insert 는 막힘','authenticated',a,'insert into public.support_rounds (name, start_date) values (''x'', ''2099-01-01'')','err:42501');
  perform pg_temp.chk('관리자: 새 기준일자 2099-12-01','authenticated',a,'select public.create_round(''2099-12-01'')','ok:1');
  select id into r1 from public.support_rounds where start_date = '2099-12-01';
  perform pg_temp.chk('마지막 기준일자보다 앞 날짜는 거절','authenticated',a,'select public.create_round(''2020-01-01'')','err:23514');
  select count(*) into nveh from public.vehicles where active;
  perform pg_temp.yes('전체 장비가 넘어옴', (select count(*) from public.round_vehicle_status where round_id = r1) = nveh, 'rows=' || (select count(*) from public.round_vehicle_status where round_id = r1) || ' veh=' || nveh);
  perform pg_temp.yes('정비중(V005)도 그대로 넘어옴(이전 기준일자, 없으면 옛 열 값)', (select status from public.round_vehicle_status where round_id = r1 and vehicle_id = 'V005') = exp5 and exp5 = 'M');
  perform pg_temp.yes('자동으로 넘긴 줄은 수정 기록에 없음', (select count(*) from public.audit_log where tab = 'round_vehicle_status') = c0);
  perform pg_temp.yes('새 V9001 은 미정', (select status from public.round_vehicle_status where round_id = r1 and vehicle_id = 'V9001') = '');

  -- 2. 지원 여부 저장 (자기 기관만)
  perform pg_temp.chk('지원장비: 자기 장비 지원 가능','authenticated',e,format('select public.save_fleet(''[]'', ''[]'', %s, ''[{"vehicle_id":"V9001","status":"O"}]'')', r1),'ok:1');
  perform pg_temp.chk('지원장비: 다른 기관 장비는 거절','authenticated',e,format('select public.save_fleet(''[]'', ''[]'', %s, ''[{"vehicle_id":"V9002","status":"O"}]'')', r1),'err:42501');
  perform pg_temp.chk('기준일자 번호 없이 지원 여부 거절','authenticated',e,'select public.save_fleet(''[]'', ''[]'', null, ''[{"vehicle_id":"V9001","status":"O"}]'')','err:22023');
  perform pg_temp.chk('장비 줄에 status 를 넣으면 거절','authenticated',e,'select public.save_fleet(''[{"id":"V9001","status":"O"}]'', ''[]'')','err:22023');
  perform pg_temp.yes('사람이 고친 줄은 수정 기록에 남음', (select count(*) from public.audit_log where tab = 'round_vehicle_status') = c0 + 1);

  -- 3. 경로
  perform pg_temp.chk('관리자: 경로 12/2','authenticated',a,format('select public.save_fleet(''[]'', ''[{"date":"2099-12-02","vehicle_id":"V9001","stops":["B001","B002"],"times":["03:50","07:30"]}]'', %s)', r1),'ok:1');
  perform pg_temp.chk('기준일자 이전 날짜(담당 없음)는 거절','authenticated',a,format('select public.save_fleet(''[]'', ''[{"date":"2099-11-30","vehicle_id":"V9001","stops":["B001"]}]'', %s)', r1),'err:23514');
  perform pg_temp.chk('지원 가능이 아닌 장비의 경로는 거절','authenticated',a,format('select public.save_fleet(''[]'', ''[{"date":"2099-12-02","vehicle_id":"V9002","stops":["B001"]}]'', %s)', r1),'err:23514');
  perform pg_temp.chk('지원장비: 경로 지사 바꾸기 거절','authenticated',e,format('select public.save_fleet(''[]'', ''[{"date":"2099-12-02","vehicle_id":"V9001","stops":["B003"]}]'', %s)', r1),'err:42501');
  perform pg_temp.chk('관리자: 지원 여부와 경로를 한 번에','authenticated',a,format('select public.save_fleet(''[]'', ''[{"date":"2099-12-03","vehicle_id":"V9002","stops":["B001"]}]'', %s, ''[{"vehicle_id":"V9002","status":"O"}]'')', r1),'ok:1');

  -- 4. 새 기준일자(12/3 시작): 겹치는 날짜는 새 기준일자가 맡음
  perform pg_temp.chk('새 기준일자 2099-12-03','authenticated',a,'select public.create_round(''2099-12-03'')','ok:1');
  select id into r2 from public.support_rounds where start_date = '2099-12-03';
  perform pg_temp.yes('지원 가능 장비가 그대로 넘어옴', (select count(*) = 2 from public.round_vehicle_status where round_id = r2 and vehicle_id in ('V9001','V9002') and status = 'O'));
  perform pg_temp.yes('경로는 복사되지 않고 공유(12/3 한 줄 그대로)', (select count(*) = 1 from public.vehicle_routes where date = '2099-12-03'));
  perform pg_temp.chk('옛 기준일자에서 새 기준일자가 맡은 날짜(12/4)는 거절','authenticated',a,format('select public.save_fleet(''[]'', ''[{"date":"2099-12-04","vehicle_id":"V9001","stops":["B001"]}]'', %s)', r1),'err:23514');
  perform pg_temp.chk('옛 기준일자에서 12/3 지우기도 거절','authenticated',a,format('select public.save_fleet(''[]'', ''[{"date":"2099-12-03","vehicle_id":"V9002","stops":[]}]'', %s)', r1),'err:23514');
  perform pg_temp.chk('새 기준일자에서 12/4','authenticated',a,format('select public.save_fleet(''[]'', ''[{"date":"2099-12-04","vehicle_id":"V9001","stops":["B001"]}]'', %s)', r2),'ok:1');
  perform pg_temp.yes('12/2 는 옛 기준일자가 맡음', private.governing_round('2099-12-02') = r1 and private.governing_round('2099-12-03') = r2);

  -- 5. 지원 불가: 겹치는 날짜가 지원 불가로 바뀜(경로는 남김)
  perform pg_temp.chk('새 기준일자에서 V9001 지원 불가','authenticated',e,format('select public.save_fleet(''[]'', ''[]'', %s, ''[{"vehicle_id":"V9001","status":"X"}]'')', r2),'ok:1');
  perform pg_temp.yes('12/2 는 가능, 12/4 는 불가', private.vehicle_avail('V9001', '2099-12-02') and not private.vehicle_avail('V9001', '2099-12-04'));
  perform pg_temp.yes('저장된 경로는 지워지지 않음', exists (select 1 from public.vehicle_routes where date = '2099-12-04' and vehicle_id = 'V9001'));
  perform pg_temp.chk('불가인 날 새 경로 거절','authenticated',a,format('select public.save_fleet(''[]'', ''[{"date":"2099-12-05","vehicle_id":"V9001","stops":["B001"]}]'', %s)', r2),'err:23514');
  perform pg_temp.chk('불가인 날 도착 시각 고치기도 거절','authenticated',e,format('select public.save_fleet(''[]'', ''[{"date":"2099-12-04","vehicle_id":"V9001","stops":["B001"],"times":["06:40"]}]'', %s)', r2),'err:23514');
  perform pg_temp.chk('다시 지원 가능 + 12/5 부터 불가','authenticated',e,format('select public.save_fleet(''[]'', ''[]'', %s, ''[{"vehicle_id":"V9001","status":"O","off_from":"2099-12-05"}]'')', r2),'ok:1');
  perform pg_temp.yes('12/4 가능, 12/5 불가(그날부터)', private.vehicle_avail('V9001', '2099-12-04') and not private.vehicle_avail('V9001', '2099-12-05'));
  perform pg_temp.chk('불가 시작일이 기준일자 시작일보다 앞이면 거절','authenticated',e,format('select public.save_fleet(''[]'', ''[]'', %s, ''[{"vehicle_id":"V9001","status":"O","off_from":"2099-12-02"}]'')', r2),'err:23514');
  perform pg_temp.chk('불가 시작일은 지원 가능일 때만(X 이면 비움)','authenticated',a,format('select public.save_fleet(''[]'', ''[]'', %s, ''[{"vehicle_id":"V9003","status":"X","off_from":"2099-12-05"}]'')', r2),'ok:1');
  perform pg_temp.yes('X 이면 불가 시작일 비워짐', (select off_from is null from public.round_vehicle_status where round_id = r2 and vehicle_id = 'V9003'));

  -- 6. 이어받기: 불가 시작일 처리
  perform pg_temp.chk('새 기준일자 2099-12-05(불가 시작일 당일)','authenticated',a,'select public.create_round(''2099-12-05'')','ok:1');
  select id into r3 from public.support_rounds where start_date = '2099-12-05';
  perform pg_temp.yes('이미 불가가 시작된 장비는 지원 불가로 넘어옴', (select status = 'X' and off_from is null from public.round_vehicle_status where round_id = r3 and vehicle_id = 'V9001'));
  perform pg_temp.chk('V9002 를 12/7 부터 불가로','authenticated',a,format('select public.save_fleet(''[]'', ''[]'', %s, ''[{"vehicle_id":"V9002","status":"O","off_from":"2099-12-07"}]'')', r3),'ok:1');
  perform pg_temp.chk('새 기준일자 2099-12-06','authenticated',a,'select public.create_round(''2099-12-06'')','ok:1');
  select id into r4 from public.support_rounds where start_date = '2099-12-06';
  perform pg_temp.yes('아직 시작 안 된 불가 시작일은 그대로 넘어옴', (select status = 'O' and off_from = '2099-12-07' from public.round_vehicle_status where round_id = r4 and vehicle_id = 'V9002'));

  -- 7. 기준일자 삭제
  perform pg_temp.chk('마지막이 아닌 기준일자 삭제 거절','authenticated',a,format('delete from public.support_rounds where id = %s', r3),'err:23514');
  perform pg_temp.chk('지원장비 계정은 삭제 못 함','authenticated',e,format('delete from public.support_rounds where id = %s', r4),'ok:0');
  perform pg_temp.chk('마지막 기준일자(경로 없음) 삭제','authenticated',a,format('delete from public.support_rounds where id = %s', r4),'ok:1');
  perform pg_temp.chk('마지막이 아닌 옛 기준일자 삭제 거절','authenticated',a,format('delete from public.support_rounds where id = %s', r1),'err:23514');
  perform pg_temp.yes('삭제하면 그 지원 여부 줄도 함께 사라짐', not exists (select 1 from public.round_vehicle_status where round_id = r4));

  -- 8. 숨기기·삭제
  perform pg_temp.chk('지원장비 계정은 숨기기 못 함','authenticated',e,'update public.vehicles set hidden_after = ''2099-12-03'' where id = ''V9001''','err:42501');
  perform pg_temp.chk('관리자: V9002 숨기기(12/3 이후 기준일자부터)','authenticated',a,'update public.vehicles set hidden_after = ''2099-12-03'' where id = ''V9002''','ok:1');
  perform pg_temp.chk('새 기준일자 2099-12-20','authenticated',a,'select public.create_round(''2099-12-20'')','ok:1');
  select id into r5 from public.support_rounds where start_date = '2099-12-20';
  perform pg_temp.yes('숨긴 장비는 새 기준일자에 안 넘어옴, 나머지는 넘어옴', not exists (select 1 from public.round_vehicle_status where round_id = r5 and vehicle_id = 'V9002') and exists (select 1 from public.round_vehicle_status where round_id = r5 and vehicle_id = 'V9001'));
  perform pg_temp.yes('숨겨도 이전 기준일자 기록은 그대로', exists (select 1 from public.round_vehicle_status where round_id = r1 and vehicle_id = 'V9002') and exists (select 1 from public.vehicle_routes where vehicle_id = 'V9002'));
  perform pg_temp.chk('경로 기록이 있는 장비는 삭제 거절(숨기기를 쓰라는 뜻)','authenticated',a,'delete from public.vehicles where id = ''V9002''','err:23503');
  perform pg_temp.chk('기록 없는 장비는 삭제 가능','authenticated',a,'delete from public.vehicles where id = ''V9003''','ok:1');
  perform pg_temp.chk('지원장비 계정은 장비 삭제 못 함','authenticated',e,'delete from public.vehicles where id = ''V9001''','ok:0');
  perform pg_temp.chk('숨김 취소','authenticated',a,'update public.vehicles set hidden_after = null where id = ''V9002''','ok:1');

  -- 9. 연말(12월 → 1월)
  perform pg_temp.chk('새 기준일자 2099-12-30','authenticated',a,'select public.create_round(''2099-12-30'')','ok:1');
  select id into r6 from public.support_rounds where start_date = '2099-12-30';
  perform pg_temp.yes('12/30 기준일자가 1/2 까지 맡음', private.governing_round('2099-12-31') = r6 and private.governing_round('2100-01-02') = r6 and private.governing_round('2100-01-03') is null);
  perform pg_temp.chk('새 기준일자 2100-01-01 (연도가 넘어가도 더 나중)','authenticated',a,'select public.create_round(''2100-01-01'')','ok:1');
  select id into r7 from public.support_rounds where start_date = '2100-01-01';
  perform pg_temp.yes('1/2 는 새 기준일자(2100-01-01)가 맡고 12/31 은 12/30 기준일자', private.governing_round('2100-01-02') = r7 and private.governing_round('2099-12-31') = r6);
  perform pg_temp.chk('2099-12-31 기준일자는 이제 거절(마지막보다 앞)','authenticated',a,'select public.create_round(''2099-12-31'')','err:23514');

  select count(*), count(*) filter (where not ok) into c, nveh from _t;
  raise exception E'기준일자별 지원 여부 시험 — 전체 %, 실패 %\n%', c, nveh, coalesce((select string_agg('FAIL ' || name || ' → ' || got || ' / ' || want, E'\n' order by n) from _t where not ok), '(모두 통과)');
end $t$;
