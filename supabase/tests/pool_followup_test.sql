-- ============================================================
-- 지역본부 장비 후속 고침(마이그레이션 45) 시험 — 장비 번호 1000번 넘김, 관리자의 기관 변경 복구(지역본부 장비는 고정), 기준일자 삭제 검사
-- SQL Editor 에 통째로 붙여넣고 실행. 마지막에 일부러 오류를 내서 시험 자료를 전부 되돌립니다. "전체 N, 실패 0" 이어야 합니다.
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
declare a uuid := gen_random_uuid(); b1 uuid := gen_random_uuid(); e uuid := gen_random_uuid();
  rid bigint; rid2 bigint; fails int; total int; n1 text; pv text;
  rq text := 'select public.save_requests(%s, ''%s'')'; rt text := 'select public.save_fleet(''[]'', ''%s'', %s)';
begin
  select name into n1 from public.branches where id = 'B001';
  insert into auth.users (id, aud, role, email) values (a,'authenticated','authenticated','fa@t.test'),(b1,'authenticated','authenticated','fb1@t.test'),(e,'authenticated','authenticated','fe@t.test');
  insert into public.profiles (id,username,display_name,role,branch_id,org,hq_id,perms,must_change) values
    (a,'pf-adm','관리자','admin',null,null,null,'{}',false),(b1,'pf-br1','지사1','branch','B001',null,null,'{req.edit.own}',false),(e,'pf-eq','서울경기 기계화부','equip',null,'서울경기',null,'{equip.edit.own}',false);
  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);
  insert into public.support_rounds (name,start_date,days) values ('t','2099-12-01',4) returning id into rid;

  -- ① 장비 번호: 999 다음은 V1000, V1001 …
  perform pg_temp.chk('관리자: 번호 V999 장비(준비)','authenticated',a,'insert into public.vehicles (id, org, type, plate) values (''V999'', ''서울경기'', ''제설차'', ''서울경기9981'')','ok:1');
  perform pg_temp.chk('기계화부: 번호 없이 추가(1000번째)','authenticated',e,'insert into public.vehicles (org, type, plate) values (''서울경기'', ''제설차'', ''서울경기9982'')','ok:1');
  perform pg_temp.yes('V1000 으로 매겨짐(예전에는 V100 으로 잘려 겹침)', (select id = 'V1000' from public.vehicles where plate = '서울경기9982'), coalesce((select id from public.vehicles where plate = '서울경기9982'), 'null'));
  perform pg_temp.chk('한 대 더','authenticated',e,'insert into public.vehicles (org, type, plate) values (''서울경기'', ''제설기'', ''서울경기9983'')','ok:1');
  perform pg_temp.yes('V1001', (select id = 'V1001' from public.vehicles where plate = '서울경기9983'));

  -- ② 기관 변경: 기계화부 장비는 관리자만(예전 규칙), 지역본부 장비는 누구도 못 바꿈
  perform pg_temp.chk('관리자: 기계화부 장비를 다른 기관으로(도공번호도 함께)','authenticated',a,'update public.vehicles set org = ''충북'', plate = ''충북9981'' where id = ''V999''','ok:1');
  perform pg_temp.chk('기계화부 계정: 다른 기관으로 옮기기는 거절','authenticated',e,'update public.vehicles set org = ''충북'', plate = ''충북9982'' where id = ''V1000''','err:42501');
  perform pg_temp.chk('관리자: B001 지원 가능 1대 확정 + B003 편성 확정','authenticated',a,format(rq, rid, '[{"branch_id":"B001","offer_truck":1,"confirmed":true},{"branch_id":"B003","assigned_truck":1,"confirmed":true}]'),'ok:1');
  perform pg_temp.chk('지사: 지역본부 장비 등록','authenticated',b1,format('insert into public.vehicles (org, type, plate, round_id, home_branch) values (''지역본부'', ''제설차'', ''%s'', %s, ''B001'')', n1 || '5', rid),'ok:1');
  select id into pv from public.vehicles where round_id = rid and plate = n1 || '5';
  perform pg_temp.yes('지역본부 장비 번호도 이어서 V1002', pv = 'V1002', coalesce(pv, 'null'));
  perform pg_temp.chk('관리자: 지역본부 장비를 기계화부로 바꾸기 거절','authenticated',a,format('update public.vehicles set org = ''서울경기'', round_id = null, home_branch = null, plate = ''서울경기9984'' where id = ''%s''', pv),'err:42501');
  perform pg_temp.chk('관리자: 지역본부 장비의 출발 지사 바꾸기 거절','authenticated',a,format('update public.vehicles set home_branch = ''B002'' where id = ''%s''', pv),'err:42501');
  perform pg_temp.chk('관리자: 기계화부 장비를 지역본부 장비로 바꾸기 거절','authenticated',a,format('update public.vehicles set org = ''지역본부'', round_id = %s, home_branch = ''B001'', plate = ''%s'' where id = ''V999''', rid, n1 || '6'),'err:42501');

  -- ③ 기준일자 삭제: 앞 기준일자에 딸린 지역본부 장비의 경로는 세지 않고, 기계화부 장비 경로는 예전처럼 막음
  perform pg_temp.chk('관리자: 지역본부 장비 → B003(12-01, 12-03)','authenticated',a,format(rt, format('[{"date":"2099-12-01","vehicle_id":"%s","stops":["B003"]},{"date":"2099-12-03","vehicle_id":"%s","stops":["B003"]}]', pv, pv), rid),'ok:1');
  perform pg_temp.chk('관리자: 겹치는 새 기준일자(12-03)','authenticated',a,'select public.create_round(''2099-12-03'')','ok:1');
  select id into rid2 from public.support_rounds where start_date = '2099-12-03';
  perform pg_temp.chk('관리자: 새 기준일자 삭제(앞 기준일자의 지역본부 장비 경로가 기간 안에 있어도 됨)','authenticated',a,format('delete from public.support_rounds where id = %s', rid2),'ok:1');
  perform pg_temp.yes('경로·장비는 그대로', (select count(*) = 2 from public.vehicle_routes where vehicle_id = pv) and exists (select 1 from public.vehicles where id = pv));
  perform pg_temp.chk('관리자: 새 기준일자 다시 만들고 기계화부 장비를 지원으로','authenticated',a,'select public.create_round(''2099-12-03'')','ok:1');
  select id into rid2 from public.support_rounds where start_date = '2099-12-03';
  perform pg_temp.chk('관리자: 기계화부 장비 경로(12-03)','authenticated',a,format('select public.save_fleet(''[]'', ''[{"date":"2099-12-03","vehicle_id":"V999","stops":["B003"]}]'', %s, ''[{"vehicle_id":"V999","status":"O"}]'')', rid2),'ok:1');
  perform pg_temp.chk('관리자: 기계화부 장비 경로가 있으면 삭제 거절','authenticated',a,format('delete from public.support_rounds where id = %s', rid2),'err:23514');
  perform pg_temp.chk('지사 계정: 기준일자 삭제는 0건','authenticated',b1,format('delete from public.support_rounds where id = %s', rid2),'ok:0');

  select count(*), count(*) filter (where not ok) into total, fails from _t;
  raise exception E'지역본부 장비 후속 시험 — 전체 %, 실패 %\n%', total, fails, (select string_agg('FAIL ' || name || ' → ' || got || ' / ' || want, E'\n' order by n) from _t where not ok);
end $t$;
