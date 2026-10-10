-- ============================================================
-- 기관별 배정(마이그레이션 43) 시험 — 관리자의 기관 → 지사 배정 대수, 기계화부(지원장비 계정)의 첫날 지사 지정·대수 넘김·서로 바꾸기·관리자 경로 보호 — SQL Editor 에 통째로 붙여넣고 실행
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
declare a uuid := gen_random_uuid(); e uuid := gen_random_uuid(); e2 uuid := gen_random_uuid(); b uuid := gen_random_uuid(); rid bigint; fails int; total int; res text;
  al text := 'select public.save_allocations(%s, ''%s'')'; rt text := 'select public.save_fleet(''[]'', ''%s'', %s)';
begin
  insert into auth.users (id, aud, role, email) values (a,'authenticated','authenticated','aa@t.test'),(e,'authenticated','authenticated','ae@t.test'),(e2,'authenticated','authenticated','ae2@t.test'),(b,'authenticated','authenticated','ab@t.test');
  insert into public.profiles (id,username,display_name,role,branch_id,org,hq_id,perms,must_change) values
    (a,'al-adm','관리자','admin',null,null,null,'{}',false),(e,'al-eq','서울경기 기계화부','equip',null,'서울경기',null,'{equip.edit.own}',false),
    (e2,'al-eq2','충북 기계화부','equip',null,'충북',null,'{equip.edit.own}',false),(b,'al-br','지사','branch','B001',null,null,'{req.edit.own}',false);
  insert into public.vehicles (id,org,type,plate) values ('V9001','서울경기','제설차','서울경기9901'),('V9003','서울경기','제설차','서울경기9903'),('V9004','서울경기','제설기','서울경기9904'),
    ('V9005','서울경기','이동정비차','서울경기9905'),('V9002','충북','제설차','충북9902');
  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);
  insert into public.support_rounds (name,start_date,days) values ('t','2099-12-01',10) returning id into rid;
  perform pg_temp.chk('관리자: 장비 5대 지원 가능','authenticated',a,format('select public.save_fleet(''[]'', ''[]'', %s, ''[{"vehicle_id":"V9001","status":"O"},{"vehicle_id":"V9003","status":"O"},{"vehicle_id":"V9004","status":"O"},{"vehicle_id":"V9005","status":"O"},{"vehicle_id":"V9002","status":"O"}]'')', rid),'ok:1');
  perform pg_temp.chk('관리자: B001·B002 편성 확정','authenticated',a,format('select public.save_requests(%s, ''[{"branch_id":"B001","assigned_truck":1,"assigned_blower":1,"confirmed":true},{"branch_id":"B002","assigned_truck":1,"confirmed":true}]'')', rid),'ok:1');

  -- 배정 표: 관리자만 쓰고 모두 읽음
  perform pg_temp.chk('기계화부: 배정 저장 거절','authenticated',e,format(al, rid, '[{"org":"서울경기","branch_id":"B001","truck":9}]'),'err:42501');
  perform pg_temp.chk('지사: 배정 표 직접 쓰기 거절','authenticated',b,format('insert into public.round_allocations (round_id, org, branch_id, truck) values (%s, ''서울경기'', ''B001'', 1)', rid),'err:42501');
  perform pg_temp.chk('관리자: 확정 안 된 지사(B003) 배정 거절','authenticated',a,format(al, rid, '[{"org":"서울경기","branch_id":"B003","truck":1}]'),'err:23514');
  perform pg_temp.chk('관리자: 없는 기관 거절','authenticated',a,format(al, rid, '[{"org":"없는기관","branch_id":"B001","truck":1}]'),'err:23503');
  perform pg_temp.chk('관리자: 서울경기 → B001 제설차 1·제설기 1, B002 제설차 1','authenticated',a,format(al, rid, '[{"org":"서울경기","branch_id":"B001","truck":1,"blower":1},{"org":"서울경기","branch_id":"B002","truck":1}]'),'ok:1');
  perform pg_temp.yes('배정 2줄', (select count(*) = 2 and sum(truck) = 2 and sum(blower) = 1 from public.round_allocations where round_id = rid));
  perform pg_temp.chk('지사 계정: 배정 표 읽기','authenticated',b,format('select 1 from public.round_allocations where round_id = %s', rid),'ok:2');
  perform pg_temp.chk('비로그인: 배정 표 읽기 차단','anon',null,'select 1 from public.round_allocations','err:42501');
  perform pg_temp.yes('배정도 수정 기록에 남음', (select count(*) >= 2 from public.audit_log where tab = 'round_allocations' and target like 'round_allocations:' || rid || ',서울경기,%'));

  -- 기계화부: 첫날, 자기 기관 장비, 배정받은 지사, 배정 대수까지
  perform pg_temp.chk('기계화부: V9001 → B001(첫날)','authenticated',e,format(rt, '[{"date":"2099-12-01","vehicle_id":"V9001","stops":["B001"],"times":["07:30"]}]', rid),'ok:1');
  perform pg_temp.yes('경로 저장(최초 지원·시각)', (select stops = array['B001'] and not revised and times = array['07:30'] and confirmed_by = e from public.vehicle_routes where date = '2099-12-01' and vehicle_id = 'V9001'));
  perform pg_temp.chk('기계화부: B001 제설차 2대째는 거절(배정 1대)','authenticated',e,format(rt, '[{"date":"2099-12-01","vehicle_id":"V9003","stops":["B001"]}]', rid),'err:SA002');
  perform pg_temp.yes('거절되어 V9003 경로 없음', not exists (select 1 from public.vehicle_routes where vehicle_id = 'V9003'));
  perform pg_temp.chk('기계화부: V9003 → B002','authenticated',e,format(rt, '[{"date":"2099-12-01","vehicle_id":"V9003","stops":["B002"]}]', rid),'ok:1');
  perform pg_temp.chk('기계화부: 한 번에 서로 바꾸기(V9001 ↔ V9003)','authenticated',e,format(rt, '[{"date":"2099-12-01","vehicle_id":"V9001","stops":["B002"]},{"date":"2099-12-01","vehicle_id":"V9003","stops":["B001"]}]', rid),'ok:1');
  perform pg_temp.yes('바뀜', (select stops = array['B002'] from public.vehicle_routes where date = '2099-12-01' and vehicle_id = 'V9001') and (select stops = array['B001'] from public.vehicle_routes where date = '2099-12-01' and vehicle_id = 'V9003'));
  perform pg_temp.chk('기계화부: 배정받지 않은 지사(B003) 거절','authenticated',e,format(rt, '[{"date":"2099-12-01","vehicle_id":"V9001","stops":["B003"]}]', rid),'err:SA001');
  perform pg_temp.chk('기계화부: 제설기를 제설기 배정이 없는 지사(B002)로 거절','authenticated',e,format(rt, '[{"date":"2099-12-01","vehicle_id":"V9004","stops":["B002"]}]', rid),'err:SA001');
  perform pg_temp.chk('기계화부: 제설기 → B001','authenticated',e,format(rt, '[{"date":"2099-12-01","vehicle_id":"V9004","stops":["B001"]}]', rid),'ok:1');
  perform pg_temp.chk('기계화부: 이동정비차는 배정받은 아무 지사로(대수 제한 없음)','authenticated',e,format(rt, '[{"date":"2099-12-01","vehicle_id":"V9005","stops":["B002"]}]', rid),'ok:1');
  perform pg_temp.chk('기계화부: 둘째 날은 거절(관리자만)','authenticated',e,format(rt, '[{"date":"2099-12-02","vehicle_id":"V9001","stops":["B001"]}]', rid),'err:SA003');
  perform pg_temp.chk('기계화부: 하루 두 곳은 거절(관리자만)','authenticated',e,format(rt, '[{"date":"2099-12-01","vehicle_id":"V9001","stops":["B002","B001"]}]', rid),'err:SA003');
  perform pg_temp.chk('기계화부: 다른 기관(충북) 장비 거절','authenticated',e,format(rt, '[{"date":"2099-12-01","vehicle_id":"V9002","stops":["B001"]}]', rid),'err:42501');
  perform pg_temp.chk('충북 기계화부: 충북은 배정이 없어 거절','authenticated',e2,format(rt, '[{"date":"2099-12-01","vehicle_id":"V9002","stops":["B001"]}]', rid),'err:SA001');
  perform pg_temp.chk('충북 기계화부: 직접 넣기도 같은 규칙(둘째 날 거절)','authenticated',e2,'insert into public.vehicle_routes (date,vehicle_id,stops) values (''2099-12-02'',''V9002'',''{B001}'')','err:SA003');
  perform pg_temp.chk('충북 기계화부: 서울경기 장비 경로는 못 건드림(0건)','authenticated',e2,'update public.vehicle_routes set stops = ''{B001}'' where vehicle_id = ''V9001''','ok:0');
  perform pg_temp.chk('지사 계정: 경로 넣기 거절','authenticated',b,'insert into public.vehicle_routes (date,vehicle_id,stops) values (''2099-12-01'',''V9001'',''{B001}'')','err:42501');
  perform pg_temp.chk('기계화부: 시각만 고치기(예전과 같음)','authenticated',e,format(rt, '[{"date":"2099-12-01","vehicle_id":"V9001","stops":["B002"],"times":["06:10"]}]', rid),'ok:1');
  perform pg_temp.chk('기계화부: V9003 지정 지우기','authenticated',e,format(rt, '[{"date":"2099-12-01","vehicle_id":"V9003","stops":[]}]', rid),'ok:1');
  perform pg_temp.yes('지워짐', not exists (select 1 from public.vehicle_routes where vehicle_id = 'V9003'));

  -- 관리자가 넣은 여러 곳·수정본·둘째 날 경로는 기계화부가 못 바꿈(시각만). 관리자가 넣은 경로도 대수에 들어감
  perform pg_temp.chk('관리자: V9001 첫날 두 곳(수정본) + 둘째 날','authenticated',a,format(rt, '[{"date":"2099-12-01","vehicle_id":"V9001","stops":["B001","B002"],"revised":true},{"date":"2099-12-02","vehicle_id":"V9001","stops":["B001"]}]', rid),'ok:1');
  perform pg_temp.chk('기계화부: 관리자가 넣은 경로 바꾸기 거절','authenticated',e,format(rt, '[{"date":"2099-12-01","vehicle_id":"V9001","stops":["B002"]}]', rid),'err:SA003');
  perform pg_temp.chk('기계화부: 관리자가 넣은 경로 지우기 거절','authenticated',e,format(rt, '[{"date":"2099-12-01","vehicle_id":"V9001","stops":[]}]', rid),'err:SA003');
  perform pg_temp.chk('기계화부: 직접 UPDATE 로 둘째 날 지사 바꾸기 거절','authenticated',e,'update public.vehicle_routes set stops = ''{B002}'' where vehicle_id = ''V9001'' and date = ''2099-12-02''','err:SA003');
  perform pg_temp.chk('기계화부: 직접 DELETE 로 자기 기관 경로 모두 지우기 거절(관리자 경로가 섞임)','authenticated',e,'delete from public.vehicle_routes where vehicle_id = ''V9001''','err:SA003');
  perform pg_temp.chk('기계화부: 관리자 경로의 시각은 고칠 수 있음','authenticated',e,format(rt, '[{"date":"2099-12-01","vehicle_id":"V9001","stops":["B001","B002"],"times":["05:00","13:00"]}]', rid),'ok:1');
  perform pg_temp.yes('구분(수정본)·지사는 그대로, 시각만', (select revised and stops = array['B001','B002'] and times = array['05:00','13:00'] from public.vehicle_routes where date = '2099-12-01' and vehicle_id = 'V9001'));
  perform pg_temp.chk('기계화부: 관리자 경로(첫 지사 B001)도 대수에 들어가 V9003 → B001 거절','authenticated',e,format(rt, '[{"date":"2099-12-01","vehicle_id":"V9003","stops":["B001"]}]', rid),'err:SA002');

  -- 관리자가 배정을 줄여도 이미 정한 경로는 그대로(화면이 '배정 초과'로 표시)
  perform pg_temp.chk('관리자: B002 제설차 배정 0 으로(줄 삭제)','authenticated',a,format(al, rid, '[{"org":"서울경기","branch_id":"B002","truck":0,"blower":0}]'),'ok:1');
  perform pg_temp.yes('배정 줄은 지워지고 이동정비차 경로(B002)는 남음', not exists (select 1 from public.round_allocations where round_id = rid and branch_id = 'B002')
    and exists (select 1 from public.vehicle_routes where vehicle_id = 'V9005' and stops = array['B002']));
  perform pg_temp.chk('관리자: 배정 대수와 상관없이 경로를 넣을 수 있음','authenticated',a,format(rt, '[{"date":"2099-12-01","vehicle_id":"V9003","stops":["B001"]}]', rid),'ok:1');

  -- 저장 함수 밖에서 직접 넣어도 끝에서 대수를 셈(미룬 검사)
  perform pg_temp.chk('관리자: V9003 경로 비움','authenticated',a,format(rt, '[{"date":"2099-12-01","vehicle_id":"V9003","stops":[]}]', rid),'ok:1');
  set constraints all deferred;
  perform pg_temp.chk('기계화부: 직접 INSERT(넣는 순간은 통과)','authenticated',e,'insert into public.vehicle_routes (date,vehicle_id,stops) values (''2099-12-01'',''V9003'',''{B001}'')','ok:1');
  perform set_config('request.jwt.claims', json_build_object('sub', e, 'role', 'authenticated')::text, true);
  begin set constraints all immediate; res := 'ok'; exception when others then res := 'err:' || sqlstate; end;
  perform pg_temp.yes('저장이 끝날 때 대수 넘김으로 거절(SA002)', res = 'err:SA002', res);

  -- 권한이 없는 계정은 예전처럼 42501
  update public.profiles set disabled = true where id = e2;
  perform pg_temp.chk('비활성 계정: 경로 넣기는 여전히 42501','authenticated',e2,'insert into public.vehicle_routes (date,vehicle_id,stops) values (''2099-12-02'',''V9002'',''{B001}'')','err:42501');

  select count(*), count(*) filter (where not ok) into total, fails from _t;
  raise exception E'기관별 배정 시험 — 전체 %, 실패 %\n%', total, fails, (select string_agg('FAIL ' || name || ' → ' || got || ' / ' || want, E'\n' order by n) from _t where not ok);
end $t$;
