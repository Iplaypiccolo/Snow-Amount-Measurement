-- ============================================================
-- 초단기예보 받기·전환 보기(마이그레이션 57) 시험 — SQL Editor 에 통째로 붙여넣고 실행(57 적용 뒤)
-- 마지막에 일부러 오류를 내서 시험 자료를 전부 되돌립니다(지금 예보도 원래대로). "전체 N, 실패 0" 이어야 합니다.
-- ============================================================
create temp table if not exists _t (n serial, name text, got text, want text, ok boolean);
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
declare a uuid := gen_random_uuid(); p jsonb; q jsonb; vr text; nc int; k int; sea int; h timestamptz; h0 timestamptz; t0 timestamptz; v real[]; cx int; cy int; sx int; sy int; i int; cnt bigint; bad bigint; ok1 boolean; o jsonb; fg jsonb; fs jsonb;
  putq text := 'select public.forecast_vsrt_put(%L, %L, %L, %L::real[])';
begin
  insert into auth.users (id, aud, role, email) values (a,'authenticated','authenticated','fv@t.test');
  insert into public.profiles (id,username,display_name,role,perms,must_change) values (a,'fv-adm','관리자','admin','{}',false);
  delete from public.forecast_runs; delete from public.forecast_vsrt_runs;
  t0 := to_timestamp(floor(extract(epoch from now()) / 600) * 600); h0 := date_trunc('hour', now()) + interval '1 hour';

  -- 권한
  perform pg_temp.chk('로그인 사용자: 계획 거절','authenticated',a,'select public.forecast_vsrt_plan()','err:42501');
  perform pg_temp.chk('로그인 사용자: 시작 거절','authenticated',a,'select public.forecast_vsrt_begin(now())','err:42501');
  perform pg_temp.chk('로그인 사용자: 넣기 거절','authenticated',a,'select public.forecast_vsrt_put(now(), ''T1H'', now(), ''{1}'')','err:42501');
  perform pg_temp.chk('로그인 사용자: 실패 기록 거절','authenticated',a,'select public.forecast_vsrt_fail(''x'')','err:42501');
  perform pg_temp.chk('관리자도: 표 읽기 거절','authenticated',a,'select * from public.forecast_vsrt_hours','err:42501');
  perform pg_temp.chk('비로그인: 표 읽기 거절','anon',null,'select * from public.forecast_vsrt_runs','err:42501');
  perform pg_temp.chk('예약 호출 함수는 일반 계정 불가','authenticated',a,'select private.kick_vsrt()','err:42501');
  perform pg_temp.yes('10분마다 예약', exists (select 1 from cron.job where jobname = 'collect-vsrt' and schedule = '8-58/10 * * * *' and active));

  -- 단기예보 준비: 전 격자 적설 0.5·강수 1·기온 10·확률 20
  set local role service_role; p := public.forecast_plan(); reset role;
  select count(distinct (nx, ny)) into nc from private.grid_effective();
  select g.nx, g.ny into cx, cy from private.grid_effective() g where g.branch_id = 'B001' order by g.ny, g.nx limit 1;
  select e.ordinality::int into k from jsonb_array_elements(p -> 'cells') with ordinality e where (e.value ->> 0)::int = cx and (e.value ->> 1)::int = cy;
  sea := case when k = 1 then 2 else 1 end; sx := (p -> 'cells' -> (sea - 1) ->> 0)::int; sy := (p -> 'cells' -> (sea - 1) ->> 1)::int;
  for vr, h in select x ->> 0, (x ->> 1)::timestamptz from jsonb_array_elements(p -> 'missing') x loop
    v := array_fill(case vr when 'SNO' then 0.5 when 'PCP' then 1 when 'TMP' then 10 else 20 end::real, array[nc]);
    set local role service_role; perform public.forecast_put((p ->> 'tmfc')::timestamptz, vr, h, v); reset role;
  end loop;

  -- 계획·시작
  set local role service_role; q := public.forecast_vsrt_plan(); reset role;
  perform pg_temp.yes('계획: 지금 10분 칸부터 20분 앞까지 새 것부터 3개', jsonb_array_length(q -> 'candidates') = 3 and (q -> 'candidates' ->> 0)::timestamptz = t0
    and (q -> 'candidates' ->> 2)::timestamptz = t0 - interval '20 minutes', q::text);
  insert into public.forecast_vsrt_runs (tmfc, cells) values (t0 - interval '20 minutes', p -> 'cells');      -- 아직 끝나지 않은 예전 발표분(뒤에서 지워지는지 봄)
  set local role service_role; q := public.forecast_vsrt_begin(t0); reset role;
  perform pg_temp.yes('시작: 다음 정시부터 6시각 × 기온·강수·확률 = 18개, 격자 전부', jsonb_array_length(q -> 'missing') = 18 and jsonb_array_length(q -> 'cells') = nc
    and (select min((x ->> 1)::timestamptz) = h0 and max((x ->> 1)::timestamptz) = h0 + interval '5 hours' from jsonb_array_elements(q -> 'missing') x), q::text);
  set local role service_role; q := public.forecast_vsrt_begin(t0); reset role;
  perform pg_temp.yes('다시 시작해도 같은 발표분(이어서)', jsonb_array_length(q -> 'missing') = 18 and (select count(*) = 1 from public.forecast_vsrt_runs where tmfc = t0));

  -- 잘못된 넣기
  v := array_fill(0::real, array[nc]);
  perform pg_temp.chk('6시간 밖(기상청이 0 을 주는 시각) 거절','service_role',null,format(putq, t0, 'T1H', h0 + interval '6 hours', v),'err:22023');
  perform pg_temp.chk('다음 정시 앞 시각 거절','service_role',null,format(putq, t0, 'T1H', h0 - interval '1 hour', v),'err:22023');
  perform pg_temp.chk('모르는 종류(적설) 거절','service_role',null,format(putq, t0, 'SNO', h0, v),'err:22023');
  perform pg_temp.chk('격자 수가 다르면 거절','service_role',null,format(putq, t0, 'T1H', h0, '{1,2}'::real[]),'err:22023');
  perform pg_temp.chk('없는 발표분 거절','service_role',null,format(putq, t0 + interval '1 day', 'T1H', h0, v),'err:23503');

  -- 넣기: B001 격자만 시작 시각 기온 -8, 강수 6시각 모두 3, 시작 2시간 뒤 확률 90. 나머지 격자 기온 5·강수 0·확률 40, 바다(-99) 격자 하나
  i := 0;
  for vr, h in select x ->> 0, (x ->> 1)::timestamptz from jsonb_array_elements(q -> 'missing') x loop
    v := array_fill(case vr when 'T1H' then 5 when 'RN1' then 0 else 40 end::real, array[nc]);
    v[k] := case vr when 'T1H' then (case when h = h0 then -8 else 5 end) when 'RN1' then 3 else (case when h = h0 + interval '2 hours' then 90 else 40 end) end;
    v[sea] := -99;
    set local role service_role; perform public.forecast_vsrt_put(t0, vr, h, v); reset role;
    i := i + 1;
    if i = 17 then perform pg_temp.yes('17개째까지는 끝나지 않음', (select done_at is null from public.forecast_vsrt_runs where tmfc = t0)); end if;
  end loop;
  perform pg_temp.yes('18개째: 끝 표시, 예전 발표분 지움, 수집 상태', (select done_at is not null from public.forecast_vsrt_runs where tmfc = t0)
    and not exists (select 1 from public.forecast_vsrt_runs where tmfc < t0)
    and (select ok and cursor = to_char(t0 at time zone 'Asia/Seoul', 'YYYYMMDDHH24MI') from public.collector_state where job = 'forecast_vsrt'));
  -- 단기예보는 전혀 바뀌지 않음
  perform pg_temp.yes('단기: 지사 값·격자 값 그대로(강수 24·기온 10·확률 20·적설 12)', (select max_pcp_24h = 24 and min_tmp = 10 and max_pop_24h = 20 and max_snow_24h = 12 and issued_at = (p ->> 'tmfc')::timestamptz from public.branch_forecast where branch_id = 'B001')
    and (select pcp_24h = 24 and tmin = 10 from public.forecast_cells where nx = cx and ny = cy));
  ok1 := private.fc_roll();
  perform pg_temp.yes('단기: 매시 정각 다시 계산해도 그대로', ok1 and (select max_pcp_24h = 24 and min_tmp = 10 from public.branch_forecast where branch_id = 'B001'));
  -- 초단기 보기: 지사
  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);
  set local role authenticated; o := public.forecast_vsrt_overview(); fg := public.forecast_vsrt_grid(array['B001']); fs := public.forecast_vsrt_grid(array['B001'], true); reset role;
  perform pg_temp.yes('초단기 지사: 발표 시각·6시간 구간', (o ->> 'tmfc')::timestamptz = t0 and (o ->> 'start_at')::timestamptz = h0 and (o ->> 'end_at')::timestamptz = h0 + interval '6 hours', o::text);
  perform pg_temp.yes('초단기 지사: 강수 3×6=18, 최저 -8(시작 시각), 확률 90, 적설 없음', exists (select 1 from jsonb_array_elements(o -> 'rows') x where x ->> 'branch_id' = 'B001' and (x ->> 'max_pcp_24h')::numeric = 18 and (x ->> 'min_tmp')::numeric = -8
    and (x ->> 'min_tmp_at')::timestamptz = h0 and (x ->> 'max_pop_24h')::int = 90 and x -> 'max_snow_24h' = 'null'::jsonb and (x ->> 'issued_at')::timestamptz = t0), o::text);
  -- 초단기 보기: 격자
  perform pg_temp.yes('초단기 격자: forecast_grid 와 같은 자리, 적설 자리 null, 추이는 기본으로 안 보냄', exists (select 1 from jsonb_array_elements(fg -> 'cells') c where (c ->> 0)::int = cx and (c ->> 1)::int = cy and c -> 3 = 'null'::jsonb
    and (c ->> 4)::numeric = 18 and (c ->> 5)::numeric = -8 and (c ->> 6)::timestamptz = h0 and c -> 7 = 'null'::jsonb and (c ->> 8)::int = 90), left(fg::text, 300));
  perform pg_temp.yes('초단기 격자: 지사 격자 전부', jsonb_array_length(fg -> 'cells') = (select count(*) from private.grid_effective() where branch_id = 'B001'));
  perform pg_temp.yes('초단기 추이: 6시각, 적설 없음', exists (select 1 from jsonb_array_elements(fs -> 'cells') c where (c ->> 0)::int = cx and (c ->> 1)::int = cy and jsonb_array_length(c -> 7 -> 'p') = 6 and jsonb_array_length(c -> 7 -> 't') = 6
    and (c -> 7 -> 'p' ->> 0)::numeric = 3 and (c -> 7 -> 't' ->> 0)::numeric = -8 and (c -> 7 -> 'r' ->> 2)::int = 90 and not (c -> 7 ? 's')));
  -- 바다 칸: 빈 값(-99 가 값으로 나오지 않음)
  select e.value into q from jsonb_array_elements(public.forecast_vsrt_grid((select array_agg(distinct g.branch_id) from private.grid_effective() g where g.nx = sx and g.ny = sy))->'cells') e where (e.value ->> 0)::int = sx and (e.value ->> 1)::int = sy;
  perform pg_temp.yes('바다(-99) 칸은 강수·기온·확률이 빈 값', q -> 4 = 'null'::jsonb and q -> 5 = 'null'::jsonb and q -> 8 = 'null'::jsonb, q::text);
  perform pg_temp.chk('초단기 추이는 지사 하나만','authenticated',a,'select public.forecast_vsrt_grid(array[''B001'',''B002''], true)','err:22023');
  perform pg_temp.chk('비로그인: 초단기 지사 거절','anon',null,'select public.forecast_vsrt_overview()','err:42501');
  perform pg_temp.chk('비로그인: 초단기 격자 거절','anon',null,'select public.forecast_vsrt_grid(array[''B001''])','err:42501');
  perform pg_temp.chk('로그인 사용자: 계산 함수 직접 호출 거절','authenticated',a,'select * from private.fc_vsrt_cells()','err:42501');

  -- 다 받은 뒤
  set local role service_role; q := public.forecast_vsrt_plan(); reset role;
  perform pg_temp.yes('다 받으면 계획 없음, 예약 호출도 함수를 부르지 않음', jsonb_array_length(q -> 'candidates') = 0 and private.kick_vsrt() is null, q::text);
  perform pg_temp.chk('끝난 뒤 넣기는 조용히 무시','service_role',null,format(putq, t0, 'T1H', h0, '{1}'::real[]),'ok:1');

  -- 3시간 넘게 못 받으면 '자료 없음'
  delete from public.forecast_vsrt_runs;
  insert into public.forecast_vsrt_runs (tmfc, cells, done_at) values (now() - interval '4 hours', p -> 'cells', now());
  insert into public.forecast_vsrt_hours (tmfc, var, tmef, vals) values (now() - interval '4 hours', 'T1H', h0, array_fill(-50::real, array[nc]));
  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);
  set local role authenticated; o := public.forecast_vsrt_overview(); fg := public.forecast_vsrt_grid(array['B001']); reset role;
  perform pg_temp.yes('3시간 넘은 초단기는 자료 없음', o -> 'tmfc' = 'null'::jsonb and jsonb_array_length(o -> 'rows') = 0 and fg -> 'tmfc' = 'null'::jsonb
    and not exists (select 1 from jsonb_array_elements(fg -> 'cells') c where c -> 5 <> 'null'::jsonb), o::text);

  -- 실패 기록
  set local role service_role; perform public.forecast_vsrt_fail('시험 실패'); reset role;
  perform pg_temp.yes('실패 기록: 초단기 상태만(단기 상태는 그대로)', (select not ok and note = '시험 실패' from public.collector_state where job = 'forecast_vsrt')
    and exists (select 1 from public.collector_runs where job = 'forecast_vsrt' and error = '시험 실패') and (select ok from public.collector_state where job = 'forecast'));

  select count(*), count(*) filter (where not ok) into cnt, bad from _t;
  raise exception E'초단기예보 시험 — 전체 %, 실패 %\n%', cnt, bad, coalesce((select string_agg('FAIL ' || name || ' → ' || got || ' / ' || want, E'\n' order by n) from _t where not ok), '(모두 통과)');
end $t$;
