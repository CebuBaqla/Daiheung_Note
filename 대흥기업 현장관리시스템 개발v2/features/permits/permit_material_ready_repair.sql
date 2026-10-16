-- 이미 permit_material_ready.sql을 실행한 DB에서 저장 함수만 교체합니다.
-- Supabase SQL Editor의 비어 있는 새 쿼리에 이 파일 내용만 붙여넣어 실행하세요.
create or replace function public.dh_save_permit_ready(p_data jsonb)
returns uuid
language plpgsql security definer set search_path = '' as $function$
declare
  actor uuid := dh_private.require_actor(array['owner', 'manager']);
  v_permit_id uuid;
  saved jsonb;
  is_ready boolean := coalesce((p_data->>'material_ready')::boolean, false);
begin
  select to_jsonb(public.dh_save_permit(
    (p_data - 'material_ready') || jsonb_build_object(
      'materials', coalesce(p_data->'materials', '[]'::jsonb)
    )
  )) into saved;

  v_permit_id := coalesce(
    nullif(p_data->>'id', '')::uuid,
    (case
      when jsonb_typeof(saved) = 'string' then saved #>> '{}'
      when jsonb_typeof(saved) = 'object' then saved->>'id'
    end)::uuid
  );
  if v_permit_id is null then
    raise exception '작업계획서 저장 결과에 ID가 없습니다';
  end if;

  insert into fieldnote_v6.permit_material_ready(permit_id, ready)
    values (v_permit_id, is_ready)
    on conflict on constraint permit_material_ready_pkey do update
      set ready = excluded.ready, updated_at = now();
  return v_permit_id;
end;
$function$;

notify pgrst, 'reload schema';
