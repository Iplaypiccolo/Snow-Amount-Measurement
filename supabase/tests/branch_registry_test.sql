-- ============================================================
-- 신설 기관 정상 등록·순서(마이그레이션 14) 시험 — SQL Editor 에 통째로 붙여넣어 실행. 끝에 일부러 오류를 내서 모두 되돌립니다.
-- 결과는 오류 창에 "기관 등록 시험 결과 — 전체 N, 실패 0" 으로 나옵니다.
-- ============================================================
create temp table _t3 (n serial, name text, got text, want text, ok boolean);
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
begin insert into _t3(name, got, want, ok) values (name, got, want, got = want); end $f$;
create or replace function pg_temp.yes(name text, cond boolean) returns void language plpgsql as $f$
begin insert into _t3(name, got, want, ok) values (name, case when cond then 'true' else 'false' end, 'true', coalesce(cond, false)); end $f$;

do $t$
declare a uuid := gen_random_uuid(); b uuid := gen_random_uuid(); rep text; fails int; total int;
begin
  insert into auth.users (id, aud, role, email) values (a,'authenticated','authenticated','ra@t.test'),(b,'authenticated','authenticated','rb@t.test');
  insert into public.profiles (id,username,display_name,role,branch_id,perms,must_change) values (a,'rg-adm','관리자','admin',null,'{}',false),(b,'rg-br','지사','branch','B001','{juris.request,req.edit.own}',false);

  perform pg_temp.yes('영암 B060·민자 B061 이 기관 목록에 있음', (select count(*) from public.branches where (id, name) in (('B060','영암'),('B061','민자'))) = 2);
  perform pg_temp.chk('지사: 영암(B060)으로 구간 변경 요청 가능(예전엔 외래키 오류)','authenticated',b,
    'insert into public.jurisdiction_requests (section_ids, snapshot, to_branch_id, reason) values (array[''S0001''], ''[]'', ''B060'', ''시험'')','ok:1');
  perform pg_temp.chk('관리자: 신설 기관 저장(위치 after 포함)','authenticated',a,
    'select public.save_jurisdiction(''[{"kind":"addBranch","payload":{"id":"B990","hq":"강원","name":"등록시험","after":"B014"}}]'')','ok:1');
  perform pg_temp.yes('저장과 함께 기관 목록에 자동 등록(본부·상태 new)', exists (select 1 from public.branches br join public.hqs h on h.id = br.hq_id where br.id = 'B990' and br.name = '등록시험' and h.name = '강원' and br.status = 'new'));
  perform pg_temp.chk('본부 이동도 기관 목록에 반영','authenticated',a,'select public.save_jurisdiction(''[{"kind":"moveHq","payload":{"branch":"B990","hq":"충북","fromHq":"강원"}}]'')','ok:1');
  perform pg_temp.yes('B990 의 본부가 충북으로 바뀜', (select h.name from public.branches br join public.hqs h on h.id = br.hq_id where br.id = 'B990') = '충북');
  perform pg_temp.chk('같은 이름의 기관은 등록 실패 → 저장 전체 취소','authenticated',a,
    'select public.save_jurisdiction(''[{"kind":"addBranch","payload":{"id":"B991","hq":"강원","name":"춘천"}}]'')','err:23505');
  perform pg_temp.yes('취소되어 B991 이력도 없음', not exists (select 1 from public.jurisdiction_events where payload ->> 'id' = 'B991'));
  perform pg_temp.chk('순서 이력(orderBranch) 저장','authenticated',a,'select public.save_jurisdiction(''[{"kind":"orderBranch","payload":{"branch":"B035","after":""}}]'')','ok:1');
  perform pg_temp.chk('순서 이력: 기관 없으면 거절','authenticated',a,'select public.save_jurisdiction(''[{"kind":"orderBranch","payload":{"after":"B001"}}]'')','err:23514');
  perform pg_temp.chk('after 가 문자가 아니면 거절','authenticated',a,'select public.save_jurisdiction(''[{"kind":"orderBranch","payload":{"branch":"B035","after":5}}]'')','err:23514');
  perform pg_temp.chk('지사: 순서 이력 저장 불가','authenticated',b,'select public.save_jurisdiction(''[{"kind":"orderBranch","payload":{"branch":"B035","after":""}}]'')','err:42501');
  perform pg_temp.chk('지사: 기관 목록 직접 추가 불가','authenticated',b,'insert into public.branches (id, hq_id, name) values (''B995'', ''H01'', ''몰래'')','err:42501');

  select count(*), count(*) filter (where not ok), string_agg(case when ok then 'PASS ' else 'FAIL ' end || name || case when ok then '' else '  → 실제 ' || got || ' / 기대 ' || want end, E'\n' order by n) into total, fails, rep from _t3;
  raise exception E'기관 등록 시험 결과 — 전체 %, 실패 %\n%', total, fails, rep;
end $t$;
