-- ============================================================
-- 특보 연동(마이그레이션 23·24) 시험 — 받아 넣기·종류 스위치·받을 필요 판단·지사별 최고 단계·특보구역 더하기/빼기·확정할 때 고정·권한 — SQL Editor 에 통째로 붙여넣고 실행
-- 마지막에 일부러 오류를 내서 시험 자료를 전부 되돌립니다(지금 특보·수집 상태도 원래대로). "전체 N, 실패 0" 이어야 합니다.
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
-- 지사 B 로 본 지금 특보 요약
create or replace function pg_temp.st(uid uuid) returns jsonb language plpgsql as $f$
declare j jsonb;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
  set local role authenticated; j := public.warning_status(); reset role; return j;
end $f$;
create or replace function pg_temp.zl(uid uuid) returns jsonb language plpgsql as $f$
declare j jsonb;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
  set local role authenticated; j := public.branch_zone_list(); reset role; return j;
end $f$;
do $t$
declare a uuid := gen_random_uuid(); b uuid := gen_random_uuid(); rid bigint; sid text; fails int; total int; j jsonb; r public.round_requests;
  rows3 text := '{"ok":true,"base":"209912010600","rows":[{"zone":"L9900001","kind":"대설","level":"주의","tm_fc":"2099-12-01T05:00:00+09:00"},{"zone":"L9900001","kind":"대설","level":"예비"},{"zone":"L9900002","kind":"대설","level":"경보"},{"zone":"L9900001","kind":"강풍","level":"경보"}]}';
begin
  insert into auth.users (id, aud, role, email) values (a,'authenticated','authenticated','wa@t.test'),(b,'authenticated','authenticated','wb@t.test');
  insert into public.profiles (id,username,display_name,role,branch_id,perms,must_change) values
    (a,'wt-adm','관리자','admin',null,'{}',false),(b,'wt-br','지사','branch','B001','{juris.request,req.edit.own}',false);
  insert into public.warning_zones (zone_code, name, sp) values ('L9900001','시험평지','00000014'),('L9900002','시험산지','00010014');
  select id into sid from public.sections where owner_id = 'B001' order by id limit 1;
  delete from public.branch_zone_overrides where branch_id in ('B001','B002');
  insert into public.section_zones (section_id, zone_code, km) values (sid, 'L9900001', 3);
  update public.settings set value = '{"kinds":["대설"]}' where key = 'warnings';           -- 먼저 대설만으로 시험

  -- 받아 넣기(서버 전용)
  perform pg_temp.chk('로그인 사용자: 특보 넣기 함수 거절','authenticated',a,'select public.ingest_warnings(''{"ok":true,"rows":[]}'')','err:42501');
  perform pg_temp.chk('로그인 사용자: 수집 토큰 확인 함수 거절','authenticated',a,'select public.collector_token_ok(''x'')','err:42501');
  perform pg_temp.chk('로그인 사용자: 수집 토큰 표 못 읽음','authenticated',a,'select token from private.collector_token','err:42501');
  perform pg_temp.chk('관리자도: warnings_active 직접 쓰기 거절','authenticated',a,'insert into public.warnings_active (zone_code, kind, level) values (''L9900001'',''대설'',''주의'')','err:42501');
  perform pg_temp.chk('서버: 특보 넣기','service_role',null,format('select public.ingest_warnings(%L)', rows3),'ok:1');
  perform pg_temp.yes('대설만: 같은 구역의 주의보+예비특보 둘 다, 강풍은 저장 안 함', (select count(*) = 3 and count(*) filter (where kind = '강풍') = 0 from public.warnings_active where zone_code like 'L99%'));
  perform pg_temp.yes('수집 상태 = 성공·기준시각', (select ok and cursor = '209912010600' and finished_at > now() - interval '1 minute' from public.collector_state where job = 'warnings'));
  perform pg_temp.chk('서버: 같은 내용 다시 넣어도 그대로','service_role',null,format('select public.ingest_warnings(%L)', rows3),'ok:1');
  perform pg_temp.yes('다시 넣어도 그대로·지난 특보 없음', (select count(*) = 3 from public.warnings_active where zone_code like 'L99%') and not exists (select 1 from public.warnings_history where zone_code like 'L99%'));
  perform pg_temp.yes('바뀐 게 없으면 수집 기록 안 남김(성공 1건만)', (select count(*) = 1 from public.collector_runs where job = 'warnings' and started_at = now()));

  -- 지사별 최고 단계(대설만)
  j := pg_temp.st(b);
  perform pg_temp.yes('B001 = 대설주의보(구역 1곳, 종류 대설)', j -> 'branches' -> 'B001' ->> 'level' = '주의' and j -> 'branches' -> 'B001' ->> 'kind' = '대설' and jsonb_array_length(j -> 'branches' -> 'B001' -> 'zones') = 1 and not (j ->> 'all')::boolean, j::text);
  update public.settings set value = '{"kinds":"all"}' where key = 'warnings';                 -- 모든 종류(확인용)
  perform pg_temp.chk('서버: 모든 종류로 다시 넣기','service_role',null,format('select public.ingest_warnings(%L)', rows3),'ok:1');
  j := pg_temp.st(b);
  perform pg_temp.yes('모든 종류: 강풍경보가 대설주의보보다 높아 맨 위, 구역 줄 2(대설·강풍)', j -> 'branches' -> 'B001' ->> 'level' = '경보' and j -> 'branches' -> 'B001' ->> 'kind' = '강풍' and jsonb_array_length(j -> 'branches' -> 'B001' -> 'zones') = 2 and (j ->> 'all')::boolean, j::text);
  update public.settings set value = '{"kinds":["대설"]}' where key = 'warnings';
  perform pg_temp.chk('서버: 대설만으로 되돌려 넣기','service_role',null,format('select public.ingest_warnings(%L)', rows3),'ok:1');
  perform pg_temp.yes('대설만으로 돌리면 강풍은 지난 특보에 안 남기고 지움', not exists (select 1 from public.warnings_active where kind = '강풍' and zone_code like 'L99%') and not exists (select 1 from public.warnings_history where zone_code like 'L99%'));
  perform pg_temp.chk('지사: 특보구역 더하기 거절','authenticated',b,'insert into public.branch_zone_overrides (branch_id, zone_code, include) values (''B001'',''L9900002'',true)','err:42501');
  perform pg_temp.chk('관리자: B001 에 산지 구역 더함','authenticated',a,'insert into public.branch_zone_overrides (branch_id, zone_code, include) values (''B001'',''L9900002'',true)','ok:1');
  j := pg_temp.st(b);
  perform pg_temp.yes('더한 구역 경보 → B001 = 경보, 구역 2곳(높은 단계 먼저)', j -> 'branches' -> 'B001' ->> 'level' = '경보' and j -> 'branches' -> 'B001' -> 'zones' -> 0 ->> 2 = '경보' and jsonb_array_length(j -> 'branches' -> 'B001' -> 'zones') = 2, j::text);
  perform pg_temp.yes('특보구역 더하기가 수정 기록에 남음', exists (select 1 from public.audit_log where tab = 'branch_zone_overrides' and target = 'branch_zone_overrides:B001,L9900002'));
  perform pg_temp.chk('관리자: 자동 구역(평지) 뺌','authenticated',a,'insert into public.branch_zone_overrides (branch_id, zone_code, include) values (''B001'',''L9900001'',false)','ok:1');
  j := pg_temp.st(b);
  perform pg_temp.yes('뺀 구역은 빠지고 산지(경보)만', jsonb_array_length(j -> 'branches' -> 'B001' -> 'zones') = 1 and j -> 'branches' -> 'B001' -> 'zones' -> 0 ->> 0 = 'L9900002', j::text);
  perform pg_temp.chk('관리자: 뺀 것 되살림','authenticated',a,'delete from public.branch_zone_overrides where branch_id = ''B001'' and zone_code = ''L9900001''','ok:1');
  perform pg_temp.chk('비로그인: 특보 요약 거절','anon',null,'select public.warning_status()','err:42501');
  perform pg_temp.yes('관리자 검토 목록: 자동 1 + 더함 1', ((pg_temp.zl(a) -> 'B001') @> '[["L9900001","시험평지","auto"],["L9900002","시험산지","manual"]]'::jsonb));

  -- 확정할 때 고정
  insert into public.support_rounds (name, start_date) values ('t', '2099-12-01') returning id into rid;
  perform pg_temp.chk('지사: 자기 줄 저장(특보 열은 보내도 무시)','authenticated',b,format('select public.save_requests(%s, ''[{"branch_id":"B001","req_truck":1}]'')', rid),'ok:1');
  perform pg_temp.yes('확정 전에는 고정값 없음', (select warn_at is null and warn_level is null from public.round_requests where round_id = rid and branch_id = 'B001'));
  perform pg_temp.chk('관리자: 숫자 0인 지사(B002)도 확정 가능','authenticated',a,format('select public.save_requests(%s, ''[{"branch_id":"B001","confirmed":true},{"branch_id":"B002","confirmed":true}]'')', rid),'ok:1');
  select * into r from public.round_requests where round_id = rid and branch_id = 'B001';
  perform pg_temp.yes('B001 확정 순간 경보로 고정(구역 2곳·기준시각)', r.warn_level = '경보' and jsonb_array_length(r.warn_zones) = 2 and r.warn_base = '209912010600' and r.warn_at is not null and r.warn_note is null, row_to_json(r)::text);
  perform pg_temp.yes('B002(구역 없음) = 특보 없음으로 고정', (select warn_level is null and warn_at is not null and warn_zones = '[]'::jsonb from public.round_requests where round_id = rid and branch_id = 'B002'));
  perform pg_temp.chk('관리자: 고정값 직접 바꾸기(무시됨)','authenticated',a,format('update public.round_requests set warn_level = null, warn_zones = null where round_id = %s and branch_id = ''B001''', rid),'ok:1');
  perform pg_temp.yes('고정값 그대로', (select warn_level = '경보' and jsonb_array_length(warn_zones) = 2 from public.round_requests where round_id = rid and branch_id = 'B001'));
  perform pg_temp.chk('서버: 특보가 모두 끝남','service_role',null,'select public.ingest_warnings(''{"ok":true,"base":"209912011200","rows":[]}'')','ok:1');
  perform pg_temp.yes('끝난 특보는 지난 특보로 옮김', (select count(*) = 3 from public.warnings_history where zone_code like 'L99%' and ended_at is not null) and not exists (select 1 from public.warnings_active where zone_code like 'L99%'));
  perform pg_temp.yes('지금은 B001 특보 없음', not (pg_temp.st(b) -> 'branches' ? 'B001'));
  perform pg_temp.yes('확정한 줄은 여전히 경보', (select warn_level = '경보' from public.round_requests where round_id = rid and branch_id = 'B001'));
  perform pg_temp.chk('관리자: 확정 취소','authenticated',a,format('select public.save_requests(%s, ''[{"branch_id":"B001","confirmed":false}]'')', rid),'ok:1');
  perform pg_temp.yes('취소하면 고정값 지움', (select warn_at is null and warn_level is null and warn_zones is null from public.round_requests where round_id = rid and branch_id = 'B001'));
  perform pg_temp.chk('관리자: 다시 확정','authenticated',a,format('select public.save_requests(%s, ''[{"branch_id":"B001","confirmed":true}]'')', rid),'ok:1');
  perform pg_temp.yes('다시 확정 = 그 순간(특보 없음)으로 고정', (select warn_level is null and warn_at is not null and warn_base = '209912011200' from public.round_requests where round_id = rid and branch_id = 'B001'));

  -- 받지 못함
  perform pg_temp.chk('서버: 받기 실패 기록','service_role',null,'select public.ingest_warnings(''{"ok":false,"http":401,"error":"기상청 응답 401"}'')','ok:1');
  perform pg_temp.yes('실패해도 마지막 성공 시각·지금 특보 유지', (select not ok and note = '기상청 응답 401' and finished_at > now() - interval '1 minute' from public.collector_state where job = 'warnings'));
  update public.collector_state set finished_at = now() - interval '31 minutes' where job = 'warnings';
  j := pg_temp.st(b);
  perform pg_temp.yes('30분 넘게 못 받으면 ok=false·지사 없음', not (j ->> 'ok')::boolean and j -> 'branches' = '{}'::jsonb and j ->> 'note' like '%30분%', j::text);
  perform pg_temp.chk('관리자: 그때 확정','authenticated',a,format('select public.save_requests(%s, ''[{"branch_id":"B003","confirmed":true}]'')', rid),'ok:1');
  perform pg_temp.yes('자료가 없으면 특보 없음으로 고정 + 이유', (select warn_level is null and warn_at is not null and warn_note like '%30분%' from public.round_requests where round_id = rid and branch_id = 'B003'));
  perform pg_temp.yes('수집 기록은 변화·실패 때만', (select count(*) filter (where ok) = 3 and count(*) filter (where not ok) = 1 from public.collector_runs where job = 'warnings' and started_at = now()));
  -- 받을 필요 판단: 기준일자 당일~+2일, 확정을 기다리는 지사가 있을 때만
  update public.support_rounds set start_date = '2000-01-01'::date + (id % 30000)::int;     -- 기준일자는 날짜마다 하나라 서로 다르게
  perform pg_temp.yes('최근 기준일자가 없으면 받지 않음', not private.warn_needed() and private.kick_warnings(false) is null);
  j := pg_temp.st(b);
  perform pg_temp.yes('화면: 수집 쉬는 중', (j ->> 'paused')::boolean and j ->> 'note' like '수집 쉬는 중%', j::text);
  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);   -- 아래 직접 넣기는 관리자로
  insert into public.support_rounds (name, start_date) values ('t2', (now() at time zone 'Asia/Seoul')::date) returning id into rid;
  perform pg_temp.yes('오늘 기준일자를 만들면(아직 확정 없음) 받음', private.warn_needed());
  insert into public.round_requests (round_id, branch_id, confirmed) values (rid, 'B001', true);
  perform pg_temp.yes('확정한 지사만 있고 기다리는 요청이 없으면 멈춤', not private.warn_needed());
  insert into public.round_requests (round_id, branch_id, req_truck) values (rid, 'B002', 1);
  perform pg_temp.yes('요청 넣고 확정 안 된 지사가 생기면 다시 받음', private.warn_needed());
  update public.support_rounds set start_date = (now() at time zone 'Asia/Seoul')::date + 1 where id = rid;
  perform pg_temp.yes('내일 기준일자는 당일 0시부터', not private.warn_needed());
  perform pg_temp.yes('특보구역 목록 받기는 필요와 상관없이', private.kick_warnings(true) is not null);

  select count(*), count(*) filter (where not ok) into total, fails from _t;
  raise exception E'특보 시험 — 전체 %, 실패 %\n%', total, fails, (select string_agg('FAIL ' || name || ' → ' || got || ' / ' || want, E'\n' order by n) from _t where not ok);
end $t$;
