-- ============================================================
-- 구간 변경 요청(jurisdiction_requests) 권한·규칙 자동 시험 — Supabase SQL Editor 에 통째로 붙여넣어 실행.
--  * 시험용 계정을 만들었다가 마지막에 "일부러 오류"를 내서 전부 되돌립니다. 실제 자료는 바뀌지 않습니다. (지사 B001·B002·B003 이 이미 있어야 함)
--  * 결과는 오류 창에 "구간 변경 요청 시험 결과 — 전체 N, 실패 0" 으로 나옵니다.
-- ============================================================
create temp table _t (n serial, name text, got text, want text, ok boolean);
create or replace function pg_temp.run_as(rl text, uid uuid, stmt text) returns text language plpgsql as $f$
declare n bigint;
begin
  perform set_config('request.jwt.claims', case when uid is null then '' else json_build_object('sub', uid, 'role', rl)::text end, true);
  perform set_config('request.headers', '{"cf-connecting-ip":"203.0.113.7"}', true);
  if rl <> 'postgres' then execute format('set local role %I', rl); end if;
  begin execute stmt; get diagnostics n = row_count; execute 'reset role'; return 'ok:' || n;
  exception when others then execute 'reset role'; return 'err:' || sqlstate; end;
end $f$;
create or replace function pg_temp.chk(name text, rl text, uid uuid, stmt text, want text) returns void language plpgsql as $f$
declare got text := pg_temp.run_as(rl, uid, stmt); good boolean;
begin good := case when want = 'ok:+' then got ~ '^ok:[1-9]' else got = want end; insert into _t(name, got, want, ok) values (name, got, want, good); end $f$;
create or replace function pg_temp.yes(name text, cond boolean, info text default '') returns void language plpgsql as $f$
begin insert into _t(name, got, want, ok) values (name, case when cond then 'true' else 'false ' || info end, 'true', coalesce(cond, false)); end $f$;

do $t$
declare
  a uuid := gen_random_uuid(); b1 uuid := gen_random_uuid(); b2 uuid := gen_random_uuid(); e uuid := gen_random_uuid(); d uuid := gen_random_uuid(); m uuid := gen_random_uuid();
  ins text := 'insert into public.jurisdiction_requests (section_ids, snapshot, to_branch_id, reason) values (array[''S0001'',''S0002''], ''[{"id":"S0001"}]''::jsonb, ''B003'', ''시험'')';
  r1 bigint; r2 bigint; i int; rep text; fails int; total int; row_ record; c0 bigint;
begin
  insert into auth.users (id, aud, role, email) values
    (a,'authenticated','authenticated','ra@t.test'),(b1,'authenticated','authenticated','rb1@t.test'),(b2,'authenticated','authenticated','rb2@t.test'),
    (e,'authenticated','authenticated','re@t.test'),(d,'authenticated','authenticated','rd@t.test'),(m,'authenticated','authenticated','rm@t.test');
  insert into public.profiles (id,username,display_name,role,branch_id,disabled,must_change) values
    (a,'rq-adm','관리자','admin',null,false,false),(b1,'rq-b1','지사1','branch','B001',false,false),(b2,'rq-b2','지사2','branch','B002',false,false),
    (e,'rq-eq','장비','equip',null,false,false),(d,'rq-dis','비활성','branch','B001',true,false),(m,'rq-tmp','임시','branch','B001',false,true);

  -- A. 비로그인
  perform pg_temp.chk('비로그인: 읽기 차단','anon',null,'select 1 from public.jurisdiction_requests','err:42501');
  perform pg_temp.chk('비로그인: 쓰기 차단','anon',null,ins,'err:42501');

  -- B. 요청 만들기
  perform pg_temp.chk('지사: 요청 만들기','authenticated',b1,ins,'ok:1');
  select id into r1 from public.jurisdiction_requests where requested_by = b1 order by id limit 1;
  perform pg_temp.chk('지사: 요청 지사·작성자·상태를 속이려 해도 DB 가 정함','authenticated',b1,
    'insert into public.jurisdiction_requests (branch_id, requested_by, status, resolved_by, section_ids, resolution_note) values (''B002'', '''||b2||''', ''approved'', '''||a||''', array[''S0003''], ''위조'')','ok:1');
  select * into row_ from public.jurisdiction_requests where section_ids = array['S0003'];
  perform pg_temp.yes('속여도 요청 지사=내 지사, 작성자=나, 상태=대기, 처리자 없음', row_.branch_id = 'B001' and row_.requested_by = b1 and row_.status = 'pending' and row_.resolved_by is null and row_.resolution_note is null);
  perform pg_temp.chk('지원장비: 요청 차단','authenticated',e,ins,'err:42501');
  perform pg_temp.chk('관리자: 요청 만들기 차단(요청은 지사만)','authenticated',a,ins,'err:42501');
  perform pg_temp.chk('비활성 지사 계정: 요청 차단','authenticated',d,ins,'err:42501');
  perform pg_temp.chk('임시 비밀번호 지사 계정: 요청 차단','authenticated',m,ins,'err:42501');
  perform pg_temp.chk('구간 번호 형식 오류','authenticated',b1,'insert into public.jurisdiction_requests (section_ids) values (array[''bad''])','err:23514');
  perform pg_temp.chk('구간이 하나도 없는 요청','authenticated',b1,'insert into public.jurisdiction_requests (section_ids) values (array[]::text[])','err:23514');
  perform pg_temp.chk('구간 61개 요청 차단','authenticated',b1,'insert into public.jurisdiction_requests (section_ids) select array_agg(''S'' || lpad(g::text, 4, ''0'')) from generate_series(1, 61) g','err:23514');
  perform pg_temp.chk('사유 201자 차단','authenticated',b1,'insert into public.jurisdiction_requests (section_ids, reason) values (array[''S0004''], repeat(''가'', 201))','err:23514');
  perform pg_temp.chk('요약 정보(snapshot)가 목록이 아니면 차단','authenticated',b1,'insert into public.jurisdiction_requests (section_ids, snapshot) values (array[''S0004''], ''{"a":1}''::jsonb)','err:23514');
  perform pg_temp.chk('없는 도착 지사 차단','authenticated',b1,'insert into public.jurisdiction_requests (section_ids, to_branch_id) values (array[''S0004''], ''B999'')','err:23503');
  perform pg_temp.chk('도착 지사를 비워 두면(관리자가 정해 달라) 가능','authenticated',b2,'insert into public.jurisdiction_requests (section_ids) values (array[''S0005''])','ok:1');
  select id into r2 from public.jurisdiction_requests where requested_by = b2 order by id limit 1;

  -- C. 읽기
  perform pg_temp.chk('지사1: 내 요청 2건만 보임','authenticated',b1,'select 1 from public.jurisdiction_requests','ok:2');
  perform pg_temp.chk('지사2: 내 요청 1건만 보임(다른 지사 것은 안 보임)','authenticated',b2,'select 1 from public.jurisdiction_requests','ok:1');
  perform pg_temp.chk('관리자: 전부 보임','authenticated',a,'select 1 from public.jurisdiction_requests','ok:3');
  perform pg_temp.chk('지원장비: 0건','authenticated',e,'select 1 from public.jurisdiction_requests','ok:0');
  perform pg_temp.chk('임시 비밀번호 계정: 0건','authenticated',m,'select 1 from public.jurisdiction_requests','ok:0');

  -- D. 처리
  perform pg_temp.chk('지사2: 남의 요청 취소 시도는 0건','authenticated',b2,'update public.jurisdiction_requests set status = ''cancelled'' where id = '||r1,'ok:0');
  perform pg_temp.chk('지원장비: 처리 시도는 0건','authenticated',e,'update public.jurisdiction_requests set status = ''approved''','ok:0');
  perform pg_temp.chk('지사: 내 요청을 스스로 승인 시도 차단','authenticated',b1,'update public.jurisdiction_requests set status = ''approved'' where id = '||r1,'err:42501');
  perform pg_temp.chk('지사: 내 요청의 구간·사유 고치기 차단','authenticated',b1,'update public.jurisdiction_requests set reason = ''바꿈'' where id = '||r1,'err:42501');
  perform pg_temp.chk('지사: 내 요청 취소','authenticated',b1,'update public.jurisdiction_requests set status = ''cancelled'' where id = '||r1,'ok:1');
  select * into row_ from public.jurisdiction_requests where id = r1;
  perform pg_temp.yes('취소하면 처리자=나, 처리 시각 기록', row_.status = 'cancelled' and row_.resolved_by = b1 and row_.resolved_at is not null);
  perform pg_temp.chk('이미 취소한 요청은 다시 못 바꿈','authenticated',b1,'update public.jurisdiction_requests set status = ''cancelled'' where id = '||r1,'err:42501');
  perform pg_temp.chk('관리자: 이미 취소된 요청 승인 차단','authenticated',a,'update public.jurisdiction_requests set status = ''approved'' where id = '||r1,'err:42501');
  perform pg_temp.chk('관리자: 요청 구간 고치기 차단','authenticated',a,'update public.jurisdiction_requests set section_ids = array[''S0009''] where id = '||r2,'err:42501');
  perform pg_temp.chk('관리자: 요청 지사 바꾸기 차단','authenticated',a,'update public.jurisdiction_requests set branch_id = ''B003'' where id = '||r2,'err:42501');
  perform pg_temp.chk('관리자: 처리 대기로 되돌리기 차단','authenticated',a,'update public.jurisdiction_requests set status = ''pending'' where id = '||r2,'err:42501');
  perform pg_temp.chk('관리자: 반려 사유 201자 차단','authenticated',a,'update public.jurisdiction_requests set status = ''rejected'', resolution_note = repeat(''가'', 201) where id = '||r2,'err:23514');
  perform pg_temp.chk('관리자: 승인','authenticated',a,'update public.jurisdiction_requests set status = ''approved'', resolution_note = ''관할 파일 저장 시 승인'', resolved_by = '''||b2||''' where id = '||r2,'ok:1');
  select * into row_ from public.jurisdiction_requests where id = r2;
  perform pg_temp.yes('승인하면 처리자=관리자(위조 불가), 시각 기록, 사유 저장', row_.status = 'approved' and row_.resolved_by = a and row_.resolved_at is not null and row_.resolution_note = '관할 파일 저장 시 승인');
  perform pg_temp.chk('관리자: 이미 승인된 요청 다시 처리 차단','authenticated',a,'update public.jurisdiction_requests set status = ''rejected'' where id = '||r2,'err:42501');
  perform pg_temp.chk('관리자: 반려','authenticated',a,'update public.jurisdiction_requests set status = ''rejected'', resolution_note = ''확인 결과 현재 소속이 맞음'' where section_ids = array[''S0003'']','ok:1');
  perform pg_temp.chk('아무도 요청을 지울 수 없음(관리자도)','authenticated',a,'delete from public.jurisdiction_requests','ok:0');
  perform pg_temp.chk('지사도 지울 수 없음','authenticated',b1,'delete from public.jurisdiction_requests','ok:0');

  -- E. 처리 대기 20개 제한
  perform pg_temp.chk('지사1 처리 대기 요청 20개까지 쌓기(앞서 만든 2건은 취소·반려로 처리됨)','authenticated',b1,'insert into public.jurisdiction_requests (section_ids) select array[''S'' || lpad((100 + g)::text, 4, ''0'')] from generate_series(1, 20) g','ok:20');
  perform pg_temp.chk('처리 대기가 20개면 21번째 차단','authenticated',b1,'insert into public.jurisdiction_requests (section_ids) values (array[''S0200''])','err:54000');
  perform pg_temp.chk('하나를 취소하면 다시 쌓을 수 있음','authenticated',b1,'update public.jurisdiction_requests set status = ''cancelled'' where id = (select min(id) from public.jurisdiction_requests where requested_by = '''||b1||''' and status = ''pending'')','ok:1');
  perform pg_temp.chk('취소 뒤 새 요청 가능','authenticated',b1,'insert into public.jurisdiction_requests (section_ids) values (array[''S0200''])','ok:1');
  perform pg_temp.chk('다른 지사는 영향 없음','authenticated',b2,'insert into public.jurisdiction_requests (section_ids) values (array[''S0201''])','ok:1');

  -- F. 기록과 설정
  select count(*) into c0 from public.audit_log where tab = 'jurisdiction_requests' and username = 'rq-b1' and kind = '추가';
  perform pg_temp.yes('요청 추가가 접속·수정 기록에 남음(지사 아이디, IP 포함)', c0 >= 2 and exists (select 1 from public.audit_log where tab = 'jurisdiction_requests' and username = 'rq-b1' and ip = '203.0.113.7'));
  perform pg_temp.yes('관리자의 승인이 기록에 남음', exists (select 1 from public.audit_log where tab = 'jurisdiction_requests' and username = 'rq-adm' and kind = '수정' and to_val ->> 'status' = 'approved'));
  perform pg_temp.yes('RLS 켜짐, 정책 3개(삭제 정책 없음)', (select relrowsecurity from pg_class where oid = 'public.jurisdiction_requests'::regclass) and (select count(*) from pg_policies where tablename = 'jurisdiction_requests') = 3);
  perform pg_temp.yes('비로그인(anon)에게 표 권한이 없음', not has_table_privilege('anon', 'public.jurisdiction_requests', 'select'));

  select count(*), count(*) filter (where not ok), string_agg(case when ok then 'PASS ' else 'FAIL ' end || name || case when ok then '' else '  → 실제 ' || got || ' / 기대 ' || want end, E'\n' order by n) into total, fails, rep from _t;
  raise exception E'구간 변경 요청 시험 결과 — 전체 %, 실패 %\n%', total, fails, rep;
end $t$;
