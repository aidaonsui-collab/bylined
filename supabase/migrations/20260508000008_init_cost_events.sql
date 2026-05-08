-- cost_events — append-only log of every billable engine event.
-- Inserts come from the engine (server-side, service_role bypasses RLS);
-- reads are RLS-gated to the row owner.
--
-- We log each event individually rather than rolling up at write time so we
-- can change the rollup logic later without losing data, and so per-event
-- introspection ("which page fetch took 12s?") stays cheap.

CREATE TABLE IF NOT EXISTS public.cost_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  article_id uuid REFERENCES public.articles(id) ON DELETE SET NULL,
  job_id uuid REFERENCES public.jobs(id) ON DELETE SET NULL,
  event_type text NOT NULL CHECK (event_type IN (
    'llm_extraction',
    'llm_generation',
    'llm_voice',
    'llm_other',
    'serp_fetch',
    'page_fetch',
    'wayback_save',
    'verification_fetch',
    'cms_publish'
  )),
  -- Provider names: minimax | openai | anthropic | brave | serper | duckduckgo | wayback | wordpress | webflow | shopify | ghost | other
  provider text,
  model text,
  input_tokens integer,
  output_tokens integer,
  -- USD with sub-cent precision so we can log $0.000003 SERP queries accurately.
  cost_usd numeric(12, 6),
  duration_ms integer,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cost_events_user_time
  ON public.cost_events (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cost_events_article ON public.cost_events (article_id);
CREATE INDEX IF NOT EXISTS idx_cost_events_job ON public.cost_events (job_id);

ALTER TABLE public.cost_events ENABLE ROW LEVEL SECURITY;

-- Users can read their own cost events. No INSERT policy — the engine
-- writes via the service_role key which bypasses RLS by design.
DROP POLICY IF EXISTS "select_own_cost_events" ON public.cost_events;
CREATE POLICY "select_own_cost_events" ON public.cost_events
  FOR SELECT
  USING ((select auth.uid()) = user_id);

-- ─── Aggregation views ──────────────────────────────────────────────
-- Per-article COGS rollup. Useful both for the dashboard's "this article
-- cost $0.18" badge and for monitoring whether we're hitting our 70%
-- gross margin target.

CREATE OR REPLACE VIEW public.cost_per_article AS
SELECT
  ce.article_id,
  ce.user_id,
  COUNT(*)                                                                AS event_count,
  SUM(ce.cost_usd)                                                        AS total_cost_usd,
  SUM(CASE WHEN ce.event_type LIKE 'llm_%' THEN ce.cost_usd ELSE 0 END)  AS llm_cost_usd,
  SUM(CASE WHEN ce.event_type = 'serp_fetch'         THEN ce.cost_usd ELSE 0 END) AS serp_cost_usd,
  SUM(CASE WHEN ce.event_type = 'page_fetch'         THEN ce.cost_usd ELSE 0 END) AS page_fetch_cost_usd,
  SUM(CASE WHEN ce.event_type = 'verification_fetch' THEN ce.cost_usd ELSE 0 END) AS verify_cost_usd,
  SUM(ce.input_tokens)                                                    AS input_tokens,
  SUM(ce.output_tokens)                                                   AS output_tokens,
  MIN(ce.created_at)                                                      AS first_event_at,
  MAX(ce.created_at)                                                      AS last_event_at
FROM public.cost_events ce
WHERE ce.article_id IS NOT NULL
GROUP BY ce.article_id, ce.user_id;

-- Per-user / per-day rollup. Useful for the Billing page's "this period"
-- cost panel and for trend graphs.
CREATE OR REPLACE VIEW public.cost_per_user_day AS
SELECT
  ce.user_id,
  date_trunc('day', ce.created_at) AS day,
  COUNT(*)                          AS event_count,
  SUM(ce.cost_usd)                  AS total_cost_usd,
  SUM(ce.input_tokens)              AS input_tokens,
  SUM(ce.output_tokens)             AS output_tokens
FROM public.cost_events ce
WHERE ce.user_id IS NOT NULL
GROUP BY ce.user_id, date_trunc('day', ce.created_at);
