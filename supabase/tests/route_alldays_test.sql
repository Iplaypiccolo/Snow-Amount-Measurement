-- ============================================================
-- 기계화부·지사가 모든 지원일에서 피지원 지사를 고르는지(마이그레이션 53) 시험 — SQL Editor 에 통째로 붙여넣고 실행(53 적용 뒤)
-- 마지막에 일부러 오류를 내서 시험 자료(2099년 기준일자, V9001·V9003~V9005, 시험 계정)를 전부 되돌립니다. "전체 N, 실패 0" 이어야 합니다.
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
declare a uuid := gen_random_uuid(); e1 uuid := gen_random_uuid(); b uuid := gen_random_uuid(); cc uuid := gen_random_uuid(); rid bigint; c bigint; f bigint;
  sf text := 'select public.save_fleet(''[]'', ''[{"date":"%s","vehicle_id":"%s","stops":%s}]'', %s)';
begin
  insert into auth.users (id, aud, role, email) values (a,'authenticated','authenticated','ra@t.test'),(e1,'authenticated','authenticated','re1@t.test'),(b,'authenticated','authenticated','rb@t.test'),(cc,'authenticated','authenticated','rc@t.test');
  insert into public.profiles (id,username,display_name,role,branch_id,org,hq_id,perms,must_change) values
    (a,'ra-adm','관리자','admin',null,null,null,'{}',false),
    (e1,'ra-eq1','서울경기 기계화부','equip',null,'서울경기',null,'{equip.edit.own,equip.edit.all}',false),
    (b,'ra-br1','지사1','branch','B001',null,null,'{req.edit.own}',false),(cc,'ra-br2','지사2','branch','B002',null,null,'{req.edit.own}',false);
  perform set_config('request.jwt.claims', '', true);
  insert into public.support_rounds (name,start_date,days) values ('t','2099-12-01',4) returning id into rid;     -- 지원일 4일: 12-01 ~ 12-04
  insert into public.vehicles (id,org,type,plate) values ('V9001','서울경기','제설차','서울경기9901'),('V9005','서울경기','제설차','서울경기9905');
  insert into public.vehicles (id,org,type,plate,round_id,home_branch) values
    ('V9003','지역본부','제설차',(select name from public.branches where id='B001')||'9901', rid, 'B001'),
    ('V9004','지역본부','제설차',(select name from public.branches where id='B001')||'9902', rid, 'B001');
  insert into public.round_vehicle_status (round_id, vehicle_id, status) values (rid,'V9001','O'),(rid,'V9005','O'),(rid,'V9003','O'),(rid,'V9004','O') on conflict do nothing;
  insert into public.round_allocations (round_id, org, branch_id, truck) values (rid,'서울경기','B002',1),(rid,'서울경기','B003',1),(rid,'지역본부','B002',1);

  perform pg_temp.chk('기계화부: 지원일 2 배정 지사','authenticated',e1,format(sf,'2099-12-02','V9001','["B002"]',rid),'ok:1');
  perform pg_temp.chk('기계화부: 지원일 2 같은 지사 두 대째 = 배정 넘김','authenticated',e1,format(sf,'2099-12-02','V9005','["B002"]',rid),'err:SA002');
  perform pg_temp.chk('기계화부: 지원일 2 다른 배정 지사','authenticated',e1,format(sf,'2099-12-02','V9005','["B003"]',rid),'ok:1');
  perform pg_temp.chk('기계화부: 지원일 1 은 날마다 따로 셈','authenticated',e1,format(sf,'2099-12-01','V9005','["B002"]',rid),'ok:1');
  perform pg_temp.chk('기계화부: 마지막 지원일(4)','authenticated',e1,format(sf,'2099-12-04','V9001','["B003"]',rid),'ok:1');
  perform pg_temp.chk('기계화부: 지원일 밖(12-05) 거절(기준일자 밖 날짜는 그 전 검사가 먼저 막음 23514)','authenticated',e1,format(sf,'2099-12-05','V9001','["B003"]',rid),'err:23514');
  perform pg_temp.chk('기계화부: 배정 안 한 지사 거절','authenticated',e1,format(sf,'2099-12-03','V9001','["B004"]',rid),'err:SA001');
  perform pg_temp.chk('기계화부: 하루 두 곳 거절','authenticated',e1,format(sf,'2099-12-03','V9001','["B002","B003"]',rid),'err:SA003');
  perform pg_temp.chk('관리자: 지원일 3 두 곳','authenticated',a,format(sf,'2099-12-03','V9001','["B002","B003"]',rid),'ok:1');
  perform pg_temp.chk('기계화부: 관리자가 정한 두 곳은 못 바꿈','authenticated',e1,format(sf,'2099-12-03','V9001','["B002"]',rid),'err:SA003');
  perform pg_temp.chk('지사: 자기 지역본부 장비 지원일 2','authenticated',b,format(sf,'2099-12-02','V9003','["B002"]',rid),'ok:1');
  perform pg_temp.chk('지사: 지원일 2 배정 넘김','authenticated',b,format(sf,'2099-12-02','V9004','["B002"]',rid),'err:SA002');
  perform pg_temp.chk('지사: 지원일 3 자기 지사로 거절','authenticated',b,format(sf,'2099-12-03','V9003','["B001"]',rid),'err:SA005');
  perform pg_temp.chk('다른 지사: 남의 지역본부 장비 거절','authenticated',cc,format(sf,'2099-12-02','V9003','["B002"]',rid),'err:42501');
  perform pg_temp.chk('기계화부: 자기가 정한 지원일 2 지우기','authenticated',e1,format(sf,'2099-12-02','V9001','[]',rid),'ok:1');
  perform pg_temp.yes('지원일 2 V9005=B003, 지원일 1 V9005=B002, 지원일 4 V9001=B003 이 남음',
    (select count(*) = 3 from public.vehicle_routes where (date, vehicle_id, stops) in (('2099-12-02','V9005','{B003}'),('2099-12-01','V9005','{B002}'),('2099-12-04','V9001','{B003}'))));

  select count(*), count(*) filter (where not ok) into c, f from _t;
  raise exception E'모든 지원일 시험 — 전체 %, 실패 %\n%', c, f, coalesce((select string_agg('FAIL ' || name || ' → ' || got || ' / ' || want, E'\n' order by n) from _t where not ok), '(모두 통과)');
end $t$;
