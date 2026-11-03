-- ============================================================
-- 기준일자 기간 10일(마이그레이션 59) 시험 — SQL Editor 에 통째로 붙여넣고 실행(59 적용 뒤)
-- 마지막에 일부러 오류를 내서 시험 자료를 전부 되돌립니다. "문제: (없음, 모두 통과)" 여야 합니다.
-- ============================================================
do $t$
declare a uuid := gen_random_uuid(); rid bigint; res jsonb; last_id bigint; d date; rows int; bad text := '';
begin
  insert into auth.users (id, aud, role, email) values (a,'authenticated','authenticated','rt@t.test');
  insert into public.profiles (id,username,display_name,role,perms,must_change) values (a,'rt-adm','관리자','admin','{}',false);
  select count(*) into rows from public.support_rounds where days = 10;
  if rows <> (select count(*) from public.support_rounds) then bad := bad || ' 기존 기준일자가 10일이 아님;'; end if;
  select id into last_id from public.support_rounds order by start_date desc limit 1;
  d := (select start_date from public.support_rounds where id = last_id);
  if private.governing_round(d + 9) is distinct from last_id then bad := bad || ' 10일째를 맡지 않음;'; end if;
  if private.governing_round(d + 10) is not null then bad := bad || ' 11일째는 어느 기준일자에도 없어야 함;'; end if;
  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);
  set local role authenticated; res := public.create_round(date '2099-12-01'); reset role;
  if (res ->> 'days')::int <> 10 then bad := bad || ' 새 기준일자 기본값이 10일이 아님;'; end if;
  rid := (res ->> 'id')::bigint;
  if (select days from public.support_rounds where id = rid) <> 10 then bad := bad || ' 저장된 값 10 아님;'; end if;
  if private.governing_round(date '2099-12-10') is distinct from rid or private.governing_round(date '2099-12-11') is not null then bad := bad || ' 새 기준일자 기간 다름;'; end if;
  -- 겹치면 시작일이 늦은 쪽
  set local role authenticated; res := public.create_round(date '2099-12-05'); reset role;
  if private.governing_round(date '2099-12-07') is distinct from (res ->> 'id')::bigint then bad := bad || ' 겹치면 늦은 쪽이 맡아야 함;'; end if;
  if private.governing_round(date '2099-12-04') is distinct from rid then bad := bad || ' 앞 날짜는 앞 기준일자;'; end if;
  -- 범위 밖 거절은 그대로
  begin set local role authenticated; perform public.create_round(date '2099-12-30', 11); reset role; bad := bad || ' 11일 허용됨;'; exception when others then reset role; if sqlstate <> '22023' then bad := bad || ' 11일 오류 코드 ' || sqlstate || ';'; end if; end;
  perform set_config('request.jwt.claims', '', true);
  begin set local role anon; perform public.create_round(date '2099-12-31'); reset role; bad := bad || ' 비로그인 허용됨;'; exception when others then reset role; end;
  raise exception '기준일자 10일 시험 — 문제: %', coalesce(nullif(bad, ''), '(없음, 모두 통과)');
end $t$;
