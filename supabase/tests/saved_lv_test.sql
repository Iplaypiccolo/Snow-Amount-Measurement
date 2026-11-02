-- ============================================================
-- 지사저장·본부저장·본사저장(마이그레이션 50) 시험 — SQL Editor 에 통째로 붙여넣고 실행(마이그레이션 50 적용 뒤)
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
  rq text := 'select public.save_requests(%s, ''%s'')';
  lv text; sa timestamptz;
begin
  select hq_id into hq1 from public.branches where id = 'B001';
  insert into auth.users (id, aud, role, email) values (a,'authenticated','authenticated','la@t.test'),(b1,'authenticated','authenticated','lb1@t.test'),(h,'authenticated','authenticated','lh@t.test');
  insert into public.profiles (id,username,display_name,role,branch_id,org,hq_id,perms,must_change) values
    (a,'pl-adm','관리자','admin',null,null,null,'{}',false),(b1,'pl-br1','지사1','branch','B001',null,null,'{req.edit.own}',false),(h,'pl-hq','본부','hq',null,null,hq1,'{req.edit.hq}',false);
  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);
  insert into public.support_rounds (name,start_date,days) values ('t','2099-12-01',4) returning id into rid;

  perform pg_temp.chk('지사: 자기 줄 저장(새 줄)','authenticated',b1,format(rq, rid, '[{"branch_id":"B001","req_truck":2}]'),'ok:1');
  perform pg_temp.yes('지사저장(branch)', (select saved_lv = 'branch' and saved_by = b1 and saved_at is not null from public.round_requests where round_id = rid and branch_id = 'B001'));
  perform pg_temp.chk('본부: 같은 줄 저장','authenticated',h,format(rq, rid, '[{"branch_id":"B001"}]'),'ok:1');
  perform pg_temp.yes('본부저장(hq)이 덮음', (select saved_lv = 'hq' and saved_by = h from public.round_requests where round_id = rid and branch_id = 'B001'));
  perform pg_temp.chk('관리자: 편성 저장','authenticated',a,format(rq, rid, '[{"branch_id":"B001","assigned_truck":2}]'),'ok:1');
  perform pg_temp.yes('본사저장(admin) — 관리자 저장도 저장', (select saved_lv = 'admin' and saved_by = a and saved_at is not null from public.round_requests where round_id = rid and branch_id = 'B001'));
  select saved_lv, saved_at into lv, sa from public.round_requests where round_id = rid and branch_id = 'B001';
  perform pg_temp.chk('관리자: 확정만','authenticated',a,format(rq, rid, '[{"branch_id":"B001","confirmed":true}]'),'ok:1');
  perform pg_temp.yes('확정만은 저장 표시를 바꾸지 않음', (select saved_lv = lv and saved_at = sa and confirmed from public.round_requests where round_id = rid and branch_id = 'B001'));
  perform pg_temp.chk('관리자: 확정 취소만','authenticated',a,format(rq, rid, '[{"branch_id":"B001","confirmed":false}]'),'ok:1');
  perform pg_temp.yes('확정 취소만도 그대로', (select saved_lv = lv and saved_at = sa and not confirmed from public.round_requests where round_id = rid and branch_id = 'B001'));
  perform pg_temp.chk('관리자: 새 줄을 확정만으로 만듦(B003)','authenticated',a,format(rq, rid, '[{"branch_id":"B003","confirmed":true}]'),'ok:1');
  perform pg_temp.yes('확정만으로 생긴 줄은 저장 안 함', (select saved_at is null and saved_lv is null from public.round_requests where round_id = rid and branch_id = 'B003'));
  perform pg_temp.chk('관리자: 새 줄 요청 저장(B004)','authenticated',a,format(rq, rid, '[{"branch_id":"B004","req_truck":1}]'),'ok:1');
  perform pg_temp.yes('새 줄 관리자 저장 = 본사저장', (select saved_lv = 'admin' and saved_at is not null from public.round_requests where round_id = rid and branch_id = 'B004'));
  perform pg_temp.chk('지사: 다른 지사 줄 저장은 여전히 거절','authenticated',b1,format(rq, rid, '[{"branch_id":"B004"}]'),'err:42501');
  perform pg_temp.chk('saved_lv 엉뚱한 값은 DB가 거절','postgres',null,format('update public.round_requests set saved_lv = %L where round_id = %s and branch_id = %L', 'x', rid, 'B004'),'err:23514');

  select count(*), count(*) filter (where not ok) into total, fails from _t;
  raise exception E'저장 표시(지사·본부·본사) 시험 — 전체 %, 실패 %\n%', total, fails, (select string_agg('FAIL ' || name || ' → ' || got || ' / ' || want, E'\n' order by n) from _t where not ok);
end $t$;
