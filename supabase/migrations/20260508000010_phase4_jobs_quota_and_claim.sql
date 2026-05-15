-- Phase 4: enforce per-period quota at the DB layer + give workers a way
-- to atomically claim the next queued job.
--
-- Quota rules:
--   * Users without an active/trialing subscription cannot enqueue jobs.
--   * Users with a subscription cannot enqueue when used >= quota.
-- We DO NOT decrement on failure: the worker only increments on success.
-- A failed run is free for the user (and a signal to us to investigate).
--
-- Applied to project boatyhrefcilcxepnbbf as migration
-- 20260508233030_phase4_jobs_quota_and_claim.

-- ─── enforce_jobs_quota ────────────────────────────────────────────
-- Trigger that gates INSERT on public.jobs. SECURITY DEFINER so it can
-- read public.subscriptions deterministically. BEFORE INSERT only — so
-- a "retry" that flips a failed job back to 'queued' via UPDATE does
-- NOT re-consume quota.
CREATE OR REPLACE FUNCTION public.enforce_jobs_quota()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  sub public.subscriptions%ROWTYPE;
BEGIN
  SELECT *
    INTO sub
    FROM public.subscriptions
   WHERE user_id = NEW.user_id
     AND status IN ('active', 'trialing')
   ORDER BY current_period_end DESC
   LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'no_active_subscription'
      USING HINT = 'Subscribe at /app/pricing before generating articles.';
  END IF;

  IF sub.articles_used_this_period >= sub.articles_quota THEN
    RAISE EXCEPTION 'quota_exceeded'
      USING HINT = format(
        'Used %s of %s articles this period. Resets on %s.',
        sub.articles_used_this_period,
        sub.articles_quota,
        to_char(sub.current_period_end, 'YYYY-MM-DD')
      );
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS jobs_enforce_quota ON public.jobs;
CREATE TRIGGER jobs_enforce_quota
  BEFORE INSERT ON public.jobs
  FOR EACH ROW EXECUTE FUNCTION public.enforce_jobs_quota();

-- ─── claim_next_job ────────────────────────────────────────────────
-- Atomic claim: pick the oldest queued job, mark it running, return it.
-- FOR UPDATE SKIP LOCKED makes this safe across concurrent workers.
-- SECURITY DEFINER + service_role-only.
CREATE OR REPLACE FUNCTION public.claim_next_job()
RETURNS public.jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  claimed public.jobs%ROWTYPE;
BEGIN
  WITH next AS (
    SELECT id
      FROM public.jobs
     WHERE status = 'queued'
     ORDER BY created_at ASC
     LIMIT 1
     FOR UPDATE SKIP LOCKED
  )
  UPDATE public.jobs j
     SET status     = 'running',
         started_at = now()
    FROM next
   WHERE j.id = next.id
  RETURNING j.* INTO claimed;

  RETURN claimed;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_next_job() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_next_job() FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_next_job() TO service_role;

-- ─── increment_articles_used ───────────────────────────────────────
-- Atomic ++ on the active subscription's usage counter. Worker calls
-- this when a job completes successfully. Service_role only.
CREATE OR REPLACE FUNCTION public.increment_articles_used(p_user_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  new_used integer;
BEGIN
  UPDATE public.subscriptions
     SET articles_used_this_period = articles_used_this_period + 1
   WHERE user_id = p_user_id
     AND status IN ('active', 'trialing')
     AND id = (
       SELECT id FROM public.subscriptions
        WHERE user_id = p_user_id
          AND status IN ('active', 'trialing')
        ORDER BY current_period_end DESC
        LIMIT 1
     )
  RETURNING articles_used_this_period INTO new_used;

  RETURN new_used;
END;
$$;

REVOKE ALL ON FUNCTION public.increment_articles_used(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.increment_articles_used(uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.increment_articles_used(uuid) TO service_role;
