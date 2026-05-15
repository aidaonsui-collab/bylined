-- demo_requests — unauthenticated "watch it write your first article"
-- requests from the marketing site. No user_id: these come from
-- visitors who haven't signed up. The worker picks them up the same
-- way it picks up jobs, crawls the URL, infers a keyword, and runs the
-- full generate() pipeline.
--
-- Reads + writes go exclusively through edge functions using the
-- service_role key. RLS is enabled with NO anon/authenticated policies,
-- so the table is invisible to the public API — the request-demo and
-- demo-status edge functions are the only door in.
--
-- Applied to project boatyhrefcilcxepnbbf as migration
-- 20260515014348_demo_requests.

CREATE TABLE IF NOT EXISTS public.demo_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  url text NOT NULL,
  -- Inferred by the worker from the crawled site; null until then.
  keyword text,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  -- Human-readable progress line the worker updates as it goes, so the
  -- landing page can show "Extracting facts…" etc. while it waits.
  progress text,
  -- On success: { title, meta_description, body_excerpt, receipts,
  --               pass_rate, keyword }. Capped/excerpted by the worker
  -- so we're not shipping a full 10k-char body to an anonymous visitor.
  result jsonb,
  error text,
  -- Rate-limiting context. ip is best-effort (from the edge function's
  -- request headers); not used for anything but throttling.
  ip text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Worker claim path: oldest queued first.
CREATE INDEX IF NOT EXISTS idx_demo_requests_queued
  ON public.demo_requests (created_at)
  WHERE status = 'queued';
-- Rate-limit lookups: by IP within a time window, and global by time.
CREATE INDEX IF NOT EXISTS idx_demo_requests_ip_time
  ON public.demo_requests (ip, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_demo_requests_time
  ON public.demo_requests (created_at DESC);

CREATE TRIGGER demo_requests_touch_updated_at
  BEFORE UPDATE ON public.demo_requests
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- RLS on, no policies — service_role bypasses RLS, everyone else is
-- locked out. The edge functions are the only access path.
ALTER TABLE public.demo_requests ENABLE ROW LEVEL SECURITY;

-- Atomic claim for the worker, mirroring claim_next_job(). SECURITY
-- DEFINER + service_role-only so only the worker can pull demo work.
CREATE OR REPLACE FUNCTION public.claim_next_demo()
RETURNS public.demo_requests
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  claimed public.demo_requests%ROWTYPE;
BEGIN
  WITH next AS (
    SELECT id
      FROM public.demo_requests
     WHERE status = 'queued'
     ORDER BY created_at ASC
     LIMIT 1
     FOR UPDATE SKIP LOCKED
  )
  UPDATE public.demo_requests d
     SET status = 'running', started_at = now()
    FROM next
   WHERE d.id = next.id
  RETURNING d.* INTO claimed;
  RETURN claimed;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_next_demo() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_next_demo() FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_next_demo() TO service_role;
