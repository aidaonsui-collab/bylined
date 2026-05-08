-- subscriptions — Stripe subscription state, mirrored from webhook events.
-- One active subscription per user (the most recent active row); historical
-- rows are kept around for audit. Quota tracking is on the subscription row
-- since plans dictate quota and quota resets each billing period.

CREATE TABLE IF NOT EXISTS public.subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  stripe_subscription_id text NOT NULL UNIQUE,
  stripe_price_id text NOT NULL,
  plan text NOT NULL
    CHECK (plan IN ('solo', 'studio', 'agency', 'scale')),
  status text NOT NULL,
  -- Stripe statuses we actually see: active, trialing, past_due, canceled,
  -- unpaid, incomplete, incomplete_expired, paused. Stored free-form to
  -- avoid migrations every time Stripe adds a value.
  current_period_start timestamptz NOT NULL,
  current_period_end timestamptz NOT NULL,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  articles_used_this_period integer NOT NULL DEFAULT 0,
  articles_quota integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_user ON public.subscriptions (user_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_active_per_user
  ON public.subscriptions (user_id)
  WHERE status IN ('active', 'trialing');

CREATE TRIGGER subscriptions_touch_updated_at
  BEFORE UPDATE ON public.subscriptions
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;

-- Users can read their own subscription. Writes happen ONLY via the
-- Stripe webhook edge function (which uses service_role and bypasses
-- RLS). No user-facing INSERT/UPDATE/DELETE policies.
DROP POLICY IF EXISTS "select_own_subscription" ON public.subscriptions;
CREATE POLICY "select_own_subscription" ON public.subscriptions
  FOR SELECT
  USING (auth.uid() = user_id);
