-- 04:00 한국시간 작업일 전환. 기존 V6, report_approval.sql,
-- work_photo_pairs.sql, share_permit.sql 설치 후 적용합니다.
begin;

create or replace function public.dh_current_work_day() returns date
language sql stable set search_path='' as $$
  select ((now() at time zone 'Asia/Seoul') - interval '4 hours')::date;
$$;
revoke all on function public.dh_current_work_day() from public,anon;
grant execute on function public.dh_current_work_day() to authenticated;

-- 출근 여부도 자정이 아닌 작업일 기준으로 저장합니다.
create table if not exists fieldnote_v6.workday_attendance (
  employee_id uuid not null references fieldnote_v6.employee(id),
  work_date date not null,
  status text not null check (status in ('work','leave')),
  updated_at timestamptz not null default now(),
  primary key(employee_id,work_date)
);
alter table fieldnote_v6.workday_attendance enable row level security;
revoke all on fieldnote_v6.workday_attendance from public,anon,authenticated;

create or replace function public.dh_worker_day_state() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare actor uuid:=dh_private.require_actor(); day date:=public.dh_current_work_day();
begin
  return jsonb_build_object('work_date',day,
    'ms_until_change',greatest(1,round(extract(epoch from
      (((day + 1)::timestamp + interval '4 hours') - (now() at time zone 'Asia/Seoul')))*1000)::integer),
    'attendance',
    (select jsonb_build_object('status',a.status,'work_date',a.work_date)
     from fieldnote_v6.workday_attendance a
     where a.employee_id=actor and a.work_date=day));
end $$;

create or replace function public.dh_workday_attend(p_status text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid:=dh_private.require_actor(); day date:=public.dh_current_work_day();
begin
  if p_status not in ('work','leave') or p_status is null then
    raise exception '출근 상태가 올바르지 않습니다';
  end if;
  insert into fieldnote_v6.workday_attendance(employee_id,work_date,status)
    values(actor,day,p_status)
    on conflict(employee_id,work_date) do update
      set status=excluded.status,updated_at=now();
  return jsonb_build_object('work_date',day,'status',p_status);
end $$;
revoke all on function public.dh_worker_day_state(),public.dh_workday_attend(text) from public,anon;
grant execute on function public.dh_worker_day_state(),public.dh_workday_attend(text) to authenticated;

-- 계획서는 계획서로 남습니다. 지난 작업일의 뒤늦은 공개만 막습니다.
create or replace function fieldnote_v6.guard_past_permit_publish() returns trigger
language plpgsql set search_path='' as $$
begin
  if old.published_at is null and new.published_at is not null
     and new.work_date < public.dh_current_work_day() then
    raise exception '지난 작업일의 계획서는 작업허가서로 공개할 수 없습니다';
  end if;
  return new;
end $$;
drop trigger if exists guard_past_permit_publish on fieldnote_v6.permit;
create trigger guard_past_permit_publish before update of published_at on fieldnote_v6.permit
for each row execute function fieldnote_v6.guard_past_permit_publish();
revoke all on function fieldnote_v6.guard_past_permit_publish() from public,anon,authenticated;

-- 임시 공유를 만들거나 게시할 때 모두 현재 작업일의 허가서인지 검사합니다.
create or replace function fieldnote_v6.assert_active_share(p_permit uuid) returns void
language plpgsql set search_path='' as $$
begin
  if not exists(
    select 1 from fieldnote_v6.permit p
    where p.id=p_permit and p.published_at is not null
      and p.work_date=public.dh_current_work_day()
      and not exists(select 1 from fieldnote_v6.work_report r
                     where r.permit_id=p.id and r.submitted_at is not null)
  ) then
    raise exception '현재 작업일의 진행 중인 작업허가서에만 현장공유를 게시할 수 있습니다';
  end if;
end $$;
create or replace function fieldnote_v6.guard_share_link_workday() returns trigger
language plpgsql set search_path='' as $$
begin
  perform fieldnote_v6.assert_active_share(new.permit_id);
  return new;
end $$;
drop trigger if exists guard_share_link_workday on fieldnote_v6.share_permit;
create trigger guard_share_link_workday before insert or update on fieldnote_v6.share_permit
for each row execute function fieldnote_v6.guard_share_link_workday();

create or replace function fieldnote_v6.guard_share_post_workday() returns trigger
language plpgsql set search_path='' as $$
declare linked uuid;
begin
  if new.kind='share' and (new.posted_at is distinct from old.posted_at
      or new.body is distinct from old.body) then
    select permit_id into linked from fieldnote_v6.share_permit where message_id=new.id;
    if linked is not null then perform fieldnote_v6.assert_active_share(linked); end if;
  end if;
  return new;
end $$;
drop trigger if exists guard_share_post_workday on fieldnote_v6.message;
create trigger guard_share_post_workday before update on fieldnote_v6.message
for each row execute function fieldnote_v6.guard_share_post_workday();
revoke all on function fieldnote_v6.assert_active_share(uuid),
  fieldnote_v6.guard_share_link_workday(),fieldnote_v6.guard_share_post_workday()
  from public,anon,authenticated;

-- 미종료 작업은 기간 제한 없이 원래 허가서와 함께 다시 열 수 있습니다.
create or replace function public.dh_my_unclosed_permits() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare actor uuid:=dh_private.require_actor();
  rec record; snapshot jsonb; permit_json jsonb; result jsonb:='[]'::jsonb;
begin
  for rec in
    select p.id,p.work_date from fieldnote_v6.work_start s
    join fieldnote_v6.permit p on p.id=s.permit_id
    where s.started_by=actor and p.published_at is not null
      and not exists(select 1 from fieldnote_v6.work_report r
                     where r.permit_id=p.id and r.submitted_at is not null)
    order by p.work_date desc
  loop
    snapshot:=public.dh_worker_snapshot(rec.work_date,rec.work_date);
    select value into permit_json
      from jsonb_array_elements(coalesce(snapshot->'permits','[]'::jsonb)) x(value)
      where value->>'id'=rec.id::text limit 1;
    if permit_json is not null then result:=result||jsonb_build_array(permit_json); end if;
    permit_json:=null;
  end loop;
  return result;
end $$;
revoke all on function public.dh_my_unclosed_permits() from public,anon;
grant execute on function public.dh_my_unclosed_permits() to authenticated;

-- 보관된 하루 기록: 허가된 작업만 포함합니다. 원본 데이터가 보존되므로
-- 종료 보고와 승인이 나중에 들어와도 원래 작업일의 기록에 즉시 반영됩니다.
create or replace function public.dh_admin_day_archive(p_from date,p_to date) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare actor uuid:=dh_private.require_actor(array['owner','manager']);
begin
  if p_from is null or p_to is null or p_to<p_from or p_to-p_from>31 then
    raise exception '조회 기간은 최대 32일입니다';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'permit_id',p.id,'work_date',p.work_date,'site_name',p.site_name_snapshot,
      'location',p.location_description,'instructions',p.special_instructions,
      'status',case when r.approved_at is not null then '승인완료'
                    when r.review_status='pending' then '승인대기'
                    when r.review_status='rejected' then '보완요청'
                    else '미종료' end,
      'report_id',r.id,
      'tasks',coalesce((select jsonb_agg(jsonb_build_object(
        'name',t.name,'target',t.target_quantity,'actual',rt.actual_quantity,'unit',t.unit)
        order by t.sort_order)
        from fieldnote_v6.permit_task t
        left join fieldnote_v6.report_task rt on rt.task_id=t.id and rt.report_id=r.id
        where t.permit_id=p.id),'[]'::jsonb),
      'shares',coalesce((select jsonb_agg(jsonb_build_object(
        'id',m.id,'sender',e.name,'posted_at',m.posted_at,'body',m.body,
        'files',coalesce((select jsonb_agg(jsonb_build_object(
          'id',f.id,'bucket',f.bucket,'path',f.object_path,
          'filename',f.filename,'mime',f.mime_type) order by mf.sort_order)
          from fieldnote_v6.message_file mf
          join fieldnote_v6.file_asset f on f.id=mf.file_id
          where mf.message_id=m.id),'[]'::jsonb),
        'updates',coalesce((select jsonb_agg(jsonb_build_object(
          'author',ue.name,'created_at',u.created_at,'flow',u.flow,
          'outcome',u.outcome,'resolved',u.resolved) order by u.created_at)
          from fieldnote_v6.situation_update u
          join fieldnote_v6.employee ue on ue.id=u.author_id
          where u.situation_id=m.id),'[]'::jsonb)
        ) order by m.posted_at,m.id)
        from fieldnote_v6.share_permit sp
        join fieldnote_v6.message m on m.id=sp.message_id and m.posted_at is not null
        join fieldnote_v6.employee e on e.id=m.sender_id
        where sp.permit_id=p.id),'[]'::jsonb)
    ) order by p.work_date,p.site_name_snapshot,p.id)
    from fieldnote_v6.permit p
    left join fieldnote_v6.work_report r on r.permit_id=p.id
    where p.published_at is not null and p.work_date between p_from and p_to
      and p.work_date<public.dh_current_work_day()
  ),'[]'::jsonb);
end $$;
revoke all on function public.dh_admin_day_archive(date,date) from public,anon;
grant execute on function public.dh_admin_day_archive(date,date) to authenticated;

create or replace function public.dh_start_work(p_permit uuid,p_photos jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid:=dh_private.require_actor(array['foreman']);
  p fieldnote_v6.permit; prior fieldnote_v6.work_start; item jsonb;
  existing jsonb; v_file uuid; v_kind text; n integer:=0;
begin
  select * into p from fieldnote_v6.permit where id=p_permit for update;
  if not found or p.published_at is null or p.work_date<>public.dh_current_work_day() then
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


notify pgrst,'reload schema';
commit;
