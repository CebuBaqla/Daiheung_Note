-- 자재 준비 완료 전에는 작업계획서 결재 요청을 허용하지 않습니다.
-- permit_material_ready.sql 적용 후 실행합니다. 기존 결재 기록은 변경하지 않습니다.
begin;

create or replace function fieldnote_v6.guard_permit_request_material_ready()
returns trigger language plpgsql set search_path='' as $$
declare ready_now boolean;
begin
  -- 최초 요청과 반려 후 재요청 모두 검사합니다. 결재 단계 변경은 막지 않습니다.
  if tg_op = 'INSERT' then
    null;
  elsif new.stage is distinct from 'first_pending'
      or old.stage is not distinct from new.stage then
    return new;
  end if;

  select r.ready into ready_now
    from fieldnote_v6.permit_material_ready r
    where r.permit_id = new.permit_id;
  if not coalesce(ready_now, false) then
    raise exception '자재 준비 완료를 저장한 뒤 결재를 요청하세요';
  end if;
  return new;
end $$;

drop trigger if exists guard_permit_request_material_ready on fieldnote_v6.permit_approval;
create trigger guard_permit_request_material_ready
before insert or update on fieldnote_v6.permit_approval
for each row execute function fieldnote_v6.guard_permit_request_material_ready();

revoke all on function fieldnote_v6.guard_permit_request_material_ready()
  from public, anon, authenticated;
commit;
