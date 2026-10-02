-- 외래키 열에 색인 추가 (성능 점검 결과 반영). "사용 안 된 색인" 안내는 아직 자료가 없어서 나온 것이라 무시.
create index if not exists cell_zone_zone_idx      on public.cell_zone(zone_code);
create index if not exists round_vehicles_plate_idx on public.round_vehicles(plate);
create index if not exists snow_daily_station_idx  on public.snow_daily(station_id, date);
create index if not exists vehicles_org_idx        on public.vehicles(org);
