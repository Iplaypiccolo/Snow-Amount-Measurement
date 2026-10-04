-- ============================================================
-- 장비 지원 저장 함수(save_fleet·save_requests, 마이그레이션 17·19) 시험 — 경로는 관리자(equip.edit.all)만 — SQL Editor 에 통째로 붙여넣고 실행
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
declare a uuid := gen_random_uuid(); e uuid := gen_random_uuid(); b uuid := gen_random_uuid(); h uuid := gen_random_uuid(); rid bigint; fails int; total int; c bigint;
begin
  insert into auth.users (id, aud, role, email) values (a,'authenticated','authenticated','fa@t.test'),(e,'authenticated','authenticated','fe@t.test'),(b,'authenticated','authenticated','fb@t.test'),(h,'authenticated','authenticated','fh@t.test');
  insert into public.profiles (id,username,display_name,role,branch_id,org,hq_id,perms,must_change) values
    (a,'sf-adm','관리자','admin',null,null,null,'{}',false),(e,'sf-eq','장비','equip',null,'서울경기',null,'{equip.edit.own}',false),
    (b,'sf-br','지사','branch','B001',null,null,'{juris.request,req.edit.own}',false),(h,'sf-hq','본부','hq',null,null,'H01','{req.edit.hq}',false);
  insert into public.vehicles (id,org,type,plate) values ('V9001','서울경기','제설차','11가1111'),('V9002','충북','제설기','22나2222');
  insert into public.support_rounds (name,start_date) values ('t','2099-12-01') returning id into rid;
  perform pg_temp.chk('장비: 자기 장비 상태·도공번호 확정','authenticated',e,'select public.save_fleet(''[{"id":"V9001","status":"O","plate":"서울경기-901"}]'', ''[]'')','ok:1');
  perform pg_temp.chk('장비: 자기 장비라도 경로는 거절(관리자만)','authenticated',e,'select public.save_fleet(''[]'', ''[{"date":"2099-12-02","vehicle_id":"V9001","stops":["B001"]}]'')','err:42501');
  perform pg_temp.chk('관리자: 경로 두 날짜 한 번에 확정','authenticated',a,'select public.save_fleet(''[]'', ''[{"date":"2099-12-02","vehicle_id":"V9001","stops":["B001","B002"]},{"date":"2099-12-03","vehicle_id":"V9001","stops":["B003"]}]'')','ok:1');
  perform pg_temp.yes('경로 2줄·상태 O·도공번호', (select count(*) = 2 from public.vehicle_routes where vehicle_id='V9001') and (select status = 'O' and plate = '서울경기-901' from public.vehicles where id='V9001'));
  select count(*) into c from public.audit_log where tab = 'vehicle_routes';
  perform pg_temp.chk('같은 경로 다시 확정','authenticated',a,'select public.save_fleet(''[]'', ''[{"date":"2099-12-02","vehicle_id":"V9001","stops":["B001","B002"]}]'')','ok:1');
  perform pg_temp.yes('같은 경로는 기록이 늘지 않음', (select count(*) from public.audit_log where tab = 'vehicle_routes') = c);
  perform pg_temp.chk('빈 목록 = 그 날짜 경로 지우기','authenticated',a,'select public.save_fleet(''[]'', ''[{"date":"2099-12-03","vehicle_id":"V9001","stops":[]}]'')','ok:1');
  perform pg_temp.yes('12/3 지워지고 12/2 남음', (select array_agg(date order by date) from public.vehicle_routes where vehicle_id='V9001') = array['2099-12-02'::date]);
  perform pg_temp.chk('하나라도 권한이 없으면 전체 취소(장비 상태 + 경로)','authenticated',e,'select public.save_fleet(''[{"id":"V9001","status":"X"}]'', ''[{"date":"2099-12-05","vehicle_id":"V9001","stops":["B001"]}]'')','err:42501');
  perform pg_temp.yes('취소되어 상태 그대로', (select status = 'O' from public.vehicles where id='V9001'));
  perform pg_temp.yes('취소되어 12/5 없음', not exists (select 1 from public.vehicle_routes where date='2099-12-05'));
  perform pg_temp.chk('다른 기관 장비 경로 지우기도 거절','authenticated',e,'select public.save_fleet(''[]'', ''[{"date":"2099-12-05","vehicle_id":"V9002","stops":[]}]'')','err:42501');
  perform pg_temp.chk('다른 기관 장비 상태 바꾸기 거절','authenticated',e,'select public.save_fleet(''[{"id":"V9002","status":"M"}]'', ''[]'')','err:42501');
  perform pg_temp.chk('없는 지사 거절','authenticated',a,'select public.save_fleet(''[]'', ''[{"date":"2099-12-06","vehicle_id":"V9001","stops":["B999"]}]'')','err:23503');
  perform pg_temp.chk('빈 저장 거절','authenticated',e,'select public.save_fleet(''[]'', ''[]'')','err:22023');
  perform pg_temp.chk('지사: 경로 확정 거절','authenticated',b,'select public.save_fleet(''[]'', ''[{"date":"2099-12-06","vehicle_id":"V9001","stops":["B001"]}]'')','err:42501');
  perform pg_temp.chk('비로그인: 함수 호출 불가','anon',null,'select public.save_fleet(''[]'', ''[]'')','err:42501');
  perform pg_temp.chk('관리자: 다른 기관 장비도 확정','authenticated',a,'select public.save_fleet(''[{"id":"V9002","status":"M"}]'', ''[{"date":"2099-12-06","vehicle_id":"V9002","stops":["B001"]}]'')','ok:1');
  perform pg_temp.chk('지사: 자기 지사 요청 저장(새 줄)','authenticated',b,format('select public.save_requests(%s, ''[{"branch_id":"B001","req_truck":3,"arrive_at":"2099-12-01T22:00:00+09:00","reason":"시험"}]'')',rid),'ok:1');
  perform pg_temp.yes('저장값', (select req_truck = 3 and arrive_at = '2099-12-01 13:00:00+00' and reason = '시험' and not confirmed from public.round_requests where round_id=rid and branch_id='B001'));
  perform pg_temp.chk('지사: 다른 지사 거절','authenticated',b,format('select public.save_requests(%s, ''[{"branch_id":"B002","req_truck":1}]'')',rid),'err:42501');
  perform pg_temp.chk('지사: 확정 거절','authenticated',b,format('select public.save_requests(%s, ''[{"branch_id":"B001","confirmed":true}]'')',rid),'err:42501');
  perform pg_temp.chk('본부: 소속 지사 둘 저장','authenticated',h,format('select public.save_requests(%s, ''[{"branch_id":"B001","snow_cm":5},{"branch_id":"B002","req_blower":2}]'')',rid),'ok:1');
  perform pg_temp.yes('보내지 않은 열은 그대로', (select req_truck = 3 and snow_cm = 5 from public.round_requests where round_id=rid and branch_id='B001'));
  perform pg_temp.chk('관리자: 편성·확정','authenticated',a,format('select public.save_requests(%s, ''[{"branch_id":"B001","assigned_truck":2,"confirmed":true},{"branch_id":"B002","confirmed":true}]'')',rid),'ok:1');
  perform pg_temp.yes('확정됨', (select count(*) = 2 from public.round_requests where round_id=rid and confirmed));
  perform pg_temp.chk('지사: 확정 뒤 요청 대수만 수정','authenticated',b,format('select public.save_requests(%s, ''[{"branch_id":"B001","req_truck":4,"reason":""}]'')',rid),'ok:1');
  perform pg_temp.yes('확정 유지·사유 비움', (select confirmed and assigned_truck = 2 and req_truck = 4 and reason is null from public.round_requests where round_id=rid and branch_id='B001'));
  perform pg_temp.chk('없는 기준일자','authenticated',a,'select public.save_requests(-1, ''[{"branch_id":"B001"}]'')','err:23503');
  perform pg_temp.chk('장비 계정: 요청 저장 거절','authenticated',e,format('select public.save_requests(%s, ''[{"branch_id":"B003","req_truck":1}]'')',rid),'err:42501');
  select count(*), count(*) filter (where not ok) into total, fails from _t;
  raise exception E'저장 함수 시험 — 전체 %, 실패 %\n%', total, fails, (select string_agg('FAIL ' || name || ' → ' || got || ' / ' || want, E'\n' order by n) from _t where not ok);
end $t$;
