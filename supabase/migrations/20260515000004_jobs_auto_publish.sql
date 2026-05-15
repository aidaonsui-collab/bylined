-- Bulk-publish support — let a job carry "publish to this site when
-- generation succeeds" so the worker takes the article straight from
-- generate() → blog_posts (or other CMS) without a manual click.
--
-- Used by the dashboard's bulk-queue textarea (N keywords, one auto-
-- publish target) and any future scripted workflows.

ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS auto_publish_site_id uuid
    REFERENCES public.sites(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS auto_publish_live boolean NOT NULL DEFAULT false;

-- Helpful when the worker is checking "any jobs to auto-publish for
-- this user" — currently the worker just walks jobs in order, but a
-- future bulk-status UI will want this.
CREATE INDEX IF NOT EXISTS idx_jobs_auto_publish
  ON public.jobs (auto_publish_site_id)
  WHERE auto_publish_site_id IS NOT NULL;
