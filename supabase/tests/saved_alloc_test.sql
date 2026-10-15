-- ============================================================
-- 저장 완료 + 기관별 배정이 편성을 따라감(마이그레이션 46) 시험 — SQL Editor 에 통째로 붙여넣고 실행
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
declare a uuid := gen_random_uuid(); b1 uuid := gen_random_uuid(); h uuid := gen_random_uuid(); hq1 text; rid bigint; fails int; total int;
  rq text := 'select public.save_requests(%s, ''%s'')'; al text := 'select public.save_allocations(%s, ''%s'')';
begin
  select hq_id into hq1 from public.branches where id = 'B001';
  insert into auth.users (id, aud, role, email) values (a,'authenticated','authenticated','sa@t.test'),(b1,'authenticated','authenticated','sb1@t.test'),(h,'authenticated','authenticated','sh@t.test');
  insert into public.profiles (id,username,display_name,role,branch_id,org,hq_id,perms,must_change) values
    (a,'ps-adm','관리자','admin',null,null,null,'{}',false),(b1,'ps-br1','지사1','branch','B001',null,null,'{req.edit.own}',false),(h,'ps-hq','본부','hq',null,null,hq1,'{req.edit.hq}',false);
  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);
  insert into public.support_rounds (name,start_date,days) values ('t','2099-12-01',4) returning id into rid;

  -- ① 저장 완료: 지사·본부가 저장하면(0이어도) 남고, 관리자 저장은 남기지 않음
  perform pg_temp.chk('지사: 바꾼 것 없이 자기 줄 저장(줄 새로 생김)','authenticated',b1,format(rq, rid, '[{"branch_id":"B001"}]'),'ok:1');
  perform pg_temp.yes('저장 완료(시각·계정)', (select saved_at is not null and saved_by = b1 and req_truck = 0 and offer_truck = 0 from public.round_requests where round_id = rid and branch_id = 'B001'));
  perform pg_temp.chk('관리자: B002 요청 저장','authenticated',a,format(rq, rid, '[{"branch_id":"B002","req_truck":3}]'),'ok:1');
  perform pg_temp.yes('관리자 저장은 저장 완료가 아님', (select saved_at is null from public.round_requests where round_id = rid and branch_id = 'B002'));
  perform pg_temp.chk('본부: 자기 본부 지사(B002) 저장','authenticated',h,format(rq, rid, '[{"branch_id":"B002"}]'),'ok:1');
  perform pg_temp.yes('본부 저장은 저장 완료', (select saved_at is not null and saved_by = h and req_truck = 3 from public.round_requests where round_id = rid and branch_id = 'B002'));
  perform pg_temp.chk('지사: 다른 지사 줄 저장은 거절','authenticated',b1,format(rq, rid, '[{"branch_id":"B002"}]'),'err:42501');

  -- ② 배정 합계 ≤ 편성
  perform pg_temp.chk('관리자: 편성 확정(B001 차5·기2, B003 차4)','authenticated',a,format(rq, rid, '[{"branch_id":"B001","assigned_truck":5,"assigned_blower":2,"confirmed":true},{"branch_id":"B003","assigned_truck":4,"confirmed":true}]'),'ok:1');
  perform pg_temp.chk('배정: B001 서울경기 차5·기2','authenticated',a,format(al, rid, '[{"org":"서울경기","branch_id":"B001","truck":5,"blower":2}]'),'ok:1');
  perform pg_temp.chk('배정: 다른 기관까지 합쳐 편성 넘으면 거절','authenticated',a,format(al, rid, '[{"org":"충북","branch_id":"B001","truck":1}]'),'err:SA006');
  perform pg_temp.chk('배정: 제설기도 따로 검사','authenticated',a,format(al, rid, '[{"org":"충북","branch_id":"B001","blower":1}]'),'err:SA006');
  perform pg_temp.chk('배정: B003 서울경기 차2 + 충북 차2','authenticated',a,format(al, rid, '[{"org":"서울경기","branch_id":"B003","truck":2},{"org":"충북","branch_id":"B003","truck":2}]'),'ok:1');
  perform pg_temp.chk('배정: 한 번에 서로 옮기기(합계 그대로)','authenticated',a,format(al, rid, '[{"org":"서울경기","branch_id":"B003","truck":3},{"org":"충북","branch_id":"B003","truck":1}]'),'ok:1');

  -- ③ 편성이 다시 확정되면 배정이 따라감
  perform pg_temp.chk('B001 확정 취소','authenticated',a,format(rq, rid, '[{"branch_id":"B001","confirmed":false}]'),'ok:1');
  perform pg_temp.chk('B001 편성 줄임(차3·기0) — 아직 확정 전','authenticated',a,format(rq, rid, '[{"branch_id":"B001","assigned_truck":3,"assigned_blower":0}]'),'ok:1');
  perform pg_temp.yes('확정 전에는 배정 그대로', (select truck = 5 and blower = 2 from public.round_allocations where round_id = rid and org = '서울경기' and branch_id = 'B001'));
  perform pg_temp.chk('B001 다시 확정','authenticated',a,format(rq, rid, '[{"branch_id":"B001","confirmed":true}]'),'ok:1');
  perform pg_temp.yes('한 기관만 → 차 3, 편성 0인 제설기는 0', (select truck = 3 and blower = 0 from public.round_allocations where round_id = rid and org = '서울경기' and branch_id = 'B001'));
  perform pg_temp.yes('배정 변경도 수정 기록에 남음', exists (select 1 from public.audit_log where tab = 'round_allocations' and target = 'round_allocations:' || rid || ',서울경기,B001' and kind = '수정' and to_val ->> 'truck' = '3'));
  perform pg_temp.chk('B003 확정 취소 → 편성 2 → 다시 확정','authenticated',a,format(rq, rid, '[{"branch_id":"B003","confirmed":false}]'),'ok:1');
  perform pg_temp.chk('B003 편성 2','authenticated',a,format(rq, rid, '[{"branch_id":"B003","assigned_truck":2}]'),'ok:1');
  perform pg_temp.chk('B003 다시 확정','authenticated',a,format(rq, rid, '[{"branch_id":"B003","confirmed":true}]'),'ok:1');
  perform pg_temp.yes('여러 기관 → 자동으로 안 줄임(3 + 1)', (select sum(truck) = 4 from public.round_allocations where round_id = rid and branch_id = 'B003'));
  perform pg_temp.chk('넘어 있는 배정을 줄이는 저장은 받음(3+0 = 3 > 2 이어도)','authenticated',a,format(al, rid, '[{"org":"충북","branch_id":"B003","truck":0}]'),'ok:1');
  perform pg_temp.chk('넘어 있는데 늘리는 저장은 거절','authenticated',a,format(al, rid, '[{"org":"충북","branch_id":"B003","truck":1}]'),'err:SA006');
  perform pg_temp.chk('B003 확정 취소 → 편성 0 → 확정','authenticated',a,format(rq, rid, '[{"branch_id":"B003","confirmed":false}]'),'ok:1');
  perform pg_temp.chk('B003 편성 0 으로 고치면서 확정(한 번에)','authenticated',a,format(rq, rid, '[{"branch_id":"B003","assigned_truck":0,"confirmed":true}]'),'ok:1');
  perform pg_temp.yes('편성 0 → 배정 줄이 지워짐', not exists (select 1 from public.round_allocations where round_id = rid and branch_id = 'B003'));
  perform pg_temp.chk('B002 편성 0으로 처음 확정(배정 없음 — 아무 일 없음)','authenticated',a,format(rq, rid, '[{"branch_id":"B002","confirmed":true}]'),'ok:1');

  select count(*), count(*) filter (where not ok) into total, fails from _t;
  raise exception E'저장 완료·배정 따라가기 시험 — 전체 %, 실패 %\n%', total, fails, (select string_agg('FAIL ' || name || ' → ' || got || ' / ' || want, E'\n' order by n) from _t where not ok);
end $t$;
