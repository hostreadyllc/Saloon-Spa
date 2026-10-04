-- =====================================================================
-- Salon Ledger v2 — multi-salon, devices and subscriptions
-- © 2026 Hostready LLC
--
-- Run ONCE in Supabase > SQL Editor > New query > Run.
-- Safe to run again (it skips what already exists).
-- Your existing records move into the first salon ("My Salon", code SALON-0001),
-- and every existing login becomes owner of that salon and a Hostready admin.
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------- tables ----------
create table if not exists public.salons (
  id            uuid primary key default gen_random_uuid(),
  code          text not null unique,
  name          text not null,
  plan          text not null default 'Starter',
  device_limit  int  not null default 2,
  status        text not null default 'active' check (status in ('active','suspended')),
  trial_ends    date,
  paid_until    date,
  contact_name  text,
  contact_phone text,
  contact_email text,
  notes         text,
  created_at    timestamptz not null default now()
);

create table if not exists public.admins (
  user_id uuid primary key references auth.users on delete cascade
);

create table if not exists public.members (
  user_id    uuid primary key references auth.users on delete cascade,
  salon_id   uuid not null references public.salons on delete cascade,
  role       text not null default 'staff' check (role in ('owner','staff')),
  name       text,
  email      text,
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.invites (
  email      text primary key,
  salon_id   uuid not null references public.salons on delete cascade,
  role       text not null default 'staff' check (role in ('owner','staff')),
  name       text,
  created_by text,
  created_at timestamptz not null default now()
);

create table if not exists public.devices (
  id          uuid primary key default gen_random_uuid(),
  salon_id    uuid not null references public.salons on delete cascade,
  device_key  text not null,
  name        text,
  platform    text,
  status      text not null default 'pending' check (status in ('pending','approved','revoked')),
  temp_until  timestamptz,
  session_id  text,
  user_email  text,
  first_seen  timestamptz not null default now(),
  last_seen   timestamptz not null default now(),
  approved_at timestamptz,
  approved_by text,
  unique (salon_id, device_key)
);

create sequence if not exists public.invoice_seq start 1;

create table if not exists public.payments (
  id          uuid primary key default gen_random_uuid(),
  salon_id    uuid not null references public.salons on delete cascade,
  invoice_no  text not null unique,
  days        int  not null,
  period_from date not null,
  period_to   date not null,
  amount      numeric(12,2) not null,
  vat         numeric(12,2) not null,
  method      text,
  note        text,
  created_at  timestamptz not null default now(),
  created_by  text
);

create table if not exists public.app_settings (
  key   text primary key,
  value text
);

insert into public.app_settings(key, value) values
  ('support_name',  'Hostready LLC'),
  ('support_phone', ''),
  ('support_email', ''),
  ('bank_details',  ''),
  ('company_trn',   ''),
  ('company_address','')
on conflict (key) do nothing;

-- ---------- move existing data into the first salon ----------
insert into public.salons (code, name, plan, device_limit, trial_ends, paid_until)
select 'SALON-0001', 'My Salon', 'Premium', 10, null, ((now() at time zone 'Asia/Dubai')::date + 365)
where not exists (select 1 from public.salons);

alter table public.records add column if not exists salon_id   uuid references public.salons on delete cascade;
alter table public.records add column if not exists created_at timestamptz not null default now();
update public.records set salon_id = (select id from public.salons order by created_at limit 1) where salon_id is null;
alter table public.records alter column salon_id set not null;

do $$ begin
  if exists (select 1 from information_schema.table_constraints
             where table_schema='public' and table_name='records' and constraint_name='records_pkey') then
    if (select count(*) from information_schema.key_column_usage
        where table_schema='public' and table_name='records' and constraint_name='records_pkey') = 2 then
      alter table public.records drop constraint records_pkey;
      alter table public.records add primary key (salon_id, col, id);
    end if;
  end if;
end $$;
create index if not exists records_salon_col_idx on public.records (salon_id, col);

insert into public.members (user_id, salon_id, role, name, email)
select u.id, (select id from public.salons order by created_at limit 1), 'owner', split_part(u.email,'@',1), u.email
from auth.users u
where not exists (select 1 from public.members m where m.user_id = u.id);

insert into public.admins (user_id)
select u.id from auth.users u
where not exists (select 1 from public.admins) ;

-- ---------- helper functions (run with owner rights so policies stay simple) ----------
create or replace function public.dubai_today() returns date
language sql stable as $$ select (now() at time zone 'Asia/Dubai')::date $$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from admins where user_id = auth.uid())
$$;

create or replace function public.my_salon() returns uuid
language sql stable security definer set search_path = public as $$
  select salon_id from members where user_id = auth.uid() and active
$$;

create or replace function public.my_role() returns text
language sql stable security definer set search_path = public as $$
  select role from members where user_id = auth.uid() and active
$$;

create or replace function public.device_ok() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from devices d
    where d.salon_id = my_salon()
      and d.session_id = (auth.jwt() ->> 'session_id')
      and (d.status = 'approved' or (d.status = 'pending' and d.temp_until > now()))
  )
$$;

create or replace function public.salon_active_until(s salons) returns date
language sql immutable as $$
  select nullif(greatest(coalesce(s.trial_ends, date '1900-01-01'), coalesce(s.paid_until, date '1900-01-01')), date '1900-01-01')
$$;

create or replace function public.salon_writable() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from salons s
    where s.id = my_salon() and s.status = 'active'
      and salon_active_until(s) >= dubai_today()
  )
$$;

-- ---------- row level security ----------
alter table public.records      enable row level security;
alter table public.salons       enable row level security;
alter table public.admins       enable row level security;
alter table public.members      enable row level security;
alter table public.invites      enable row level security;
alter table public.devices      enable row level security;
alter table public.payments     enable row level security;
alter table public.app_settings enable row level security;

drop policy if exists "staff can read"   on public.records;
drop policy if exists "staff can insert" on public.records;
drop policy if exists "staff can update" on public.records;
drop policy if exists "staff can delete" on public.records;
drop policy if exists "salon read"   on public.records;
drop policy if exists "salon insert" on public.records;
drop policy if exists "salon update" on public.records;
drop policy if exists "salon delete" on public.records;

create policy "salon read" on public.records for select to authenticated
  using (salon_id = my_salon() and device_ok());
create policy "salon insert" on public.records for insert to authenticated
  with check (salon_id = my_salon() and device_ok() and salon_writable()
              and (my_role() = 'owner' or col not in ('staff','services','settings')));
create policy "salon update" on public.records for update to authenticated
  using (salon_id = my_salon() and device_ok() and salon_writable()
         and (my_role() = 'owner' or col not in ('staff','services','settings')))
  with check (salon_id = my_salon() and device_ok() and salon_writable()
              and (my_role() = 'owner' or col not in ('staff','services','settings')));
create policy "salon delete" on public.records for delete to authenticated
  using (salon_id = my_salon() and device_ok() and salon_writable()
         and (my_role() = 'owner' or col not in ('staff','services','settings')));

drop policy if exists "read own salon" on public.salons;
create policy "read own salon" on public.salons for select to authenticated using (is_admin() or id = my_salon());
drop policy if exists "read admins" on public.admins;
create policy "read admins" on public.admins for select to authenticated using (is_admin());
drop policy if exists "read members" on public.members;
create policy "read members" on public.members for select to authenticated using (is_admin() or salon_id = my_salon());
drop policy if exists "read invites" on public.invites;
create policy "read invites" on public.invites for select to authenticated using (is_admin() or (salon_id = my_salon() and my_role() = 'owner'));
drop policy if exists "read devices" on public.devices;
create policy "read devices" on public.devices for select to authenticated using (is_admin() or salon_id = my_salon());
drop policy if exists "read payments" on public.payments;
create policy "read payments" on public.payments for select to authenticated using (is_admin() or (salon_id = my_salon() and my_role() = 'owner'));
drop policy if exists "read settings" on public.app_settings;
create policy "read settings" on public.app_settings for select to authenticated using (true);
drop policy if exists "admin settings" on public.app_settings;
create policy "admin settings" on public.app_settings for all to authenticated using (is_admin()) with check (is_admin());

-- ---------- sign-up only by invitation ----------
create or replace function public.gate_signup() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from invites where lower(email) = lower(new.email))
     and not exists (select 1 from members where lower(email) = lower(new.email)) then
    raise exception 'NOT_INVITED: This email has not been invited. Ask your salon owner or Hostready for access.';
  end if;
  return new;
end $$;

create or replace function public.link_invite() returns trigger
language plpgsql security definer set search_path = public as $$
declare i invites;
begin
  select * into i from invites where lower(email) = lower(new.email);
  if found then
    insert into members (user_id, salon_id, role, name, email)
    values (new.id, i.salon_id, i.role, coalesce(i.name, split_part(new.email,'@',1)), new.email)
    on conflict (user_id) do update set salon_id = excluded.salon_id, role = excluded.role, active = true;
    delete from invites where lower(email) = lower(new.email);
  end if;
  return new;
end $$;

drop trigger if exists gate_signup on auth.users;
create trigger gate_signup before insert on auth.users for each row execute function public.gate_signup();
drop trigger if exists link_invite on auth.users;
create trigger link_invite after insert on auth.users for each row execute function public.link_invite();

-- ---------- public: check a salon code before login ----------
create or replace function public.check_salon_code(p_code text) returns json
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select json_build_object('ok', true, 'name', name, 'code', code) from salons where upper(code) = upper(trim(p_code))),
    json_build_object('ok', false))
$$;

-- ---------- status of the signed-in user, salon and this device ----------
create or replace function public.my_status() returns json
language plpgsql stable security definer set search_path = public as $$
declare
  s salons; m members; d devices; approved int; settings json; until date;
begin
  select * into m from members where user_id = auth.uid();
  select json_object_agg(key, value) into settings from app_settings;
  if m.user_id is null or not m.active then
    return json_build_object('admin', is_admin(), 'member', false, 'support', settings);
  end if;
  select * into s from salons where id = m.salon_id;
  select * into d from devices where salon_id = s.id and session_id = (auth.jwt() ->> 'session_id');
  select count(*) into approved from devices where salon_id = s.id and status = 'approved';
  until := salon_active_until(s);
  return json_build_object(
    'admin', is_admin(),
    'member', true,
    'role', m.role,
    'name', m.name,
    'salon', json_build_object(
      'id', s.id, 'code', s.code, 'name', s.name, 'plan', s.plan, 'status', s.status,
      'trial_ends', s.trial_ends, 'paid_until', s.paid_until, 'active_until', until,
      'on_trial', s.trial_ends is not null and (s.paid_until is null or s.paid_until < s.trial_ends),
      'days_left', case when until is null then -1 else until - dubai_today() end,
      'writable', s.status = 'active' and until is not null and until >= dubai_today(),
      'device_limit', s.device_limit, 'devices_approved', approved),
    'device', case when d.id is null then null else json_build_object(
      'id', d.id, 'name', d.name, 'status', d.status, 'temp_until', d.temp_until,
      'ok', d.status = 'approved' or (d.status = 'pending' and d.temp_until > now())) end,
    'today', dubai_today(),
    'support', settings);
end $$;

-- ---------- device registration (called after every sign-in) ----------
create or replace function public.register_device(p_key text, p_name text, p_platform text) returns json
language plpgsql security definer set search_path = public as $$
declare
  s uuid := my_salon(); d devices; sid text := auth.jwt() ->> 'session_id'; open_passes int;
begin
  if s is null then return my_status(); end if;
  if coalesce(p_key, '') = '' or sid is null then raise exception 'Missing device key or session'; end if;
  select * into d from devices where salon_id = s and device_key = p_key;
  if not found then
    -- at most 2 devices can run on a temporary pass at the same time
    select count(*) into open_passes from devices where salon_id = s and status = 'pending' and temp_until > now();
    insert into devices (salon_id, device_key, name, platform, status, temp_until, session_id, user_email)
    values (s, p_key, left(coalesce(nullif(p_name,''), 'Device'), 60), left(p_platform, 40), 'pending',
            case when open_passes < 2 then now() + interval '2 days' else now() end, sid, auth.jwt() ->> 'email')
    returning * into d;
  else
    update devices set session_id = sid, last_seen = now(), user_email = auth.jwt() ->> 'email',
                       platform = coalesce(left(p_platform, 40), platform)
    where id = d.id returning * into d;
  end if;
  update devices set session_id = null where session_id = sid and id <> d.id;
  return my_status();
end $$;

create or replace function public.touch_device() returns void
language sql security definer set search_path = public as $$
  update devices set last_seen = now() where session_id = (auth.jwt() ->> 'session_id')
$$;

-- ---------- device management: owner within plan limit, Hostready for extras ----------
create or replace function public.approve_device(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare d devices; s salons; approved int;
begin
  select * into d from devices where id = p_id;
  if not found then raise exception 'Device not found'; end if;
  select * into s from salons where id = d.salon_id;
  if not is_admin() then
    if my_role() is distinct from 'owner' or d.salon_id <> my_salon() then raise exception 'Only the salon owner can approve devices'; end if;
    select count(*) into approved from devices where salon_id = s.id and status = 'approved' and id <> d.id;
    if approved >= s.device_limit then
      raise exception 'PLAN_LIMIT: Your plan includes % devices. Contact Hostready to add more.', s.device_limit;
    end if;
  end if;
  update devices set status = 'approved', approved_at = now(), approved_by = auth.jwt() ->> 'email' where id = p_id;
end $$;

create or replace function public.revoke_device(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare d devices;
begin
  select * into d from devices where id = p_id;
  if not found then raise exception 'Device not found'; end if;
  if not is_admin() and (my_role() is distinct from 'owner' or d.salon_id <> my_salon()) then
    raise exception 'Only the salon owner can remove devices';
  end if;
  update devices set status = 'revoked', session_id = null, temp_until = null where id = p_id;
end $$;

create or replace function public.rename_device(p_id uuid, p_name text) returns void
language plpgsql security definer set search_path = public as $$
declare d devices;
begin
  select * into d from devices where id = p_id;
  if not found then raise exception 'Device not found'; end if;
  if not is_admin() and d.salon_id <> my_salon() then raise exception 'Not allowed'; end if;
  update devices set name = left(p_name, 60) where id = p_id;
end $$;

-- ---------- team logins ----------
create or replace function public.invite_member(p_salon uuid, p_email text, p_name text, p_role text) returns text
language plpgsql security definer set search_path = public as $$
declare uid uuid; em text := lower(trim(p_email));
begin
  if not is_admin() and (my_role() is distinct from 'owner' or p_salon <> my_salon()) then
    raise exception 'Only the salon owner can add logins';
  end if;
  if p_role not in ('owner','staff') then raise exception 'Role must be owner or staff'; end if;
  if em !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'Enter a valid email address'; end if;
  select id into uid from auth.users where lower(email) = em;
  if uid is not null then
    if exists (select 1 from members where user_id = uid and salon_id <> p_salon and active) then
      raise exception 'This email already belongs to another salon';
    end if;
    insert into members (user_id, salon_id, role, name, email) values (uid, p_salon, p_role, p_name, em)
    on conflict (user_id) do update set salon_id = excluded.salon_id, role = excluded.role, name = coalesce(excluded.name, members.name), active = true;
    return 'linked';
  end if;
  insert into invites (email, salon_id, role, name, created_by) values (em, p_salon, p_role, p_name, auth.jwt() ->> 'email')
  on conflict (email) do update set salon_id = excluded.salon_id, role = excluded.role, name = excluded.name;
  return 'invited';
end $$;

create or replace function public.set_member(p_user uuid, p_role text, p_active boolean) returns void
language plpgsql security definer set search_path = public as $$
declare m members;
begin
  select * into m from members where user_id = p_user;
  if not found then raise exception 'Login not found'; end if;
  if not is_admin() and (my_role() is distinct from 'owner' or m.salon_id <> my_salon()) then raise exception 'Not allowed'; end if;
  if p_user = auth.uid() and (p_active = false or p_role <> 'owner') and not is_admin() then
    raise exception 'You cannot remove your own owner access';
  end if;
  update members set role = coalesce(p_role, role), active = coalesce(p_active, active) where user_id = p_user;
end $$;

create or replace function public.cancel_invite(p_email text) returns void
language plpgsql security definer set search_path = public as $$
declare i invites;
begin
  select * into i from invites where email = lower(trim(p_email));
  if not found then return; end if;
  if not is_admin() and (my_role() is distinct from 'owner' or i.salon_id <> my_salon()) then raise exception 'Not allowed'; end if;
  delete from invites where email = i.email;
end $$;

-- ---------- Hostready admin ----------
create or replace function public.admin_overview() returns json
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'Admins only'; end if;
  return coalesce((select json_agg(x order by x.name) from (
    select s.*, salon_active_until(s) as active_until,
           case when salon_active_until(s) is null then null else salon_active_until(s) - dubai_today() end as days_left,
           (select count(*) from devices d where d.salon_id = s.id and d.status = 'approved') as devices_approved,
           (select count(*) from devices d where d.salon_id = s.id and d.status = 'pending') as devices_pending,
           (select count(*) from members m where m.salon_id = s.id and m.active) as logins,
           (select json_agg(json_build_object('email', m.email, 'role', m.role)) from members m where m.salon_id = s.id and m.role = 'owner' and m.active) as owners,
           (select json_agg(json_build_object('email', i.email, 'role', i.role)) from invites i where i.salon_id = s.id) as invites
    from salons s) x), '[]'::json);
end $$;

create or replace function public.admin_create_salon(p_name text, p_code text, p_plan text, p_device_limit int,
                                                     p_owner_email text, p_owner_name text, p_phone text, p_trial_days int default 7)
returns json language plpgsql security definer set search_path = public as $$
declare s salons; v_code text := upper(trim(coalesce(p_code, '')));
begin
  if not is_admin() then raise exception 'Admins only'; end if;
  if v_code = '' then
    loop
      v_code := 'SAL-' || lpad((floor(random() * 9000) + 1000)::int::text, 4, '0');
      exit when not exists (select 1 from salons where salons.code = v_code);
    end loop;
  end if;
  if v_code !~ '^[A-Z0-9-]{4,20}$' then raise exception 'Salon code: 4-20 letters, numbers or dashes'; end if;
  if exists (select 1 from salons where salons.code = v_code) then raise exception 'That salon code is already used'; end if;
  insert into salons (code, name, plan, device_limit, trial_ends, contact_name, contact_phone, contact_email)
  values (v_code, trim(p_name), coalesce(nullif(p_plan,''), 'Starter'), greatest(1, coalesce(p_device_limit, 2)),
          dubai_today() + greatest(0, coalesce(p_trial_days, 7)), p_owner_name, p_phone, lower(trim(p_owner_email)))
  returning * into s;
  if coalesce(trim(p_owner_email), '') <> '' then
    perform invite_member(s.id, p_owner_email, p_owner_name, 'owner');
  end if;
  return row_to_json(s);
end $$;

create or replace function public.admin_update_salon(p_id uuid, p_name text, p_plan text, p_device_limit int, p_status text,
                                                     p_contact_name text, p_contact_phone text, p_contact_email text, p_notes text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'Admins only'; end if;
  update salons set
    name = coalesce(nullif(trim(p_name), ''), name),
    plan = coalesce(nullif(p_plan, ''), plan),
    device_limit = coalesce(p_device_limit, device_limit),
    status = coalesce(nullif(p_status, ''), status),
    contact_name = p_contact_name, contact_phone = p_contact_phone, contact_email = p_contact_email, notes = p_notes
  where id = p_id;
end $$;

create or replace function public.admin_record_payment(p_salon uuid, p_days int, p_amount numeric, p_method text, p_note text)
returns json language plpgsql security definer set search_path = public as $$
declare s salons; p payments; start date; inv text;
begin
  if not is_admin() then raise exception 'Admins only'; end if;
  if p_days not in (90, 180, 270, 365) then raise exception 'Subscription must be 90, 180, 270 or 365 days'; end if;
  if coalesce(p_amount, -1) < 0 then raise exception 'Enter the amount (excluding VAT)'; end if;
  select * into s from salons where id = p_salon for update;
  if not found then raise exception 'Salon not found'; end if;
  start := greatest(dubai_today(), coalesce(s.paid_until + 1, dubai_today()));
  inv := 'HR-' || to_char(dubai_today(), 'YYMM') || '-' || lpad(nextval('invoice_seq')::text, 4, '0');
  insert into payments (salon_id, invoice_no, days, period_from, period_to, amount, vat, method, note, created_by)
  values (s.id, inv, p_days, start, start + p_days - 1, round(p_amount, 2), round(p_amount * 0.05, 2), p_method, p_note, auth.jwt() ->> 'email')
  returning * into p;
  update salons set paid_until = p.period_to, status = 'active' where id = s.id;
  return json_build_object('payment', row_to_json(p), 'salon', (select row_to_json(x) from salons x where x.id = s.id));
end $$;

create or replace function public.admin_salon_detail(p_salon uuid) returns json
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'Admins only'; end if;
  return json_build_object(
    'devices',  (select json_agg(d order by d.first_seen) from devices d where d.salon_id = p_salon),
    'members',  (select json_agg(m order by m.created_at) from members m where m.salon_id = p_salon),
    'invites',  (select json_agg(i order by i.created_at) from invites i where i.salon_id = p_salon),
    'payments', (select json_agg(p order by p.created_at desc) from payments p where p.salon_id = p_salon));
end $$;

create or replace function public.admin_add_admin(p_email text) returns void
language plpgsql security definer set search_path = public as $$
declare uid uuid;
begin
  if not is_admin() then raise exception 'Admins only'; end if;
  select id into uid from auth.users where lower(email) = lower(trim(p_email));
  if uid is null then raise exception 'That email has no login yet'; end if;
  insert into admins (user_id) values (uid) on conflict do nothing;
end $$;

-- ---------- permissions ----------
revoke all on function public.check_salon_code(text) from public;
grant execute on function public.check_salon_code(text) to anon, authenticated;
grant execute on function public.my_status(), public.register_device(text,text,text), public.touch_device(),
  public.approve_device(uuid), public.revoke_device(uuid), public.rename_device(uuid,text),
  public.invite_member(uuid,text,text,text), public.set_member(uuid,text,boolean), public.cancel_invite(text),
  public.admin_overview(), public.admin_create_salon(text,text,text,int,text,text,text,int),
  public.admin_update_salon(uuid,text,text,int,text,text,text,text,text), public.admin_record_payment(uuid,int,numeric,text,text),
  public.admin_salon_detail(uuid), public.admin_add_admin(text)
to authenticated;

-- Live updates between devices (devices table too, so approvals apply instantly).
do $$ begin
  alter publication supabase_realtime add table public.records;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.devices;
exception when duplicate_object then null; end $$;

select 'Salon Ledger v2 database upgrade complete' as result;
