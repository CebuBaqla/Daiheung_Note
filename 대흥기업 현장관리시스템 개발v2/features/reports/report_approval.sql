-- 작업종료 보고 승인: 기존 제출 건은 확정된 작업일보로 이관합니다.
-- 기존 V6 + 관리자 연결 SQL 적용 후 Supabase SQL Editor에서 한 번 실행합니다.
-- 파일 배포만으로는 DB 함수가 설치되지 않습니다.
begin;

alter table fieldnote_v6.work_report
  add column if not exists review_status text not null default 'draft',
  add column if not exists approved_at timestamptz,
  add column if not exists approved_by uuid references fieldnote_v6.employee(id),
  add column if not exists rejected_at timestamptz,
  add column if not exists rejected_by uuid references fieldnote_v6.employee(id),
  add column if not exists rejection_reason text;
alter table fieldnote_v6.work_report drop constraint if exists work_report_review_status_check;
alter table fieldnote_v6.work_report add constraint work_report_review_status_check
  check (review_status in ('draft','pending','rejected','approved'));
drop trigger if exists validate_header on fieldnote_v6.work_report;

-- 설치 이전의 제출 보고는 추가 승인 없이 확정된 기록으로 취급합니다.
update fieldnote_v6.work_report set review_status='approved', approved_at=submitted_at
  where submitted_at is not null and approved_at is null and review_status='draft';
create index if not exists work_report_approved_site_date_idx
  on fieldnote_v6.work_report(site_id,work_date) where approved_at is not null;

create table if not exists fieldnote_v6.report_review_event (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references fieldnote_v6.work_report(id),
  actor_id uuid not null references fieldnote_v6.employee(id),
  action text not null check (action in ('submitted','approved','rejected')),
  reason text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists report_review_event_report_idx
  on fieldnote_v6.report_review_event(report_id,created_at);
alter table fieldnote_v6.report_review_event enable row level security;
revoke all on fieldnote_v6.report_review_event from public,anon,authenticated;

-- 허가서와 메시지의 기존 검증은 그대로 두고, 보고서의 승인 단계만 분리합니다.
create or replace function fieldnote_v6.validate_work_report_review() returns trigger language plpgsql
  set search_path=fieldnote_v6,pg_catalog,pg_temp as $$
declare target_count integer; actual_count integer;
begin
  if tg_op='DELETE' then
    if old.submitted_at is not null or old.approved_at is not null then
      raise exception '제출된 보고는 삭제할 수 없습니다';
    end if;
    return old;
  end if;
  if tg_op='UPDATE' then
    if old.approved_at is not null then raise exception '승인된 작업일보는 수정할 수 없습니다'; end if;
    if old.submitted_at is not null then
      if not ((old.review_status='pending' and new.review_status in ('approved','rejected')
          and new.submitted_at=old.submitted_at)
        or (old.review_status='rejected' and new.review_status='draft'
          and new.submitted_at is null)) then
        raise exception '제출된 보고는 승인, 반려 또는 보완 재제출만 가능합니다';
      end if;
      if (to_jsonb(new)-'review_status'-'approved_at'-'approved_by'-'rejected_at'-'rejected_by'-'rejection_reason'-'submitted_at')
        is distinct from
        (to_jsonb(old)-'review_status'-'approved_at'-'approved_by'-'rejected_at'-'rejected_by'-'rejection_reason'-'submitted_at') then
        raise exception '검토 중인 보고 내용은 바꿀 수 없습니다';
      end if;
    end if;
  end if;
  if (new.review_status='draft' and new.submitted_at is not null)
    or (new.review_status in ('pending','rejected','approved') and new.submitted_at is null)
    or (new.review_status='approved' and new.approved_at is null)
    or (new.review_status<>'approved' and new.approved_at is not null) then
    raise exception '작업종료 보고 상태가 올바르지 않습니다';
  end if;
  if new.submitted_at is not null then
    perform 1 from permit where id=new.permit_id and published_at is not null;
    if not found then raise exception '허가서가 먼저 발행되어야 합니다'; end if;
    select count(*) into target_count from permit_task where permit_id=new.permit_id;
    select count(*) into actual_count from report_task where report_id=new.id;
    if target_count=0 or actual_count<>target_count then raise exception '모든 목표 작업의 실제 물량이 필요합니다'; end if;
    if not exists(select 1 from report_worker where report_id=new.id) then
      raise exception '실제 투입 인원이 필요합니다'; end if;
    if new.roster_confirmed_by is distinct from new.submitted_by or new.roster_confirmed_at is null
      or not (new.area_cleaned and new.equipment_collected and new.safety_checked) then
      raise exception '명단과 종료 점검을 확인해 주세요'; end if;
    if not exists(select 1 from report_file rf join file_asset f on f.id=rf.file_id
      where rf.report_id=new.id and f.kind='photo') then raise exception '완료 사진이 필요합니다'; end if;
    if exists(select 1 from report_file rf join file_asset f on f.id=rf.file_id
      where rf.report_id=new.id and f.kind<>'photo') then raise exception '완료 사진만 첨부할 수 있습니다'; end if;
    if exists(select 1 from report_task rt join permit_task pt on pt.id=rt.task_id
      where rt.report_id=new.id and rt.actual_quantity<pt.target_quantity)
      and nullif(btrim(new.incomplete_reason),'') is null then
      raise exception '목표 미달 사유를 입력하세요'; end if;
  end if;
  return new;
end $$;
drop trigger if exists validate_work_report_review on fieldnote_v6.work_report;
create trigger validate_work_report_review before insert or update or delete on fieldnote_v6.work_report
  for each row execute function fieldnote_v6.validate_work_report_review();
revoke all on function fieldnote_v6.validate_work_report_review() from public,anon,authenticated;

-- 반려된 보고는 기존 제출 내용을 보존해 보여주고, 재제출 때 한 트랜잭션에서 다시 작성합니다.
create or replace function fieldnote_v6.submit_report(p_id uuid) returns uuid language plpgsql
  set search_path=fieldnote_v6,pg_catalog,pg_temp as $$
declare r work_report;
begin
  select * into strict r from work_report where id=p_id for update;
  if r.submitted_at is not null then return p_id; end if;
  if r.review_status<>'draft' then raise exception '제출 가능한 보고가 아닙니다'; end if;
  update work_report set submitted_at=now(),review_status='pending',
    rejected_at=null,rejected_by=null,rejection_reason=null where id=p_id;
  insert into report_review_event(report_id,actor_id,action,details)
  values(p_id,r.submitted_by,'submitted',jsonb_build_object('report',
    (select to_jsonb(x) from work_report x where x.id=p_id),
    'tasks',(select coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) from report_task x where x.report_id=p_id),
    'workers',(select coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) from report_worker x where x.report_id=p_id),
    'equipment',(select coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) from report_equipment x where x.report_id=p_id),
    'files',(select coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) from report_file x where x.report_id=p_id)));
  return p_id;
end $$;
revoke all on function fieldnote_v6.submit_report(uuid) from public,anon,authenticated;

create or replace function public.dh_decide_report(p_id uuid,p_decision text,p_reason text default null)
returns text language plpgsql security definer set search_path='' as $$
declare actor uuid:=dh_private.require_actor(array['owner','manager']);
  r fieldnote_v6.work_report; requester uuid;
begin
  select * into strict r from fieldnote_v6.work_report where id=p_id for update;
  select a.requested_by into requester from fieldnote_v6.permit_approval a where a.permit_id=r.permit_id;
  if requester is null or actor<>requester then
    raise exception '이 허가서의 결재 요청자만 종료 보고를 확인할 수 있습니다' using errcode='42501'; end if;
  if r.review_status<>'pending' or r.submitted_at is null then
    raise exception '승인 대기 중인 종료 보고가 아닙니다'; end if;
  if p_decision='approve' then
    update fieldnote_v6.work_report set review_status='approved',approved_at=now(),approved_by=actor where id=p_id;
    insert into fieldnote_v6.report_review_event(report_id,actor_id,action)
      values(p_id,actor,'approved');
    if not exists(select 1 from fieldnote_v6.message where report_id=p_id and kind='completion') then
      insert into fieldnote_v6.message(site_id,sender_id,kind,report_id,posted_at)
        values(r.site_id,actor,'completion',p_id,now());
    end if;
  elsif p_decision='reject' then
    if nullif(btrim(p_reason),'') is null then raise exception '보완 사유를 입력하세요'; end if;
    update fieldnote_v6.work_report set review_status='rejected',rejected_at=now(),
      rejected_by=actor,rejection_reason=btrim(p_reason) where id=p_id;
    insert into fieldnote_v6.report_review_event(report_id,actor_id,action,reason)
      values(p_id,actor,'rejected',btrim(p_reason));
  else raise exception 'approve 또는 reject만 사용할 수 있습니다'; end if;
  return p_decision;
end $$;

create or replace function public.dh_resubmit_report(p_data jsonb) returns uuid
  language plpgsql security definer set search_path='' as $$
declare actor uuid:=dh_private.require_actor(array['owner','manager','foreman']);
  r fieldnote_v6.work_report; result uuid; item jsonb;
begin
  select * into strict r from fieldnote_v6.work_report where id=(p_data->>'id')::uuid for update;
  if r.submitted_by<>actor or r.review_status<>'rejected'
    or r.permit_id is distinct from (p_data->>'permit_id')::uuid then
    raise exception '보완 재제출 권한이 없습니다' using errcode='42501'; end if;
  update fieldnote_v6.work_report set submitted_at=null,review_status='draft',
    rejected_at=null,rejected_by=null,rejection_reason=null where id=r.id;
  result:=dh_private.save_report_base(p_data);
  delete from fieldnote_v6.report_material where report_id=result;
  for item in select value from jsonb_array_elements(coalesce(p_data->'materials','[]'::jsonb)) loop
    insert into fieldnote_v6.report_material(report_id,permit_id,permit_material_id,actual_quantity)
      values(result,r.permit_id,(item->>'permit_material_id')::uuid,(item->>'actual')::numeric);
  end loop;
  perform fieldnote_v6.submit_report(result);
  return result;
end $$;

create or replace function public.dh_report_revision_detail(p_id uuid) returns jsonb
  language plpgsql stable security definer set search_path='' as $$
declare actor uuid:=dh_private.require_actor(array['owner','manager','foreman']); r fieldnote_v6.work_report;
begin
  select * into strict r from fieldnote_v6.work_report where id=p_id;
  if r.submitted_by<>actor or r.review_status<>'rejected' then
    raise exception '보완 보고 조회 권한이 없습니다' using errcode='42501'; end if;
  return to_jsonb(r)||jsonb_build_object(
    'tasks',coalesce((select jsonb_agg(jsonb_build_object('task_id',t.task_id,'actual',t.actual_quantity,
      'external_material_used',t.external_material_used)) from fieldnote_v6.report_task t where t.report_id=p_id),'[]'::jsonb),
    'workers',coalesce((select jsonb_agg(w.employee_id) from fieldnote_v6.report_worker w where w.report_id=p_id),'[]'::jsonb),
    'equipment',coalesce((select jsonb_agg(jsonb_build_object('id',e.equipment_id,'quantity',e.quantity))
      from fieldnote_v6.report_equipment e where e.report_id=p_id),'[]'::jsonb),
    'photos',coalesce((select jsonb_agg(jsonb_build_object('id',f.id,'bucket',f.bucket,'path',f.object_path,
      'filename',f.filename,'mime',f.mime_type) order by rf.sort_order)
      from fieldnote_v6.report_file rf join fieldnote_v6.file_asset f on f.id=rf.file_id
      where rf.report_id=p_id),'[]'::jsonb));
end $$;

create or replace function public.dh_my_report_reviews(p_from date,p_to date) returns jsonb
  language plpgsql stable security definer set search_path='' as $$
declare actor uuid:=dh_private.require_actor();
begin
  if p_from is null or p_to is null or p_to<p_from or p_to-p_from>400 then
    raise exception '조회 기간이 올바르지 않습니다'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('permit_id',r.permit_id,
    'review_status',r.review_status,'approved_at',r.approved_at,'submitted_by',r.submitted_by,
    'rejection_reason',r.rejection_reason)) from fieldnote_v6.work_report r
    join fieldnote_v6.permit p on p.id=r.permit_id
    where r.submitted_at is not null and p.published_at is not null
      and p.work_date between p_from and p_to),'[]'::jsonb);
end $$;

-- 모바일 기본 조회 기간(최근 14일) 밖에서 반려되어도 원 제출자는 보완할 수 있습니다.
create or replace function public.dh_my_rejected_permits() returns jsonb
  language plpgsql stable security definer set search_path='' as $$
declare actor uuid:=dh_private.require_actor();
begin
  return coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'site_id',p.site_id,
    'site_name',p.site_name_snapshot,'work_date',p.work_date,
    'tasks',coalesce((select jsonb_agg(jsonb_build_object('id',t.id,'name',t.name,
      'target',t.target_quantity,'unit',t.unit) order by t.sort_order)
      from fieldnote_v6.permit_task t where t.permit_id=p.id),'[]'::jsonb),
    'workers',coalesce((select jsonb_agg(jsonb_build_object('id',w.employee_id,'name',w.name_snapshot))
      from fieldnote_v6.permit_worker w where w.permit_id=p.id),'[]'::jsonb),
    'equipment',coalesce((select jsonb_agg(jsonb_build_object('id',e.equipment_id,'name',e.name_snapshot,
      'quantity',e.quantity)) from fieldnote_v6.permit_equipment e where e.permit_id=p.id),'[]'::jsonb),
    'report',jsonb_build_object('id',r.id,'submitted_at',r.submitted_at,
      'review_status',r.review_status,'rejection_reason',r.rejection_reason))
    order by p.work_date,p.site_name_snapshot)
    from fieldnote_v6.work_report r join fieldnote_v6.permit p on p.id=r.permit_id
    where r.submitted_by=actor and r.review_status='rejected'),'[]'::jsonb);
end $$;

create or replace function public.dh_admin_report_detail(p_permit uuid) returns jsonb
  language plpgsql stable security definer set search_path='' as $$
declare actor uuid:=dh_private.require_actor(array['owner','manager']); result jsonb;
begin
  select to_jsonb(r)||jsonb_build_object('site_name',p.site_name_snapshot,
    'requested_by',a.requested_by,
    'requested_by_name',(select e.name from fieldnote_v6.employee e where e.id=a.requested_by),
    'submitted_by_name',(select e.name from fieldnote_v6.employee e where e.id=r.submitted_by),
    'approved_by_name',(select e.name from fieldnote_v6.employee e where e.id=r.approved_by),
    'tasks',coalesce((select jsonb_agg(jsonb_build_object('name',t.name,'unit',t.unit,
      'target_quantity',t.target_quantity,'actual_quantity',rt.actual_quantity,
      'external_material_used',rt.external_material_used) order by t.sort_order)
      from fieldnote_v6.report_task rt join fieldnote_v6.permit_task t on t.id=rt.task_id
      where rt.report_id=r.id),'[]'::jsonb),
    'workers',coalesce((select jsonb_agg(w.name_snapshot order by w.name_snapshot)
      from fieldnote_v6.report_worker w where w.report_id=r.id),'[]'::jsonb),
    'equipment',coalesce((select jsonb_agg(jsonb_build_object('name',e.name_snapshot,'quantity',e.quantity))
      from fieldnote_v6.report_equipment e where e.report_id=r.id),'[]'::jsonb),
    'photos',coalesce((select jsonb_agg(jsonb_build_object('id',f.id,'bucket',f.bucket,'path',f.object_path,
      'filename',f.filename,'mime',f.mime_type) order by rf.sort_order)
      from fieldnote_v6.report_file rf join fieldnote_v6.file_asset f on f.id=rf.file_id
      where rf.report_id=r.id),'[]'::jsonb)) into result
  from fieldnote_v6.work_report r join fieldnote_v6.permit p on p.id=r.permit_id
  left join fieldnote_v6.permit_approval a on a.permit_id=p.id
  where p.id=p_permit and r.submitted_at is not null;
  return result;
end $$;

create or replace function public.dh_admin_pending_reports() returns jsonb
  language plpgsql stable security definer set search_path='' as $$
declare actor uuid:=dh_private.require_actor(array['owner','manager']);
begin
  return coalesce((select jsonb_agg(jsonb_build_object('permit_id',p.id,'report_id',r.id,
    'site_name',p.site_name_snapshot,'work_date',p.work_date,
    'tasks',coalesce((select jsonb_agg(t.name order by t.sort_order)
      from fieldnote_v6.permit_task t where t.permit_id=p.id),'[]'::jsonb))
    order by p.work_date,p.site_name_snapshot)
    from fieldnote_v6.work_report r join fieldnote_v6.permit p on p.id=r.permit_id
    join fieldnote_v6.permit_approval a on a.permit_id=p.id
    where r.review_status='pending' and a.requested_by=actor),'[]'::jsonb);
end $$;

revoke all on function public.dh_decide_report(uuid,text,text),
  public.dh_resubmit_report(jsonb),public.dh_report_revision_detail(uuid),
  public.dh_my_report_reviews(date,date),public.dh_my_rejected_permits(),
  public.dh_admin_report_detail(uuid),
  public.dh_admin_pending_reports()
  from public,anon;
grant execute on function public.dh_decide_report(uuid,text,text),
  public.dh_resubmit_report(jsonb),public.dh_report_revision_detail(uuid),
  public.dh_my_report_reviews(date,date),public.dh_my_rejected_permits(),
  public.dh_admin_report_detail(uuid),
  public.dh_admin_pending_reports()
  to authenticated;

-- 기존 작업일보·공정률·단가계약 실적 함수는 아래에서 승인된 보고 기준으로 교체합니다.
create or replace function public.dh_admin_work_log(p_from date,p_to date) returns jsonb
  language plpgsql stable security definer set search_path='' as $$
declare actor uuid:=dh_private.require_actor(array['owner','manager']); result jsonb;
begin
  if p_to<p_from or p_to-p_from>3660 then raise exception '조회 기간이 올바르지 않습니다'; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    '날짜',r.work_date,'현장명',p.site_name_snapshot,
    '작업자 명단',(select string_agg(w.name_snapshot,', ' order by w.name_snapshot)
      from fieldnote_v6.report_worker w where w.report_id=r.id),
    '목표 작업량',t.name||' '||t.target_quantity||t.unit,
    '실제 작업량',t.name||' '||a.actual_quantity||t.unit,
    '자재 구분',case when a.external_material_used then '회사 자재 외 사용(일부 또는 전부)' else '회사 자재 사용' end,
    '작업 사진',coalesce((select jsonb_agg(jsonb_build_object('bucket',f.bucket,'path',f.object_path,
      'filename',f.filename) order by rf.sort_order)
      from fieldnote_v6.report_file rf join fieldnote_v6.file_asset f on f.id=rf.file_id
      where rf.report_id=r.id),'[]'::jsonb)
  ) order by r.work_date,p.site_name_snapshot,t.sort_order),'[]'::jsonb) into result
  from fieldnote_v6.work_report r join fieldnote_v6.permit p on p.id=r.permit_id
  join fieldnote_v6.report_task a on a.report_id=r.id
  join fieldnote_v6.permit_task t on t.id=a.task_id
  where r.approved_at is not null and r.work_date between p_from and p_to;
  return result;
end $$;

create or replace function public.dh_site_progress() returns jsonb
  language plpgsql stable security definer set search_path='' as $$
declare actor uuid:=dh_private.require_actor(array['owner','manager']); result jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object('site_id',s.id,'progress',coalesce(x.progress,0)) order by s.name),'[]'::jsonb) into result
  from fieldnote_v6.site s left join lateral (
    select round(100*sum(least(coalesce(q.actual,0)/c.target_quantity,1)*c.weight)/nullif(sum(c.weight),0),1) as progress
    from fieldnote_v6.contract_item c left join lateral (
      select sum(rt.actual_quantity) as actual from fieldnote_v6.permit_task pt
      join fieldnote_v6.report_task rt on rt.task_id=pt.id
      join fieldnote_v6.work_report r on r.id=rt.report_id and r.approved_at is not null
      where pt.contract_item_id=c.id
    ) q on true where c.site_id=s.id and c.active
  ) x on true;
  return result;
end $$;

create or replace function public.dh_contract_progress_snapshot(p_site uuid default null)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare actor uuid:=dh_private.require_actor(array['owner','manager']);
begin
  if not exists (select 1 from pg_catalog.pg_attribute
    where attrelid='fieldnote_v6.report_task'::regclass
      and attname in ('task_id','permit_task_id') and not attisdropped)
    or not exists (select 1 from pg_catalog.pg_attribute
    where attrelid='fieldnote_v6.report_task'::regclass
      and attname in ('actual','actual_quantity') and not attisdropped) then
    raise exception '작업종료 실적 열 구성을 확인하세요';
  end if;
  return coalesce((with approved as (
    select pt.contract_item_id,
      sum(coalesce(to_jsonb(rt)->>'actual_quantity',to_jsonb(rt)->>'actual','0')::numeric) as actual_quantity
    from fieldnote_v6.permit_task pt
    join fieldnote_v6.report_task rt
      on coalesce(to_jsonb(rt)->>'task_id',to_jsonb(rt)->>'permit_task_id')=pt.id::text
    join fieldnote_v6.work_report wr
      on wr.id=rt.report_id and wr.permit_id=pt.permit_id and wr.approved_at is not null
    where pt.contract_item_id is not null group by pt.contract_item_id)
    select jsonb_agg(jsonb_build_object('id',c.id,'site_id',c.site_id,'name',c.name,'unit',c.unit,
      'target_quantity',c.target_quantity,'actual_quantity',coalesce(a.actual_quantity,0))
      order by c.site_id,c.name,c.id)
    from fieldnote_v6.contract_item c left join approved a on a.contract_item_id=c.id
    where c.active and (p_site is null or c.site_id=p_site)),'[]'::jsonb);
end $$;

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

create or replace view fieldnote_v6.excel_work_log as
select r.work_date as "날짜",p.site_name_snapshot as "현장명",
  (select string_agg(w.name_snapshot,', ' order by w.name_snapshot,w.employee_id)
    from fieldnote_v6.report_worker w where w.report_id=r.id) as "작업자 명단",
  t.name||' '||t.target_quantity::text||t.unit as "목표 작업량",
  t.name||' '||a.actual_quantity::text||t.unit as "실제 작업량",
  case when a.external_material_used then '회사 자재 외 사용(일부 또는 전부)'
    else '회사 자재 사용' end as "자재 구분",
  coalesce((select jsonb_agg(jsonb_build_object('file_id',f.id,'bucket',f.bucket,
    'path',f.object_path,'filename',f.filename) order by rf.sort_order,f.id)
    from fieldnote_v6.report_file rf join fieldnote_v6.file_asset f on f.id=rf.file_id
    where rf.report_id=r.id and f.kind='photo'),'[]'::jsonb) as "작업 사진"
from fieldnote_v6.work_report r join fieldnote_v6.permit p on p.id=r.permit_id
join fieldnote_v6.report_task a on a.report_id=r.id
join fieldnote_v6.permit_task t on t.id=a.task_id and t.permit_id=r.permit_id
where r.approved_at is not null;

notify pgrst,'reload schema';
commit;
