-- voices — brand voice fingerprints extracted from a user's existing site.
-- The fingerprint JSON shape mirrors VoiceFingerprint in engine/src/clients/voice.ts.

CREATE TABLE IF NOT EXISTS public.voices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  source_url text NOT NULL,
  fingerprint jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_voices_user ON public.voices (user_id);

CREATE TRIGGER voices_touch_updated_at
  BEFORE UPDATE ON public.voices
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

ALTER TABLE public.voices ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "owner_full_access" ON public.voices;
CREATE POLICY "owner_full_access" ON public.voices
  FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- ─── sites ──────────────────────────────────────────────────────────
-- A "site" is a CMS connection where Bylined publishes articles.
-- cms_config is JSONB so each provider can store its own auth shape:
--   wordpress: { url, username, app_password }
--   webflow:   { api_token, site_id, collection_id, mapping }
--   shopify:   { shop_url, access_token }
--   ghost:     { admin_url, admin_api_key }
--   notion:    { integration_token, database_id }
--   webhook:   { url, secret? }
CREATE TABLE IF NOT EXISTS public.sites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name text NOT NULL,
  domain text,
  cms_type text NOT NULL
    CHECK (cms_type IN ('wordpress', 'webflow', 'shopify', 'ghost', 'notion', 'webhook')),
  cms_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  voice_id uuid REFERENCES public.voices(id) ON DELETE SET NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sites_user ON public.sites (user_id);
CREATE INDEX IF NOT EXISTS idx_sites_user_active ON public.sites (user_id, is_active) WHERE is_active;

CREATE TRIGGER sites_touch_updated_at
  BEFORE UPDATE ON public.sites
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

ALTER TABLE public.sites ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "owner_full_access" ON public.sites;
CREATE POLICY "owner_full_access" ON public.sites
  FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
