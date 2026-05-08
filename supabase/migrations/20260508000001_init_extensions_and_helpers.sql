-- Extensions + helper functions used across the schema.

-- pgcrypto provides gen_random_uuid() for table primary keys.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Generic touch_updated_at() trigger function — every table with an
-- updated_at column attaches a BEFORE UPDATE trigger that calls this.
CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
