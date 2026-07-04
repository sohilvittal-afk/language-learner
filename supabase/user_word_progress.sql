-- Run this once in the Supabase SQL Editor, AFTER supabase/words.sql.
--
-- Tracks one learner's affinity/mastery of one word — a simplified SM-2
-- spaced-repetition record. Updated by POST /api/practice/answer (flashcard
-- review) and POST /api/side-quests/:id/complete (quest comprehension quiz).
-- A missing row for a (user, word) pair means "never studied" and is treated
-- as immediately due — see pickWordsForUser() in server.js.

create table if not exists public.user_word_progress (
  user_id uuid not null references public.users(id) on delete cascade,
  word_id uuid not null references public.words(id) on delete cascade,
  repetitions integer not null default 0,
  ease_factor real not null default 2.5,
  interval_days integer not null default 0,
  correct_count integer not null default 0,
  incorrect_count integer not null default 0,
  last_result text check (last_result in ('correct', 'incorrect')),
  next_review_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, word_id)
);

create index if not exists user_word_progress_due_idx on public.user_word_progress (user_id, next_review_at);

alter table public.user_word_progress enable row level security;

-- No policies, intentionally: same reasoning as users.sql — this table is
-- only ever touched server-side via the service role key.
