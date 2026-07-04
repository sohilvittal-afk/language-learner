-- Run this once in the Supabase SQL Editor, AFTER supabase/words.sql and
-- supabase/profiles.sql. Safe to run on an existing database — every
-- statement is idempotent, and the alters below bring older words/profiles
-- tables up to date with the language features.
--
-- Three pieces make word-bank translation work:
--   1. words.language           — which language a term is written in
--                                 (set by the admin when adding the word)
--   2. profiles.preferred_language — which language each learner wants
--                                 words translated INTO (set on the
--                                 Profile page)
--   3. word_translations        — the cache of AI translations, one row per
--                                 (word, target language), filled lazily the
--                                 first time any learner needs it
--
-- Language values are lowercase names ('english', 'dutch', 'german', ...) —
-- the canonical list lives in lib/translation.js and is validated in
-- Express, not with a check constraint, so new languages don't need a
-- migration.

alter table public.words
  add column if not exists language text not null default 'english';

alter table public.profiles
  add column if not exists preferred_language text not null default 'english';

-- The original unique index on lower(term) blocked the same spelling in two
-- languages (e.g. "hotel" exists in English, Dutch, and German), so
-- uniqueness is now per language.
drop index if exists words_term_lower_idx;
create unique index if not exists words_term_language_idx
  on public.words (lower(term), language);

create table if not exists public.word_translations (
  id uuid primary key default gen_random_uuid(),
  word_id uuid not null references public.words(id) on delete cascade,
  language text not null,
  translation text not null,
  created_at timestamptz not null default now(),
  unique (word_id, language)
);

alter table public.word_translations enable row level security;

-- No policies, intentionally: same reasoning as users.sql — no Supabase Auth
-- session exists, so this table is only ever touched via the service role key.
