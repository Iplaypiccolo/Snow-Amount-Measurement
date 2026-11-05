-- 69 적용 후 조회/권한/기존자료 불변 시험. 마지막 오류로 시험계정과 변경 전체를 취소.
begin isolation level repeatable read;

create temp table _69_before on commit drop as
select
 (select md5(string_agg(to_jsonb(r)::text,'' order by to_jsonb(r)::text)) from public.round_requests r where r.confirmed) frozen_hash,
 (select md5(string_agg(to_jsonb(c)::text,'' order by c.ny,c.nx)) from public.forecast_cells c) cache_hash,
 (select md5(string_agg(to_jsonb(h)::text,'' order by h.tmef)) from private.fc_hours(
   (select max(tmfc) from public.forecast_runs),
   (select (detail->>'end_at')::timestamptz from public.branch_forecast order by issued_at desc limit 1),
   (select max(end_at) from public.forecast_runs),true) h) hours_hash;

do $prepare$
declare u uuid:=gen_random_uuid(); target jsonb;
begin
 select jsonb_build_object('nx',g.nx,'ny',g.ny) into target
  from private.grid_effective() g join public.forecast_cells c using(nx,ny)
  where c.issued_at>=now()-interval '12 hours' and jsonb_array_length(c.series->'s')=24
  order by g.ny,g.nx limit 1;
 if target is null then raise exception 'no fresh sample available'; end if;
 insert into auth.users(id,aud,role,email) values(u,'authenticated','authenticated','t69@t.test');
 insert into public.profiles(id,username,display_name,role,perms,must_change)
 values(u,'t69-adm','69조회시험','admin','{}',false);
 perform set_config('request.jwt.claims',jsonb_build_object('sub',u,'role','authenticated')::text,true);
 perform set_config('tail69.target',target::text,true);
end $prepare$;
set local role authenticated;
set local statement_timeout='8s';
select set_config('tail69.started',clock_timestamp()::text,true);
select set_config('tail69.result',public.forecast_cell_tail(
 (current_setting('tail69.target')::jsonb->>'nx')::int,
 (current_setting('tail69.target')::jsonb->>'ny')::int)::text,true);
select set_config('tail69.elapsed_ms',(extract(epoch from(clock_timestamp()-current_setting('tail69.started')::timestamptz))*1000)::text,true);
reset role;
set local statement_timeout='45s';

do $test$
declare x jsonb:=current_setting('tail69.result')::jsonb; u jsonb; b jsonb; h text; f text; z text;
begin
 if x->>'status'<>'ok' then raise exception 'RPC not ready: %',x->>'status'; end if;
 select series into u from public.forecast_cells where nx=(x->>'nx')::int and ny=(x->>'ny')::int;
 if x->'upper'->'series' is distinct from u then raise exception 'upper cache changed'; end if;
 if (current_setting('tail69.elapsed_ms'))::numeric>=8000 then raise exception 'RPC exceeds8seconds'; end if;
 if octet_length(x::text)>20000 then raise exception 'RPC exceeds review20KB target'; end if;
 if jsonb_typeof(x->'tail'->'bins')<>'array' then raise exception 'bad bins'; end if;
 for b in select value from jsonb_array_elements(x->'tail'->'bins') loop
  if (b->>'first_at')::timestamptz < (x->'upper'->>'end_at')::timestamptz or
     (b->>'last_at')::timestamptz < (b->>'first_at')::timestamptz or
     (b->>'hours')::int not between 1 and 3 then raise exception 'bad range'; end if;
  if (b->>'code_hours')::int>0 and (b->'snow'<>'null'::jsonb or b->'pcp'<>'null'::jsonb) then raise exception 'code added as amount'; end if;
 end loop;
 select md5(string_agg(to_jsonb(r)::text,'' order by to_jsonb(r)::text)) into h from public.round_requests r where r.confirmed;
 select md5(string_agg(to_jsonb(c)::text,'' order by c.ny,c.nx)) into f from public.forecast_cells c;
 select md5(string_agg(to_jsonb(a)::text,'' order by a.tmef)) into z from private.fc_hours(
   (select max(tmfc) from public.forecast_runs),
   (select (detail->>'end_at')::timestamptz from public.branch_forecast order by issued_at desc limit 1),
   (select max(end_at) from public.forecast_runs),true) a;
 if h is distinct from(select frozen_hash from _69_before) or f is distinct from(select cache_hash from _69_before)
    or z is distinct from(select hours_hash from _69_before) then raise exception 'existing data/selection changed'; end if;
 if has_function_privilege('anon','public.forecast_cell_tail(int,int)','execute') or
    has_function_privilege('authenticated','private.fc_hours(timestamptz,timestamptz,timestamptz,boolean,int,int)','execute') then raise exception 'bad RPC privileges'; end if;
 raise exception '69_TEST_PASSED_ROLLED_BACK elapsed_ms=% body_bytes=% bins=%',current_setting('tail69.elapsed_ms'),octet_length(x::text),jsonb_array_length(x->'tail'->'bins');
end $test$;
