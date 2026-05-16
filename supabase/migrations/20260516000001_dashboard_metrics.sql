-- Dashboard metrics — per-article quality scores feeding the new
-- in-app dashboard (Publishing Health gauge + AEO/Voice pillars).
--
-- aeo_score:        heuristic 0-100 for LLM-citation readiness
--                   (headings, citation density, quotes, stats, lists).
-- voice_match_score: 0-100 of how close the draft matches the brand
--                   voice fingerprint. NULL when no voice was used.
--
-- Both are computed in engine/src/scorer.ts during generation and
-- written by the worker alongside pass_rate. Existing rows stay NULL
-- until they're regenerated — the dashboard treats NULL as "not
-- scored" rather than "zero" so the averages aren't dragged down.

ALTER TABLE public.articles
  ADD COLUMN IF NOT EXISTS aeo_score         smallint
    CHECK (aeo_score IS NULL OR (aeo_score BETWEEN 0 AND 100)),
  ADD COLUMN IF NOT EXISTS voice_match_score smallint
    CHECK (voice_match_score IS NULL OR (voice_match_score BETWEEN 0 AND 100));

-- The dashboard reads articles from the last 30 days for rolling
-- averages — index that path so we don't scan the whole table.
CREATE INDEX IF NOT EXISTS articles_user_generated_at_idx
  ON public.articles (user_id, generated_at DESC);
