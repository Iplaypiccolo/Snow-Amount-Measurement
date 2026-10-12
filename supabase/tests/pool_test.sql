-- ============================================================
-- 지역본부 장비(마이그레이션 44) 시험 — 타지사 지원 가능 대수(확정·잠금), 지사 계정의 장비 등록·이름·삭제, 경로는 관리자만(지사는 시각만),
-- 자기 지사로 못 보냄, 지원 여부는 늘 지원, 새 기준일자로 이어받지 않음, 기관별 배정의 '지역본부' 칸 — SQL Editor 에 통째로 붙여넣고 실행
-- 마지막에 일부러 오류를 내서 시험 자료를 전부 되돌립니다. "전체 N, 실패 0" 이어야 합니다.
-- ============================================================
create temp table _t (n serial, name text, got text, want text, ok boolean);
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
declare a uuid := gen_random_uuid(); b1 uuid := gen_random_uuid(); b2 uuid := gen_random_uuid(); h uuid := gen_random_uuid(); e uuid := gen_random_uuid();
  rid bigint; rid2 bigint; fails int; total int; n1 text; n2 text; hq1 text; v1 text; v2 text; v3 text;
  rq text := 'select public.save_requests(%s, ''%s'')'; rt text := 'select public.save_fleet(''[]'', ''%s'', %s)'; vh text := 'select public.save_fleet(''%s'', ''[]'')';
  ins text := 'insert into public.vehicles (org, type, plate, round_id, home_branch, rented) values (''지역본부'', ''%s'', ''%s'', %s, ''%s'', %s)';
begin
  select name, hq_id into n1, hq1 from public.branches where id = 'B001'; select name into n2 from public.branches where id = 'B002';
  insert into auth.users (id, aud, role, email) values (a,'authenticated','authenticated','pa@t.test'),(b1,'authenticated','authenticated','pb1@t.test'),(b2,'authenticated','authenticated','pb2@t.test'),
    (h,'authenticated','authenticated','ph@t.test'),(e,'authenticated','authenticated','pe@t.test');
  insert into public.profiles (id,username,display_name,role,branch_id,org,hq_id,perms,must_change) values
    (a,'pl-adm','관리자','admin',null,null,null,'{}',false),(b1,'pl-br1','지사1','branch','B001',null,null,'{req.edit.own}',false),(b2,'pl-br2','지사2','branch','B002',null,null,'{req.edit.own}',false),
    (h,'pl-hq','본부','hq',null,null,hq1,'{req.edit.hq}',false),(e,'pl-eq','서울경기 기계화부','equip',null,'서울경기',null,'{equip.edit.own}',false);
  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);
  insert into public.support_rounds (name,start_date,days) values ('t','2099-12-01',4) returning id into rid;

  -- 타지사 지원 가능 대수: 지사(자기 줄)·본부(자기 본부 지사)·관리자가 넣고, 확정하면 잠김
  perform pg_temp.chk('지사: 자기 줄 지원 가능 2대','authenticated',b1,format(rq, rid, '[{"branch_id":"B001","offer_truck":2}]'),'ok:1');
  perform pg_temp.yes('저장됨', (select offer_truck = 2 and not confirmed from public.round_requests where round_id = rid and branch_id = 'B001'));
  perform pg_temp.chk('지사: 다른 지사 줄은 거절','authenticated',b1,format(rq, rid, '[{"branch_id":"B002","offer_truck":1}]'),'err:42501');
  perform pg_temp.chk('본부: 자기 본부 지사 줄 3대','authenticated',h,format(rq, rid, '[{"branch_id":"B001","offer_truck":3}]'),'ok:1');
  perform pg_temp.chk('100대는 거절(0~99)','authenticated',b1,format(rq, rid, '[{"branch_id":"B001","offer_truck":100}]'),'err:23514');
  perform pg_temp.chk('지사: 확정 전에는 장비 등록 거절','authenticated',b1,format(ins, '제설차', n1 || '252', rid, 'B001', 'false'),'err:SA004');
  perform pg_temp.chk('관리자도 확정 전에는 등록 거절','authenticated',a,format(ins, '제설차', n1 || '252', rid, 'B001', 'false'),'err:SA004');
  perform pg_temp.chk('관리자: B001 확정(편성 0, 지원 가능 3) + B003 편성 확정','authenticated',a,format(rq, rid, '[{"branch_id":"B001","confirmed":true},{"branch_id":"B003","assigned_truck":2,"confirmed":true}]'),'ok:1');
  perform pg_temp.chk('지사: 확정한 줄의 지원 가능 대수는 잠김','authenticated',b1,format(rq, rid, '[{"branch_id":"B001","offer_truck":5}]'),'err:55000');
  perform pg_temp.chk('관리자도 취소 전에는 못 고침','authenticated',a,format(rq, rid, '[{"branch_id":"B001","offer_truck":5}]'),'err:55000');

  -- 등록: 그 지사 계정과 관리자만. 이름 = 지사 이름 + [임차] + 숫자, 같은 기준일자 안에서 중복 불가
  perform pg_temp.chk('지사: 252 등록(번호는 서버가 매김)','authenticated',b1,format(ins, '제설차', n1 || '252', rid, 'B001', 'false'),'ok:1');
  select id into v1 from public.vehicles where round_id = rid and plate = n1 || '252';
  perform pg_temp.yes('장비 번호 자동', v1 ~ '^V[0-9]{3,5}$', coalesce(v1, 'null'));
  perform pg_temp.yes('지원 여부가 지원으로 자동 생김', (select status = 'O' and off_from is null from public.round_vehicle_status where round_id = rid and vehicle_id = v1));
  perform pg_temp.yes('등록은 수정 기록에 남고 자동 지원 여부 줄은 안 남음', exists (select 1 from public.audit_log where target = 'vehicles:' || v1 and kind = '추가')
    and not exists (select 1 from public.audit_log where tab = 'round_vehicle_status' and target = 'round_vehicle_status:' || rid || ',' || v1));
  perform pg_temp.chk('지사: 임차 1 등록','authenticated',b1,format(ins, '제설차', n1 || '임차1', rid, 'B001', 'true'),'ok:1');
  select id into v2 from public.vehicles where round_id = rid and plate = n1 || '임차1';
  perform pg_temp.chk('같은 이름은 거절','authenticated',b1,format(ins, '제설차', n1 || '252', rid, 'B001', 'false'),'err:23505');
  perform pg_temp.chk('임차 번호와 일반 번호는 따로(임차 252)','authenticated',b1,format(ins, '제설차', n1 || '임차252', rid, 'B001', 'true'),'ok:1');
  select id into v3 from public.vehicles where round_id = rid and plate = n1 || '임차252';
  perform pg_temp.chk('이름에 다른 지사 이름은 거절','authenticated',b1,format(ins, '제설차', n2 || '7', rid, 'B001', 'false'),'err:23514');
  perform pg_temp.chk('숫자가 아니면 거절','authenticated',b1,format(ins, '제설차', n1 || '가나', rid, 'B001', 'false'),'err:23514');
  perform pg_temp.chk('임차 표시와 이름이 다르면 거절','authenticated',b1,format(ins, '제설차', n1 || '9', rid, 'B001', 'true'),'err:23514');
  perform pg_temp.chk('제설기는 거절(제설차만)','authenticated',a,format(ins, '제설기', n1 || '8', rid, 'B001', 'false'),'err:23514');
  perform pg_temp.chk('지사: 다른 지사 이름으로 등록 거절','authenticated',b1,format(ins, '제설차', n2 || '1', rid, 'B002', 'false'),'err:42501');
  perform pg_temp.chk('지원 가능 대수를 안 낸 지사는 거절','authenticated',b2,format(ins, '제설차', n2 || '1', rid, 'B002', 'false'),'err:SA004');
  perform pg_temp.chk('본부 계정은 등록 거절','authenticated',h,format(ins, '제설차', n1 || '5', rid, 'B001', 'false'),'err:42501');
  perform pg_temp.chk('기계화부 계정은 등록 거절','authenticated',e,format(ins, '제설차', n1 || '5', rid, 'B001', 'false'),'err:42501');
  perform pg_temp.chk('관리자: 확정된 지사 이름으로 등록(4대째 — 대수는 막지 않음)','authenticated',a,format(ins, '제설차', n1 || '300', rid, 'B001', 'false'),'ok:1');
  perform pg_temp.chk('기계화부: 자기 기관 장비 추가는 예전처럼(번호 자동)','authenticated',e,'insert into public.vehicles (org, type, plate) values (''서울경기'', ''제설차'', ''서울경기9971'')','ok:1');
  perform pg_temp.chk('기계화부 장비 이름은 전체에서 하나','authenticated',a,'insert into public.vehicles (org, type, plate) values (''서울경기'', ''제설기'', ''서울경기9971'')','err:23505');
  perform pg_temp.chk('기계화부 장비에 기준일자·지사를 붙이면 거절','authenticated',a,format('insert into public.vehicles (org, type, plate, round_id) values (''서울경기'', ''제설차'', ''서울경기9972'', %s)', rid),'err:23514');

  -- 경로: 피지원 지사는 관리자만, 지사는 도착 예상 시각만. 자기 지사로는 못 보냄
  perform pg_temp.chk('관리자: 252 → B003(첫날·둘째 날)','authenticated',a,format(rt, format('[{"date":"2099-12-01","vehicle_id":"%s","stops":["B003"]},{"date":"2099-12-02","vehicle_id":"%s","stops":["B003"]}]', v1, v1), rid),'ok:1');
  perform pg_temp.chk('관리자: 자기 지사(B001)로는 거절','authenticated',a,format(rt, format('[{"date":"2099-12-01","vehicle_id":"%s","stops":["B001"]}]', v2), rid),'err:SA005');
  perform pg_temp.chk('지사: 도착 예상 시각만 고침','authenticated',b1,format(rt, format('[{"date":"2099-12-01","vehicle_id":"%s","stops":["B003"],"times":["08:20"]}]', v1), rid),'ok:1');
  perform pg_temp.yes('시각 저장, 지사·구분은 그대로', (select stops = array['B003'] and not revised and times = array['08:20'] from public.vehicle_routes where date = '2099-12-01' and vehicle_id = v1));
  perform pg_temp.chk('지사: 피지원 지사 바꾸기 거절','authenticated',b1,format(rt, format('[{"date":"2099-12-01","vehicle_id":"%s","stops":["B002"]}]', v1), rid),'err:42501');
  perform pg_temp.chk('지사: 경로 지우기 거절','authenticated',b1,format(rt, format('[{"date":"2099-12-01","vehicle_id":"%s","stops":[]}]', v1), rid),'err:42501');
  perform pg_temp.chk('지사: 새 경로 넣기 거절','authenticated',b1,format(rt, format('[{"date":"2099-12-01","vehicle_id":"%s","stops":["B003"]}]', v2), rid),'err:42501');
  perform pg_temp.chk('지사: 직접 INSERT 거절','authenticated',b1,format('insert into public.vehicle_routes (date,vehicle_id,stops) values (''2099-12-01'',''%s'',''{B003}'')', v2),'err:42501');
  perform pg_temp.chk('지사: 직접 UPDATE 로 지사 바꾸기 거절','authenticated',b1,format('update public.vehicle_routes set stops = ''{B002}'' where vehicle_id = ''%s'' and date = ''2099-12-01''', v1),'err:42501');
  perform pg_temp.chk('지사: 직접 DELETE 는 0건','authenticated',b1,format('delete from public.vehicle_routes where vehicle_id = ''%s''', v1),'ok:0');
  perform pg_temp.chk('다른 지사: 남의 장비 시각은 못 고침(0건)','authenticated',b2,format('update public.vehicle_routes set times = ''{09:00}'' where vehicle_id = ''%s'' and date = ''2099-12-01''', v1),'ok:0');
  perform pg_temp.chk('다른 지사: 저장 함수로도 거절','authenticated',b2,format(rt, format('[{"date":"2099-12-01","vehicle_id":"%s","stops":["B003"],"times":["09:00"]}]', v1), rid),'err:42501');
  perform pg_temp.chk('기계화부: 지역본부 장비 경로 거절','authenticated',e,format(rt, format('[{"date":"2099-12-01","vehicle_id":"%s","stops":["B003"],"times":["09:00"]}]', v1), rid),'err:42501');
  perform pg_temp.yes('경로는 그대로', (select times = array['08:20'] from public.vehicle_routes where date = '2099-12-01' and vehicle_id = v1));

  -- 지원 여부는 늘 지원
  perform pg_temp.chk('관리자: 지원 불가로 바꾸기 거절','authenticated',a,format('select public.save_fleet(''[]'', ''[]'', %s, ''[{"vehicle_id":"%s","status":"X"}]'')', rid, v1),'err:23514');
  perform pg_temp.chk('관리자: 지원 불가 시작일 거절','authenticated',a,format('select public.save_fleet(''[]'', ''[]'', %s, ''[{"vehicle_id":"%s","status":"O","off_from":"2099-12-02"}]'')', rid, v1),'err:23514');
  perform pg_temp.chk('지사: 지원 여부 직접 고치기는 0건','authenticated',b1,format('update public.round_vehicle_status set status = ''X'' where vehicle_id = ''%s''', v1),'ok:0');

  -- 번호·임차 고치기, 삭제
  perform pg_temp.chk('지사: 번호 고침(252 → 253)','authenticated',b1,format(vh, format('[{"id":"%s","plate":"%s"}]', v1, n1 || '253')),'ok:1');
  perform pg_temp.chk('지사: 임차로 바꿈(이름도 함께)','authenticated',b1,format(vh, format('[{"id":"%s","plate":"%s","rented":true}]', v1, n1 || '임차253')),'ok:1');
  perform pg_temp.chk('지사: 임차만 바꾸고 이름이 안 맞으면 거절','authenticated',b1,format(vh, format('[{"id":"%s","rented":false}]', v1)),'err:23514');
  perform pg_temp.chk('지사: 이미 있는 이름으로는 거절','authenticated',b1,format(vh, format('[{"id":"%s","plate":"%s"}]', v1, n1 || '임차1')),'err:23505');
  perform pg_temp.chk('다른 지사: 남의 장비 고치기 거절','authenticated',b2,format(vh, format('[{"id":"%s","plate":"%s"}]', v1, n1 || '임차999')),'err:42501');
  perform pg_temp.chk('지사: 출발 지사 바꾸기 거절','authenticated',b1,format('update public.vehicles set home_branch = ''B002'' where id = ''%s''', v2),'err:42501');
  perform pg_temp.chk('관리자도 기준일자·출발 지사는 못 바꿈','authenticated',a,format('update public.vehicles set home_branch = ''B002'' where id = ''%s''', v2),'err:42501');
  perform pg_temp.chk('지사: 경로가 있는 장비 삭제 거절','authenticated',b1,format('delete from public.vehicles where id = ''%s''', v1),'err:23503');
  perform pg_temp.chk('다른 지사: 남의 장비 삭제는 0건','authenticated',b2,format('delete from public.vehicles where id = ''%s''', v3),'ok:0');
  perform pg_temp.chk('기계화부: 지역본부 장비 삭제는 0건','authenticated',e,format('delete from public.vehicles where id = ''%s''', v3),'ok:0');
  perform pg_temp.chk('지사: 경로 없는 장비 삭제','authenticated',b1,format('delete from public.vehicles where id = ''%s''', v3),'ok:1');
  perform pg_temp.yes('지원 여부 줄도 함께 지워짐', not exists (select 1 from public.round_vehicle_status where vehicle_id = v3));
  perform pg_temp.chk('지사: 기계화부 장비 삭제는 0건','authenticated',b1,'delete from public.vehicles where plate = ''서울경기9971''','ok:0');

  -- 확정 취소: 등록한 장비·경로는 그대로, 새 등록만 막힘. 대수를 등록 대수보다 줄여도 저장·확정됨
  perform pg_temp.chk('관리자: B001 확정 취소','authenticated',a,format(rq, rid, '[{"branch_id":"B001","confirmed":false}]'),'ok:1');
  perform pg_temp.yes('장비·경로는 남음', (select count(*) = 3 from public.vehicles where round_id = rid and home_branch = 'B001') and exists (select 1 from public.vehicle_routes where vehicle_id = v1));
  perform pg_temp.chk('확정 취소 뒤 새 등록 거절','authenticated',b1,format(ins, '제설차', n1 || '400', rid, 'B001', 'false'),'err:SA004');
  perform pg_temp.chk('지사: 대수를 1로 줄임(등록 3대보다 적어도 저장)','authenticated',b1,format(rq, rid, '[{"branch_id":"B001","offer_truck":1}]'),'ok:1');
  perform pg_temp.chk('관리자: 다시 확정','authenticated',a,format(rq, rid, '[{"branch_id":"B001","confirmed":true}]'),'ok:1');
  perform pg_temp.chk('다시 확정 뒤 등록됨','authenticated',b1,format(ins, '제설차', n1 || '400', rid, 'B001', 'false'),'ok:1');

  -- 기관별 배정의 '지역본부' 칸(제설차만), 계정 소속으로는 못 씀
  perform pg_temp.chk('관리자: 지역본부 → B003 제설차 1대 배정','authenticated',a,format('select public.save_allocations(%s, ''[{"org":"지역본부","branch_id":"B003","truck":1}]'')', rid),'ok:1');
  perform pg_temp.chk('지역본부 제설기 배정은 거절','authenticated',a,format('select public.save_allocations(%s, ''[{"org":"지역본부","branch_id":"B003","truck":1,"blower":1}]'')', rid),'err:23514');
  perform pg_temp.chk('계정의 출발 기관으로 지역본부는 못 씀','postgres',a,format('update public.profiles set org = ''지역본부'' where id = ''%s''', e),'err:23514');

  -- 새 기준일자: 지역본부 장비는 이어받지 않고, 그날부터는 경로도 못 넣음. 같은 이름으로 다시 등록할 수 있음
  perform pg_temp.chk('관리자: 새 기준일자(12-03)','authenticated',a,'select public.create_round(''2099-12-03'')','ok:1');
  select id into rid2 from public.support_rounds where start_date = '2099-12-03';
  perform pg_temp.yes('새 기준일자에 지역본부 장비 지원 여부 줄 없음(기계화부 장비는 있음)', not exists (select 1 from public.round_vehicle_status s join public.vehicles v on v.id = s.vehicle_id where s.round_id = rid2 and v.org = '지역본부')
    and exists (select 1 from public.round_vehicle_status s where s.round_id = rid2));
  perform pg_temp.chk('관리자: 예전 기준일자 장비를 새 기준일자 날짜에 넣기 거절','authenticated',a,format(rt, format('[{"date":"2099-12-03","vehicle_id":"%s","stops":["B003"]}]', v1), rid2),'err:23514');
  perform pg_temp.chk('관리자: 새 기준일자에 B001 지원 가능 1대 확정','authenticated',a,format(rq, rid2, '[{"branch_id":"B001","offer_truck":1,"confirmed":true}]'),'ok:1');
  perform pg_temp.chk('지사: 새 기준일자에 같은 이름으로 다시 등록','authenticated',b1,format(ins, '제설차', n1 || '임차1', rid2, 'B001', 'true'),'ok:1');
  perform pg_temp.yes('기준일자마다 따로', (select count(*) = 2 from public.vehicles where plate = n1 || '임차1'));
  perform pg_temp.chk('관리자: 새 기준일자 삭제(딸린 장비도 함께)','authenticated',a,format('delete from public.support_rounds where id = %s', rid2),'ok:1');
  perform pg_temp.yes('그 기준일자의 지역본부 장비만 지워짐', not exists (select 1 from public.vehicles where round_id = rid2) and (select count(*) = 4 from public.vehicles where round_id = rid));

  select count(*), count(*) filter (where not ok) into total, fails from _t;
  raise exception E'지역본부 장비 시험 — 전체 %, 실패 %\n%', total, fails, (select string_agg('FAIL ' || name || ' → ' || got || ' / ' || want, E'\n' order by n) from _t where not ok);
end $t$;
