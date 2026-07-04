-- Run this once in the Supabase SQL Editor (Project > SQL Editor > New query).
--
-- Stores each user's role. Rows are created automatically (defaulting to
-- 'user') the first time someone logs in — see resolveRole() in server.js.
-- Promoting someone to 'admin' or 'super_admin' is a manual, out-of-band step:
-- open Table Editor > profiles and edit the role column for that row. There is
-- intentionally no update policy below, so no logged-in user — including
-- admins — can grant themselves or anyone else a higher role through the app.

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  role text not null default 'user' check (role in ('user', 'admin', 'super_admin')),
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "profiles_select_own"
  on public.profiles for select
  using (auth.uid() = id);

create policy "profiles_insert_own"
  on public.profiles for insert
  with check (auth.uid() = id and role = 'user');
