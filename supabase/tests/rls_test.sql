-- ============================================================
-- 권한(RLS)·접속 기록 자동 시험 — Supabase SQL Editor 에 통째로 붙여넣고 실행하세요.
--  * 시험용 계정·자료를 만들었다가 마지막에 "일부러 오류"를 내서 전부 되돌립니다. 실제 자료는 바뀌지 않습니다.
--  * 운영 DB 에 이미 있는 자료 수를 먼저 세고 그만큼 더해서 비교합니다(빈 DB·운영 DB 모두에서 실행 가능).
--  * 결과는 오류 창에 "RLS 시험 결과 — 전체 N, 실패 0" 과 항목별 PASS/FAIL 목록으로 나옵니다. 실패가 0 이어야 합니다.
--  * 권한 규칙(마이그레이션 02·15·16·19·20)을 바꿀 때마다 다시 실행하세요.
-- ============================================================
create temp table _t (n serial, name text, got text, want text, ok boolean);

create or replace function pg_temp.run_as(rl text, uid uuid, stmt text, hdr text default '') returns text
language plpgsql as $f$
declare n bigint;
begin
  perform set_config('request.jwt.claims', case when uid is null then '' else json_build_object('sub', uid, 'role', rl)::text end, true);
  perform set_config('request.headers', coalesce(hdr, ''), true);
  if rl <> 'postgres' then execute format('set local role %I', rl); end if;
  begin
    execute stmt;
    get diagnostics n = row_count;
    execute 'reset role';
    return 'ok:' || n;
  exception when others then
    execute 'reset role';
    return 'err:' || sqlstate;
  end;
end $f$;

create or replace function pg_temp.chk(name text, rl text, uid uuid, stmt text, want text, hdr text default '') returns void
language plpgsql as $f$
declare got text := pg_temp.run_as(rl, uid, stmt, hdr); good boolean;
begin
  good := case when want = 'ok:+' then got ~ '^ok:[1-9]' else got = want end;
  insert into _t(name, got, want, ok) values (name, got, want, good);
end $f$;

create or replace function pg_temp.yes(name text, cond boolean, info text default '') returns void
language plpgsql as $f$
begin insert into _t(name, got, want, ok) values (name, case when cond then 'true' else 'false ' || info end, 'true', coalesce(cond, false)); end $f$;

do $t$
declare
  a uuid := gen_random_uuid(); b1 uuid := gen_random_uuid(); b2 uuid := gen_random_uuid(); b3 uuid := gen_random_uuid();
  e uuid := gen_random_uuid(); e2 uuid := gen_random_uuid(); h uuid := gen_random_uuid(); v uuid := gen_random_uuid();
  d uuid := gen_random_uuid(); m uuid := gen_random_uuid();
  bp text[] := array['juris.request','req.edit.own'];
  rid bigint; rep text; fails int; total int; hdr text := '{"cf-connecting-ip":"203.0.113.9"}';
  c0 bigint; c1 bigint; s text; nh bigint; nb bigint; np bigint; nperm bigint; nset bigint;
begin
  -- ===== 시험용 자료(시험이 끝나면 전부 사라짐) =====
  insert into auth.users (id, aud, role, email) values
    (a,'authenticated','authenticated','a@t.test'),(b1,'authenticated','authenticated','b1@t.test'),(b2,'authenticated','authenticated','b2@t.test'),
    (b3,'authenticated','authenticated','b3@t.test'),(e,'authenticated','authenticated','e@t.test'),(e2,'authenticated','authenticated','e2@t.test'),
    (h,'authenticated','authenticated','h@t.test'),(v,'authenticated','authenticated','v@t.test'),
    (d,'authenticated','authenticated','d@t.test'),(m,'authenticated','authenticated','m@t.test');
  insert into public.hqs (id,name,is_private,sort) values ('H91','시험본부1',false,91),('H92','시험본부2',true,92);
  insert into public.branches (id,hq_id,name) values ('B901','H91','시험춘천'),('B902','H91','시험홍천'),('B903','H92','시험민자');
  insert into public.profiles (id,username,display_name,role,branch_id,org,hq_id,perms,disabled,must_change) values
    (a,'adm-test','관리자','admin',null,null,null,'{}',false,false),
    (b1,'br-001','춘천지사','branch','B901',null,null,bp,false,false),
    (b2,'br-002','홍천지사','branch','B902',null,null,bp,false,false),
    (b3,'br-003','민자지사(권한 추가)','branch','B903',null,null,bp || array['grid.edit','log.view'],false,false),
    (e,'eq-001','지원장비 서울경기','equip',null,'서울경기',null,'{equip.edit.own}',false,false),
    (e2,'eq-002','지원장비 충북','equip',null,'충북',null,'{equip.edit.own}',false,false),
    (h,'hq-001','시험본부1','hq',null,null,'H91','{req.edit.hq}',false,false),
    (v,'vw-001','보기 전용','viewer',null,null,null,'{}',false,false),
    (d,'dis-001','비활성','equip',null,'서울경기',null,'{equip.edit.own}',true,false),
    (m,'tmp-001','임시비번','equip',null,'서울경기',null,'{equip.edit.own}',false,true);
  insert into public.vehicles (id,org,type,plate) values ('V9001','서울경기','제설차','11가1111'),('V9002','충북','제설기','22나2222');
  insert into public.support_rounds (name,start_date) values ('시험 기준일자','2099-12-01') returning id into rid;
  insert into public.round_requests (round_id, branch_id) values (rid,'B902');
  insert into public.stations (id,name,lat,lon) values (99001,'시험관측소',37,127);
  insert into public.settings values ('rls-test-key','{}');
  insert into public.collector_runs (job, started_at) values ('forecast', now());
  select count(*) into nh from public.hqs; select count(*) into nb from public.branches; select count(*) into np from public.profiles;
  select count(*) into nperm from public.permissions; select count(*) into nset from public.settings;

  -- ===== A. 비로그인(anon)은 아무것도 못 한다 =====
  perform pg_temp.chk('anon: hqs 읽기 차단','anon',null,'select 1 from public.hqs','err:42501');
  perform pg_temp.chk('anon: profiles 읽기 차단','anon',null,'select 1 from public.profiles','err:42501');
  perform pg_temp.chk('anon: snapshots 읽기 차단','anon',null,'select 1 from public.snapshots','err:42501');
  perform pg_temp.chk('anon: permissions 읽기 차단','anon',null,'select 1 from public.permissions','err:42501');
  perform pg_temp.chk('anon: vehicle_routes 읽기 차단','anon',null,'select 1 from public.vehicle_routes','err:42501');
  perform pg_temp.chk('anon: 도우미 함수(private) 호출 차단','anon',null,'select private.my_role()','err:42501');
  perform pg_temp.chk('anon: 권한 검사 함수 호출 차단','anon',null,'select private.has_perm(''juris.edit'')','err:42501');
  perform pg_temp.chk('anon: round_requests 쓰기 차단','anon',null,format('insert into public.round_requests(round_id,branch_id) values (%s,%L)',rid,'B901'),'err:42501');

  -- ===== B. 비활성 계정은 읽기도 쓰기도 못 한다 =====
  perform pg_temp.chk('비활성: hqs 읽으면 0건','authenticated',d,'select 1 from public.hqs','ok:0');
  perform pg_temp.chk('비활성: 자기 기관 장비 수정은 0건','authenticated',d,'update public.vehicles set status=''O'' where id=''V9001''','ok:0');
  perform pg_temp.chk('비활성: 경로 확정 차단','authenticated',d,'insert into public.vehicle_routes (date,vehicle_id,stops) values (''2099-12-02'',''V9001'',''{B901}'')','err:42501');

  -- ===== B2. 임시 비밀번호(must_change) 계정은 비밀번호를 바꾸기 전까지 아무 자료도 못 쓴다 =====
  perform pg_temp.chk('임시비번: hqs 읽으면 0건','authenticated',m,'select 1 from public.hqs','ok:0');
  perform pg_temp.chk('임시비번: 경로 확정 차단','authenticated',m,'insert into public.vehicle_routes (date,vehicle_id,stops) values (''2099-12-02'',''V9001'',''{B901}'')','err:42501');
  perform pg_temp.chk('임시비번: 본인 계정 정보는 볼 수 있음(변경 필요 여부 확인용)','authenticated',m,'select 1 from public.profiles','ok:1');
  perform pg_temp.chk('임시비번: 스스로 must_change 해제 시도 → 0건','authenticated',m,format('update public.profiles set must_change=false where id=%L',m),'ok:0');
  perform pg_temp.yes('임시비번 상태가 그대로 유지됨', (select must_change from public.profiles where id = m));
  perform pg_temp.chk('비밀번호가 바뀌면(auth.users 갱신) 임시 상태가 자동으로 해제됨','postgres',null,format('update auth.users set encrypted_password=%L where id=%L','$2a$10$x',m),'ok:1');
  perform pg_temp.yes('must_change 가 자동 해제됨', not (select must_change from public.profiles where id = m));
  perform pg_temp.chk('해제 후: hqs 읽기','authenticated',m,'select 1 from public.hqs',format('ok:%s',nh));

  -- ===== C. 활성 로그인 사용자는 기준정보를 읽는다 =====
  perform pg_temp.chk('관리자: hqs 읽기','authenticated',a,'select 1 from public.hqs',format('ok:%s',nh));
  perform pg_temp.chk('지사: hqs 읽기','authenticated',b1,'select 1 from public.hqs',format('ok:%s',nh));
  perform pg_temp.chk('지원장비: branches 읽기','authenticated',e,'select 1 from public.branches',format('ok:%s',nb));
  perform pg_temp.chk('보기 전용: branches 읽기','authenticated',v,'select 1 from public.branches',format('ok:%s',nb));
  perform pg_temp.chk('지사: vehicles 읽기(시험 장비 2대)','authenticated',b2,'select 1 from public.vehicles where id like ''V9%''','ok:2');
  perform pg_temp.chk('지사: round_requests 읽기(타 지사 행도 읽음)','authenticated',b1,format('select 1 from public.round_requests where round_id=%s',rid),'ok:1');
  perform pg_temp.chk('지사: 권한 목록 읽기','authenticated',b1,'select 1 from public.permissions',format('ok:%s',nperm));

  -- ===== D. 관리자 전용 정보 =====
  perform pg_temp.chk('지사: audit_log 0건','authenticated',b1,'select 1 from public.audit_log','ok:0');
  perform pg_temp.chk('지원장비: audit_log 0건','authenticated',e,'select 1 from public.audit_log','ok:0');
  perform pg_temp.chk('관리자: audit_log 보임','authenticated',a,'select 1 from public.audit_log','ok:+');
  perform pg_temp.chk('log.view 권한을 받은 지사: audit_log 보임','authenticated',b3,'select 1 from public.audit_log','ok:+');
  perform pg_temp.chk('지사: collector_runs 0건','authenticated',b1,'select 1 from public.collector_runs','ok:0');
  perform pg_temp.chk('관리자: collector_runs 보임','authenticated',a,'select 1 from public.collector_runs','ok:+');
  perform pg_temp.chk('지사: settings 0건','authenticated',b1,'select 1 from public.settings','ok:0');
  perform pg_temp.chk('관리자: settings 보임','authenticated',a,'select 1 from public.settings',format('ok:%s',nset));
  perform pg_temp.chk('지사: profiles 본인 1건만','authenticated',b1,'select 1 from public.profiles','ok:1');
  perform pg_temp.chk('지원장비: profiles 본인 1건만','authenticated',e,'select 1 from public.profiles','ok:1');
  perform pg_temp.chk('관리자: profiles 전체','authenticated',a,'select 1 from public.profiles',format('ok:%s',np));

  -- ===== E. 기준정보 쓰기는 관리자만 / 권한별 쓰기 =====
  perform pg_temp.chk('지사: hqs 추가 차단','authenticated',b1,'insert into public.hqs values (''H93'',''x'',false,93)','err:42501');
  perform pg_temp.chk('지원장비: hqs 추가 차단','authenticated',e,'insert into public.hqs values (''H93'',''x'',false,93)','err:42501');
  perform pg_temp.chk('관리자: hqs 추가','authenticated',a,'insert into public.hqs values (''H93'',''x'',false,93)','ok:1');
  perform pg_temp.chk('지사: branches 수정은 0건','authenticated',b1,'update public.branches set name=''해킹'' where id=''B901''','ok:0');
  perform pg_temp.chk('지원장비: branches 삭제는 0건','authenticated',e,'delete from public.branches where id like ''B90%''','ok:0');
  perform pg_temp.chk('관리자: branches 수정','authenticated',a,'update public.branches set radius_km=5 where id like ''B90%''','ok:3');
  perform pg_temp.chk('지사: snapshots 쓰기 차단','authenticated',b1,'insert into public.snapshots values (''rls-s1'',1,now(),''{}'')','err:42501');
  perform pg_temp.chk('관리자: snapshots 쓰기','authenticated',a,'insert into public.snapshots values (''rls-s1'',1,now(),''{}'')','ok:1');
  perform pg_temp.chk('지사: grid_assign 쓰기 차단','authenticated',b1,'insert into public.grid_assign values (73,127,''B901'')','err:42501');
  perform pg_temp.chk('관리자: grid_assign 쓰기(한 격자에 두 기관)','authenticated',a,'insert into public.grid_assign values (73,127,''B901''),(73,127,''B902'')','ok:2');
  perform pg_temp.chk('관리자: grid_assign 범위 밖 격자 차단','authenticated',a,'insert into public.grid_assign values (500,1,''B901'')','err:23514');
  perform pg_temp.chk('지원장비: snow_daily 쓰기 차단','authenticated',e,'insert into public.snow_daily values (''2099-12-01'',99001,3.5)','err:42501');
  perform pg_temp.chk('관리자: snow_daily 쓰기','authenticated',a,'insert into public.snow_daily values (''2099-12-01'',99001,3.5)','ok:1');
  perform pg_temp.chk('지사: snow_uploads 읽기 0건','authenticated',b1,'select 1 from public.snow_uploads','ok:0');
  perform pg_temp.chk('지사: snow_uploads 기록 차단(snow.upload 없음)','authenticated',b1,'insert into public.snow_uploads (ok, rows_written) values (true, 1)','err:42501');
  perform pg_temp.chk('관리자: snow_uploads 기록','authenticated',a,'insert into public.snow_uploads (ok, rows_written) values (true, 680)','ok:1');
  perform pg_temp.chk('관리자: grid_events 기록(작성자 위조 시도)','authenticated',a,format('insert into public.grid_events (by_user, kind, payload) values (%L,''cellAdd'',''{}'')', b2),'ok:1');
  perform pg_temp.yes('grid_events 작성자는 DB가 채움(위조 불가)', (select by_user = a from public.grid_events order by id desc limit 1));
  perform pg_temp.chk('지사: grid_events 기록 차단(grid.edit 없음)','authenticated',b1,'insert into public.grid_events (kind, payload) values (''cellAdd'',''{}'')','err:42501');
  perform pg_temp.chk('grid.edit 권한을 받은 지사: grid_events 기록','authenticated',b3,'insert into public.grid_events (kind, payload) values (''cellAdd'',''{}'')','ok:1');
  perform pg_temp.chk('지사: 관할 이력 기록 차단(juris.edit 없음)','authenticated',b1,'insert into public.jurisdiction_events (kind, payload) values (''move'',''{}'')','err:42501');
  perform pg_temp.chk('보기 전용: 관할 이력 기록 차단','authenticated',v,'insert into public.jurisdiction_events (kind, payload) values (''move'',''{}'')','err:42501');

  -- ===== E2. 권한 목록·계정 권한 =====
  perform pg_temp.chk('지사: 권한 목록 추가 차단','authenticated',b1,'insert into public.permissions values (''x.y'',''x'','''',''{}'',1)','err:42501');
  perform pg_temp.chk('관리자도: 권한 목록 수정 차단(마이그레이션으로만)','authenticated',a,'update public.permissions set label=''x''','err:42501');
  perform pg_temp.chk('목록에 없는 권한은 계정에 못 넣음','postgres',null,format('update public.profiles set perms=''{juris.edit,nope.perm}'' where id=%L',b1),'err:23514');
  perform pg_temp.chk('지사: 본인에게 juris.edit 추가 시도 → 0건','authenticated',b1,format('update public.profiles set perms=perms||''{juris.edit}'' where id=%L',b1),'ok:0');
  perform pg_temp.yes('지사 권한은 그대로', (select perms = bp from public.profiles where id = b1));
  perform pg_temp.chk('지원장비 역할인데 출발 기관이 없으면 거절','postgres',null,format('insert into public.profiles (id,username,display_name,role) values (%L,''bad-eq'',''x'',''equip'')',gen_random_uuid()),'err:23514');
  perform pg_temp.chk('지역본부 역할인데 본부가 없으면 거절','postgres',null,format('insert into public.profiles (id,username,display_name,role) values (%L,''bad-hq'',''x'',''hq'')',gen_random_uuid()),'err:23514');
  perform pg_temp.chk('없는 출발 기관 거절','postgres',null,format('insert into public.profiles (id,username,display_name,role,org) values (%L,''bad-eq2'',''x'',''equip'',''없는기관'')',gen_random_uuid()),'err:23503');

  -- ===== F. 서버 전용(수집) 표는 로그인 사용자가 못 쓴다 =====
  perform pg_temp.chk('관리자도: collector_runs 쓰기 차단(서버 전용)','authenticated',a,'insert into public.collector_runs (job, started_at) values (''x'', now())','err:42501');
  perform pg_temp.chk('관리자도: forecast_cells 쓰기 차단(서버 전용)','authenticated',a,'insert into public.forecast_cells (nx, ny) values (1,1)','err:42501');
  perform pg_temp.chk('관리자도: warnings_active 쓰기 차단(서버 전용)','authenticated',a,'insert into public.warnings_active (zone_code, kind, level) values (''z'',''대설'',''주의보'')','err:42501');

  -- ===== G. 장비: 지원장비 계정은 자기 기관 장비 추가·도공번호·지원 여부만(마이그레이션 19) =====
  perform pg_temp.chk('지원장비: 자기 기관 장비 추가','authenticated',e,'insert into public.vehicles (id,org,type,plate) values (''V9010'',''서울경기'',''제설차'',''서울경기910'')','ok:1');
  perform pg_temp.chk('지원장비: 다른 기관 장비 추가 차단','authenticated',e,'insert into public.vehicles (id,org,type,plate) values (''V9011'',''충북'',''제설차'',''충북911'')','err:42501');
  perform pg_temp.chk('지사: 장비 추가 차단','authenticated',b1,'insert into public.vehicles (id,org,type,plate) values (''V9012'',''서울경기'',''제설차'',''서울경기912'')','err:42501');
  perform pg_temp.chk('지원장비: 자기 기관 도공번호 수정','authenticated',e,'update public.vehicles set plate=''서울경기901'' where id=''V9001''','ok:1');
  perform pg_temp.chk('지원장비: 자기 기관 지원 여부 = 정비중','authenticated',e,'update public.vehicles set status=''M'' where id=''V9001''','ok:1');
  perform pg_temp.chk('지원장비: 다른 기관 장비 수정은 0건','authenticated',e,'update public.vehicles set status=''O'' where id=''V9002''','ok:0');
  perform pg_temp.chk('지원장비: 장비 종류 변경 차단','authenticated',e,'update public.vehicles set type=''제설기'' where id=''V9001''','err:42501');
  perform pg_temp.chk('지원장비: 장비를 다른 기관으로 옮기기 차단','authenticated',e,'update public.vehicles set org=''충북'' where id=''V9001''','err:42501');
  perform pg_temp.chk('지원장비: 장비 삭제는 0건','authenticated',e,'delete from public.vehicles where id=''V9001''','ok:0');
  perform pg_temp.chk('지사: 장비 수정은 0건','authenticated',b1,'update public.vehicles set status=''O''','ok:0');
  perform pg_temp.chk('보기 전용: 장비 수정은 0건','authenticated',v,'update public.vehicles set status=''O''','ok:0');
  perform pg_temp.chk('관리자: 장비 추가','authenticated',a,'insert into public.vehicles (id,org,type,plate) values (''V9003'',''서울경기'',''이동정비차'',''33다3333'')','ok:1');
  perform pg_temp.chk('차종 값 검사','authenticated',a,'insert into public.vehicles (id,org,type,plate) values (''V9004'',''서울경기'',''덤프'',''44라4444'')','err:23514');
  perform pg_temp.chk('도공번호 형식 검사','authenticated',a,'update public.vehicles set plate=''ABC'' where id=''V9003''','err:23514');
  perform pg_temp.chk('도공번호 형식 검사(숫자 없음)','authenticated',a,'update public.vehicles set plate=''서울경기'' where id=''V9003''','err:23514');
  perform pg_temp.chk('도공번호 중복 거절','authenticated',a,'update public.vehicles set plate=''22나2222'' where id=''V9003''','err:23505');
  perform pg_temp.chk('지원 여부 값 검사','authenticated',a,'update public.vehicles set status=''Z'' where id=''V9003''','err:23514');
  perform pg_temp.chk('장비 고유 번호 형식 검사','authenticated',a,'insert into public.vehicles (id,org,type,plate) values (''X1'',''서울경기'',''제설차'',''55마5555'')','err:23514');
  perform pg_temp.yes('장비 수정자는 DB가 채움', (select updated_by = e from public.vehicles where id = 'V9001'));

  -- ===== G2. 날짜별 경로: 관리자(equip.edit.all)만, [확정]한 날짜마다 한 줄, 이전 날짜는 남는다 =====
  perform pg_temp.chk('지원장비: 자기 장비라도 첫날이 아닌 경로는 차단(마이그레이션 43)','authenticated',e,'insert into public.vehicle_routes (date,vehicle_id,stops) values (''2099-12-09'',''V9001'',''{B901}'')','err:SA003');
  perform pg_temp.chk('관리자: 12/2 경로 확정','authenticated',a,'insert into public.vehicle_routes (date,vehicle_id,stops) values (''2099-12-02'',''V9001'',''{B901,B902}'')','ok:1');
  perform pg_temp.chk('관리자: 같은 장비 12/3 다른 지사로 확정','authenticated',a,'insert into public.vehicle_routes (date,vehicle_id,stops) values (''2099-12-03'',''V9001'',''{B903}'')','ok:1');
  perform pg_temp.yes('이전 날짜 경로가 그대로 남음(장비 1대에 2줄)', (select count(*) = 2 from public.vehicle_routes where vehicle_id = 'V9001'));
  perform pg_temp.chk('관리자: 12/2 경로 고쳐서 다시 확정','authenticated',a,'update public.vehicle_routes set stops=''{B902}'' where date=''2099-12-02'' and vehicle_id=''V9001''','ok:1');
  perform pg_temp.yes('경로 확정자는 DB가 채움', (select confirmed_by = a from public.vehicle_routes where date = '2099-12-02' and vehicle_id = 'V9001'));
  select format('%s|%s', kind, from_val::text) into s from public.audit_log where target like 'vehicle_routes:%' and kind = '수정' order by id desc limit 1;
  perform pg_temp.yes('경로를 고치면 이전 값이 수정 기록에 남음', s like '수정|%B901%', coalesce(s,'없음'));
  perform pg_temp.chk('충북 지원장비: 자기 장비 경로도 차단(첫날 배정받은 지사만)','authenticated',e2,'insert into public.vehicle_routes (date,vehicle_id,stops) values (''2099-12-02'',''V9002'',''{B901}'')','err:SA003');
  perform pg_temp.chk('관리자: 충북 장비 경로 확정','authenticated',a,'insert into public.vehicle_routes (date,vehicle_id,stops) values (''2099-12-02'',''V9002'',''{B901}'')','ok:1');
  perform pg_temp.chk('충북 지원장비: 서울경기 장비 경로 수정은 0건','authenticated',e2,'update public.vehicle_routes set stops=''{B903}'' where vehicle_id=''V9001''','ok:0');
  perform pg_temp.chk('충북 지원장비: 서울경기 장비 경로 삭제는 0건','authenticated',e2,'delete from public.vehicle_routes where vehicle_id=''V9001''','ok:0');
  perform pg_temp.chk('같은 날 같은 지사 두 번 거절','authenticated',a,'insert into public.vehicle_routes (date,vehicle_id,stops) values (''2099-12-04'',''V9001'',''{B901,B901}'')','err:23514');
  perform pg_temp.chk('없는 지사 거절','authenticated',a,'insert into public.vehicle_routes (date,vehicle_id,stops) values (''2099-12-04'',''V9001'',''{B999}'')','err:23503');
  perform pg_temp.chk('빈 경로 거절(지우려면 줄 삭제)','authenticated',a,'insert into public.vehicle_routes (date,vehicle_id,stops) values (''2099-12-04'',''V9001'',''{}'')','err:23514');
  perform pg_temp.chk('지사: 경로 확정 차단','authenticated',b1,'insert into public.vehicle_routes (date,vehicle_id,stops) values (''2099-12-04'',''V9001'',''{B901}'')','err:42501');
  perform pg_temp.chk('지사: 경로 읽기(모든 장비)','authenticated',b1,'select 1 from public.vehicle_routes where vehicle_id like ''V9%''','ok:3');
  perform pg_temp.chk('지원장비: 관리자가 넣은 경로 삭제는 거절','authenticated',e,'delete from public.vehicle_routes where vehicle_id=''V9001''','err:SA003');
  perform pg_temp.chk('관리자: 경로 삭제(확정 취소)','authenticated',a,'delete from public.vehicle_routes where date=''2099-12-03'' and vehicle_id=''V9001''','ok:1');
  perform pg_temp.chk('관리자: 장비 삭제(경로도 함께 지워짐)','authenticated',a,'delete from public.vehicles where id=''V9002''','ok:1');
  perform pg_temp.yes('삭제한 장비 경로가 남지 않음', not exists (select 1 from public.vehicle_routes where vehicle_id = 'V9002'));

  -- ===== H. 기준일자(지원 회차)는 req.confirm(관리자)만 =====
  perform pg_temp.chk('지원장비: 기준일자 만들기 차단','authenticated',e,'insert into public.support_rounds (name,start_date) values (''x'',''2099-12-05'')','err:42501');
  perform pg_temp.chk('지사: 기준일자 만들기 차단','authenticated',b1,'insert into public.support_rounds (name,start_date) values (''x'',''2099-12-05'')','err:42501');
  perform pg_temp.chk('관리자: 기준일자 만들기','authenticated',a,'insert into public.support_rounds (name,start_date,created_by) values (''r2'',''2099-12-05'','''||b2||''')','ok:1');
  perform pg_temp.yes('support_rounds 작성자는 DB가 채움(위조 불가)', (select created_by = a from public.support_rounds where name='r2'));
  perform pg_temp.chk('같은 기준일자 두 번 거절','authenticated',a,'insert into public.support_rounds (name,start_date) values (''r3'',''2099-12-05'')','err:23505');

  -- ===== H2. 지사별 요청·편성: 지사는 본인 지사, 지역본부는 본부 소속 지사, 편성·확정은 관리자 =====
  perform pg_temp.chk('춘천지사: 본인 행 추가','authenticated',b1,format('insert into public.round_requests(round_id,branch_id) values (%s,''B901'')',rid),'ok:1',hdr);
  perform pg_temp.chk('춘천지사: 홍천 행 추가 차단','authenticated',b1,format('insert into public.round_requests(round_id,branch_id) values (%s,''B903'')',rid),'err:42501');
  select count(*) into c0 from public.audit_log where username = 'br-001';
  perform pg_temp.chk('춘천지사: 본인 행 수정','authenticated',b1,'update public.round_requests set req_truck=3, reason=''눈길사고 예방'' where branch_id=''B901''','ok:1',hdr);
  perform pg_temp.chk('춘천지사: 홍천 행 수정은 0건','authenticated',b1,'update public.round_requests set req_truck=99 where branch_id=''B902''','ok:0');
  perform pg_temp.chk('홍천지사: 춘천 행 수정은 0건','authenticated',b2,'update public.round_requests set req_truck=99 where branch_id=''B901''','ok:0');
  perform pg_temp.chk('춘천지사: 본인 행을 다른 지사로 옮기기 차단','authenticated',b1,'update public.round_requests set branch_id=''B902'' where branch_id=''B901''','err:42501');
  perform pg_temp.chk('춘천지사: 삭제는 0건','authenticated',b1,'delete from public.round_requests where branch_id=''B901''','ok:0');
  perform pg_temp.chk('춘천지사: 음수 대수 차단','authenticated',b1,'update public.round_requests set req_truck=-1 where branch_id=''B901''','err:23514');
  perform pg_temp.chk('춘천지사: 편성 대수 바꾸기 차단','authenticated',b1,'update public.round_requests set assigned_truck=2 where branch_id=''B901''','err:42501');
  perform pg_temp.chk('춘천지사: 스스로 확정 차단','authenticated',b1,'update public.round_requests set confirmed=true where branch_id=''B901''','err:42501');
  perform pg_temp.chk('춘천지사: 수정자 위조 시도','authenticated',b1,format('update public.round_requests set updated_by=%L where branch_id=''B901''',b2),'ok:1');
  perform pg_temp.yes('round_requests 수정자는 DB가 채움(위조 불가)', (select updated_by = b1 from public.round_requests where round_id=rid and branch_id='B901'));
  perform pg_temp.chk('지역본부: 소속 지사(홍천) 요청 수정','authenticated',h,'update public.round_requests set req_blower=1 where branch_id=''B902''','ok:1');
  perform pg_temp.chk('지역본부: 다른 본부 지사 행 추가 차단','authenticated',h,format('insert into public.round_requests(round_id,branch_id) values (%s,''B903'')',rid),'err:42501');
  perform pg_temp.chk('지역본부: 편성 대수 바꾸기 차단','authenticated',h,'update public.round_requests set assigned_blower=1 where branch_id=''B902''','err:42501');
  perform pg_temp.chk('지원장비: round_requests 추가 차단','authenticated',e,format('insert into public.round_requests(round_id,branch_id) values (%s,''B903'')',rid),'err:42501');
  perform pg_temp.chk('지원장비: round_requests 수정은 0건','authenticated',e,'update public.round_requests set req_truck=9','ok:0');
  perform pg_temp.chk('관리자: 편성·확정','authenticated',a,'update public.round_requests set assigned_truck=2, confirmed=true where branch_id=''B901''','ok:1');
  perform pg_temp.chk('관리자: 홍천 행 수정','authenticated',a,'update public.round_requests set snow_cm=7 where branch_id=''B902''','ok:1');
  perform pg_temp.chk('확정 후 지사가 요청 대수만 고치기는 가능','authenticated',b1,'update public.round_requests set req_truck=4 where branch_id=''B901''','ok:1');
  perform pg_temp.yes('확정·편성 값은 그대로', (select confirmed and assigned_truck = 2 from public.round_requests where round_id=rid and branch_id='B901'));

  -- ===== I. 계정: 본인이 역할을 못 바꾼다 =====
  perform pg_temp.chk('지사: 본인 역할을 admin 으로 바꾸기 → 0건','authenticated',b1,format('update public.profiles set role=''admin'', branch_id=null where id=%L',b1),'ok:0');
  perform pg_temp.yes('지사 역할은 그대로', (select role = 'branch' from public.profiles where id = b1));
  perform pg_temp.chk('지사: 새 계정 만들기 차단','authenticated',b1,format('insert into public.profiles (id,username,display_name,role) values (%L,''x-001'',''x'',''admin'')',gen_random_uuid()),'err:42501');
  perform pg_temp.chk('관리자: 계정 비활성화','authenticated',a,format('update public.profiles set disabled=true where id=%L',e),'ok:1');
  perform pg_temp.chk('방금 비활성화된 계정은 즉시 읽기 0건','authenticated',e,'select 1 from public.hqs','ok:0');
  perform pg_temp.chk('방금 비활성화된 계정은 권한도 즉시 사라짐','authenticated',e,'update public.vehicles set status=''O'' where id=''V9001''','ok:0');
  perform pg_temp.chk('지사 역할인데 소속 지사가 없으면 거절','postgres',null,format('insert into public.profiles (id,username,display_name,role) values (%L,''bad-001'',''x'',''branch'')',gen_random_uuid()),'err:23514');
  perform pg_temp.chk('아이디는 소문자·숫자만','postgres',null,format('insert into public.profiles (id,username,display_name,role) values (%L,''BAD-002'',''x'',''admin'')',gen_random_uuid()),'err:23514');

  -- ===== J. 접속·수정 기록 =====
  select count(*) into c1 from public.audit_log where username = 'br-001';
  perform pg_temp.yes('춘천지사 수정이 기록됨', c1 > c0, c0||'→'||c1);
  select format('%s|%s|%s|%s', kind, tab, to_val::text, ip) into s from public.audit_log where username='br-001' and kind='수정' and target like 'round_requests:%' order by id limit 1;
  perform pg_temp.yes('기록: 구분·표·바뀐 값만·IP', s like '수정|round_requests|%"req_truck": 3%' and s not like '%updated_by%' and s like '%|203.0.113.9', coalesce(s,'없음'));
  select count(*) into c0 from public.audit_log;
  perform pg_temp.chk('바뀐 것이 없는 수정','authenticated',b1,'update public.round_requests set req_truck=req_truck where branch_id=''B901''','ok:1');
  perform pg_temp.yes('바뀐 것이 없으면 기록하지 않음', (select count(*) from public.audit_log) = c0);
  perform pg_temp.chk('지사: audit_log 쓰기 차단','authenticated',b1,'insert into public.audit_log (kind) values (''위조'')','err:42501');
  perform pg_temp.chk('관리자: audit_log 수정 차단','authenticated',a,'update public.audit_log set kind=''x''','err:42501');
  perform pg_temp.chk('관리자: audit_log 삭제 차단','authenticated',a,'delete from public.audit_log','err:42501');
  perform pg_temp.chk('서버(postgres)도: audit_log 수정 차단(트리거)','postgres',null,'update public.audit_log set kind=''x''','err:42501');
  perform pg_temp.chk('서버(postgres)도: audit_log 삭제 차단(트리거)','postgres',null,'delete from public.audit_log','err:42501');
  perform pg_temp.chk('서버(postgres)도: audit_log 비우기 차단(트리거)','postgres',null,'truncate public.audit_log','err:42501');

  -- ===== K. 설정 점검 =====
  perform pg_temp.yes('RLS 가 꺼진 표가 없다', (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and not c.relrowsecurity) = 0);
  perform pg_temp.yes('RLS 가 켜져 있는데 정책이 하나도 없는 표가 없다', (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and c.relrowsecurity and not exists (select 1 from pg_policies p where p.schemaname='public' and p.tablename=c.relname)) = 0);
  perform pg_temp.yes('anon 에게 public 표 권한이 없다', (select count(*) from information_schema.role_table_grants where grantee='anon' and table_schema='public') = 0);
  perform pg_temp.yes('로그인 사용자에게 TRUNCATE 권한이 없다', (select count(*) from information_schema.role_table_grants where grantee='authenticated' and table_schema='public' and privilege_type in ('TRUNCATE','TRIGGER','REFERENCES')) = 0);

  select count(*), count(*) filter (where not ok), string_agg(case when ok then 'PASS ' else 'FAIL ' end || name || case when ok then '' else '  → 실제 ' || got || ' / 기대 ' || want end, E'\n' order by n)
    into total, fails, rep from _t;
  raise exception E'RLS 시험 결과 — 전체 %, 실패 %\n%', total, fails, rep;   -- 예외로 끝내서 시험 자료를 전부 되돌림
end $t$;
