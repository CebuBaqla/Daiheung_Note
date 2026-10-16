-- 기능: 상황발생 (현장공유에서 올린 문제 → 허가서 작성자의 후속 기록)
-- 설치 순서 2/3 · 현장공유 SQL(dh_save_share)이 이 테이블을 사용하므로 먼저 설치합니다.
-- 사용 화면: features/situation/admin.js, features/situation/mobile.js
begin;

do $$ begin
 if to_regclass('fieldnote_v6.situation') is not null then
  raise exception '상황발생이 이미 설치되었습니다';
 end if;
end $$;

create table fieldnote_v6.situation (
 id uuid primary key,
 site_id uuid not null,
 permit_id uuid not null,
 owner_id uuid not null references fieldnote_v6.employee(id),
 description text not null check (btrim(description)<>''),
 status text not null default 'open' check (status in ('open','resolved')),
 created_at timestamptz not null default now(),
 resolved_at timestamptz,
 foreign key(id,site_id) references fieldnote_v6.message(id,site_id),
 foreign key(permit_id,site_id) references fieldnote_v6.permit(id,site_id),
 check ((status='open' and resolved_at is null) or
        (status='resolved' and resolved_at is not null))
);
create table fieldnote_v6.situation_update (
 id uuid primary key default gen_random_uuid(),
 situation_id uuid not null references fieldnote_v6.situation(id),
 author_id uuid not null references fieldnote_v6.employee(id),
 flow text not null check (btrim(flow)<>''),
 outcome text,
 resolved boolean not null default false,
 created_at timestamptz not null default now(),
 check (not resolved or nullif(btrim(outcome),'') is not null)
);
create index situation_owner_status_idx on fieldnote_v6.situation(owner_id,status,created_at desc);
create index situation_update_case_idx on fieldnote_v6.situation_update(situation_id,created_at);
alter table fieldnote_v6.situation enable row level security;
alter table fieldnote_v6.situation_update enable row level security;
grant select on fieldnote_v6.situation,fieldnote_v6.situation_update to authenticated;
create policy dh_read on fieldnote_v6.situation for select to authenticated
 using (dh_private.can_read_message(id));
create policy dh_read on fieldnote_v6.situation_update for select to authenticated
 using (exists(select 1 from fieldnote_v6.situation s
  where s.id=situation_id and dh_private.can_read_message(s.id)));

-- dh_situation_snapshot은 share_permit도 읽습니다(설치 순서 3에서 생성). 함수는 호출 시점에만 테이블을 확인합니다.
create function public.dh_add_situation_update(p_data jsonb) returns uuid
 language plpgsql security definer set search_path='' as $$
declare actor uuid:=dh_private.require_actor();
 result uuid:=coalesce((p_data->>'id')::uuid,gen_random_uuid());
 s fieldnote_v6.situation; old_update fieldnote_v6.situation_update;
 flow_text text:=nullif(btrim(p_data->>'flow'),'');
 outcome_text text:=nullif(btrim(p_data->>'outcome'),'');
 done boolean:=coalesce((p_data->>'resolved')::boolean,false);
begin
 select * into strict s from fieldnote_v6.situation
  where id=(p_data->>'situation_id')::uuid for update;
 if s.owner_id<>actor then
  raise exception '허가서 작성자인 현장 담당자만 기록할 수 있습니다' using errcode='42501';
 end if;
 select * into old_update from fieldnote_v6.situation_update where id=result;
 if found then
  if old_update.situation_id<>s.id or old_update.author_id<>actor then
   raise exception '이미 사용한 기록 ID입니다';
  end if;
  return result;
 end if;
 if s.status<>'open' then raise exception '이미 해결된 상황입니다'; end if;
 if flow_text is null or (done and outcome_text is null) then
  raise exception '확인 흐름과 해결 결과를 입력하세요';
 end if;
 insert into fieldnote_v6.situation_update(id,situation_id,author_id,flow,outcome,resolved)
  values(result,s.id,actor,flow_text,outcome_text,done);
 if done then
  update fieldnote_v6.situation set status='resolved',resolved_at=now() where id=s.id;
 end if;
 return result;
end $$;

create function public.dh_situation_snapshot(p_from date,p_to date) returns jsonb
 language plpgsql stable security definer set search_path='' as $$
declare actor uuid:=dh_private.require_actor();
begin
 if p_to<p_from or p_to-p_from>45 then raise exception '조회 기간이 올바르지 않습니다'; end if;
 return jsonb_build_object(
  'authored_permits',coalesce((select jsonb_agg(p.id order by p.work_date desc)
   from fieldnote_v6.permit p where p.created_by=actor and p.published_at is not null),'[]'::jsonb),
  'share_links',coalesce((select jsonb_agg(jsonb_build_object(
   'message_id',l.message_id,'permit_id',l.permit_id))
   from fieldnote_v6.share_permit l join fieldnote_v6.message m on m.id=l.message_id
   where m.posted_at is not null and
    (m.posted_at at time zone 'Asia/Seoul')::date between p_from and p_to),'[]'::jsonb),
  'situations',coalesce((select jsonb_agg(jsonb_build_object(
   'id',s.id,'permit_id',s.permit_id,'site_id',s.site_id,
   'site_name',p.site_name_snapshot,'work_date',p.work_date,
   'owner_id',s.owner_id,'owner_name',owner.name,'reporter_name',reporter.name,
   'description',s.description,'status',s.status,'created_at',s.created_at,
   'resolved_at',s.resolved_at,
   'updates',coalesce((select jsonb_agg(jsonb_build_object(
    'id',u.id,'flow',u.flow,'outcome',u.outcome,'resolved',u.resolved,
    'author_name',author.name,'created_at',u.created_at) order by u.created_at,u.id)
    from fieldnote_v6.situation_update u
    join fieldnote_v6.employee author on author.id=u.author_id
    where u.situation_id=s.id),'[]'::jsonb)
  ) order by s.created_at desc)
  from fieldnote_v6.situation s
  join fieldnote_v6.message m on m.id=s.id and m.posted_at is not null
  join fieldnote_v6.permit p on p.id=s.permit_id
  join fieldnote_v6.employee owner on owner.id=s.owner_id
  join fieldnote_v6.employee reporter on reporter.id=m.sender_id),'[]'::jsonb)
 );
end $$;

revoke all on function public.dh_add_situation_update(jsonb),
 public.dh_situation_snapshot(date,date) from public,anon;
grant execute on function public.dh_add_situation_update(jsonb),
 public.dh_situation_snapshot(date,date) to authenticated;
notify pgrst,'reload schema';
commit;
