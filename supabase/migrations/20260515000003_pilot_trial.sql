-- Pilot trial — free 14-day, 10-article evaluation tier.
--
-- Replaces the old paid Solo tier on the marketing site. Pilot
-- subscriptions are created without Stripe (no card, no checkout) by
-- the start-pilot edge function. They live in the same subscriptions
-- table as paid plans so quota enforcement and the in-app billing UI
-- all keep working unchanged — we just relax two constraints and lean
-- on current_period_end as the trial-deadline timestamp.

-- ─── 1. allow 'pilot' as a plan value ────────────────────────────────

ALTER TABLE public.subscriptions
  DROP CONSTRAINT IF EXISTS subscriptions_plan_check;

ALTER TABLE public.subscriptions
  ADD CONSTRAINT subscriptions_plan_check
  CHECK (plan IN ('pilot', 'solo', 'studio', 'agency', 'scale'));

-- ─── 2. allow Stripe columns to be NULL for non-Stripe rows ─────────
-- Pilot rows have no Stripe subscription on the other side, so we
-- can't satisfy the original NOT NULL. UNIQUE on stripe_subscription_id
-- still prevents duplicates among real Stripe rows because PostgreSQL
-- UNIQUE treats NULLs as distinct by default.

ALTER TABLE public.subscriptions
  ALTER COLUMN stripe_subscription_id DROP NOT NULL,
  ALTER COLUMN stripe_price_id DROP NOT NULL;

-- Only one active pilot per user — prevents trial-cycling abuse from
-- the same auth identity. Doesn't restrict paid subscriptions.
CREATE UNIQUE INDEX IF NOT EXISTS unq_subscriptions_one_pilot_per_user
  ON public.subscriptions (user_id)
  WHERE plan = 'pilot';

-- ─── 3. enforce_jobs_quota: require current_period_end > now() ───────
-- The original query just picked the most recent active/trialing sub
-- regardless of period_end. For Pilot we need an automatic time-based
-- gate: once the 14-day window closes, the trial sub should stop
-- letting new jobs in even though it's still status='trialing' (we
-- don't run a cron to flip it). Adding the time check also tightens
-- behavior for paid subs whose webhook update lags briefly — a fresh
-- "expired but renewing" sub will fail closed, which is the right
-- default for a metered service.

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
     AND current_period_end > now()
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
