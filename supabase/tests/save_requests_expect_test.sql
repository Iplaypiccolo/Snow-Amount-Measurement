-- ============================================================
-- [확정] 때 값이 바뀌었는지 확인 + 첫 저장 충돌(마이그레이션 56) 시험 — SQL Editor 에 통째로 붙여넣고 실행(56 적용 뒤)
-- 마지막에 일부러 오류를 내서 시험 자료(2099년 기준일자, 시험 계정, 시험용 정책·함수)를 전부 되돌립니다. "전체 N, 실패 0" 이어야 합니다.
-- 한 트랜잭션 안에서는 수정 시각(now())이 그대로라 '그사이 바뀜'은 예전 시각을 보내는 것으로 흉내 냅니다.
-- 첫 저장 충돌은 '처음 한 번만 줄이 안 보이는' 시험용 정책으로 흉내 냅니다(줄이 없다고 보고 추가 → 23505 → 다시 돌아가 수정).
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
-- 시험용: 시퀀스가 처음일 때 한 번만 B005·B006 줄을 숨김
create sequence public._t_seq;
create function public._t_first() returns boolean language sql security definer set search_path = '' as $f$ select nextval('public._t_seq') = 1 $f$;
grant execute on function public._t_first() to authenticated;
create policy _t_hide on public.round_requests as restrictive for select using (not (branch_id in ('B005', 'B006') and public._t_first()));
do $t$
declare a uuid := gen_random_uuid(); b uuid := gen_random_uuid(); rid bigint; c bigint; f bigint; ts timestamptz; ts2 timestamptz; ret jsonb;
  old constant text := '2020-01-01T00:00:00+00:00';
  sr text; at text;
begin
  insert into auth.users (id, aud, role, email) values (a,'authenticated','authenticated','xa@t.test'),(b,'authenticated','authenticated','xb@t.test');
  insert into public.profiles (id,username,display_name,role,branch_id,org,hq_id,perms,must_change) values
    (a,'xa-adm','관리자','admin',null,null,null,'{}',false),
    (b,'xa-br1','지사1','branch','B001',null,null,'{req.edit.own}',false);
  perform set_config('request.jwt.claims', '', true);
  insert into public.support_rounds (name,start_date,days) values ('t','2099-12-01',4) returning id into rid;
  sr := 'select public.save_requests(' || rid || ', %L::jsonb)';

  -- 저장은 예전과 같고, 돌려주는 값에 수정 시각이 더해짐
  perform pg_temp.chk('지사: 첫 저장','authenticated',b,format(sr,'[{"branch_id":"B001","req_truck":3}]'),'ok:1');
  select updated_at into ts from public.round_requests where round_id=rid and branch_id='B001';
  perform pg_temp.yes('첫 저장 값·저장 표시', (select req_truck=3 and saved_lv='branch' and not confirmed from public.round_requests where round_id=rid and branch_id='B001'));
  perform set_config('request.jwt.claims', json_build_object('sub', b, 'role', 'authenticated')::text, true);
  set local role authenticated;
  ret := public.save_requests(rid, '[{"branch_id":"B001","req_truck":3}]');
  reset role;
  select updated_at into ts2 from public.round_requests where round_id=rid and branch_id='B001';
  perform pg_temp.yes('돌려주는 값: rows, versions = 저장 뒤 수정 시각', (ret->>'rows')='1' and (ret->'versions'->>'B001')::timestamptz = ts2, ret::text);
  at := to_json(ts2)::text;

  -- ① 확정: 본 시각이 맞으면 됨, 그사이 바뀌었으면 거절
  perform pg_temp.chk('관리자: 옛 시각으로 확정 거절','authenticated',a,format(sr,'[{"branch_id":"B001","confirmed":true,"expect_at":"'||old||'"}]'),'err:SA007');
  perform pg_temp.yes('거절되면 확정 안 됨', (select not confirmed from public.round_requests where round_id=rid and branch_id='B001'));
  perform pg_temp.chk('관리자: 빈 줄을 봤는데 그사이 줄이 생김 거절','authenticated',a,format(sr,'[{"branch_id":"B001","confirmed":true,"expect_at":null}]'),'err:SA007');
  perform pg_temp.chk('관리자: 본 시각이 맞으면 확정','authenticated',a,format(sr,'[{"branch_id":"B001","confirmed":true,"expect_at":'||at||'}]'),'ok:1');
  perform pg_temp.yes('확정됨, 확정만 하면 저장 표시는 그대로', (select confirmed and saved_lv='branch' from public.round_requests where round_id=rid and branch_id='B001'));
  perform pg_temp.chk('확정한 줄은 그대로 잠김','authenticated',a,format(sr,'[{"branch_id":"B001","req_truck":9}]'),'err:55000');
  perform pg_temp.chk('확정 취소는 시각 없이 됨','authenticated',a,format(sr,'[{"branch_id":"B001","confirmed":false}]'),'ok:1');
  perform pg_temp.chk('시각을 안 보내는 옛 화면의 확정은 예전과 같음','authenticated',a,format(sr,'[{"branch_id":"B001","confirmed":true}]'),'ok:1');
  perform pg_temp.chk('확정 취소','authenticated',a,format(sr,'[{"branch_id":"B001","confirmed":false}]'),'ok:1');

  -- 줄이 아직 없을 때
  perform pg_temp.chk('관리자: 줄이 없는데 시각을 보냄(줄이 사라짐) 거절','authenticated',a,format(sr,'[{"branch_id":"B004","confirmed":true,"expect_at":"'||old||'"}]'),'err:SA007');
  perform pg_temp.yes('줄이 안 생김', not exists (select 1 from public.round_requests where round_id=rid and branch_id='B004'));
  perform pg_temp.chk('관리자: 빈 줄을 보고 확정(빈 줄 그대로)','authenticated',a,format(sr,'[{"branch_id":"B004","confirmed":true,"expect_at":null}]'),'ok:1');
  perform pg_temp.yes('빈 줄이 확정으로 생김', (select confirmed and saved_at is null from public.round_requests where round_id=rid and branch_id='B004'));

  -- 묶음: 한 줄이라도 바뀌었으면 전부 취소
  perform pg_temp.chk('관리자: 묶음에 저장','authenticated',a,format(sr,'[{"branch_id":"B002","req_truck":1}]'),'ok:1');
  select to_json(updated_at)::text into at from public.round_requests where round_id=rid and branch_id='B002';
  perform pg_temp.chk('일괄 확정: 한 줄이 바뀌었으면 거절','authenticated',a,format(sr,'[{"branch_id":"B002","confirmed":true,"expect_at":'||at||'},{"branch_id":"B001","confirmed":true,"expect_at":"'||old||'"}]'),'err:SA007');
  perform pg_temp.yes('일괄 확정이 거절되면 앞줄도 확정 안 됨', (select not confirmed from public.round_requests where round_id=rid and branch_id='B002'));

  -- 권한은 그대로
  perform pg_temp.chk('지사: 남의 지사 저장 거절','authenticated',b,format(sr,'[{"branch_id":"B002","req_truck":5}]'),'err:42501');
  perform pg_temp.chk('지사: 시각을 보내도 확정 거절','authenticated',b,format(sr,'[{"branch_id":"B001","confirmed":true,"expect_at":'||to_json((select updated_at from public.round_requests where round_id=rid and branch_id='B001'))::text||'}]'),'err:42501');
  perform pg_temp.yes('지사가 남의 줄에 시각을 보내도 안 바뀜', pg_temp.run_as('authenticated',b,format(sr,'[{"branch_id":"B002","req_truck":5,"expect_at":'||at||'}]')) like 'err:%' and (select req_truck=1 from public.round_requests where round_id=rid and branch_id='B002'));

  -- ② 첫 저장 충돌: 줄이 없는 줄 알고 추가하다 23505 → 다시 돌아가 그 줄을 수정
  insert into public.round_requests (round_id, branch_id, req_truck) values (rid, 'B005', 7), (rid, 'B006', 7);
  perform setval('public._t_seq', 1, false);
  perform pg_temp.chk('첫 저장 충돌: 오류 없이 저장','authenticated',a,format(sr,'[{"branch_id":"B005","req_blower":3}]'),'ok:1');
  perform pg_temp.yes('먼저 만든 값은 유지, 내 값만 더해짐', (select req_truck=7 and req_blower=3 and saved_lv='admin' from public.round_requests where round_id=rid and branch_id='B005'));
  perform setval('public._t_seq', 1, false);
  perform pg_temp.chk('첫 저장 충돌 + 확정: 못 본 값이라 거절','authenticated',a,format(sr,'[{"branch_id":"B006","confirmed":true,"expect_at":null}]'),'err:SA007');
  perform pg_temp.yes('충돌한 줄은 확정 안 됨', (select not confirmed and req_truck=7 from public.round_requests where round_id=rid and branch_id='B006'));

  select count(*), count(*) filter (where not ok) into c, f from _t;
  raise exception E'확정 시각 확인·첫 저장 충돌 시험 — 전체 %, 실패 %\n%', c, f, coalesce((select string_agg('FAIL ' || name || ' → ' || got || ' / ' || want, E'\n' order by n) from _t where not ok), '(모두 통과)');
end $t$;
