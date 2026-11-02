-- ============================================================
-- 지역본부 장비의 피지원 지사는 관리자만(마이그레이션 55) 시험 — SQL Editor 에 통째로 붙여넣고 실행(55 적용 뒤)
-- 마지막에 일부러 오류를 내서 시험 자료(2099년 기준일자, V9001·V9003, 시험 계정)를 전부 되돌립니다. "전체 N, 실패 0" 이어야 합니다.
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
  sf text := 'select public.save_fleet(''[]'', ''[{"date":"%s","vehicle_id":"%s","stops":%s%s}]'', %s)';
begin
  insert into auth.users (id, aud, role, email) values (a,'authenticated','authenticated','pa@t.test'),(e1,'authenticated','authenticated','pe1@t.test'),(b,'authenticated','authenticated','pb@t.test'),(cc,'authenticated','authenticated','pc@t.test');
  insert into public.profiles (id,username,display_name,role,branch_id,org,hq_id,perms,must_change) values
    (a,'pa-adm','관리자','admin',null,null,null,'{}',false),
    (e1,'pa-eq1','서울경기 기계화부','equip',null,'서울경기',null,'{equip.edit.own,equip.edit.all}',false),
    (b,'pa-br1','지사1','branch','B001',null,null,'{req.edit.own}',false),(cc,'pa-br2','지사2','branch','B002',null,null,'{req.edit.own}',false);
  perform set_config('request.jwt.claims', '', true);
  insert into public.support_rounds (name,start_date,days) values ('t','2099-12-01',4) returning id into rid;
  insert into public.vehicles (id,org,type,plate) values ('V9001','서울경기','제설차','서울경기9901');
  insert into public.vehicles (id,org,type,plate,round_id,home_branch) values ('V9003','지역본부','제설차',(select name from public.branches where id='B001')||'9901', rid, 'B001');
  insert into public.round_vehicle_status (round_id, vehicle_id, status) values (rid,'V9001','O'),(rid,'V9003','O') on conflict do nothing;
  insert into public.round_allocations (round_id, org, branch_id, truck) values (rid,'서울경기','B002',1),(rid,'지역본부','B002',1),(rid,'지역본부','B003',1);

  perform pg_temp.chk('지사: 지역본부 장비 지사 고르기 거절','authenticated',b,format(sf,'2099-12-01','V9003','["B002"]','',rid),'err:42501');
  perform pg_temp.chk('관리자: 지역본부 장비 지사 정함','authenticated',a,format(sf,'2099-12-01','V9003','["B002"]','',rid),'ok:1');
  perform pg_temp.chk('지사: 도착 예상 시각은 됨','authenticated',b,format(sf,'2099-12-01','V9003','["B002"]',',"times":["08:30"]',rid),'ok:1');
  perform pg_temp.yes('시각이 저장됨', (select times[1] = '08:30' from public.vehicle_routes where date='2099-12-01' and vehicle_id='V9003'));
  perform pg_temp.chk('지사: 정해진 지사 바꾸기 거절','authenticated',b,format(sf,'2099-12-01','V9003','["B003"]','',rid),'err:42501');
  perform pg_temp.chk('지사: 정해진 지사 지우기 거절','authenticated',b,format(sf,'2099-12-01','V9003','[]','',rid),'err:42501');
  perform pg_temp.chk('지사: 다른 지원일 지사 고르기 거절','authenticated',b,format(sf,'2099-12-02','V9003','["B002"]','',rid),'err:42501');
  perform pg_temp.chk('다른 지사: 남의 장비 시각 거절','authenticated',cc,format(sf,'2099-12-01','V9003','["B002"]',',"times":["09:00"]',rid),'err:42501');
  perform pg_temp.yes('경로는 관리자가 정한 그대로', (select stops = '{B002}' from public.vehicle_routes where date='2099-12-01' and vehicle_id='V9003'));
  perform pg_temp.chk('기계화부: 자기 기관 장비 지사 고르기는 그대로','authenticated',e1,format(sf,'2099-12-01','V9001','["B002"]','',rid),'ok:1');
  perform pg_temp.chk('기계화부: 지원일 2 도 그대로','authenticated',e1,format(sf,'2099-12-02','V9001','["B002"]','',rid),'ok:1');
  perform pg_temp.chk('기계화부: 배정 안 한 지사 거절은 그대로','authenticated',e1,format(sf,'2099-12-03','V9001','["B004"]','',rid),'err:SA001');
  perform pg_temp.chk('기계화부: 지역본부 장비 거절','authenticated',e1,format(sf,'2099-12-03','V9003','["B002"]','',rid),'err:42501');
  perform pg_temp.chk('관리자: 지역본부 장비 바꾸기','authenticated',a,format(sf,'2099-12-01','V9003','["B003"]','',rid),'ok:1');
  perform pg_temp.chk('관리자: 지역본부 장비 지우기','authenticated',a,format(sf,'2099-12-01','V9003','[]','',rid),'ok:1');

  select count(*), count(*) filter (where not ok) into c, f from _t;
  raise exception E'지역본부 장비 경로 시험 — 전체 %, 실패 %\n%', c, f, coalesce((select string_agg('FAIL ' || name || ' → ' || got || ' / ' || want, E'\n' order by n) from _t where not ok), '(모두 통과)');
end $t$;
