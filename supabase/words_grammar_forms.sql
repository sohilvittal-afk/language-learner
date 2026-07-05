-- Migration: run this once in the Supabase SQL Editor if you created the
-- words table BEFORE grammar_forms existed. Fresh installs get the column
-- from supabase/words.sql and can skip this file.
--
-- grammar_forms holds the part-of-speech specific forms the AI fills in when
-- a word is added (see lib/enrichment.js): verbs get {imperfectum, perfectum},
-- nouns {article, plural}, adjectives {comparative, superlative}.

alter table public.words add column if not exists grammar_forms jsonb;
