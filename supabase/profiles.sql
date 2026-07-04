-- Run this once in the Supabase SQL Editor (Project > SQL Editor > New query).
-- If profiles already exists from an earlier version, the ALTERs below add
-- the new columns without touching existing rows or policies.
--
-- Stores each user's role plus a few admin-editable fields. Rows are created
-- automatically (defaulting to role 'user', status 'active') the first time
-- someone logs in — see resolveRole() in server.js.
--
-- Role changes never go through the anon/authenticated RLS path — there is
-- intentionally no update policy below, so no logged-in user, including
-- admins, can grant themselves or anyone else a higher role directly against
-- Supabase. The only way to change role/display_name/status/notes is either
-- manually in Table Editor, or through this app's PATCH /api/users/:id route,
-- which runs server-side with the service role key (see lib/supabaseClient.js
-- getServiceRoleClient) after its own requireRole checks — not through RLS.

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  role text not null default 'user' check (role in ('user', 'admin', 'super_admin')),
  created_at timestamptz not null default now()
);

alter table public.profiles add column if not exists display_name text;
alter table public.profiles add column if not exists status text not null default 'active';
alter table public.profiles add column if not exists notes text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'profiles_status_check'
  ) then
    alter table public.profiles
      add constraint profiles_status_check check (status in ('active', 'disabled'));
  end if;
end $$;

alter table public.profiles enable row level security;

drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own"
  on public.profiles for select
  using (auth.uid() = id);

drop policy if exists "profiles_insert_own" on public.profiles;
create policy "profiles_insert_own"
  on public.profiles for insert
  with check (auth.uid() = id and role = 'user');
