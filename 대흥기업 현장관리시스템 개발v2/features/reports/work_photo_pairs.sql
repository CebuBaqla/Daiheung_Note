-- 작업 시작 및 전·후 사진 쌍. 기존 V6와 report_approval.sql, unit_contract.sql 적용 후 실행합니다.
-- 기존 보고는 그대로 보존하고, 이 설치 이후 새 보고에만 시작·사진 쌍을 필수로 적용합니다.
begin;

alter table fieldnote_v6.work_report
  add column if not exists requires_photo_pairs boolean not null default false;
-- 기존 행은 false로 두고 이후 새로 작성되는 보고에만 기본값 true를 적용합니다.
alter table fieldnote_v6.work_report alter column requires_photo_pairs set default true;

create table if not exists fieldnote_v6.work_start (
  permit_id uuid primary key references fieldnote_v6.permit(id),
  started_by uuid not null references fieldnote_v6.employee(id),
  started_at timestamptz not null default now()
);
create table if not exists fieldnote_v6.work_photo_pair (
  permit_id uuid not null references fieldnote_v6.work_start(permit_id),
  sort_order integer not null check (sort_order between 1 and 6),
  category text not null check (category in ('overview','subject')),
  before_file_id uuid not null unique references fieldnote_v6.file_asset(id),
  after_file_id uuid unique references fieldnote_v6.file_asset(id),
  primary key (permit_id,sort_order),
  check (after_file_id is distinct from before_file_id)
);
create index if not exists work_photo_pair_permit_idx on fieldnote_v6.work_photo_pair(permit_id);
alter table fieldnote_v6.work_start enable row level security;
alter table fieldnote_v6.work_photo_pair enable row level security;
revoke all on fieldnote_v6.work_start,fieldnote_v6.work_photo_pair from public,anon,authenticated;

create or replace function fieldnote_v6.work_photo_pairs_json(p_permit uuid) returns jsonb
language sql stable security definer set search_path='' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'sort_order',q.sort_order,'kind',q.category,
    'before',jsonb_build_object('id',bf.id,'bucket',bf.bucket,'path',bf.object_path,
      'filename',bf.filename,'mime',bf.mime_type),
    'after',case when af.id is null then null else jsonb_build_object(
      'id',af.id,'bucket',af.bucket,'path',af.object_path,
      'filename',af.filename,'mime',af.mime_type) end
  ) order by q.sort_order),'[]'::jsonb)
  from fieldnote_v6.work_photo_pair q
  join fieldnote_v6.file_asset bf on bf.id=q.before_file_id
  left join fieldnote_v6.file_asset af on af.id=q.after_file_id
  where q.permit_id=p_permit;
$$;
revoke all on function fieldnote_v6.work_photo_pairs_json(uuid) from public,anon,authenticated;

create or replace function public.dh_start_work(p_permit uuid,p_photos jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid:=dh_private.require_actor(array['foreman']);
  p fieldnote_v6.permit; prior fieldnote_v6.work_start; item jsonb;
  existing jsonb; v_file uuid; v_kind text; n integer:=0;
begin
  select * into p from fieldnote_v6.permit where id=p_permit for update;
  if not found or p.published_at is null or p.work_date<>(now() at time zone 'Asia/Seoul')::date then
    raise exception '오늘 승인된 작업허가서만 시작할 수 있습니다'; end if;
  if not exists(select 1 from fieldnote_v6.permit_worker w
      where w.permit_id=p_permit and w.employee_id=actor) then
    raise exception '예정 작업자 명단에 있는 작업반장만 시작할 수 있습니다' using errcode='42501'; end if;
  if exists(select 1 from fieldnote_v6.work_report r
      where r.permit_id=p_permit and r.submitted_at is not null) then
    raise exception '이미 작업종료 보고가 제출되었습니다'; end if;
  if jsonb_typeof(p_photos)<>'array' or jsonb_array_length(p_photos) not between 2 and 6 then
    raise exception '전경과 작업물 사진을 합해 2~6장 올려 주세요'; end if;
  if (select count(*) from jsonb_array_elements(p_photos) as v(item) where v.item->>'kind'='overview')<>1
    or (select count(*) from jsonb_array_elements(p_photos) as v(item) where v.item->>'kind'='subject')<1 then
    raise exception '전경 1장과 작업물 사진 1장 이상이 필요합니다'; end if;
  select * into prior from fieldnote_v6.work_start where permit_id=p_permit;
  if found then
    select coalesce(jsonb_agg(jsonb_build_object('kind',q.category,'file_id',q.before_file_id)
      order by q.sort_order),'[]'::jsonb) into existing
      from fieldnote_v6.work_photo_pair q where q.permit_id=p_permit;
    if prior.started_by=actor and existing=p_photos then
      return jsonb_build_object('started_at',prior.started_at,'pairs',fieldnote_v6.work_photo_pairs_json(p_permit));
    end if;
    raise exception '이미 시작된 작업입니다';
  end if;
  insert into fieldnote_v6.work_start(permit_id,started_by) values(p_permit,actor);
  for item in select value from jsonb_array_elements(p_photos) loop
    n:=n+1;
    v_file:=(item->>'file_id')::uuid;
    v_kind:=item->>'kind';
    if v_kind not in ('overview','subject') or v_file is null or not exists(
      select 1 from fieldnote_v6.file_asset f
      where f.id=v_file and f.site_id=p.site_id and f.kind='photo') then
      raise exception '작업 전 사진의 현장과 파일 종류를 확인해 주세요'; end if;
    insert into fieldnote_v6.work_photo_pair(permit_id,sort_order,category,before_file_id)
      values(p_permit,n,v_kind,v_file);
  end loop;
  return jsonb_build_object('started_at',(select started_at from fieldnote_v6.work_start where permit_id=p_permit),
    'pairs',fieldnote_v6.work_photo_pairs_json(p_permit));
end $$;

create or replace function public.dh_work_photo_state(p_ids uuid[]) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare actor uuid:=dh_private.require_actor();
begin
  if coalesce(array_length(p_ids,1),0)>500 then raise exception '조회할 작업이 너무 많습니다'; end if;
  return coalesce((select jsonb_object_agg(s.permit_id::text,jsonb_build_object(
    'started_at',s.started_at,'started_by',s.started_by,
    'pairs',fieldnote_v6.work_photo_pairs_json(s.permit_id)))
    from fieldnote_v6.work_start s join fieldnote_v6.permit p on p.id=s.permit_id
    where s.permit_id=any(coalesce(p_ids,'{}'::uuid[])) and p.published_at is not null),'{}'::jsonb);
end $$;

-- 기존 제출 검증은 유지하고, 새 보고의 시작 기록과 모든 사진 쌍을 추가로 검사합니다.
create or replace function fieldnote_v6.validate_work_photo_pairs() returns trigger
language plpgsql set search_path='' as $$
declare pair_count integer;
begin
  if new.submitted_at is null or not new.requires_photo_pairs then return new; end if;
  if not exists(select 1 from fieldnote_v6.work_start s
      where s.permit_id=new.permit_id and s.started_by=new.submitted_by) then
    raise exception '작업반장의 작업 시작 기록이 필요합니다'; end if;
  select count(*) into pair_count from fieldnote_v6.work_photo_pair q where q.permit_id=new.permit_id;
  if pair_count<2 or not exists(select 1 from fieldnote_v6.work_photo_pair q
      where q.permit_id=new.permit_id and q.category='overview')
    or not exists(select 1 from fieldnote_v6.work_photo_pair q
      where q.permit_id=new.permit_id and q.category='subject')
    or exists(select 1 from fieldnote_v6.work_photo_pair q
      where q.permit_id=new.permit_id and q.after_file_id is null) then
    raise exception '작업 전 사진마다 작업 후 사진을 올려 주세요'; end if;
  if (select count(*) from fieldnote_v6.report_file rf where rf.report_id=new.id)<>pair_count
    or exists(select 1 from fieldnote_v6.work_photo_pair q
      where q.permit_id=new.permit_id and not exists(select 1 from fieldnote_v6.report_file rf
        where rf.report_id=new.id and rf.file_id=q.after_file_id)) then
    raise exception '종료 보고의 사진이 작업 전·후 사진 쌍과 일치하지 않습니다'; end if;
  return new;
end $$;
drop trigger if exists validate_work_photo_pairs on fieldnote_v6.work_report;
create trigger validate_work_photo_pairs before insert or update on fieldnote_v6.work_report
  for each row execute function fieldnote_v6.validate_work_photo_pairs();
revoke all on function fieldnote_v6.validate_work_photo_pairs() from public,anon,authenticated;

-- 사진 쌍 변경과 보고 제출을 한 트랜잭션으로 묶습니다. 보완 요청은 기존 보고 ID를 유지합니다.
create or replace function public.dh_submit_work_report(p_data jsonb,p_pairs jsonb) returns uuid
language plpgsql security definer set search_path='' as $$
declare actor uuid:=dh_private.require_actor(array['foreman']);
  p fieldnote_v6.permit; s fieldnote_v6.work_start; r fieldnote_v6.work_report;
  item jsonb; v_file uuid; v_count integer; n integer:=0; result uuid;
begin
  select * into p from fieldnote_v6.permit where id=(p_data->>'permit_id')::uuid for update;
  if not found then raise exception '작업허가서를 찾을 수 없습니다'; end if;
  select * into s from fieldnote_v6.work_start where permit_id=p.id for update;
  if not found or s.started_by<>actor then
    raise exception '작업을 시작한 반장만 종료할 수 있습니다' using errcode='42501'; end if;
  select * into r from fieldnote_v6.work_report where permit_id=p.id for update;
  if found and (r.submitted_by<>actor or r.id is distinct from (p_data->>'id')::uuid
    or r.review_status not in ('draft','rejected')) then
    raise exception '제출 가능한 작업종료 보고가 아닙니다'; end if;
  select count(*) into v_count from fieldnote_v6.work_photo_pair where permit_id=p.id;
  if jsonb_typeof(p_pairs)<>'array' or jsonb_array_length(p_pairs)<>v_count then
    raise exception '작업 전 사진마다 작업 후 사진이 필요합니다'; end if;
  if jsonb_typeof(p_data->'files')<>'array' or p_data->'files'<>
    (select coalesce(jsonb_agg(v.item->>'after_file_id' order by (v.item->>'sort_order')::integer),'[]'::jsonb)
      from jsonb_array_elements(p_pairs) as v(item)) then
    raise exception '종료 보고 사진과 전·후 사진 쌍이 일치하지 않습니다'; end if;
  for item in select value from jsonb_array_elements(p_pairs) loop
    n:=n+1;
    if (item->>'sort_order')::integer<>n then raise exception '사진 순서가 올바르지 않습니다'; end if;
    v_file:=(item->>'after_file_id')::uuid;
    if v_file is null or exists(select 1 from fieldnote_v6.work_photo_pair q
      where q.before_file_id=v_file)
      or not exists(select 1 from fieldnote_v6.file_asset f
      where f.id=v_file and f.site_id=p.site_id and f.kind='photo') then
      raise exception '작업 후 사진의 현장과 파일 종류를 확인해 주세요'; end if;
    update fieldnote_v6.work_photo_pair set after_file_id=v_file
      where permit_id=p.id and sort_order=n;
    if not found then raise exception '작업 전 사진 순서를 찾지 못했습니다'; end if;
  end loop;
  if r.id is not null and r.review_status='rejected' then
    result:=public.dh_resubmit_report(p_data);
  else
    result:=public.dh_save_report(p_data);
    perform public.dh_submit_report(result);
  end if;
  return result;
end $$;

revoke all on function public.dh_start_work(uuid,jsonb),public.dh_work_photo_state(uuid[]),
  public.dh_submit_work_report(jsonb,jsonb) from public,anon;
grant execute on function public.dh_start_work(uuid,jsonb),public.dh_work_photo_state(uuid[]),
  public.dh_submit_work_report(jsonb,jsonb) to authenticated;

create or replace function public.dh_admin_work_photo_detail(p_permit uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare actor uuid:=dh_private.require_actor(array['owner','manager']);
begin
  return (select jsonb_build_object('location',p.location_description,
    'started_at',s.started_at,'pairs',fieldnote_v6.work_photo_pairs_json(p.id))
    from fieldnote_v6.permit p left join fieldnote_v6.work_start s on s.permit_id=p.id
    where p.id=p_permit);
end $$;

-- 작업 항목별 행 구성은 유지하되 위치와 사진 쌍을 보고 단위로 함께 반환합니다.
create or replace function public.dh_admin_work_log_v2(p_from date,p_to date) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare actor uuid:=dh_private.require_actor(array['owner','manager']); result jsonb;
begin
  if p_from is null or p_to is null or p_to<p_from or p_to-p_from>3660 then
    raise exception '조회 기간이 올바르지 않습니다'; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    '날짜',r.work_date,'현장명',p.site_name_snapshot,
    '작업 위치 설명',p.location_description,'보고 ID',r.id,'허가서 ID',p.id,
    '작업자 명단',(select string_agg(w.name_snapshot,', ' order by w.name_snapshot)
      from fieldnote_v6.report_worker w where w.report_id=r.id),
    '목표 작업량',t.name||' '||t.target_quantity||t.unit,
    '실제 작업량',t.name||' '||a.actual_quantity||t.unit,
    '자재 구분',case when a.external_material_used then '회사 자재 외 사용(일부 또는 전부)'
      else '회사 자재 사용' end,
    '사진 쌍',fieldnote_v6.work_photo_pairs_json(p.id),
    '작업 사진',coalesce((select jsonb_agg(jsonb_build_object('id',f.id,
      'bucket',f.bucket,'path',f.object_path,'filename',f.filename)
      order by rf.sort_order)
      from fieldnote_v6.report_file rf join fieldnote_v6.file_asset f on f.id=rf.file_id
      where rf.report_id=r.id),'[]'::jsonb)
  ) order by r.work_date,p.site_name_snapshot,t.sort_order),'[]'::jsonb) into result
  from fieldnote_v6.work_report r join fieldnote_v6.permit p on p.id=r.permit_id
  join fieldnote_v6.report_task a on a.report_id=r.id
  join fieldnote_v6.permit_task t on t.id=a.task_id and t.permit_id=p.id
  where r.approved_at is not null and r.work_date between p_from and p_to;
  return result;
end $$;
revoke all on function public.dh_admin_work_photo_detail(uuid),
  public.dh_admin_work_log_v2(date,date) from public,anon;
grant execute on function public.dh_admin_work_photo_detail(uuid),
  public.dh_admin_work_log_v2(date,date) to authenticated;

-- 단가계약 SQL이 나중에 설치되면 제출 기준으로 되돌아갈 수 있어 승인 기준을 다시 확정합니다.
create or replace function public.dh_unit_contract_work_log(p_site uuid,p_from date,p_to date)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare actor uuid:=dh_private.require_actor(array['owner','manager']);
begin
  if p_from is null or p_to is null or p_to<p_from then raise exception '조회 기간이 올바르지 않습니다'; end if;
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
    from fieldnote_v6.work_report r join fieldnote_v6.permit p on p.id=r.permit_id
    join fieldnote_v6.report_task a on a.report_id=r.id
    join fieldnote_v6.permit_task t on t.id::text=
      coalesce(to_jsonb(a)->>'task_id',to_jsonb(a)->>'permit_task_id') and t.permit_id=p.id
    join fieldnote_v6.contract_item c on c.id=t.contract_item_id and c.site_id=p_site
    where r.site_id=p_site and r.approved_at is not null
      and r.work_date between p_from and p_to),'[]'::jsonb);
end $$;

notify pgrst,'reload schema';
commit;
