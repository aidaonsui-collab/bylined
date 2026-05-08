-- Performance hardening based on Supabase database-linter output:
--
-- 1. auth_rls_initplan WARN — RLS policies that call auth.uid() directly
--    re-evaluate the function for every row. Wrapping in `(select auth.uid())`
--    lets Postgres cache the result per statement.
--    See https://supabase.com/docs/guides/database/postgres/row-level-security#call-functions-with-select
--
-- 2. unindexed_foreign_keys INFO — FKs without a covering index slow down
--    CASCADE/SET NULL operations and FK lookup joins.

-- ─── Profiles policies ──────────────────────────────────────────────
DROP POLICY "select_own_profile" ON public.profiles;
CREATE POLICY "select_own_profile" ON public.profiles
  FOR SELECT
  USING ((select auth.uid()) = id);

DROP POLICY "update_own_profile" ON public.profiles;
CREATE POLICY "update_own_profile" ON public.profiles
  FOR UPDATE
  USING ((select auth.uid()) = id)
  WITH CHECK ((select auth.uid()) = id);

-- ─── Voices ─────────────────────────────────────────────────────────
DROP POLICY "owner_full_access" ON public.voices;
CREATE POLICY "owner_full_access" ON public.voices
  FOR ALL
  USING ((select auth.uid()) = user_id)
  WITH CHECK ((select auth.uid()) = user_id);

-- ─── Sites ──────────────────────────────────────────────────────────
DROP POLICY "owner_full_access" ON public.sites;
CREATE POLICY "owner_full_access" ON public.sites
  FOR ALL
  USING ((select auth.uid()) = user_id)
  WITH CHECK ((select auth.uid()) = user_id);

CREATE INDEX IF NOT EXISTS idx_sites_voice ON public.sites (voice_id);

-- ─── Articles ───────────────────────────────────────────────────────
DROP POLICY "owner_full_access" ON public.articles;
CREATE POLICY "owner_full_access" ON public.articles
  FOR ALL
  USING ((select auth.uid()) = user_id)
  WITH CHECK ((select auth.uid()) = user_id);

-- ─── Jobs ───────────────────────────────────────────────────────────
DROP POLICY "owner_full_access" ON public.jobs;
CREATE POLICY "owner_full_access" ON public.jobs
  FOR ALL
  USING ((select auth.uid()) = user_id)
  WITH CHECK ((select auth.uid()) = user_id);

CREATE INDEX IF NOT EXISTS idx_jobs_site ON public.jobs (site_id);
CREATE INDEX IF NOT EXISTS idx_jobs_voice ON public.jobs (voice_id);
CREATE INDEX IF NOT EXISTS idx_jobs_article ON public.jobs (article_id);

-- ─── Subscriptions ──────────────────────────────────────────────────
DROP POLICY "select_own_subscription" ON public.subscriptions;
CREATE POLICY "select_own_subscription" ON public.subscriptions
  FOR SELECT
  USING ((select auth.uid()) = user_id);
