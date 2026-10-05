-- ============================================================
-- 예상 적설·강수·최저기온(마이그레이션 27·28·34) 시험 — 모으기 계획·1시간치 넣기(적설·강수·기온)·격자별 24시간 합·최저기온·추이·지사 값·격자 편입 변경 반영·지도용 함수·확정 고정·권한 — SQL Editor 에 통째로 붙여넣고 실행
-- 마지막에 일부러 오류를 내서 시험 자료를 전부 되돌립니다(지금 예보도 원래대로). "전체 N, 실패 0" 이어야 합니다.
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
declare a uuid := gen_random_uuid(); p jsonb; fg jsonb; vr text; nc int; k int; i int; hi int; h timestamptz; st0 timestamptz; v real[]; cx int; cy int; rid bigint; fails int; total int;
begin
  insert into auth.users (id, aud, role, email) values (a,'authenticated','authenticated','fa@t.test');
  insert into public.profiles (id,username,display_name,role,perms,must_change) values (a,'ft-adm','관리자','admin','{}',false);
  delete from public.forecast_runs;

  perform pg_temp.chk('로그인 사용자: 계획 함수 거절','authenticated',a,'select public.forecast_plan()','err:42501');
  perform pg_temp.chk('로그인 사용자: 넣기 함수 거절','authenticated',a,'select public.forecast_put(now(), ''SNO'', now(), ''{1}'')','err:42501');
  perform pg_temp.chk('관리자도: 1시간치 표 직접 쓰기 거절','authenticated',a,'insert into public.forecast_hours (tmfc, tmef, vals) values (now(), now(), ''{1}'')','err:42501');

  set local role service_role; p := public.forecast_plan(); reset role;
  select count(distinct (nx, ny)) into nc from private.grid_effective(); st0 := (p ->> 'start_at')::timestamptz;   -- 다음 계획(done)에는 start_at 이 없어 따로 둠
  perform pg_temp.yes('계획: 가장 최근 발표분, 다음 정시부터 24시각 × 적설·강수·기온, 지사 격자 전부', not (p ->> 'done')::boolean and jsonb_array_length(p -> 'missing') = 72 and jsonb_array_length(p -> 'cells') = nc
    and (p ->> 'tmfc')::timestamptz = private.fc_latest_tmfc() and (p ->> 'start_at')::timestamptz = date_trunc('hour', now()) + interval '1 hour', p::text);
  -- B001 의 첫 격자만 매시간 1.5cm·강수 2mm, 기온은 시작 7시간 뒤와 15시간 뒤 -6℃(같으면 이른 시각), 나머지 3℃. 다른 격자는 0·0·10℃, 바다(-99)인 격자 하나
  select g.nx, g.ny into cx, cy from private.grid_effective() g where g.branch_id = 'B001' order by g.ny, g.nx limit 1;
  select c.ordinality::int into k from jsonb_array_elements(p -> 'cells') with ordinality c where (c.value ->> 0)::int = cx and (c.value ->> 1)::int = cy;
  i := 0;
  for vr, h in select x ->> 0, (x ->> 1)::timestamptz from jsonb_array_elements(p -> 'missing') x loop
    hi := (extract(epoch from h - (p ->> 'start_at')::timestamptz) / 3600)::int;
    v := array_fill(case when vr = 'TMP' then 10 else 0 end::real, array[nc]);
    v[k] := case when vr = 'SNO' then 1.5 when vr = 'PCP' then 2 when hi in (7, 15) then -6 else 3 end; v[1] := case when k = 1 then v[k] else -99 end;
    set local role service_role; perform public.forecast_put((p ->> 'tmfc')::timestamptz, vr, h, v); reset role;
    i := i + 1;
    if i = 71 then perform pg_temp.yes('71개째까지는 아직 끝나지 않음', (select done_at is null from public.forecast_runs where tmfc = (p ->> 'tmfc')::timestamptz) and not exists (select 1 from public.branch_forecast where branch_id = 'B001' and max_snow_24h = 36)); end if;   -- 같은 발표분의 실제 결과가 이미 있을 수 있어 값으로 봄
  end loop;
  perform pg_temp.yes('72개 다 모이면 끝: B001 적설 36.0cm(1.5×24)·강수 48.0mm(2×24), 가장 많은 격자', (select max_snow_24h = 36 and max_pcp_24h = 48 and worst_nx = cx and worst_ny = cy and issued_at = (p ->> 'tmfc')::timestamptz from public.branch_forecast where branch_id = 'B001'));
  perform pg_temp.yes('바다(-99)는 0 으로', (select count(*) = 0 from public.branch_forecast where max_snow_24h < 0));
  perform pg_temp.yes('지사 모두(격자 편입 변경 반영)', (select count(*) from public.branch_forecast) = (select count(distinct branch_id) from private.grid_effective()));
  perform pg_temp.yes('격자별 24시간 합(지도용)', (select snow_24h = 36 and pcp_24h = 48 from public.forecast_cells where nx = cx and ny = cy) and (select count(*) from public.forecast_cells) = nc);
  perform pg_temp.yes('격자 최저기온 -6℃, 같은 값이면 이른 시각(시작 7시간 뒤), 추이 24시각', (select tmin = -6 and tmin_at = (p ->> 'start_at')::timestamptz + interval '7 hours'
    and jsonb_array_length(series -> 't') = 24 and (series -> 't' ->> 7)::numeric = -6 and (series -> 's' ->> 0)::numeric = 1.5 from public.forecast_cells where nx = cx and ny = cy));
  perform pg_temp.yes('지사 최저기온 = 가장 추운 격자', (select min_tmp = -6 and min_tmp_at = (p ->> 'start_at')::timestamptz + interval '7 hours' from public.branch_forecast where branch_id = 'B001'));
  perform pg_temp.yes('바다(-99) 기온은 없음으로(최저 -99 아님)', (select count(*) = 0 from public.forecast_cells where tmin <= -90) and (select count(*) = 0 from public.branch_forecast where min_tmp <= -90));
  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);
  set local role authenticated; fg := public.forecast_grid(array['B001']); reset role;
  perform pg_temp.yes('지도용 함수: B001 격자와 값', jsonb_array_length(fg -> 'cells') = (select count(*) from private.grid_effective() where branch_id = 'B001')
    and exists (select 1 from jsonb_array_elements(fg -> 'cells') c where (c ->> 0)::int = cx and (c ->> 1)::int = cy and (c ->> 3)::numeric = 36 and (c ->> 4)::numeric = 48), fg::text);
  perform pg_temp.yes('지도용 함수: 추이는 기본으로 보내지 않음', not exists (select 1 from jsonb_array_elements(fg -> 'cells') c where c -> 7 <> 'null'::jsonb) and exists (select 1 from jsonb_array_elements(fg -> 'cells') c where (c ->> 5)::numeric = -6));
  set local role authenticated; fg := public.forecast_grid(array['B001'], true); reset role;
  perform pg_temp.yes('지도용 함수: 지사 하나는 추이까지', exists (select 1 from jsonb_array_elements(fg -> 'cells') c where (c ->> 0)::int = cx and (c ->> 1)::int = cy and jsonb_array_length(c -> 7 -> 't') = 24), left(fg::text, 300));
  perform pg_temp.chk('추이는 지사 하나만','authenticated',a,'select public.forecast_grid(array[''B001'',''B002''], true)','err:22023');
  perform pg_temp.chk('비로그인: 지도용 함수 거절','anon',null,'select public.forecast_grid(array[''B001''])','err:42501');
  -- 격자 편입 변경: 관리자가 '예보 격자 편입' 탭에서 B001 에 칸을 더하면 서버 계산에도 들어감
  insert into public.grid_events (kind, payload) values ('cellAdd', jsonb_build_object('to', 'B001', 'cells', jsonb_build_array(jsonb_build_array(10, 10))));
  perform pg_temp.yes('격자 편입 변경이 지사 격자에 반영', exists (select 1 from private.grid_effective() where branch_id = 'B001' and nx = 10 and ny = 10));
  insert into public.grid_events (kind, payload) values ('cellRemove', jsonb_build_object('from', 'B001', 'cells', jsonb_build_array(jsonb_build_array(10, 10), jsonb_build_array(cx, cy))));
  perform pg_temp.yes('나중 변경(빼기)이 이김', not exists (select 1 from private.grid_effective() where branch_id = 'B001' and ((nx = 10 and ny = 10) or (nx = cx and ny = cy))));
  perform pg_temp.yes('모으기 끝 표시·수집 상태', (select done_at is not null from public.forecast_runs where tmfc = (p ->> 'tmfc')::timestamptz)
    and (select ok and cursor = to_char((p ->> 'tmfc')::timestamptz at time zone 'Asia/Seoul', 'YYYYMMDDHH24') from public.collector_state where job = 'forecast'));
  set local role service_role; p := public.forecast_plan(); reset role;
  perform pg_temp.yes('다 받은 발표분은 다시 받지 않음(계획 = done, 예약 호출도 안 함)', (p ->> 'done')::boolean and private.kick_forecast() is null, p::text);
  perform pg_temp.chk('끝난 뒤 넣기는 조용히 무시','service_role',null,format('select public.forecast_put(%L, ''PCP'', now(), ''{1,2}'')', p ->> 'tmfc'),'ok:1');   -- 이미 끝난 모으기는 조용히 무시

  -- 확정할 때 고정
  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);
  insert into public.support_rounds (name, start_date) values ('t', '2099-12-01') returning id into rid;
  perform pg_temp.chk('관리자: B001 확정','authenticated',a,format('select public.save_requests(%s, ''[{"branch_id":"B001","confirmed":true}]'')', rid),'ok:1');
  perform pg_temp.yes('확정 순간 예상 적설 36.0·강수 48.0·최저기온 -6 고정', (select fc_snow = 36 and fc_pcp = 48 and fc_tmin = -6 and fc_tmin_at = st0 + interval '7 hours' and fc_tmfc = (p ->> 'tmfc')::timestamptz and fc_at is not null from public.round_requests where round_id = rid and branch_id = 'B001'));
  perform pg_temp.chk('관리자: 고정값 직접 바꾸기(무시됨)','authenticated',a,format('update public.round_requests set fc_snow = 1 where round_id = %s and branch_id = ''B001''', rid),'ok:1');
  perform pg_temp.yes('고정값 그대로', (select fc_snow = 36 from public.round_requests where round_id = rid and branch_id = 'B001'));
  perform pg_temp.chk('관리자: 확정 취소','authenticated',a,format('select public.save_requests(%s, ''[{"branch_id":"B001","confirmed":false}]'')', rid),'ok:1');
  perform pg_temp.yes('취소하면 지움', (select fc_snow is null and fc_pcp is null and fc_tmin is null and fc_tmin_at is null and fc_at is null from public.round_requests where round_id = rid and branch_id = 'B001'));
  update public.branch_forecast set issued_at = now() - interval '13 hours' where branch_id = 'B002';
  perform pg_temp.chk('관리자: 예보가 12시간 넘게 지난 지사 확정','authenticated',a,format('select public.save_requests(%s, ''[{"branch_id":"B002","confirmed":true}]'')', rid),'ok:1');
  perform pg_temp.yes('지난 예보는 쓰지 않음(값 없음으로 고정)', (select fc_snow is null and fc_at is not null from public.round_requests where round_id = rid and branch_id = 'B002'));
  perform pg_temp.chk('관리자: 최저기온 직접입력 저장','authenticated',a,format('select public.save_requests(%s, ''[{"branch_id":"B003","wx_manual":true,"wx_tmin":-8.5,"wx_tmin_at":"2099-12-01T06:00:00+09:00"}]'')', rid),'ok:1');
  perform pg_temp.yes('직접입력 최저기온·시각', (select wx_manual and wx_tmin = -8.5 and wx_tmin_at = '2099-12-01T06:00:00+09:00'::timestamptz from public.round_requests where round_id = rid and branch_id = 'B003'));
  perform pg_temp.chk('직접입력 최저기온 범위(-60~50) 밖은 거절','authenticated',a,format('select public.save_requests(%s, ''[{"branch_id":"B003","wx_tmin":-99}]'')', rid),'err:23514');
  perform pg_temp.yes('지사는 예상 적설 표를 읽을 수 있음(로그인 사용자 읽기)', pg_temp.run_as('authenticated', a, 'select 1 from public.branch_forecast') like 'ok:%');

  select count(*), count(*) filter (where not ok) into total, fails from _t;
  raise exception E'예상 적설 시험 — 전체 %, 실패 %\n%', total, fails, (select string_agg('FAIL ' || name || ' → ' || got || ' / ' || want, E'\n' order by n) from _t where not ok);
end $t$;
