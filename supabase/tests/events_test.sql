-- ============================================================
-- 변경 이력 표(jurisdiction_events · grid_events) 시험 — Supabase SQL Editor 에 통째로 붙여넣어 실행. 끝에 일부러 오류를 내서 모두 되돌립니다.
--  * 관할·격자 변경을 저장하면 화면이 이 표에 한 줄씩 쌓습니다. 읽기는 로그인한 활성 사용자 모두, 쓰기는 관리자만.
--  * 결과는 오류 창에 "변경 이력 시험 결과 — 전체 N, 실패 0" 으로 나옵니다.
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
declare a uuid := gen_random_uuid(); b uuid := gen_random_uuid(); e uuid := gen_random_uuid(); m uuid := gen_random_uuid(); rep text; fails int; total int; r record;
begin
  insert into auth.users (id, aud, role, email) values (a,'authenticated','authenticated','ea@t.test'),(b,'authenticated','authenticated','eb@t.test'),(e,'authenticated','authenticated','ee@t.test'),(m,'authenticated','authenticated','em@t.test');
  insert into public.profiles (id,username,display_name,role,branch_id,must_change) values
    (a,'ev-adm','관리자','admin',null,false),(b,'ev-br','지사','branch','B001',false),(e,'ev-eq','장비','equip',null,false),(m,'ev-tmp','임시','admin',null,true);

  perform pg_temp.chk('비로그인: 관할 이력 읽기 차단','anon',null,'select 1 from public.jurisdiction_events','err:42501');
  perform pg_temp.chk('비로그인: 격자 이력 쓰기 차단','anon',null,'insert into public.grid_events (kind, payload) values (''cellAdd'', ''{}'')','err:42501');
  perform pg_temp.chk('관리자: 관할 이동 이력 여러 줄을 한 번에 저장','authenticated',a,
    'insert into public.jurisdiction_events (kind, payload, note) values (''move'', ''{"sections":["S0001","S0002"],"to":"B002","from":["B001"],"km":8.1,"req":7}'', ''시험''), (''addBranch'', ''{"id":"B900","hq":"강원","name":"신설"}'', null), (''moveHq'', ''{"branch":"B002","hq":"서울경기","fromHq":"수도권"}'', null)','ok:3');
  perform pg_temp.chk('관리자: 격자 편입·제외 이력 저장','authenticated',a,'insert into public.grid_events (kind, payload, note) values (''cellAdd'', ''{"cells":[[73,127],[74,127]],"to":"B001"}'', ''시험''), (''cellRemove'', ''{"cells":[[73,127]],"from":"B001"}'', null)','ok:2');
  select * into r from public.jurisdiction_events where kind = 'move';
  perform pg_temp.yes('이동 이력의 내용이 그대로 저장됨(구간 목록·도착·출발·길이·요청 번호)', r.payload = '{"sections":["S0001","S0002"],"to":"B002","from":["B001"],"km":8.1,"req":7}'::jsonb and r.note = '시험');
  perform pg_temp.yes('저장한 사람은 DB 가 채움(위조 불가)', exists (select 1 from public.jurisdiction_events where kind = 'move' and by_user = a));
  perform pg_temp.chk('작성자를 속여서 저장해도 무시됨','authenticated',a,format('insert into public.jurisdiction_events (kind, payload, by_user) values (''move'', ''{}'', %L)', b),'ok:1');
  perform pg_temp.yes('속여도 작성자는 관리자 본인', (select count(*) from public.jurisdiction_events where by_user = b) = 0);
  perform pg_temp.chk('종류가 올바르지 않으면 거절(관할)','authenticated',a,'insert into public.jurisdiction_events (kind, payload) values (''delete'', ''{}'')','err:23514');
  perform pg_temp.chk('종류가 올바르지 않으면 거절(격자)','authenticated',a,'insert into public.grid_events (kind, payload) values (''add'', ''{}'')','err:23514');
  perform pg_temp.chk('한 줄이라도 잘못되면 전부 취소(원자적)','authenticated',a,'insert into public.jurisdiction_events (kind, payload) values (''move'', ''{}''), (''bogus'', ''{}'')','err:23514');
  perform pg_temp.yes('취소되어 앞 줄도 저장되지 않음', (select count(*) from public.jurisdiction_events) = 4);
  perform pg_temp.chk('지사: 이력 쓰기 차단','authenticated',b,'insert into public.jurisdiction_events (kind, payload) values (''move'', ''{}'')','err:42501');
  perform pg_temp.chk('지원장비: 격자 이력 쓰기 차단','authenticated',e,'insert into public.grid_events (kind, payload) values (''cellAdd'', ''{}'')','err:42501');
  perform pg_temp.chk('임시 비밀번호 관리자: 쓰기 차단','authenticated',m,'insert into public.jurisdiction_events (kind, payload) values (''move'', ''{}'')','err:42501');
  perform pg_temp.chk('지사: 관할 이력 읽기(화면이 계산에 씀)','authenticated',b,'select 1 from public.jurisdiction_events','ok:4');
  perform pg_temp.chk('지원장비: 격자 이력 읽기','authenticated',e,'select 1 from public.grid_events','ok:2');
  perform pg_temp.chk('임시 비밀번호 관리자: 읽기 차단(0건)','authenticated',m,'select 1 from public.jurisdiction_events','ok:0');
  perform pg_temp.chk('관리자도 이력을 고칠 수 없음(정책 없음 → 0건)','authenticated',a,'update public.jurisdiction_events set note = ''바꿈''','ok:0');
  perform pg_temp.chk('관리자도 이력을 지울 수 없음','authenticated',a,'delete from public.grid_events','ok:0');
  perform pg_temp.chk('지사도 이력을 지울 수 없음','authenticated',b,'delete from public.jurisdiction_events','ok:0');
  perform pg_temp.yes('이력은 id 순서대로 읽힘(저장한 순서)', (select array_agg(kind order by id) from public.jurisdiction_events where payload <> '{}'::jsonb) = array['move','addBranch','moveHq']);
  perform pg_temp.yes('저장이 접속·수정 기록에 남음', exists (select 1 from public.audit_log where tab = 'jurisdiction_events' and username = 'ev-adm' and kind = '추가'));
  perform pg_temp.yes('비로그인(anon)에게 표 권한이 없음', not has_table_privilege('anon', 'public.jurisdiction_events', 'select') and not has_table_privilege('anon', 'public.grid_events', 'select'));

  select count(*), count(*) filter (where not ok), string_agg(case when ok then 'PASS ' else 'FAIL ' end || name || case when ok then '' else '  → 실제 ' || got || ' / 기대 ' || want end, E'\n' order by n) into total, fails, rep from _t;
  raise exception E'변경 이력 시험 결과 — 전체 %, 실패 %\n%', total, fails, rep;
end $t$;
