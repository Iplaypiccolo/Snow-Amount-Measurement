-- ============================================================
-- 지원일 칸·기관별 배정 = 관리자만, 지사는 자기 지사 지역본부 장비 첫날 한 곳(마이그레이션 49, equip.route) 시험 — SQL Editor 에 통째로 붙여넣고 실행
-- (2026-11-02 마이그레이션 53 뒤로는 '둘째 날 거절' 항목이 바뀜 — 지금 규칙은 route_alldays_test.sql)
-- 마지막에 일부러 오류를 내서 시험 자료(2099년 기준일자, V9001·V9002, 시험 계정)를 전부 되돌립니다. "전체 N, 실패 0" 이어야 합니다.
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
declare a uuid := gen_random_uuid(); e1 uuid := gen_random_uuid(); e2 uuid := gen_random_uuid(); b uuid := gen_random_uuid(); cc uuid := gen_random_uuid(); rid bigint; c bigint; f bigint;
begin
  insert into auth.users (id, aud, role, email) values (a,'authenticated','authenticated','pa@t.test'),(e1,'authenticated','authenticated','pe1@t.test'),(e2,'authenticated','authenticated','pe2@t.test'),(b,'authenticated','authenticated','pb@t.test'),(cc,'authenticated','authenticated','pc@t.test');
  insert into public.profiles (id,username,display_name,role,branch_id,org,hq_id,perms,must_change) values
    (a,'rp-adm','관리자','admin',null,null,null,'{}',false),
    (e1,'rp-eq1','장비(자기 기관)','equip',null,'서울경기',null,'{equip.edit.own}',false),
    (e2,'rp-eq2','장비(모든 기관)','equip',null,'서울경기',null,'{equip.edit.own,equip.edit.all}',false),
    (b,'rp-br1','지사1','branch','B001',null,null,'{req.edit.own}',false),(cc,'rp-br2','지사2','branch','B002',null,null,'{req.edit.own}',false);
  insert into public.vehicles (id,org,type,plate) values ('V9001','서울경기','제설차','서울경기9901'),('V9002','충북','제설차','충북9902');
  insert into public.support_rounds (name,start_date,days) values ('t','2099-12-01',10) returning id into rid;
  insert into public.round_vehicle_status (round_id, vehicle_id, status) values (rid,'V9001','O'),(rid,'V9002','O');

  perform pg_temp.yes('새 권한 equip.route 있음, 기본으로 주는 역할 없음', exists (select 1 from public.permissions where key = 'equip.route' and default_roles = '{}'));
  perform pg_temp.yes('equip.edit.all 이름에서 경로가 빠짐', (select label not like '%경로%' from public.permissions where key = 'equip.edit.all'));
  -- 관리자: 지원일 칸 전부
  perform pg_temp.chk('관리자: 둘째 날 두 곳','authenticated',a,format('select public.save_fleet(''[]'', ''[{"date":"2099-12-02","vehicle_id":"V9001","stops":["B001","B002"]}]'', %s)', rid),'ok:1');
  perform pg_temp.chk('관리자: 다른 기관 장비도','authenticated',a,format('select public.save_fleet(''[]'', ''[{"date":"2099-12-03","vehicle_id":"V9002","stops":["B003"]}]'', %s)', rid),'ok:1');
  -- '모든 기관' 권한만 있는 지원장비: 지원일 칸은 예전 수준
  perform pg_temp.chk('모든 기관 지원장비: 둘째 날 경로 거절(첫날만)','authenticated',e2,format('select public.save_fleet(''[]'', ''[{"date":"2099-12-04","vehicle_id":"V9001","stops":["B001"]}]'', %s)', rid),'err:SA003');
  perform pg_temp.chk('모든 기관 지원장비: 관리자가 넣은 여러 곳 바꾸기 거절','authenticated',e2,format('select public.save_fleet(''[]'', ''[{"date":"2099-12-02","vehicle_id":"V9001","stops":["B001"]}]'', %s)', rid),'err:SA003');
  perform pg_temp.chk('모든 기관 지원장비: 관리자 경로 지우기 거절','authenticated',e2,format('select public.save_fleet(''[]'', ''[{"date":"2099-12-02","vehicle_id":"V9001","stops":[]}]'', %s)', rid),'err:SA003');
  perform pg_temp.chk('모든 기관 지원장비: 자기 기관 장비 도착 시각은 됨','authenticated',e2,format('select public.save_fleet(''[]'', ''[{"date":"2099-12-02","vehicle_id":"V9001","stops":["B001","B002"],"times":["06:10","09:20"]}]'', %s)', rid),'ok:1');
  perform pg_temp.chk('모든 기관 지원장비: 다른 기관 장비 경로 거절','authenticated',e2,format('select public.save_fleet(''[]'', ''[{"date":"2099-12-01","vehicle_id":"V9002","stops":["B001"]}]'', %s)', rid),'err:42501');
  perform pg_temp.chk('모든 기관 지원장비: 다른 기관 장비 도착 시각도 거절','authenticated',e2,format('select public.save_fleet(''[]'', ''[{"date":"2099-12-03","vehicle_id":"V9002","stops":["B003"],"times":["07:00"]}]'', %s)', rid),'err:42501');
  perform pg_temp.chk('모든 기관 지원장비: 표에 직접 넣기(다른 기관) 거절','authenticated',e2,'insert into public.vehicle_routes (date, vehicle_id, stops) values (''2099-12-05'', ''V9002'', ''{B001}'')','err:42501');
  perform pg_temp.chk('모든 기관 지원장비: 표에 직접 넣기(자기 기관 둘째 날) 거절','authenticated',e2,'insert into public.vehicle_routes (date, vehicle_id, stops) values (''2099-12-05'', ''V9001'', ''{B001}'')','err:SA003');
  perform pg_temp.chk('모든 기관 지원장비: 다른 기관 장비 지원 여부는 그대로 됨','authenticated',e2,format('select public.save_fleet(''[]'', ''[]'', %s, ''[{"vehicle_id":"V9002","status":"M"}]'')', rid),'ok:1');
  perform pg_temp.chk('모든 기관 지원장비: 다른 기관 장비 숨기기는 그대로 됨','authenticated',e2,'update public.vehicles set hidden_after = ''2099-11-30'' where id = ''V9002''','ok:1');
  -- 자기 기관 권한만: 예전과 같음
  perform pg_temp.chk('자기 기관 지원장비: 둘째 날 경로 거절','authenticated',e1,format('select public.save_fleet(''[]'', ''[{"date":"2099-12-06","vehicle_id":"V9001","stops":["B001"]}]'', %s)', rid),'err:SA003');
  perform pg_temp.chk('자기 기관 지원장비: 도착 시각은 됨','authenticated',e1,format('select public.save_fleet(''[]'', ''[{"date":"2099-12-02","vehicle_id":"V9001","stops":["B001","B002"],"times":["06:30","09:20"]}]'', %s)', rid),'ok:1');
  -- 지역본부 장비: 그 지사가 첫날 한 곳(관리자가 '지역본부'에 배정한 지사·대수 안, 자기 지사 안 됨)
  perform set_config('request.jwt.claims', '', true);          -- 아래 자료 넣기는 로그인 사용자 없이(서버 관리용 작업처럼)
  insert into public.vehicles (id,org,type,plate,round_id,home_branch) values
    ('V9003','지역본부','제설차',(select name from public.branches where id='B001')||'9901', rid, 'B001'),
    ('V9004','지역본부','제설차',(select name from public.branches where id='B001')||'9902', rid, 'B001');
  insert into public.round_vehicle_status (round_id, vehicle_id, status) values (rid,'V9003','O'),(rid,'V9004','O') on conflict do nothing;
  insert into public.round_allocations (round_id, org, branch_id, truck) values (rid, '지역본부', 'B002', 1);
  perform pg_temp.chk('지사: 자기 지역본부 장비 첫날 배정 지사로','authenticated',b,format('select public.save_fleet(''[]'', ''[{"date":"2099-12-01","vehicle_id":"V9003","stops":["B002"]}]'', %s)', rid),'ok:1');
  perform pg_temp.chk('지사: 배정 대수 넘김 거절','authenticated',b,format('select public.save_fleet(''[]'', ''[{"date":"2099-12-01","vehicle_id":"V9004","stops":["B002"]}]'', %s)', rid),'err:SA002');
  perform pg_temp.chk('지사: 자기 지사로는 거절','authenticated',b,format('select public.save_fleet(''[]'', ''[{"date":"2099-12-01","vehicle_id":"V9004","stops":["B001"]}]'', %s)', rid),'err:SA005');
  perform pg_temp.chk('지사: 배정받지 않은 지사 거절','authenticated',b,format('select public.save_fleet(''[]'', ''[{"date":"2099-12-01","vehicle_id":"V9004","stops":["B003"]}]'', %s)', rid),'err:SA001');
  perform pg_temp.chk('지사: 둘째 날은 거절','authenticated',b,format('select public.save_fleet(''[]'', ''[{"date":"2099-12-02","vehicle_id":"V9004","stops":["B002"]}]'', %s)', rid),'err:SA003');
  perform pg_temp.chk('다른 지사: 남의 지역본부 장비 거절','authenticated',cc,format('select public.save_fleet(''[]'', ''[{"date":"2099-12-01","vehicle_id":"V9003","stops":["B002"],"times":["07:00"]}]'', %s)', rid),'err:42501');
  perform pg_temp.chk('모든 기관 지원장비: 지역본부 장비 거절','authenticated',e2,format('select public.save_fleet(''[]'', ''[{"date":"2099-12-01","vehicle_id":"V9004","stops":["B002"]}]'', %s)', rid),'err:42501');
  perform pg_temp.chk('지사: 도착 시각','authenticated',b,format('select public.save_fleet(''[]'', ''[{"date":"2099-12-01","vehicle_id":"V9003","stops":["B002"],"times":["06:00"]}]'', %s)', rid),'ok:1');
  perform pg_temp.chk('지사: 자기가 정한 첫날 경로 지우기','authenticated',b,format('select public.save_fleet(''[]'', ''[{"date":"2099-12-01","vehicle_id":"V9003","stops":[]}]'', %s)', rid),'ok:1');
  -- 기관별 배정 = 관리자만
  perform pg_temp.chk('모든 기관 지원장비: 배정 저장 거절','authenticated',e2,format('select public.save_allocations(%s, ''[{"org":"서울경기","branch_id":"B002","truck":1}]'')', rid),'err:42501');
  perform pg_temp.chk('모든 기관 지원장비: 배정 표 직접 넣기 거절','authenticated',e2,format('insert into public.round_allocations (round_id, org, branch_id, truck) values (%s, ''서울경기'', ''B003'', 1)', rid),'err:42501');
  perform pg_temp.chk('모든 기관 지원장비: 배정 표 직접 고치기는 0줄','authenticated',e2,format('update public.round_allocations set truck = 3 where round_id = %s', rid),'ok:0');
  perform pg_temp.chk('관리자: 배정 표 고치기','authenticated',a,format('update public.round_allocations set truck = 2 where round_id = %s and org = ''지역본부''', rid),'ok:1');
  perform pg_temp.yes('관리자 경로는 그대로(지사 두 곳)', (select stops = '{B001,B002}' and times = '{06:30,09:20}' from public.vehicle_routes where vehicle_id = 'V9001' and date = '2099-12-02'));

  select count(*), count(*) filter (where not ok) into c, f from _t;
  raise exception E'지원일 칸 권한 시험 — 전체 %, 실패 %\n%', c, f, coalesce((select string_agg('FAIL ' || name || ' → ' || got || ' / ' || want, E'\n' order by n) from _t where not ok), '(모두 통과)');
end $t$;
