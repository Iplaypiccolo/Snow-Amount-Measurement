-- ============================================================
-- 확정한 지사 줄 잠금(마이그레이션 35)·이름표 잠금(39) 시험 — SQL Editor 에 통째로 붙여넣고 실행
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
declare a uuid := gen_random_uuid(); br uuid := gen_random_uuid(); rid bigint; fails int; total int;
  sv text := 'select public.save_requests(%s, ''%s'')';
begin
  insert into auth.users (id, aud, role, email) values (a,'authenticated','authenticated','la@t.test'), (br,'authenticated','authenticated','lb@t.test');
  insert into public.profiles (id,username,display_name,role,perms,must_change) values (a,'lk-adm','관리자','admin','{}',false);
  insert into public.profiles (id,username,display_name,role,branch_id,perms,must_change) values (br,'lk-br','지사','branch','B001','{req.edit.own}',false);
  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);
  insert into public.support_rounds (name, start_date) values ('t', '2000-01-01'::date + (floor(random() * 30000))::int) returning id into rid;

  perform pg_temp.chk('지사: 요청 입력','authenticated',br,format(sv, rid, '[{"branch_id":"B001","req_truck":2,"wx_manual":true,"wx_snow":3}]'),'ok:1');
  perform pg_temp.chk('관리자: 편성하면서 확정','authenticated',a,format(sv, rid, '[{"branch_id":"B001","assigned_truck":2,"confirmed":true}]'),'ok:1');
  perform pg_temp.chk('확정 뒤 지사: 요청 고치기 거절','authenticated',br,format(sv, rid, '[{"branch_id":"B001","req_truck":5}]'),'err:55000');
  perform pg_temp.chk('확정 뒤 지사: 기상현황 직접입력 고치기 거절','authenticated',br,format(sv, rid, '[{"branch_id":"B001","wx_snow":9}]'),'err:55000');
  perform pg_temp.chk('확정 뒤 관리자도: 편성 고치기 거절','authenticated',a,format(sv, rid, '[{"branch_id":"B001","assigned_truck":3}]'),'err:55000');
  perform pg_temp.chk('확정 뒤 관리자도: 직접 update 거절','authenticated',a,format('update public.round_requests set arrive_at = now() where round_id = %s and branch_id = ''B001''', rid),'err:55000');
  perform pg_temp.chk('취소하면서 값 바꾸기 거절','authenticated',a,format(sv, rid, '[{"branch_id":"B001","confirmed":false,"req_truck":7}]'),'err:55000');
  -- 이름표(기준일자·지사)는 누구도 못 바꿈(마이그레이션 39) — 예전엔 지사·본부 계정이 확정된 줄을 옮겨 '확정'을 만들 수 있었음
  perform pg_temp.chk('지사: 확정 줄을 다른 기준일자로 옮기기 거절','authenticated',br,format('update public.round_requests set round_id = %s where round_id = %s and branch_id = ''B001''', rid + 100000, rid),'err:42501');
  perform pg_temp.chk('관리자도: 확정 줄 지사 바꾸기 거절','authenticated',a,format('update public.round_requests set branch_id = ''B002'' where round_id = %s and branch_id = ''B001''', rid),'err:42501');
  perform pg_temp.chk('같은 값으로 다시 보내기는 괜찮음','authenticated',a,format(sv, rid, '[{"branch_id":"B001","req_truck":2}]'),'ok:1');
  perform pg_temp.yes('값 그대로', (select req_truck = 2 and assigned_truck = 2 and wx_snow = 3 and confirmed from public.round_requests where round_id = rid and branch_id = 'B001'));
  perform pg_temp.chk('관리자: 확정 취소','authenticated',a,format(sv, rid, '[{"branch_id":"B001","confirmed":false}]'),'ok:1');
  perform pg_temp.chk('취소 뒤 지사: 요청 고치기','authenticated',br,format(sv, rid, '[{"branch_id":"B001","req_truck":5}]'),'ok:1');
  perform pg_temp.chk('취소 뒤 관리자: 편성 고치기','authenticated',a,format(sv, rid, '[{"branch_id":"B001","assigned_truck":4}]'),'ok:1');
  perform pg_temp.yes('고친 값', (select req_truck = 5 and assigned_truck = 4 and not confirmed from public.round_requests where round_id = rid and branch_id = 'B001'));
  perform pg_temp.chk('지사: 확정은 여전히 못 함','authenticated',br,format(sv, rid, '[{"branch_id":"B001","confirmed":true}]'),'err:42501');
  perform pg_temp.chk('관리자: 확정된 기준일자도 지울 수 있음(줄 삭제는 잠금 아님)','authenticated',a,format('delete from public.round_requests where round_id = %s', rid),'ok:1');

  select count(*), count(*) filter (where not ok) into total, fails from _t;
  raise exception E'확정 잠금 시험 — 전체 %, 실패 %\n%', total, fails, (select string_agg('FAIL ' || name || ' → ' || got || ' / ' || want, E'\n' order by n) from _t where not ok);
end $t$;
