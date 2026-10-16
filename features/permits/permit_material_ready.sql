-- 작업계획서 단위의 자재 준비 상태. 기존 예정 자재/보고 기록은 삭제하지 않습니다.
-- 기존 V6 설치 후 Supabase SQL Editor에서 실행합니다. 함수 수정 시 재실행할 수 있습니다.
begin;

create table if not exists fieldnote_v6.permit_material_ready (
  permit_id uuid primary key references fieldnote_v6.permit(id) on delete cascade,
  ready boolean not null default false,
  updated_at timestamptz not null default now()
);
alter table fieldnote_v6.permit_material_ready enable row level security;
revoke all on fieldnote_v6.permit_material_ready from public, anon, authenticated;

-- 작업계획서와 준비 상태를 한 트랜잭션으로 저장합니다.
create or replace function public.dh_save_permit_ready(p_data jsonb) returns uuid
language plpgsql security definer set search_path='' as $$
declare
  actor uuid := dh_private.require_actor(array['owner','manager']);
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
    nullif(p_data->>'id','')::uuid,
    (case when jsonb_typeof(saved) = 'string' then saved #>> '{}'
          when jsonb_typeof(saved) = 'object' then saved->>'id' end)::uuid
  );
  if v_permit_id is null then raise exception '작업계획서 저장 결과에 ID가 없습니다'; end if;
  insert into fieldnote_v6.permit_material_ready(permit_id, ready)
    values (v_permit_id, is_ready)
    on conflict on constraint permit_material_ready_pkey do update
      set ready = excluded.ready, updated_at = now();
  return v_permit_id;
end $$;

create or replace function public.dh_admin_permit_material_ready(p_ids uuid[]) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare
  actor uuid := dh_private.require_actor(array['owner','manager']);
  result jsonb;
begin
  select coalesce(jsonb_object_agg(p.id::text, coalesce(r.ready, false)), '{}'::jsonb)
    into result
  from fieldnote_v6.permit p
  left join fieldnote_v6.permit_material_ready r on r.permit_id = p.id
  where p.id = any(coalesce(p_ids, '{}'::uuid[]));
  return result;
end $$;

create or replace function public.dh_worker_permit_material_ready(p_ids uuid[]) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare
  actor uuid := dh_private.require_actor();
  result jsonb;
begin
  select coalesce(jsonb_object_agg(p.id::text, coalesce(r.ready, false)), '{}'::jsonb)
    into result
  from fieldnote_v6.permit p
  left join fieldnote_v6.permit_material_ready r on r.permit_id = p.id
  where p.id = any(coalesce(p_ids, '{}'::uuid[])) and p.published_at is not null;
  return result;
end $$;

revoke all on function public.dh_save_permit_ready(jsonb),
  public.dh_admin_permit_material_ready(uuid[]),
  public.dh_worker_permit_material_ready(uuid[]) from public, anon;
grant execute on function public.dh_save_permit_ready(jsonb),
  public.dh_admin_permit_material_ready(uuid[]),
  public.dh_worker_permit_material_ready(uuid[]) to authenticated;
notify pgrst, 'reload schema';
commit;
