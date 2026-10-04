-- ============================================================
-- 이력 값 검사(마이그레이션 10)·저장+승인 한 번에(11)·적설 함수 권한(09) 시험 — SQL Editor 에 통째로 붙여넣어 실행. 끝에 일부러 오류를 내서 모두 되돌립니다.
-- 결과는 오류 창에 "저장·검사 시험 결과 — 전체 N, 실패 0" 으로 나옵니다.
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
declare got text := pg_temp.run_as(rl, uid, stmt);
begin insert into _t(name, got, want, ok) values (name, got, want, got = want); end $f$;
create or replace function pg_temp.yes(name text, cond boolean) returns void language plpgsql as $f$
begin insert into _t(name, got, want, ok) values (name, case when cond then 'true' else 'false' end, 'true', coalesce(cond, false)); end $f$;

do $t$
declare a uuid := gen_random_uuid(); b uuid := gen_random_uuid(); rep text; fails int; total int; r1 bigint; r2 bigint;
begin
  insert into auth.users (id, aud, role, email) values (a,'authenticated','authenticated','sa@t.test'),(b,'authenticated','authenticated','sb@t.test');
  insert into public.profiles (id,username,display_name,role,branch_id,perms,must_change) values (a,'sv-adm','관리자','admin',null,'{}',false),(b,'sv-br','지사','branch','B001','{juris.request,req.edit.own}',false);

  -- 10. 이력 값 검사
  perform pg_temp.chk('신설 기관: 정상 이름은 저장','authenticated',a,'insert into public.jurisdiction_events (kind, payload) values (''addBranch'', ''{"id":"B990","hq":"광주전남","name":"새만금"}'')','ok:1');
  perform pg_temp.chk('신설 기관: 이름에 < > 가 있으면 거절','authenticated',a,'insert into public.jurisdiction_events (kind, payload) values (''addBranch'', ''{"id":"B991","hq":"광주전남","name":"<img src=x>"}'')','err:23514');
  perform pg_temp.chk('신설 기관: 이름에 따옴표가 있으면 거절','authenticated',a,'insert into public.jurisdiction_events (kind, payload) values (''addBranch'', ''{"id":"B991","hq":"광주전남","name":"a\"b"}'')','err:23514');
  perform pg_temp.chk('신설 기관: 이름 21자 이상 거절','authenticated',a,'insert into public.jurisdiction_events (kind, payload) values (''addBranch'', ''{"id":"B991","hq":"광주전남","name":"가나다라마바사아자차카타파하가나다라마바사"}'')','err:23514');
  perform pg_temp.chk('신설 기관: 빈 이름 거절','authenticated',a,'insert into public.jurisdiction_events (kind, payload) values (''addBranch'', ''{"id":"B991","hq":"광주전남","name":"  "}'')','err:23514');
  perform pg_temp.chk('신설 기관: 번호 형식(B000)이 아니면 거절','authenticated',a,'insert into public.jurisdiction_events (kind, payload) values (''addBranch'', ''{"id":"12","hq":"광주전남","name":"새기관"}'')','err:23514');
  perform pg_temp.chk('신설 기관: 없는 본부 거절','authenticated',a,'insert into public.jurisdiction_events (kind, payload) values (''addBranch'', ''{"id":"B991","hq":"없는본부","name":"새기관"}'')','err:23514');
  perform pg_temp.chk('본부 이동: 없는 본부 거절','authenticated',a,'insert into public.jurisdiction_events (kind, payload) values (''moveHq'', ''{"branch":"B001","hq":"없는본부"}'')','err:23514');
  perform pg_temp.chk('구간 이동: 구간 목록이 비면 거절','authenticated',a,'insert into public.jurisdiction_events (kind, payload) values (''move'', ''{"sections":[],"to":"B001"}'')','err:23514');
  perform pg_temp.chk('메모 201자 거절','authenticated',a,'insert into public.jurisdiction_events (kind, payload, note) values (''move'', ''{"sections":["S0001"],"to":"B001"}'', repeat(''가'', 201))','err:23514');
  perform pg_temp.chk('지사: 정상 값이어도 이력 저장 불가','authenticated',b,'insert into public.jurisdiction_events (kind, payload) values (''move'', ''{"sections":["S0001"],"to":"B001"}'')','err:42501');

  -- 11. 저장 + 승인 한 번에
  perform set_config('request.jwt.claims', json_build_object('sub', b, 'role', 'authenticated')::text, true);
  set local role authenticated;
  insert into public.jurisdiction_requests (section_ids, snapshot, to_branch_id, reason) values (array['S0001'], '[]', 'B002', '시험1') returning id into r1;
  insert into public.jurisdiction_requests (section_ids, snapshot, to_branch_id, reason) values (array['S0002'], '[]', 'B002', '시험2') returning id into r2;
  reset role;
  perform pg_temp.chk('관리자: 이동 저장 + 요청 승인 한 번에','authenticated',a,
    format('select public.save_jurisdiction(''[{"kind":"move","payload":{"sections":["S0001"],"to":"B002","from":["B001"],"req":%s},"note":"시험"}]'', array[%s]::bigint[])', r1, r1),'ok:1');
  perform pg_temp.yes('요청 1 이 승인됨', (select status from public.jurisdiction_requests where id = r1) = 'approved');
  perform pg_temp.chk('이미 처리된 요청이 섞이면 전부 취소','authenticated',a,
    format('select public.save_jurisdiction(''[{"kind":"move","payload":{"sections":["S0002"],"to":"B002"},"note":null}]'', array[%s, %s]::bigint[])', r1, r2),'err:55000');
  perform pg_temp.yes('취소되어 요청 2 는 대기 그대로', (select status from public.jurisdiction_requests where id = r2) = 'pending');
  perform pg_temp.yes('취소되어 이동 이력도 저장되지 않음', (select count(*) from public.jurisdiction_events where payload -> 'sections' = '["S0002"]'::jsonb) = 0);
  perform pg_temp.chk('값 검사에 걸리면 승인도 취소','authenticated',a,
    format('select public.save_jurisdiction(''[{"kind":"addBranch","payload":{"id":"B992","hq":"강원","name":"<b>"}}]'', array[%s]::bigint[])', r2),'err:23514');
  perform pg_temp.yes('요청 2 는 여전히 대기', (select status from public.jurisdiction_requests where id = r2) = 'pending');
  perform pg_temp.chk('요청 없이 저장만','authenticated',a,'select public.save_jurisdiction(''[{"kind":"moveHq","payload":{"branch":"B001","hq":"수도권","fromHq":"수도권"}}]'')','ok:1');
  perform pg_temp.chk('지사: 저장 함수로도 이력 저장 불가','authenticated',b,'select public.save_jurisdiction(''[{"kind":"move","payload":{"sections":["S0001"],"to":"B001"}}]'')','err:42501');
  perform pg_temp.chk('비로그인: 저장 함수 호출 불가','anon',null,'select public.save_jurisdiction(''[{"kind":"move","payload":{"sections":["S0001"],"to":"B001"}}]'')','err:42501');
  perform pg_temp.chk('빈 목록 거절','authenticated',a,'select public.save_jurisdiction(''[]'')','err:22023');

  -- 09. 적설 함수는 서버(service_role)만
  perform pg_temp.chk('관리자도 적설 넣기 함수 직접 호출 불가','authenticated',a,'select public.admin_import_snow(''{}'', false, true)','err:42501');
  perform pg_temp.chk('관리자도 요약본 만들기 직접 호출 불가','authenticated',a,'select public.admin_rebuild_snow_snapshot()','err:42501');
  perform pg_temp.chk('지사: 적설 원자료 쓰기 불가','authenticated',b,'insert into public.snow_daily (date, station_id, value) values (''2025-12-01'', 90, 1)','err:42501');
  perform pg_temp.chk('지사: 요약본 읽기 가능','authenticated',b,'select 1 from public.snapshots where false','ok:0');
  perform pg_temp.yes('비로그인(anon)에게 적설 표 권한 없음', not has_table_privilege('anon', 'public.snow_daily', 'select') and not has_table_privilege('anon', 'public.snapshots', 'select'));

  select count(*), count(*) filter (where not ok), string_agg(case when ok then 'PASS ' else 'FAIL ' end || name || case when ok then '' else '  → 실제 ' || got || ' / 기대 ' || want end, E'\n' order by n) into total, fails, rep from _t;
  raise exception E'저장·검사 시험 결과 — 전체 %, 실패 %\n%', total, fails, rep;
end $t$;
