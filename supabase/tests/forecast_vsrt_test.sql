-- ============================================================
-- 초단기예보 받기(57)·24시간 예보에 섞기(60) 시험 — SQL Editor 에 통째로 붙여넣고 실행(60 적용 뒤)
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
  perform pg_temp.yes('초단기가 없으면 단기예보만(강수 24·기온 10·확률 20·적설 12, vn 0)', (select max_pcp_24h = 24 and min_tmp = 10 and max_pop_24h = 20 and max_snow_24h = 12 and (detail ->> 'vn')::int = 0 from public.branch_forecast where branch_id = 'B001'));

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
  -- 섞은 24시간 예보(마이그레이션 60): 초단기를 다 받으면 지금 창 그대로 다시 계산 → 단기 표 자체가 앞 6시간 초단기 + 나머지 단기
  perform pg_temp.yes('지사: 강수 3×6 + 단기 1×18 = 36, 최저 -8(시작 시각), 확률 90, 적설은 단기 그대로 12, 발표 시각은 단기', (select max_pcp_24h = 36 and min_tmp = -8 and min_tmp_at = h0 and max_pop_24h = 90 and max_snow_24h = 12
      and issued_at = (p ->> 'tmfc')::timestamptz and (detail ->> 'start_at')::timestamptz = h0 and (detail ->> 'vsrt_at')::timestamptz = t0 and (detail ->> 'vn')::int = 6 from public.branch_forecast where branch_id = 'B001'),
    (select row_to_json(b)::text from public.branch_forecast b where branch_id = 'B001'));
  perform pg_temp.yes('격자: 24시각 그대로, 앞 6시각만 초단기, 적설은 모두 단기, vn = 6', (select pcp_24h = 36 and tmin = -8 and pop_24h = 90 and snow_24h = 12
      and jsonb_array_length(series -> 'p') = 24 and (series -> 'p' ->> 0)::numeric = 3 and (series -> 'p' ->> 5)::numeric = 3 and (series -> 'p' ->> 6)::numeric = 1
      and (series -> 't' ->> 0)::numeric = -8 and (series -> 't' ->> 5)::numeric = 5 and (series -> 't' ->> 6)::numeric = 10
      and (series -> 'r' ->> 2)::int = 90 and (series -> 'r' ->> 6)::int = 20 and (series -> 's' ->> 0)::numeric = 0.5 and (series ->> 'vn')::int = 6 from public.forecast_cells where nx = cx and ny = cy),
    (select left(series::text, 300) from public.forecast_cells where nx = cx and ny = cy));
  perform pg_temp.yes('바다(-99) 칸은 단기 값 그대로', (select (series -> 'p' ->> 0)::numeric = 1 and (series -> 't' ->> 0)::numeric = 10 and (series -> 'r' ->> 0)::int = 20 from public.forecast_cells where nx = sx and ny = sy),
    (select left(series::text, 300) from public.forecast_cells where nx = sx and ny = sy));
  perform pg_temp.yes('확정 고정값(branch_fc)도 섞은 값', (private.branch_fc('B001') ->> 'pcp')::numeric = 36 and (private.branch_fc('B001') ->> 'tmin')::numeric = -8 and (private.branch_fc('B001') ->> 'pop')::int = 90);
  ok1 := private.fc_roll();
  perform pg_temp.yes('매시 정각 다시 계산해도 섞은 값', ok1 and (select max_pcp_24h = 36 and min_tmp = -8 and (detail ->> 'vn')::int = 6 from public.branch_forecast where branch_id = 'B001'));
  -- 화면 읽기: 로그인 사용자는 forecast_grid 로 같은 값(추이에 vn)
  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);
  set local role authenticated; fs := public.forecast_grid(array['B001'], true); reset role;
  perform pg_temp.yes('forecast_grid: 섞은 값·추이 vn', exists (select 1 from jsonb_array_elements(fs -> 'cells') c where (c ->> 0)::int = cx and (c ->> 1)::int = cy and (c ->> 4)::numeric = 36 and (c ->> 5)::numeric = -8 and (c ->> 8)::int = 90 and (c -> 7 ->> 'vn')::int = 6), left(fs::text, 300));
  perform pg_temp.yes('전환 보기 함수는 지움', to_regprocedure('public.forecast_vsrt_overview()') is null and to_regprocedure('public.forecast_vsrt_grid(text[],boolean)') is null and to_regprocedure('private.fc_vsrt_cells(text[],boolean)') is null);
  perform pg_temp.chk('로그인 사용자: 다시 계산 함수 직접 호출 거절','authenticated',a,'select private.fc_refresh()','err:42501');

  -- 다 받은 뒤
  set local role service_role; q := public.forecast_vsrt_plan(); reset role;
  perform pg_temp.yes('다 받으면 계획 없음, 예약 호출도 함수를 부르지 않음', jsonb_array_length(q -> 'candidates') = 0 and private.kick_vsrt() is null, q::text);
  perform pg_temp.chk('끝난 뒤 넣기는 조용히 무시','service_role',null,format(putq, t0, 'T1H', h0, '{1}'::real[]),'ok:1');

  -- 3시간 넘게 못 받으면 단기예보 값(다음 계산 때부터)
  delete from public.forecast_vsrt_runs;
  insert into public.forecast_vsrt_runs (tmfc, cells, done_at) values (now() - interval '4 hours', p -> 'cells', now());
  insert into public.forecast_vsrt_hours (tmfc, var, tmef, vals) values (now() - interval '4 hours', 'T1H', h0, array_fill(-50::real, array[nc]));
  ok1 := private.fc_roll();
  perform pg_temp.yes('3시간 넘은 초단기는 안 씀: 단기예보만, 초단기 시각 없음', ok1 and (select max_pcp_24h = 24 and min_tmp = 10 and max_pop_24h = 20 and max_snow_24h = 12 and detail -> 'vsrt_at' = 'null'::jsonb and (detail ->> 'vn')::int = 0 from public.branch_forecast where branch_id = 'B001')
    and (select not (series ? 'vn') from public.forecast_cells where nx = cx and ny = cy), (select row_to_json(b)::text from public.branch_forecast b where branch_id = 'B001'));

  -- 실패 기록
  set local role service_role; perform public.forecast_vsrt_fail('시험 실패'); reset role;
  perform pg_temp.yes('실패 기록: 초단기 상태만(단기 상태는 그대로)', (select not ok and note = '시험 실패' from public.collector_state where job = 'forecast_vsrt')
    and exists (select 1 from public.collector_runs where job = 'forecast_vsrt' and error = '시험 실패') and (select ok from public.collector_state where job = 'forecast'));

  select count(*), count(*) filter (where not ok) into cnt, bad from _t;
  raise exception E'초단기예보 시험 — 전체 %, 실패 %\n%', cnt, bad, coalesce((select string_agg('FAIL ' || name || ' → ' || got || ' / ' || want, E'\n' order by n) from _t where not ok), '(모두 통과)');
end $t$;
