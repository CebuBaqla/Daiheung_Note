-- 관리자 달력의 날짜별 채팅 조회. share_replies.sql 적용 후 실행합니다.
-- 채팅은 허가서별 작업일보와 별도로, 한국시간 04:00 기준 작업일에 묶습니다.
begin;

create or replace function public.dh_admin_day_chat(p_day date) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare actor uuid := dh_private.require_actor(array['owner', 'manager']);
begin
  if p_day is null then
    raise exception '조회할 작업일을 선택하세요';
  end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', m.id,
      'posted_at', m.posted_at,
      'sender_name', sender.name,
      'body', m.body,
      'site_name', p.site_name_snapshot,
      'location', p.location_description,
      'permit_id', p.id,
      'is_situation', s.id is not null,
      'reply_to_id', reply.parent_message_id,
      'reply_to_sender', parent_sender.name,
      'reply_to_body', parent.body,
      'reply_to_has_photo', exists (
        select 1 from fieldnote_v6.message_file parent_file
        join fieldnote_v6.file_asset parent_asset on parent_asset.id = parent_file.file_id
        where parent_file.message_id = parent.id and parent_asset.mime_type like 'image/%'
      ),
      'files', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', asset.id,
          'bucket', asset.bucket,
          'path', asset.object_path,
          'filename', asset.filename,
          'mime', asset.mime_type
        ) order by message_file.sort_order)
        from fieldnote_v6.message_file message_file
        join fieldnote_v6.file_asset asset on asset.id = message_file.file_id
        where message_file.message_id = m.id
      ), '[]'::jsonb)
    ) order by m.posted_at, m.id)
    from fieldnote_v6.message m
    join fieldnote_v6.share_permit link on link.message_id = m.id
    join fieldnote_v6.permit p on p.id = link.permit_id
    join fieldnote_v6.employee sender on sender.id = m.sender_id
    left join fieldnote_v6.situation s on s.id = m.id
    left join fieldnote_v6.share_reply reply on reply.child_message_id = m.id
    left join fieldnote_v6.message parent on parent.id = reply.parent_message_id
    left join fieldnote_v6.employee parent_sender on parent_sender.id = parent.sender_id
    where m.kind = 'share'
      and m.posted_at >= ((p_day::timestamp + interval '4 hours') at time zone 'Asia/Seoul')
      and m.posted_at < (((p_day + 1)::timestamp + interval '4 hours') at time zone 'Asia/Seoul')
  ), '[]'::jsonb);
end $$;

revoke all on function public.dh_admin_day_chat(date) from public, anon;
grant execute on function public.dh_admin_day_chat(date) to authenticated;
notify pgrst, 'reload schema';
commit;
