-- visibility_snapshots — weekly "are AI engines citing this customer?"
-- measurements. Populated by a scheduled edge function (v2) that asks
-- each customer's buyer-question set across Perplexity / ChatGPT / Claude
-- and counts citations.
--
-- Shipped now (v1) without the writer wired up — the dashboard renders
-- mocked client-side data with a "Preview" badge until the cron lands.
-- Creating the table now means v2 doesn't need a migration on day one.

CREATE TABLE IF NOT EXISTS public.visibility_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- Weeks since the user's signup, 0-indexed. Lets the chart x-axis
  -- read as a journey ("week 4 since you joined") rather than absolute
  -- dates, which are noisier to compare across customers.
  week_number integer NOT NULL,
  snapshot_date timestamptz NOT NULL DEFAULT now(),
  -- Per-engine citation counts (= number of buyer questions for which
  -- the customer's domain or brand appeared in that engine's answer).
  perplexity_citations integer NOT NULL DEFAULT 0,
  chatgpt_citations integer NOT NULL DEFAULT 0,
  claude_citations integer NOT NULL DEFAULT 0,
  total_citations integer GENERATED ALWAYS AS (
    perplexity_citations + chatgpt_citations + claude_citations
  ) STORED,
  -- Denominator: how many questions were asked per engine that week.
  -- Stays constant per customer (= the audit's 5 buyer questions) but
  -- stored per row so the math is reproducible if the question set
  -- ever changes.
  questions_asked integer NOT NULL,
  -- Raw per-question per-engine results for transparency + future
  -- "which question are we losing on" drilldowns.
  results jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- One row per (user, week). If the cron retries, upsert by this key.
  UNIQUE (user_id, week_number)
);

CREATE INDEX IF NOT EXISTS idx_visibility_user_week
  ON public.visibility_snapshots (user_id, week_number);

ALTER TABLE public.visibility_snapshots ENABLE ROW LEVEL SECURITY;

-- Owners read their own snapshots. Writes only via service role (the
-- cron edge function) — no INSERT/UPDATE policies on purpose.
DROP POLICY IF EXISTS "owner_select" ON public.visibility_snapshots;
CREATE POLICY "owner_select" ON public.visibility_snapshots
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);
