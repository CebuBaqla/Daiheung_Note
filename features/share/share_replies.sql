-- 모바일 현장공유의 답장 관계. share_permit.sql과 workday_archive.sql 적용 후 실행합니다.
-- 기존 메시지·파일·상황발생 기록은 변경하지 않습니다.
begin;

create table if not exists fieldnote_v6.share_reply (
  child_message_id uuid primary key references fieldnote_v6.message(id) on delete cascade,
  parent_message_id uuid not null references fieldnote_v6.message(id),
  created_at timestamptz not null default now(),
  check (child_message_id <> parent_message_id)
);
create index if not exists share_reply_parent_idx
  on fieldnote_v6.share_reply(parent_message_id);
alter table fieldnote_v6.share_reply enable row level security;
revoke all on fieldnote_v6.share_reply from public, anon, authenticated;

create or replace function public.dh_link_share_reply(p_child uuid, p_parent uuid)
returns uuid language plpgsql security definer set search_path='' as $$
declare
  actor uuid := dh_private.require_actor();
  child_site uuid;
  child_permit uuid;
  child_posted timestamptz;
  parent_site uuid;
  parent_permit uuid;
  existing_parent uuid;
begin
  if p_child is null or p_parent is null or p_child = p_parent then
    raise exception '답장할 글을 확인하세요';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_child::text, 0));

  select m.site_id, sp.permit_id, m.posted_at
    into child_site, child_permit, child_posted
    from fieldnote_v6.message m
    join fieldnote_v6.share_permit sp on sp.message_id = m.id
    where m.id = p_child and m.kind = 'share' and m.sender_id = actor
    for update of m;
  if not found then
    raise exception '본인이 작성 중인 현장공유만 답장으로 연결할 수 있습니다'
      using errcode = '42501';
  end if;

  select m.site_id, sp.permit_id into parent_site, parent_permit
    from fieldnote_v6.message m
    join fieldnote_v6.share_permit sp on sp.message_id = m.id
    where m.id = p_parent and m.kind = 'share' and m.posted_at is not null;
  if not found or child_site is distinct from parent_site
      or child_permit is distinct from parent_permit
      or not dh_private.can_read_message(p_parent) then
    raise exception '같은 작업허가서의 공개된 현장공유에만 답장할 수 있습니다';
  end if;

  select parent_message_id into existing_parent
    from fieldnote_v6.share_reply where child_message_id = p_child;
  if found then
    if existing_parent <> p_parent then
      raise exception '이미 다른 글에 연결된 답장입니다';
    end if;
    return p_child;
  end if;
  if child_posted is not null then
    raise exception '게시된 현장공유에는 답장 관계를 추가할 수 없습니다';
  end if;
  insert into fieldnote_v6.share_reply(child_message_id, parent_message_id)
    values (p_child, p_parent);
  return p_child;
end $$;

create or replace function public.dh_share_reply_links(p_ids uuid[])
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare actor uuid := dh_private.require_actor();
begin
  if coalesce(array_length(p_ids, 1), 0) > 1000 then
    raise exception '답장 조회 건수가 너무 많습니다';
  end if;
  return coalesce((select jsonb_object_agg(r.child_message_id::text,
      r.parent_message_id::text)
    from fieldnote_v6.share_reply r
    where r.child_message_id = any(coalesce(p_ids, '{}'::uuid[]))
      and dh_private.can_read_message(r.child_message_id)
      and dh_private.can_read_message(r.parent_message_id)), '{}'::jsonb);
end $$;

revoke all on function public.dh_link_share_reply(uuid, uuid),
  public.dh_share_reply_links(uuid[]) from public, anon;
grant execute on function public.dh_link_share_reply(uuid, uuid),
  public.dh_share_reply_links(uuid[]) to authenticated;
notify pgrst, 'reload schema';
commit;
