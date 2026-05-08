-- articles — generated long-form output from the engine.
-- The receipts JSONB array mirrors the Receipt type in engine/src/types.ts.

CREATE TABLE IF NOT EXISTS public.articles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  site_id uuid REFERENCES public.sites(id) ON DELETE SET NULL,
  keyword text NOT NULL,
  title text NOT NULL,
  meta_description text,
  body_markdown text NOT NULL,
  receipts jsonb NOT NULL DEFAULT '[]'::jsonb,
  pass_rate numeric(5,4),
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'scheduled', 'published', 'failed')),
  cms_post_id text,
  cms_post_url text,
  generated_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_articles_user ON public.articles (user_id);
CREATE INDEX IF NOT EXISTS idx_articles_site ON public.articles (site_id);
CREATE INDEX IF NOT EXISTS idx_articles_user_status ON public.articles (user_id, status);

CREATE TRIGGER articles_touch_updated_at
  BEFORE UPDATE ON public.articles
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

ALTER TABLE public.articles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "owner_full_access" ON public.articles;
CREATE POLICY "owner_full_access" ON public.articles
  FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- ─── jobs ───────────────────────────────────────────────────────────
-- Async generation queue. The dashboard creates a job, a worker (edge
-- function or background process) picks it up, runs the engine pipeline,
-- and writes back the resulting article_id + status.

CREATE TABLE IF NOT EXISTS public.jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  site_id uuid REFERENCES public.sites(id) ON DELETE SET NULL,
  voice_id uuid REFERENCES public.voices(id) ON DELETE SET NULL,
  keyword text NOT NULL,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  article_id uuid REFERENCES public.articles(id) ON DELETE SET NULL,
  error text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_jobs_user ON public.jobs (user_id);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON public.jobs (status) WHERE status IN ('queued', 'running');
CREATE INDEX IF NOT EXISTS idx_jobs_user_status ON public.jobs (user_id, status);

CREATE TRIGGER jobs_touch_updated_at
  BEFORE UPDATE ON public.jobs
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

ALTER TABLE public.jobs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "owner_full_access" ON public.jobs;
CREATE POLICY "owner_full_access" ON public.jobs
  FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
