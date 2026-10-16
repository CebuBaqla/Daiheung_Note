-- Supabase SQL Editor에서 전체 내용을 한 번 실행합니다.
-- 기존 계약내역·작업허가서 데이터는 삭제하지 않습니다.

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


-- 계약내역 검토 v1. 기존 V6 + contracts_edit.sql 다음에 실행합니다.
-- 기존 가져오기/수정 함수를 호출하여 기존 물량·허가서 제약을 그대로 사용합니다.
begin;
do $$ begin
 if to_regprocedure('public.dh_import_contract(uuid,jsonb)') is null
 or to_regprocedure('public.dh_admin_edit_contract_item(uuid,numeric,text)') is null then
  raise exception 'V6 계약 가져오기와 contracts_edit.sql을 먼저 설치하세요';
 end if;
end $$;

create table if not exists fieldnote_v6.contract_review_import (
 id uuid primary key,
 site_id uuid not null references fieldnote_v6.site(id),
 actor_id uuid not null references fieldnote_v6.employee(id),
 document jsonb not null,
 created_at timestamptz not null default now()
);
create index if not exists contract_review_import_site_idx on fieldnote_v6.contract_review_import(site_id,created_at desc);
create table if not exists fieldnote_v6.contract_review_item (
 contract_item_id uuid primary key references fieldnote_v6.contract_item(id) on delete cascade,
 import_id uuid references fieldnote_v6.contract_review_import(id),
 source_row_id text,
 group_label text not null default '',
 note text not null default '',
 original jsonb,
 source jsonb,
 updated_at timestamptz not null default now()
);
alter table fieldnote_v6.contract_review_import enable row level security;
alter table fieldnote_v6.contract_review_item enable row level security;
revoke all on fieldnote_v6.contract_review_import,fieldnote_v6.contract_review_item from public,anon,authenticated;

create or replace function public.dh_import_contract_reviewed(p_site uuid,p_request uuid,p_document jsonb)
returns uuid language plpgsql security definer set search_path='' as $$
declare
 actor uuid:=dh_private.require_actor(array['owner','manager']);
 previous fieldnote_v6.contract_review_import;
 row_data jsonb; item_id uuid; chosen jsonb:='[]'::jsonb; chosen_count integer:=0;
 quantity numeric; item_weight numeric; group_name text;
 codes text[]:='{}'::text[]; ids text[]:='{}'::text[]; version_name text;
begin
 if p_request is null or p_site is null then raise exception '현장과 등록 요청이 필요합니다'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_request::text,0));
 select * into previous from fieldnote_v6.contract_review_import where id=p_request;
 if found then
  if previous.site_id<>p_site or previous.actor_id<>actor or previous.document is distinct from p_document then
   raise exception '같은 요청의 내용을 변경할 수 없습니다';
  end if;
  return p_request;
 end if;
 perform 1 from fieldnote_v6.site where id=p_site for update;
 if not found then raise exception '현장을 찾을 수 없습니다'; end if;
 if p_document is null or p_document->>'format' is distinct from 'dh-contract-review/1'
 or jsonb_typeof(p_document->'items') is distinct from 'array'
 or jsonb_typeof(p_document->'groups') is distinct from 'array'
 or jsonb_typeof(p_document->'rawRows') is distinct from 'array' then
  raise exception '원본·검토 내역 형식이 올바르지 않습니다';
 end if;
 if jsonb_array_length(p_document->'items')>20000 or octet_length(p_document::text)>25000000 then
  raise exception '내역을 20,000행·25MB 이내로 나누어 주세요';
 end if;
 for row_data in select value from jsonb_array_elements(p_document->'items') loop
  if nullif(btrim(row_data->>'id'),'') is null or (row_data->>'id')=any(ids) then raise exception '행 식별자가 없거나 중복됩니다'; end if;
  ids:=array_append(ids,row_data->>'id');
  if row_data->'selected' is distinct from 'true'::jsonb then continue; end if;
  if nullif(btrim(row_data->>'code'),'') is null or nullif(btrim(row_data->>'name'),'') is null
   or nullif(btrim(row_data->>'unit'),'') is null then raise exception '선택한 품명·단위를 확인하세요'; end if;
  quantity:=(row_data->>'target')::numeric;
  item_weight:=(row_data->>'weight')::numeric;
  if quantity is null or quantity<=0 or quantity::text in ('NaN','Infinity','-Infinity')
   or item_weight is null or item_weight<=0 or item_weight::text in ('NaN','Infinity','-Infinity') then
   raise exception '선택한 물량·가중치를 확인하세요';
  end if;
  if (row_data->>'code')=any(codes) then raise exception '내역 코드가 중복됩니다'; end if;
  codes:=array_append(codes,row_data->>'code');
  if not exists(select 1 from jsonb_array_elements(p_document->'groups') g where g->>'id'=row_data->>'groupId') then
   raise exception '선택한 항목의 구역이 없습니다';
  end if;
  if nullif(row_data->>'version','') is not null then
   if version_name is not null and version_name<>row_data->>'version' then raise exception '당초와 변경을 함께 등록할 수 없습니다'; end if;
   version_name:=row_data->>'version';
  end if;
  chosen:=chosen||jsonb_build_array(jsonb_build_object(
   'code',row_data->>'code','name',btrim(row_data->>'name')||case when nullif(btrim(row_data->>'spec'),'') is null then '' else ' · '||btrim(row_data->>'spec') end,
   'unit',btrim(row_data->>'unit'),'target',quantity,'weight',item_weight));
  chosen_count:=chosen_count+1;
 end loop;
 if chosen_count=0 then raise exception '관리할 물량을 선택하세요'; end if;

 -- 한 트랜잭션: 기존 물량 저장과 원본·비고 저장은 함께 성공하거나 함께 취소됩니다.
 perform public.dh_import_contract(p_site,chosen);
 insert into fieldnote_v6.contract_review_import(id,site_id,actor_id,document) values(p_request,p_site,actor,p_document);
 for row_data in select value from jsonb_array_elements(p_document->'items') where value->'selected'='true'::jsonb loop
  select id into strict item_id from fieldnote_v6.contract_item where site_id=p_site and active and item_code=row_data->>'code';
  select g->>'label' into group_name from jsonb_array_elements(p_document->'groups') g where g->>'id'=row_data->>'groupId' limit 1;
  insert into fieldnote_v6.contract_review_item(contract_item_id,import_id,source_row_id,group_label,note,original,source)
   values(item_id,p_request,row_data->>'id',coalesce(group_name,''),coalesce(row_data->>'note',''),row_data->'original',row_data->'source')
   on conflict(contract_item_id) do update set import_id=excluded.import_id,source_row_id=excluded.source_row_id,
    group_label=excluded.group_label,note=excluded.note,original=excluded.original,source=excluded.source,updated_at=now();
 end loop;
 return p_request;
end $$;

create or replace function public.dh_admin_edit_contract_reviewed(p_item uuid,p_target numeric,p_unit text,p_note text)
returns void language plpgsql security definer set search_path='' as $$
declare actor uuid:=dh_private.require_actor(array['owner','manager']);
begin
 perform public.dh_admin_edit_contract_item(p_item,p_target,p_unit);
 insert into fieldnote_v6.contract_review_item(contract_item_id,note) values(p_item,coalesce(p_note,''))
 on conflict(contract_item_id) do update set note=excluded.note,updated_at=now();
end $$;

create or replace function public.dh_contract_review_snapshot()
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare actor uuid:=dh_private.require_actor(array['owner','manager']);
begin
 return coalesce((select jsonb_agg(to_jsonb(r)) from fieldnote_v6.contract_review_item r),'[]'::jsonb);
end $$;

create or replace function public.dh_contract_review_history(p_site uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare actor uuid:=dh_private.require_actor(array['owner','manager']);
begin
 return coalesce((select jsonb_agg(to_jsonb(h)) from (
  select id,created_at,document->'source'->>'fileName' as file_name from fieldnote_v6.contract_review_import
  where site_id=p_site order by created_at desc limit 100) h),'[]'::jsonb);
end $$;

create or replace function public.dh_contract_review_document(p_request uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare actor uuid:=dh_private.require_actor(array['owner','manager']); result jsonb;
begin
 select document into strict result from fieldnote_v6.contract_review_import where id=p_request;
 return result;
end $$;

-- 원본 worker_snapshot이 허용한 허가서의 작업 비고만 반환합니다.
create or replace function public.dh_contract_task_notes(p_from date,p_to date)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare actor uuid:=dh_private.require_actor(); allowed jsonb;
begin
 allowed:=public.dh_worker_snapshot(p_from,p_to);
 return coalesce((select jsonb_agg(jsonb_build_object('task_id',t.id,'note',r.note,'group_label',r.group_label))
  from fieldnote_v6.permit_task t join fieldnote_v6.contract_review_item r on r.contract_item_id=t.contract_item_id
  where t.permit_id in (select (p->>'id')::uuid from jsonb_array_elements(coalesce(allowed->'permits','[]'::jsonb)) p)), '[]'::jsonb);
end $$;

revoke all on function public.dh_import_contract_reviewed(uuid,uuid,jsonb),public.dh_admin_edit_contract_reviewed(uuid,numeric,text,text),
 public.dh_contract_review_snapshot(),public.dh_contract_review_history(uuid),public.dh_contract_review_document(uuid),
 public.dh_contract_task_notes(date,date) from public,anon;
grant execute on function public.dh_import_contract_reviewed(uuid,uuid,jsonb),public.dh_admin_edit_contract_reviewed(uuid,numeric,text,text),
 public.dh_contract_review_snapshot(),public.dh_contract_review_history(uuid),public.dh_contract_review_document(uuid),
 public.dh_contract_task_notes(date,date) to authenticated;
notify pgrst,'reload schema';
commit;
