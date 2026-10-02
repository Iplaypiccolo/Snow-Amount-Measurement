-- ============================================================
-- 실제 계정 점검 — 기준정보·계정을 넣은 뒤(Supabase snow-support)에 SQL Editor 에서 실행. 자료는 읽기만 하고 마지막에 되돌립니다.
--  * 가입만 한 낯선 사람(프로필 없음)이 아무 자료도 못 보는지, 새 지사 계정(임시 비밀번호)이 막혀 있는지, 관리자가 정상인지 확인
--  * "비로그인: 비공개 저장소" 항목은 오류가 아니라 "0건(보이는 파일 없음)"이 정상입니다.
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

do $t$
declare x uuid := gen_random_uuid(); br uuid; ad uuid; rep text; fails int; total int;
begin
  insert into auth.users (id, aud, role, email) values (x, 'authenticated', 'authenticated', 'stranger@t.test');   -- 가입만 한 낯선 사람(프로필 없음)
  select id into br from auth.users where email = 'exchungju@snow-support.invalid';
  select id into ad from auth.users where email = 'admin-01@snow-support.invalid';

  perform pg_temp.chk('낯선 가입자: 본부 목록 0건','authenticated',x,'select 1 from public.hqs','ok:0');
  perform pg_temp.chk('낯선 가입자: 지사 목록 0건','authenticated',x,'select 1 from public.branches','ok:0');
  perform pg_temp.chk('낯선 가입자: 계정 목록 0건','authenticated',x,'select 1 from public.profiles','ok:0');
  perform pg_temp.chk('낯선 가입자: 기록 0건','authenticated',x,'select 1 from public.audit_log','ok:0');
  perform pg_temp.chk('낯선 가입자: 장비 추가 차단','authenticated',x,'insert into public.vehicles values (''11가1111'',''서울경기'',''제설차'',true)','err:42501');
  perform pg_temp.chk('낯선 가입자: 스스로 관리자 계정 만들기 차단','authenticated',x,format('insert into public.profiles (id,username,display_name,role) values (%L,''me-admin'',''x'',''admin'')',x),'err:42501');
  perform pg_temp.chk('낯선 가입자: 비공개 저장소 파일 목록 0건','authenticated',x,'select 1 from storage.objects where bucket_id = ''credentials''','ok:0');
  perform pg_temp.chk('비로그인: 비공개 저장소 파일 0건','anon',null,'select 1 from storage.objects','ok:0');
  perform pg_temp.chk('새 지사 계정(임시 비밀번호 상태): 본부 목록 0건','authenticated',br,'select 1 from public.hqs','ok:0');
  perform pg_temp.chk('새 지사 계정: 본인 계정 정보는 1건','authenticated',br,'select 1 from public.profiles','ok:1');
  perform pg_temp.chk('새 지사 계정: 비공개 저장소 0건','authenticated',br,'select 1 from storage.objects where bucket_id = ''credentials''','ok:0');
  perform pg_temp.chk('관리자(admin-01): 본부 목록 10건','authenticated',ad,'select 1 from public.hqs','ok:10');
  perform pg_temp.chk('관리자(admin-01): 계정 목록 61건','authenticated',ad,'select 1 from public.profiles','ok:61');
  perform pg_temp.chk('관리자(admin-01)도 임시 비밀번호 파일은 앱(API)으로 못 읽음 — 대시보드에서만','authenticated',ad,'select 1 from storage.objects where bucket_id = ''credentials''','ok:0');
  perform pg_temp.chk('계정 표에 비밀번호 열이 없음','authenticated',ad,'select password from public.profiles','err:42703');

  select count(*), count(*) filter (where not ok), string_agg(case when ok then 'PASS ' else 'FAIL ' end || name || case when ok then '' else '  → 실제 ' || got || ' / 기대 ' || want end, E'\n' order by n) into total, fails, rep from _t;
  raise exception E'실제 계정 점검 — 전체 %, 실패 %\n%', total, fails, rep;
end $t$;
