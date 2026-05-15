-- bylined_hosted blog — Bylined's own dogfood publishing target.
--
-- Lets us publish Bylined articles to getbylined.com/blog via the same
-- publish-article edge function used for WordPress/Webflow. The marketing
-- site is a static export on Vercel; on publish we POST to a Vercel Deploy
-- Hook URL (stored as the BYLINED_HOSTED_DEPLOY_HOOK env var on the edge
-- function) which triggers a rebuild that fetches blog_posts via Supabase
-- REST and emits static HTML.
--
-- Anon-readable for published rows so the build-time fetch needs no
-- service key.

-- ─── 1. extend sites.cms_type to include 'bylined_hosted' ────────────

ALTER TABLE public.sites
  DROP CONSTRAINT IF EXISTS sites_cms_type_check;

ALTER TABLE public.sites
  ADD CONSTRAINT sites_cms_type_check
  CHECK (cms_type IN (
    'wordpress', 'webflow', 'shopify', 'ghost', 'notion', 'webhook',
    'bylined_hosted'
  ));

-- ─── 2. blog_posts table ─────────────────────────────────────────────
-- One row per published Bylined article. We keep body_html (rendered
-- markdown) and sources_html (the receipts footer) split so the build
-- script can style them independently. (article_id, site_id) is the
-- natural key — same article re-published updates the existing row.

CREATE TABLE IF NOT EXISTS public.blog_posts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  article_id uuid NOT NULL REFERENCES public.articles(id) ON DELETE CASCADE,
  site_id uuid NOT NULL REFERENCES public.sites(id) ON DELETE CASCADE,
  slug text NOT NULL,
  title text NOT NULL,
  meta_description text,
  body_html text NOT NULL,
  sources_html text,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'published')),
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Re-publish updates existing row, not create a duplicate
  UNIQUE (article_id, site_id),
  -- Slug uniqueness per site so URL routing is unambiguous
  UNIQUE (site_id, slug)
);

CREATE INDEX IF NOT EXISTS idx_blog_posts_user
  ON public.blog_posts (user_id);

CREATE INDEX IF NOT EXISTS idx_blog_posts_published
  ON public.blog_posts (site_id, published_at DESC)
  WHERE status = 'published';

CREATE TRIGGER blog_posts_touch_updated_at
  BEFORE UPDATE ON public.blog_posts
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

ALTER TABLE public.blog_posts ENABLE ROW LEVEL SECURITY;

-- Owners can do anything with their rows (draft + published).
DROP POLICY IF EXISTS "owner_full_access" ON public.blog_posts;
CREATE POLICY "owner_full_access" ON public.blog_posts
  FOR ALL
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Anon/public can SELECT published rows only. The marketing static build
-- uses the anon key to fetch posts; this policy is what lets that work
-- without exposing drafts.
DROP POLICY IF EXISTS "anon_read_published" ON public.blog_posts;
CREATE POLICY "anon_read_published" ON public.blog_posts
  FOR SELECT
  TO anon
  USING (status = 'published');
