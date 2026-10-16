-- 기능: 현장 및 영업 관리 (발주처·원도급 회사, 담당자 이력)
-- 설치 순서 1/3 · 기존 V6 모바일 연결 기능(dh_worker_snapshot)이 먼저 설치되어 있어야 합니다.
-- 사용 화면: features/sites/admin.js
begin;

do $$ begin
 if to_regclass('fieldnote_v6.sales_organization') is not null then
  raise exception '영업관리가 이미 설치되었습니다';
 end if;
 if to_regprocedure('public.dh_worker_snapshot(date,date)') is null then
  raise exception '기존 모바일 연결 기능을 먼저 설치하세요';
 end if;
end $$;

create table fieldnote_v6.sales_organization (
 id uuid primary key default gen_random_uuid(),
 name text not null unique check (btrim(name)<>''),
 created_at timestamptz not null default now()
);
create table fieldnote_v6.sales_contact (
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null references fieldnote_v6.sales_organization(id),
 name text not null check (btrim(name)<>''),
 position text,
 phone text,
 email text,
 active boolean not null default true,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
create table fieldnote_v6.sales_site_party (
 site_id uuid not null references fieldnote_v6.site(id),
 party_role text not null check (party_role in ('client','prime')),
 organization_id uuid not null references fieldnote_v6.sales_organization(id),
 primary key(site_id,party_role)
);
create table fieldnote_v6.sales_site_contact (
 id uuid primary key default gen_random_uuid(),
 site_id uuid not null references fieldnote_v6.site(id),
 party_role text not null check (party_role in ('client','prime')),
 contact_id uuid not null references fieldnote_v6.sales_contact(id),
 assigned_on date not null default (now() at time zone 'Asia/Seoul')::date,
 ended_on date,
 check (ended_on is null or ended_on>=assigned_on)
);
create unique index sales_site_contact_active
 on fieldnote_v6.sales_site_contact(site_id,party_role,contact_id)
 where ended_on is null;
create index sales_site_contact_history
 on fieldnote_v6.sales_site_contact(contact_id,assigned_on desc);

-- Keep the one existing site's organization names when moving to the new structure.
insert into fieldnote_v6.sales_organization(name)
 select distinct btrim(client_name) from fieldnote_v6.site
 where nullif(btrim(client_name),'') is not null
union
 select distinct btrim(prime_contractor) from fieldnote_v6.site
 where nullif(btrim(prime_contractor),'') is not null
on conflict(name) do nothing;
insert into fieldnote_v6.sales_site_party(site_id,party_role,organization_id)
 select s.id,'client',o.id from fieldnote_v6.site s
 join fieldnote_v6.sales_organization o on o.name=btrim(s.client_name)
 where nullif(btrim(s.client_name),'') is not null;
insert into fieldnote_v6.sales_site_party(site_id,party_role,organization_id)
 select s.id,'prime',o.id from fieldnote_v6.site s
 join fieldnote_v6.sales_organization o on o.name=btrim(s.prime_contractor)
 where nullif(btrim(s.prime_contractor),'') is not null;

-- Contact details are available through manager-only RPCs, not direct table reads.
alter table fieldnote_v6.sales_organization enable row level security;
alter table fieldnote_v6.sales_contact enable row level security;
alter table fieldnote_v6.sales_site_party enable row level security;
alter table fieldnote_v6.sales_site_contact enable row level security;
revoke all on fieldnote_v6.sales_organization,fieldnote_v6.sales_contact,
 fieldnote_v6.sales_site_party,fieldnote_v6.sales_site_contact from public,anon,authenticated;

create function public.dh_sales_snapshot() returns jsonb
 language plpgsql stable security definer set search_path='' as $$
declare actor uuid:=dh_private.require_actor(array['owner','manager']);
begin
 return jsonb_build_object(
  'organizations',coalesce((select jsonb_agg(jsonb_build_object(
   'id',id,'name',name) order by name) from fieldnote_v6.sales_organization),'[]'::jsonb),
  'contacts',coalesce((select jsonb_agg(jsonb_build_object(
   'id',id,'organization_id',organization_id,'name',name,'position',position,
   'phone',phone,'email',email,'active',active) order by name)
   from fieldnote_v6.sales_contact),'[]'::jsonb),
  'parties',coalesce((select jsonb_agg(jsonb_build_object(
   'site_id',site_id,'party_role',party_role,'organization_id',organization_id))
   from fieldnote_v6.sales_site_party),'[]'::jsonb),
  'assignments',coalesce((select jsonb_agg(jsonb_build_object(
   'id',id,'site_id',site_id,'party_role',party_role,'contact_id',contact_id,
   'assigned_on',assigned_on,'ended_on',ended_on) order by assigned_on desc)
   from fieldnote_v6.sales_site_contact),'[]'::jsonb)
 );
end $$;

create function public.dh_save_sales_site(p_data jsonb) returns uuid
 language plpgsql security definer set search_path='' as $$
declare actor uuid:=dh_private.require_actor(array['owner','manager']);
 result uuid:=coalesce((p_data->>'id')::uuid,gen_random_uuid());
 role_name text; name_key text; contacts_key text; company_name text;
 contacts jsonb; item jsonb; org uuid; contact uuid; old_org uuid;
 wanted uuid[]; site_result uuid;
begin
 if jsonb_typeof(p_data)<>'object' or nullif(btrim(p_data->>'name'),'') is null then
  raise exception '현장명을 입력하세요';
 end if;
 perform pg_advisory_xact_lock(hashtextextended(result::text,0));
 site_result:=public.dh_admin_save_master('site',p_data||jsonb_build_object('id',result));
 foreach role_name in array array['client','prime'] loop
  name_key:=case when role_name='client' then 'client_name' else 'prime_contractor' end;
  contacts_key:=role_name||'_contacts';
  company_name:=nullif(btrim(p_data->>name_key),'');
  contacts:=coalesce(p_data->contacts_key,'[]'::jsonb);
  if jsonb_typeof(contacts)<>'array' then raise exception '담당자 목록 형식이 올바르지 않습니다'; end if;
  wanted:='{}'::uuid[];
  if company_name is null then
   if jsonb_array_length(contacts)>0 then raise exception '담당자를 등록하려면 회사명을 입력하세요'; end if;
   delete from fieldnote_v6.sales_site_party where site_id=result and party_role=role_name;
  else
   insert into fieldnote_v6.sales_organization(name) values(company_name)
    on conflict(name) do update set name=excluded.name returning id into org;
   insert into fieldnote_v6.sales_site_party(site_id,party_role,organization_id)
    values(result,role_name,org)
    on conflict(site_id,party_role) do update set organization_id=excluded.organization_id;
   for item in select value from jsonb_array_elements(contacts) loop
    if nullif(btrim(item->>'name'),'') is null then raise exception '담당자 이름을 입력하세요'; end if;
    contact:=nullif(item->>'id','')::uuid;
    if contact is not null then
     select organization_id into old_org from fieldnote_v6.sales_contact where id=contact for update;
     if old_org is null or old_org<>org then raise exception '회사와 담당자가 일치하지 않습니다'; end if;
     update fieldnote_v6.sales_contact set
      name=btrim(item->>'name'),position=nullif(btrim(item->>'position'),''),
      phone=nullif(btrim(item->>'phone'),''),email=nullif(btrim(item->>'email'),''),
      active=true,updated_at=now() where id=contact;
    else
     insert into fieldnote_v6.sales_contact(organization_id,name,position,phone,email)
      values(org,btrim(item->>'name'),nullif(btrim(item->>'position'),''),
       nullif(btrim(item->>'phone'),''),nullif(btrim(item->>'email'),''))
      returning id into contact;
    end if;
    wanted:=array_append(wanted,contact);
    perform 1 from fieldnote_v6.sales_site_contact
     where site_id=result and party_role=role_name and contact_id=contact and ended_on is null;
    if not found then
     insert into fieldnote_v6.sales_site_contact(site_id,party_role,contact_id)
      values(result,role_name,contact);
    end if;
  end loop;
  end if;
  update fieldnote_v6.sales_site_contact set
   ended_on=greatest(assigned_on,(now() at time zone 'Asia/Seoul')::date)
   where site_id=result and party_role=role_name and ended_on is null
    and not(contact_id=any(wanted));
 end loop;
 return site_result;
end $$;

revoke all on function public.dh_sales_snapshot(),
 public.dh_save_sales_site(jsonb) from public,anon;
grant execute on function public.dh_sales_snapshot(),
 public.dh_save_sales_site(jsonb) to authenticated;
notify pgrst,'reload schema';
commit;
