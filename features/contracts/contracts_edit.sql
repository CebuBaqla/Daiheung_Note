-- 계약 내역 수정·삭제. 작업허가서가 참조하는 항목은 기록 보존을 위해 비활성화합니다.
begin;

create or replace function public.dh_admin_edit_contract_item(
  p_item uuid, p_target numeric, p_unit text
) returns void
language plpgsql security definer set search_path='' as $$
declare
  actor uuid := dh_private.require_actor(array['owner','manager']);
  current_item fieldnote_v6.contract_item;
  clean_unit text := nullif(btrim(p_unit),'');
begin
  select * into current_item from fieldnote_v6.contract_item where id=p_item for update;
  if not found then raise exception '내역 항목을 찾을 수 없습니다'; end if;
  if not current_item.active then raise exception '제외된 내역은 수정할 수 없습니다'; end if;
  if p_target is null or p_target<=0 or p_target='NaN'::numeric or clean_unit is null then
    raise exception '물량과 단위를 확인하세요';
  end if;
  if current_item.unit is distinct from clean_unit and exists(
    select 1 from fieldnote_v6.permit_task where contract_item_id=p_item
  ) then raise exception '작업허가서에 연결된 항목의 단위는 바꿀 수 없습니다'; end if;
  update fieldnote_v6.contract_item
  set target_quantity=p_target,unit=clean_unit
  where id=p_item;
end $$;

create or replace function public.dh_admin_delete_contract_item(p_item uuid) returns text
language plpgsql security definer set search_path='' as $$
declare
  actor uuid := dh_private.require_actor(array['owner','manager']);
  current_item fieldnote_v6.contract_item;
begin
  select * into current_item from fieldnote_v6.contract_item where id=p_item for update;
  if not found then raise exception '내역 항목을 찾을 수 없습니다'; end if;
  if exists(select 1 from fieldnote_v6.permit_task where contract_item_id=p_item) then
    update fieldnote_v6.contract_item set active=false where id=p_item;
    return 'archived';
  end if;
  delete from fieldnote_v6.contract_item where id=p_item;
  return 'deleted';
end $$;

create or replace function public.dh_admin_clear_contract_items(p_site uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  actor uuid := dh_private.require_actor(array['owner','manager']);
  deleted_count integer := 0;
  archived_count integer := 0;
begin
  perform 1 from fieldnote_v6.site where id=p_site for update;
  if not found then raise exception '현장을 찾을 수 없습니다'; end if;
  update fieldnote_v6.contract_item c set active=false
  where c.site_id=p_site and c.active and exists(
    select 1 from fieldnote_v6.permit_task t where t.contract_item_id=c.id
  );
  get diagnostics archived_count=row_count;
  delete from fieldnote_v6.contract_item c
  where c.site_id=p_site and not exists(
    select 1 from fieldnote_v6.permit_task t where t.contract_item_id=c.id
  );
  get diagnostics deleted_count=row_count;
  return jsonb_build_object('deleted',deleted_count,'archived',archived_count);
end $$;

revoke all on function public.dh_admin_edit_contract_item(uuid,numeric,text),
  public.dh_admin_delete_contract_item(uuid),
  public.dh_admin_clear_contract_items(uuid) from public,anon;
grant execute on function public.dh_admin_edit_contract_item(uuid,numeric,text),
  public.dh_admin_delete_contract_item(uuid),
  public.dh_admin_clear_contract_items(uuid) to authenticated;
notify pgrst,'reload schema';
commit;
