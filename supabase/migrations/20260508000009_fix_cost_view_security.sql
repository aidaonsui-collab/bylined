-- Views inherit SECURITY DEFINER by default in Supabase Postgres, which
-- means they execute with the view-creator's permissions and bypass RLS.
-- We need them to run with the querying user's permissions so the
-- cost_events RLS policy gates the rows.

ALTER VIEW public.cost_per_article SET (security_invoker = on);
ALTER VIEW public.cost_per_user_day SET (security_invoker = on);
