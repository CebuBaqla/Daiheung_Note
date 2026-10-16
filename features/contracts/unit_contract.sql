-- 단가계약: 기존 현장/계약내역/작업계획/작업종료 흐름을 확장합니다.
-- 기존 V6, contracts_edit.sql, contracts_review.sql, permit_material_ready.sql 설치 후 실행합니다.
-- 운영 DB에 적용하기 전 백업과 검토가 필요합니다. 이 파일은 자동 실행되지 않습니다.
begin;

alter table fieldnote_v6.site
  add column if not exists contract_type text not null default 'standard';
alter table fieldnote_v6.site
  drop constraint if exists site_contract_type_check;
alter table fieldnote_v6.site
  add constraint site_contract_type_check check (contract_type in ('standard','unit_price'));

alter table fieldnote_v6.contract_item
  drop constraint if exists contract_item_target_quantity_check;
alter table fieldnote_v6.contract_item
  add constraint contract_item_target_quantity_check
  check (target_quantity >= 0 and target_quantity <> 'NaN'::numeric);

alter table fieldnote_v6.permit_task
  add column if not exists order_memo text not null default '';
alter table fieldnote_v6.permit_task
  drop constraint if exists permit_task_order_memo_check;
alter table fieldnote_v6.permit_task
  add constraint permit_task_order_memo_check check (char_length(order_memo) <= 2000);

create index if not exists permit_unpublished_work_date_idx
  on fieldnote_v6.permit(work_date, id) where published_at is null;
create index if not exists work_report_submitted_site_date_idx
  on fieldnote_v6.work_report(site_id, work_date) where submitted_at is not null;

create table if not exists fieldnote_v6.unit_contract_import (
  id uuid primary key,
  site_id uuid not null references fieldnote_v6.site(id),
  actor_id uuid not null references fieldnote_v6.employee(id),
  items_snapshot jsonb not null,
  created_at timestamptz not null default now()
);
alter table fieldnote_v6.unit_contract_import enable row level security;
revoke all on fieldnote_v6.unit_contract_import from public,anon,authenticated;

create or replace function public.dh_save_sales_site_with_type(p_data jsonb)
returns uuid language plpgsql security definer set search_path='' as $$
declare
  actor uuid := dh_private.require_actor(array['owner','manager']);
  kind text := coalesce(nullif(p_data->>'contract_type',''),'standard');
  saved_id uuid;
begin
  if kind not in ('standard','unit_price') then raise exception '계약 유형을 확인하세요'; end if;
  saved_id := public.dh_save_sales_site(p_data - 'contract_type');
  update fieldnote_v6.site set contract_type=kind where id=saved_id;
  return saved_id;
end $$;

-- 일반 공사의 기존 dh_import_contract는 그대로 사용합니다.
create or replace function public.dh_import_unit_contract(p_site uuid, p_items jsonb)
returns uuid language plpgsql security definer set search_path='' as $$
declare
  actor uuid := dh_private.require_actor(array['owner','manager']);
  item jsonb;
  result uuid := gen_random_uuid();
  codes text[] := '{}'::text[];
  code text;
  old_unit text;
begin
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items)=0 then
    raise exception '내역 항목이 필요합니다';
  end if;
  perform 1 from fieldnote_v6.site where id=p_site and contract_type='unit_price' for update;
  if not found then raise exception '단가계약 현장을 찾을 수 없습니다'; end if;
  for item in select value from jsonb_array_elements(p_items) loop
    code := btrim(item->>'code');
    if nullif(code,'') is null or code=any(codes)
      or nullif(btrim(item->>'name'),'') is null
      or nullif(btrim(item->>'unit'),'') is null
      or (item->>'target')::numeric is distinct from 0
      or coalesce((item->>'weight')::numeric,1)<=0 then
      raise exception '내역 코드, 명칭, 단위 또는 수량 0을 확인하세요';
    end if;
    codes := array_append(codes,code);
    select unit into old_unit from fieldnote_v6.contract_item
      where site_id=p_site and item_code=code;
    if old_unit is distinct from item->>'unit' and exists (
      select 1 from fieldnote_v6.permit_task t
      join fieldnote_v6.contract_item c on c.id=t.contract_item_id
      where c.site_id=p_site and c.item_code=code
    ) then raise exception '작업 이력이 연결된 내역의 단위는 바꿀 수 없습니다: %',code;
    end if;
    insert into fieldnote_v6.contract_item(site_id,item_code,name,unit,target_quantity,weight,active)
      values(p_site,code,btrim(item->>'name'),btrim(item->>'unit'),0,
             coalesce((item->>'weight')::numeric,1),true)
    on conflict(site_id,item_code) do update
      set name=excluded.name,unit=excluded.unit,target_quantity=0,
          weight=excluded.weight,active=true;
  end loop;
  update fieldnote_v6.contract_item set active=false
    where site_id=p_site and not(item_code=any(codes));
  insert into fieldnote_v6.unit_contract_import(id,site_id,actor_id,items_snapshot)
    values(result,p_site,actor,p_items);
  return result;
end $$;

-- 기존 관리자 스냅샷의 고정 필드 구성과 무관하게 새 필드를 전달합니다.
create or replace function public.dh_admin_unit_context(p_from date,p_to date)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare actor uuid := dh_private.require_actor(array['owner','manager']);
begin
  if p_from is null or p_to is null or p_to<p_from or p_to-p_from>400 then
    raise exception '조회 기간이 올바르지 않습니다';
  end if;
  return jsonb_build_object(
    'sites',coalesce((select jsonb_agg(jsonb_build_object('id',id,'contract_type',contract_type))
      from fieldnote_v6.site),'[]'::jsonb),
    'task_memos',coalesce((select jsonb_agg(jsonb_build_object('id',t.id,'order_memo',t.order_memo))
      from fieldnote_v6.permit_task t join fieldnote_v6.permit p on p.id=t.permit_id
      where p.work_date between p_from and p_to),'[]'::jsonb)
  );
end $$;

create or replace function public.dh_admin_edit_unit_contract_item(
  p_item uuid, p_unit text, p_note text
) returns void language plpgsql security definer set search_path='' as $$
declare
  actor uuid := dh_private.require_actor(array['owner','manager']);
  current_item fieldnote_v6.contract_item;
  clean_unit text := nullif(btrim(p_unit),'');
begin
  select c.* into current_item from fieldnote_v6.contract_item c
    join fieldnote_v6.site s on s.id=c.site_id
    where c.id=p_item and c.active and s.contract_type='unit_price' for update of c;
  if not found then raise exception '단가계약 내역을 찾을 수 없습니다'; end if;
  if clean_unit is null then raise exception '단위를 확인하세요'; end if;
  if current_item.unit is distinct from clean_unit and exists (
    select 1 from fieldnote_v6.permit_task where contract_item_id=p_item
  ) then raise exception '작업계획서에 연결된 항목의 단위는 바꿀 수 없습니다'; end if;
  update fieldnote_v6.contract_item set target_quantity=0,unit=clean_unit where id=p_item;
  insert into fieldnote_v6.contract_review_item(contract_item_id,note)
    values(p_item,coalesce(p_note,''))
    on conflict(contract_item_id) do update set note=excluded.note,updated_at=now();
end $$;

-- 계획서 저장 및 자재별 발주 메모를 한 트랜잭션에서 처리합니다.
create or replace function public.dh_save_permit_with_memo(p_data jsonb)
returns uuid language plpgsql security definer set search_path='' as $$
declare
  actor uuid := dh_private.require_actor(array['owner','manager']);
  saved_id uuid;
  item jsonb;
  ord integer := 0;
  unit_contract boolean;
begin
  select contract_type='unit_price' into unit_contract from fieldnote_v6.site
    where id=(p_data->>'site_id')::uuid;
  if unit_contract is null then raise exception '현장을 찾을 수 없습니다'; end if;
  if jsonb_typeof(p_data->'tasks') is distinct from 'array' then
    raise exception '작업 항목을 확인하세요';
  end if;
  for item in select value from jsonb_array_elements(p_data->'tasks') loop
    if unit_contract and nullif(item->>'contract_item_id','') is null then
      raise exception '단가계약은 모든 작업 항목에서 계약 자재를 선택해야 합니다';
    end if;
    if char_length(coalesce(item->>'order_memo',''))>2000 then
      raise exception '발주 메모는 2000자 이내로 입력하세요';
    end if;
  end loop;
  saved_id := public.dh_save_permit_ready(p_data);
  for item in select value from jsonb_array_elements(p_data->'tasks') loop
    ord := ord+1;
    update fieldnote_v6.permit_task
      set order_memo=coalesce(item->>'order_memo','')
      where permit_id=saved_id and sort_order=ord;
    if not found then raise exception '작업 항목 발주 메모를 저장하지 못했습니다'; end if;
  end loop;
  return saved_id;
end $$;

-- 달력 조회 기간 밖의 초안/결재 대기/반려도 모두 반환합니다.
create or replace function public.dh_admin_unpublished_permits()
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare actor uuid := dh_private.require_actor(array['owner','manager']);
begin
  return coalesce((select jsonb_agg(to_jsonb(p)||jsonb_build_object(
    'tasks',coalesce((select jsonb_agg(to_jsonb(t) order by t.sort_order)
      from fieldnote_v6.permit_task t where t.permit_id=p.id),'[]'::jsonb),
    'workers',coalesce((select jsonb_agg(to_jsonb(w))
      from fieldnote_v6.permit_worker w where w.permit_id=p.id),'[]'::jsonb),
    'equipment',coalesce((select jsonb_agg(to_jsonb(e))
      from fieldnote_v6.permit_equipment e where e.permit_id=p.id),'[]'::jsonb),
    'drawings',coalesce((select jsonb_agg(to_jsonb(d))
      from fieldnote_v6.permit_drawing d where d.permit_id=p.id),'[]'::jsonb),
    'approval',(select to_jsonb(a) from fieldnote_v6.permit_approval a where a.permit_id=p.id)
  ) order by p.work_date,p.created_at) from fieldnote_v6.permit p
  where p.published_at is null),'[]'::jsonb);
end $$;

-- 청구용 실적: 선택 기간의 제출 완료 보고만, 단가계약 현장별로 조회합니다.
create or replace function public.dh_unit_contract_work_log(
  p_site uuid, p_from date, p_to date
) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare actor uuid := dh_private.require_actor(array['owner','manager']);
begin
  if p_from is null or p_to is null or p_to<p_from then
    raise exception '조회 기간이 올바르지 않습니다';
  end if;
  perform 1 from fieldnote_v6.site where id=p_site and contract_type='unit_price';
  if not found then raise exception '단가계약 현장을 찾을 수 없습니다'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
    'work_date',r.work_date,'site_name',p.site_name_snapshot,
    'permit_id',p.id,'report_id',r.id,'contract_item_id',c.id,
    'item_code',c.item_code,'name',t.name,'unit',t.unit,
    'planned_quantity',t.target_quantity,
    'actual_quantity',coalesce(to_jsonb(a)->>'actual_quantity',to_jsonb(a)->>'actual')::numeric,
    'order_memo',t.order_memo,'location',p.location_description,
    'submitted_at',r.submitted_at
  ) order by r.work_date,p.created_at,t.sort_order)
    from fieldnote_v6.work_report r
    join fieldnote_v6.permit p on p.id=r.permit_id
    join fieldnote_v6.report_task a on a.report_id=r.id
    join fieldnote_v6.permit_task t on t.id::text=
      coalesce(to_jsonb(a)->>'task_id',to_jsonb(a)->>'permit_task_id') and t.permit_id=p.id
    join fieldnote_v6.contract_item c on c.id=t.contract_item_id and c.site_id=p_site
    where r.site_id=p_site and r.submitted_at is not null
      and r.work_date between p_from and p_to),'[]'::jsonb);
end $$;

-- 기존 모바일 조회 권한 범위를 유지하면서 계획서별 발주 메모를 전달합니다.
create or replace function public.dh_contract_task_notes(p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare
  actor uuid := dh_private.require_actor();
  allowed jsonb;
begin
  allowed := public.dh_worker_snapshot(p_from,p_to);
  return coalesce((select jsonb_agg(jsonb_build_object(
    'task_id',t.id,'note',coalesce(r.note,''),
    'group_label',coalesce(r.group_label,''),'order_memo',t.order_memo
  )) from fieldnote_v6.permit_task t
  left join fieldnote_v6.contract_review_item r on r.contract_item_id=t.contract_item_id
  where t.permit_id in (select (p->>'id')::uuid
    from jsonb_array_elements(coalesce(allowed->'permits','[]'::jsonb)) p)),'[]'::jsonb);
end $$;

revoke all on function public.dh_save_sales_site_with_type(jsonb),
  public.dh_import_unit_contract(uuid,jsonb),
  public.dh_admin_edit_unit_contract_item(uuid,text,text),
  public.dh_save_permit_with_memo(jsonb),
  public.dh_admin_unit_context(date,date),
  public.dh_admin_unpublished_permits(),
  public.dh_unit_contract_work_log(uuid,date,date),
  public.dh_contract_task_notes(date,date) from public,anon;
grant execute on function public.dh_save_sales_site_with_type(jsonb),
  public.dh_import_unit_contract(uuid,jsonb),
  public.dh_admin_edit_unit_contract_item(uuid,text,text),
  public.dh_save_permit_with_memo(jsonb),
  public.dh_admin_unit_context(date,date),
  public.dh_admin_unpublished_permits(),
  public.dh_unit_contract_work_log(uuid,date,date),
  public.dh_contract_task_notes(date,date) to authenticated;
notify pgrst,'reload schema';
commit;
