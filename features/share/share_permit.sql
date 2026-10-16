-- 기능: 현장공유 (모든 공유를 승인된 작업허가서 하나에 연결, 상황발생 표시 저장)
-- 설치 순서 3/3 · 상황발생 SQL을 먼저 설치하세요.
-- 사용 화면: features/share/mobile.js, features/share/admin.js
begin;

do $$ begin
 if to_regclass('fieldnote_v6.share_permit') is not null then
  raise exception '현장공유-허가서 연결이 이미 설치되었습니다';
 end if;
 if to_regclass('fieldnote_v6.situation') is null then
  raise exception '상황발생 SQL을 먼저 설치하세요';
 end if;
end $$;

-- Link each field share to exactly one published work permit.
create table fieldnote_v6.share_permit (
 message_id uuid primary key,
 site_id uuid not null,
 permit_id uuid not null,
 foreign key(message_id,site_id) references fieldnote_v6.message(id,site_id),
 foreign key(permit_id,site_id) references fieldnote_v6.permit(id,site_id)
);
create index share_permit_permit_idx on fieldnote_v6.share_permit(permit_id);
alter table fieldnote_v6.share_permit enable row level security;
grant select on fieldnote_v6.share_permit to authenticated;
create policy dh_read on fieldnote_v6.share_permit for select to authenticated
 using (dh_private.can_read_message(message_id));

create or replace function public.dh_save_share(p_data jsonb) returns uuid
 language plpgsql security definer set search_path='' as $$
declare actor uuid:=dh_private.require_actor();
 result uuid:=coalesce((p_data->>'id')::uuid,gen_random_uuid());
 p fieldnote_v6.permit; files uuid[]; m fieldnote_v6.message;
 is_issue boolean:=coalesce((p_data->>'is_situation')::boolean,false);
begin
 perform pg_advisory_xact_lock(hashtextextended(result::text,0));
 select * into strict p from fieldnote_v6.permit
  where id=(p_data->>'permit_id')::uuid and published_at is not null;
 if nullif(p_data->>'site_id','')::uuid is distinct from p.site_id then
  raise exception '현장과 작업허가서가 일치하지 않습니다';
 end if;
 select * into m from fieldnote_v6.message where id=result for update;
 if found and (m.sender_id<>actor or m.kind<>'share' or m.posted_at is not null) then
  raise exception '수정할 수 없는 메시지입니다' using errcode='42501';
 end if;
 if exists(select 1 from fieldnote_v6.share_permit
  where message_id=result and permit_id<>p.id) then
  raise exception '이미 다른 허가서에 연결된 공유입니다';
 end if;
 if is_issue and nullif(btrim(p_data->>'body'),'') is null then
  raise exception '발생한 문제를 입력하세요';
 end if;
 select coalesce(array_agg(value::uuid),'{}'::uuid[]) into files
  from jsonb_array_elements_text(coalesce(p_data->'files','[]'::jsonb));
 perform dh_private.check_file_list(p.site_id,files);
 delete from fieldnote_v6.message_file where message_id=result;
 insert into fieldnote_v6.message(id,site_id,sender_id,kind,body)
  values(result,p.site_id,actor,'share',p_data->>'body')
  on conflict(id) do update set body=excluded.body;
 insert into fieldnote_v6.share_permit(message_id,site_id,permit_id)
  values(result,p.site_id,p.id) on conflict(message_id) do nothing;
 insert into fieldnote_v6.message_file(message_id,site_id,file_id,sort_order)
  select result,p.site_id,f,ord::int from unnest(files) with ordinality as x(f,ord);
 if is_issue then
  insert into fieldnote_v6.situation(id,site_id,permit_id,owner_id,description)
   values(result,p.site_id,p.id,p.created_by,btrim(p_data->>'body'))
   on conflict(id) do update set description=excluded.description;
 elsif exists(select 1 from fieldnote_v6.situation where id=result) then
  raise exception '상황발생 표시를 해제할 수 없습니다';
 end if;
 return result;
end $$;

create or replace function public.dh_post_share(p_id uuid) returns uuid
 language plpgsql security definer set search_path='' as $$
declare actor uuid:=dh_private.require_actor();
begin
 perform 1 from fieldnote_v6.message m join fieldnote_v6.share_permit l on l.message_id=m.id
  where m.id=p_id and m.sender_id=actor for update of m;
 if not found then raise exception '허가서에 연결된 본인 공유만 게시할 수 있습니다' using errcode='42501'; end if;
 return fieldnote_v6.post_share(p_id);
end $$;

revoke all on function public.dh_save_share(jsonb),
 public.dh_post_share(uuid) from public,anon;
grant execute on function public.dh_save_share(jsonb),
 public.dh_post_share(uuid) to authenticated;
notify pgrst,'reload schema';
commit;
