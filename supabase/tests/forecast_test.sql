-- ============================================================
-- 예상 적설(마이그레이션 27) 시험 — 모으기 계획·1시간치 넣기·24시간 합의 지사 최댓값·확정 고정·권한 — SQL Editor 에 통째로 붙여넣고 실행
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
declare a uuid := gen_random_uuid(); p jsonb; nc int; k int; i int; h timestamptz; v real[]; cx int; cy int; rid bigint; fails int; total int;
begin
  insert into auth.users (id, aud, role, email) values (a,'authenticated','authenticated','fa@t.test');
  insert into public.profiles (id,username,display_name,role,perms,must_change) values (a,'ft-adm','관리자','admin','{}',false);
  delete from public.forecast_runs;

  perform pg_temp.chk('로그인 사용자: 계획 함수 거절','authenticated',a,'select public.forecast_plan()','err:42501');
  perform pg_temp.chk('로그인 사용자: 넣기 함수 거절','authenticated',a,'select public.forecast_put(now(), now(), ''{1}'')','err:42501');
  perform pg_temp.chk('관리자도: 1시간치 표 직접 쓰기 거절','authenticated',a,'insert into public.forecast_hours (tmfc, tmef, vals) values (now(), now(), ''{1}'')','err:42501');

  set local role service_role; p := public.forecast_plan(); reset role;
  select count(distinct (nx, ny)) into nc from public.grid_assign;
  perform pg_temp.yes('계획: 가장 최근 발표분, 다음 정시부터 24시각, 지사 격자 전부', not (p ->> 'done')::boolean and jsonb_array_length(p -> 'missing') = 24 and jsonb_array_length(p -> 'cells') = nc
    and (p ->> 'tmfc')::timestamptz = private.fc_latest_tmfc() and (p ->> 'start_at')::timestamptz = date_trunc('hour', now()) + interval '1 hour', p::text);
  -- B001 의 첫 격자만 매시간 1.5cm, 바다(-99)인 격자 하나
  select g.nx, g.ny into cx, cy from public.grid_assign g where g.branch_id = 'B001' order by g.ny, g.nx limit 1;
  select c.ordinality::int into k from jsonb_array_elements(p -> 'cells') with ordinality c where (c.value ->> 0)::int = cx and (c.value ->> 1)::int = cy;
  i := 0;
  for h in select (x)::text::timestamptz from jsonb_array_elements_text(p -> 'missing') x loop
    v := array_fill(0::real, array[nc]); v[k] := 1.5; v[1] := case when k = 1 then 1.5 else -99 end;
    set local role service_role; perform public.forecast_put((p ->> 'tmfc')::timestamptz, h, v); reset role;
    i := i + 1;
    if i = 23 then perform pg_temp.yes('23시간째까지는 아직 끝나지 않음', (select done_at is null from public.forecast_runs where tmfc = (p ->> 'tmfc')::timestamptz) and not exists (select 1 from public.branch_forecast where branch_id = 'B001' and max_snow_24h = 36)); end if;   -- 같은 발표분의 실제 결과가 이미 있을 수 있어 값으로 봄
  end loop;
  perform pg_temp.yes('24시간 다 모이면 끝: B001 = 36.0cm(1.5×24), 가장 많은 격자', (select max_snow_24h = 36 and worst_nx = cx and worst_ny = cy and issued_at = (p ->> 'tmfc')::timestamptz from public.branch_forecast where branch_id = 'B001'));
  perform pg_temp.yes('바다(-99)는 0 으로', (select count(*) = 0 from public.branch_forecast where max_snow_24h < 0));
  perform pg_temp.yes('지사 59곳 모두', (select count(*) from public.branch_forecast) = (select count(distinct branch_id) from public.grid_assign));
  perform pg_temp.yes('모으기 끝 표시·수집 상태', (select done_at is not null from public.forecast_runs where tmfc = (p ->> 'tmfc')::timestamptz)
    and (select ok and cursor = to_char((p ->> 'tmfc')::timestamptz at time zone 'Asia/Seoul', 'YYYYMMDDHH24') from public.collector_state where job = 'forecast'));
  set local role service_role; p := public.forecast_plan(); reset role;
  perform pg_temp.yes('다 받은 발표분은 다시 받지 않음(계획 = done, 예약 호출도 안 함)', (p ->> 'done')::boolean and private.kick_forecast() is null, p::text);
  perform pg_temp.chk('개수가 다른 값은 거절','service_role',null,format('select public.forecast_put(%L, now(), ''{1,2}'')', p ->> 'tmfc'),'ok:1');   -- 이미 끝난 모으기는 조용히 무시

  -- 확정할 때 고정
  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);
  insert into public.support_rounds (name, start_date) values ('t', '2099-12-01') returning id into rid;
  perform pg_temp.chk('관리자: B001 확정','authenticated',a,format('select public.save_requests(%s, ''[{"branch_id":"B001","confirmed":true}]'')', rid),'ok:1');
  perform pg_temp.yes('확정 순간 예상 적설 36.0 고정', (select fc_snow = 36 and fc_tmfc = (p ->> 'tmfc')::timestamptz and fc_at is not null from public.round_requests where round_id = rid and branch_id = 'B001'));
  perform pg_temp.chk('관리자: 고정값 직접 바꾸기(무시됨)','authenticated',a,format('update public.round_requests set fc_snow = 1 where round_id = %s and branch_id = ''B001''', rid),'ok:1');
  perform pg_temp.yes('고정값 그대로', (select fc_snow = 36 from public.round_requests where round_id = rid and branch_id = 'B001'));
  perform pg_temp.chk('관리자: 확정 취소','authenticated',a,format('select public.save_requests(%s, ''[{"branch_id":"B001","confirmed":false}]'')', rid),'ok:1');
  perform pg_temp.yes('취소하면 지움', (select fc_snow is null and fc_at is null from public.round_requests where round_id = rid and branch_id = 'B001'));
  update public.branch_forecast set issued_at = now() - interval '13 hours' where branch_id = 'B002';
  perform pg_temp.chk('관리자: 예보가 12시간 넘게 지난 지사 확정','authenticated',a,format('select public.save_requests(%s, ''[{"branch_id":"B002","confirmed":true}]'')', rid),'ok:1');
  perform pg_temp.yes('지난 예보는 쓰지 않음(값 없음으로 고정)', (select fc_snow is null and fc_at is not null from public.round_requests where round_id = rid and branch_id = 'B002'));
  perform pg_temp.yes('지사는 예상 적설 표를 읽을 수 있음(로그인 사용자 읽기)', pg_temp.run_as('authenticated', a, 'select 1 from public.branch_forecast') like 'ok:%');

  select count(*), count(*) filter (where not ok) into total, fails from _t;
  raise exception E'예상 적설 시험 — 전체 %, 실패 %\n%', total, fails, (select string_agg('FAIL ' || name || ' → ' || got || ' / ' || want, E'\n' order by n) from _t where not ok);
end $t$;
