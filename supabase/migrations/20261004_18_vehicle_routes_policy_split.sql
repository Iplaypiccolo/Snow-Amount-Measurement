-- vehicle_routes: "for all" 쓰기 정책이 읽기에도 겹쳐 붙어(성능 경고) 추가·수정·삭제로 나눔. 규칙 내용은 같음
drop policy if exists vehicle_routes_write on public.vehicle_routes;
create policy vehicle_routes_ins on public.vehicle_routes for insert to authenticated
  with check ((select private.has_perm('equip.edit.all')) or ((select private.has_perm('equip.edit.own')) and exists (select 1 from public.vehicles v where v.id = vehicle_id and v.org = (select private.my_org()))));
create policy vehicle_routes_upd on public.vehicle_routes for update to authenticated
  using ((select private.has_perm('equip.edit.all')) or ((select private.has_perm('equip.edit.own')) and exists (select 1 from public.vehicles v where v.id = vehicle_id and v.org = (select private.my_org()))))
  with check ((select private.has_perm('equip.edit.all')) or ((select private.has_perm('equip.edit.own')) and exists (select 1 from public.vehicles v where v.id = vehicle_id and v.org = (select private.my_org()))));
create policy vehicle_routes_del on public.vehicle_routes for delete to authenticated
  using ((select private.has_perm('equip.edit.all')) or ((select private.has_perm('equip.edit.own')) and exists (select 1 from public.vehicles v where v.id = vehicle_id and v.org = (select private.my_org()))));
