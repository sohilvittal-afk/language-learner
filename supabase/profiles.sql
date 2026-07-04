-- Run this once in the Supabase SQL Editor, AFTER supabase/users.sql
-- (id below references public.users, not auth.users).
--
-- BREAKING CHANGE from an earlier version of this file: this app no longer
-- uses Supabase Auth, so a profiles table built against auth.users no longer
-- applies. If you ran the old version, drop it first — its ids won't match
-- anything in the new public.users table and old accounts must re-register:
--   drop table if exists public.profiles;
--
-- Stores role plus a few admin-editable fields, linked 1:1 to public.users.
-- A row is created automatically (role 'user', status 'active') at
-- registration, with a lazy-create fallback on login — see server.js.
--
-- Role changes never go through RLS — there is intentionally no update
-- policy (see below), so the only way to change role/display_name/status/notes
-- is through this app's PATCH /api/users/:id route, which runs server-side
-- with the service role key after its own requireRole checks, or manually in
-- Supabase Table Editor.

create table if not exists public.profiles (
  id uuid primary key references public.users(id) on delete cascade,
  role text not null default 'user' check (role in ('user', 'admin', 'super_admin')),
  display_name text,
  status text not null default 'active' check (status in ('active', 'disabled')),
  notes text,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- No policies, intentionally: same reasoning as users.sql — no Supabase Auth
-- session exists, so this table is only ever touched via the service role key.
