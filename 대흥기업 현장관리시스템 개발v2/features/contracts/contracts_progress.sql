-- 관리자 계약 수량 진행현황. 기존 데이터는 변경하지 않습니다.
-- 기존 V6 및 계약내역 설치 후 Supabase SQL Editor에서 실행합니다.
begin;

create or replace function public.dh_contract_progress_snapshot(p_site uuid default null)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare
  actor uuid := dh_private.require_actor(array['owner','manager']);
begin
  -- V6 설치본마다 실적 열 이름이 다를 수 있으므로 모르는 형식은 0으로 처리하지 않습니다.
  if not exists (
    select 1 from pg_catalog.pg_attribute
    where attrelid='fieldnote_v6.report_task'::regclass
      and attname in ('task_id','permit_task_id') and not attisdropped
  ) or not exists (
    select 1 from pg_catalog.pg_attribute
    where attrelid='fieldnote_v6.report_task'::regclass
      and attname in ('actual','actual_quantity') and not attisdropped
  ) then
    raise exception '작업종료 실적 열 구성을 확인하세요';
  end if;

  return coalesce((
    with submitted as (
      select pt.contract_item_id,
             sum(coalesce(to_jsonb(rt)->>'actual_quantity',to_jsonb(rt)->>'actual','0')::numeric) as actual_quantity
      from fieldnote_v6.permit_task pt
      join fieldnote_v6.report_task rt
        on coalesce(to_jsonb(rt)->>'task_id',to_jsonb(rt)->>'permit_task_id')=pt.id::text
      join fieldnote_v6.work_report wr
        on wr.id=rt.report_id and wr.permit_id=pt.permit_id and wr.submitted_at is not null
      where pt.contract_item_id is not null
      group by pt.contract_item_id
    )
    select jsonb_agg(jsonb_build_object(
      'id',c.id,'site_id',c.site_id,'name',c.name,'unit',c.unit,
      'target_quantity',c.target_quantity,'actual_quantity',coalesce(s.actual_quantity,0)
    ) order by c.site_id,c.name,c.id)
    from fieldnote_v6.contract_item c
    left join submitted s on s.contract_item_id=c.id
    where c.active and (p_site is null or c.site_id=p_site)
  ),'[]'::jsonb);
end $$;

revoke all on function public.dh_contract_progress_snapshot(uuid) from public,anon;
grant execute on function public.dh_contract_progress_snapshot(uuid) to authenticated;
notify pgrst,'reload schema';
commit;
