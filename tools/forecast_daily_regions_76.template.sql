-- 검토용76: 일별예보의 대표 읍면동/중기 구역 연결. 운영 미적용.
-- 기존 예보값·함수·수집 일정은 변경하지 않는다. API 호출도 추가하지 않는다.
-- 공식5km 행정 경계표가 아니다. 기존 시군구 지명을 우선하고 새 칸은
-- 격자 중심에서 가장 가까운 공식 읍면동을 대표로 선택(40km 초과는 미연결)한다.
begin;

create table private.forecast_daily_places (
  code text primary key check(code ~ '^[0-9]{10}$'),
  city_code text not null check(city_code ~ '^[0-9]{10}$'),
  label text not null check(length(label) between 1 and 160),
  lat double precision not null check(lat between 30 and 44),
  lon double precision not null check(lon between 122 and 133),
  land_id text not null check(land_id ~ '^[0-9A-Z]{8}$'),
  temp_id text not null check(temp_id ~ '^[0-9A-Z]{8}$'),
  unique(code,city_code)
);
create index forecast_daily_places_city_idx on private.forecast_daily_places(city_code);
create table private.forecast_daily_region_hints (
  nx integer not null check(nx between 1 and 149),
  ny integer not null check(ny between 1 and 253),
  city_code text not null check(city_code ~ '^[0-9]{10}$'),
  dong_code text,
  primary key(nx,ny),
  foreign key(dong_code,city_code) references private.forecast_daily_places(code,city_code)
);
alter table private.forecast_daily_places enable row level security;
alter table private.forecast_daily_region_hints enable row level security;
revoke all on private.forecast_daily_places,private.forecast_daily_region_hints
  from public,anon,authenticated,service_role;

-- 공개 기상청 좌표와 기존 격자 지명만 포함. 키/계정/업무자료 없음.
--__PLACES__
--__HINTS__

do $$ begin
  if exists(select 1 from private.forecast_daily_region_hints h
    where not exists(select 1 from private.forecast_daily_places p where p.city_code=h.city_code)) then
    raise exception 'unresolved hint city';
  end if;
  if exists(select 1 from private.forecast_daily_places p where
    not exists(select 1 from private.forecast_midterm_cache c,
      lateral jsonb_array_elements(c.payload) r
      where c.kind='regions' and r->>'type'='C' and r->>'reg_id'=p.temp_id)
    or not exists(select 1 from private.forecast_midterm_cache c,
      lateral jsonb_array_elements(c.payload) r
      where c.kind='regions' and r->>'type'='A' and r->>'reg_id'=p.land_id)) then
    raise exception 'region catalog mismatch';
  end if;
end $$;

-- grid/core.js 및 tools/build_grid_names.py와 같은 기상청 LCC 역변환.
create function private.fc_daily_lonlat(p_nx integer,p_ny integer)
returns table(lat double precision,lon double precision)
language plpgsql immutable strict set search_path='' as $$
declare
  d double precision:=pi()/180.0; re double precision:=6371.00877/5.0;
  s1 double precision:=30*d; s2 double precision:=60*d; olat double precision:=38*d;
  sn double precision; sf double precision; ro double precision;
  xn double precision; yn double precision; ra double precision;
begin
  if p_nx not between 1 and 149 or p_ny not between 1 and 253 then
    raise exception 'bad cell' using errcode='22023';
  end if;
  sn:=ln(cos(s1)/cos(s2))/ln(tan(pi()/4+s2/2)/tan(pi()/4+s1/2));
  sf:=power(tan(pi()/4+s1/2),sn)*cos(s1)/sn;
  ro:=re*sf/power(tan(pi()/4+olat/2),sn);
  xn:=p_nx-43; yn:=ro-(p_ny-136); ra:=sqrt(xn*xn+yn*yn);
  lat:=(2*atan(power(re*sf/ra,1/sn))-pi()/2)/d;
  lon:=126+atan2(xn,yn)/sn/d;
  return next;
end $$;

create function private.fc_daily_region(p_nx integer,p_ny integer)
returns jsonb language sql stable set search_path='' as $$
  with ll as materialized(select * from private.fc_daily_lonlat(p_nx,p_ny)),
  hint as materialized(select * from private.forecast_daily_region_hints where nx=p_nx and ny=p_ny),
  selected as (
    select p.*,sqrt(power((p.lat-ll.lat)*111,2)+
      power((p.lon-ll.lon)*111*cos(radians(ll.lat)),2)) km
    from private.forecast_daily_places p cross join ll
    where not exists(select 1 from hint)
      or exists(select 1 from hint h where h.city_code=p.city_code
        and(h.dong_code is null or h.dong_code=p.code))
    order by km,p.code limit 1)
  select coalesce((select jsonb_build_object('status','ok','land_id',p.land_id,
    'temp_id',p.temp_id,'dong_code',p.code,'label',p.label,
    'distance_km',round(p.km::numeric,2),
    'method',case when exists(select 1 from hint) then 'named_place' else 'nearest_town' end)
    from selected p where p.km<=40),jsonb_build_object('status','unmapped'))
$$;

-- 다른 예보와 같은 로그인/현재 유효 격자 검사. 전체 전국 목록은 브라우저로 보내지 않는다.
create function public.forecast_daily_region(p_nx integer,p_ny integer)
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  if (select private.my_role()) is null then
    raise exception 'login required' using errcode='42501';
  end if;
  if p_nx is null or p_ny is null or p_nx not between 1 and 149 or p_ny not between 1 and 253
    or not exists(select 1 from private.grid_effective() g where g.nx=p_nx and g.ny=p_ny) then
    raise exception 'bad cell' using errcode='22023';
  end if;
  return private.fc_daily_region(p_nx,p_ny)||jsonb_build_object('nx',p_nx,'ny',p_ny);
end $$;
revoke all on function private.fc_daily_lonlat(integer,integer),
  private.fc_daily_region(integer,integer),public.forecast_daily_region(integer,integer)
  from public,anon,authenticated,service_role;
grant execute on function public.forecast_daily_region(integer,integer) to authenticated;
commit;
