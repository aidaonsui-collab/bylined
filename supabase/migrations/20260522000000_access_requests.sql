-- access_requests — "Request access" leads from the marketing site.
--
-- Bylined is a done-for-you service: prospects don't self-serve sign up,
-- they ask to be onboarded by hand. This table captures those requests.
--
-- Unauthenticated, like demo_requests: the people filling this in aren't
-- users yet. Same security model — RLS enabled with NO anon/authenticated
-- policies, so the request-access edge function (service_role) is the
-- only way a row gets written, and nothing is readable from the public
-- API.
--
-- An AFTER INSERT trigger emails the founder via Resend, reusing the
-- exact pg_net + vault.decrypted_secrets path proven by the signup alert
-- (notify_founder_on_signup). No new secret to configure — the
-- resend_api_key Vault secret is already in place.

create table if not exists public.access_requests (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null,
  website text not null,
  -- One optional line about the business.
  note text,
  -- Best-effort client IP, from the edge function headers. Rate limiting
  -- only — not used for anything else.
  ip text,
  created_at timestamptz not null default now()
);

-- Newest-first listing (for a future admin view) and IP rate-limit lookups.
create index if not exists idx_access_requests_time
  on public.access_requests (created_at desc);
create index if not exists idx_access_requests_ip_time
  on public.access_requests (ip, created_at desc);

-- RLS on, no policies — service_role bypasses RLS, everyone else is
-- locked out. The request-access edge function is the only door in.
alter table public.access_requests enable row level security;

-- Founder alert — mirrors notify_founder_on_signup exactly. The whole
-- body is wrapped in an exception block: a Resend failure (missing key,
-- API down, bad response) must NEVER roll back the lead insert.
--
-- reply_to is set to the prospect's address so a reply from the alert
-- goes straight back to them.
create or replace function public.notify_founder_on_access_request()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_resend_key text;
begin
  begin
    select decrypted_secret into v_resend_key
    from vault.decrypted_secrets
    where name = 'resend_api_key'
    limit 1;

    -- Not configured yet → skip silently; the lead is still saved.
    if v_resend_key is null or v_resend_key = '' then
      return new;
    end if;

    perform net.http_post(
      url := 'https://api.resend.com/emails',
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || v_resend_key,
        'Content-Type', 'application/json'
      ),
      body := jsonb_build_object(
        'from', 'Bylined <alerts@glossi.cc>',
        'to', jsonb_build_array('yoda.h79@gmail.com'),
        'reply_to', new.email,
        'subject', 'New Bylined access request: ' || coalesce(new.name, new.email),
        'text',
          'Someone requested access to Bylined.' || E'\n\n' ||
          '  Name:    ' || coalesce(new.name, '—') || E'\n' ||
          '  Email:   ' || coalesce(new.email, '—') || E'\n' ||
          '  Website: ' || coalesce(new.website, '—') || E'\n' ||
          '  About:   ' || coalesce(new.note, '—') || E'\n' ||
          '  Time:    ' || coalesce(new.created_at::text, '') || E'\n' ||
          '  Id:      ' || new.id::text
      )
    );
  exception when others then
    -- Alert failed — log it, but never abort the insert transaction.
    raise warning 'notify_founder_on_access_request: alert failed (insert unaffected): %', sqlerrm;
  end;
  return new;
end;
$$;

drop trigger if exists trg_notify_founder_on_access_request on public.access_requests;
create trigger trg_notify_founder_on_access_request
  after insert on public.access_requests
  for each row execute function public.notify_founder_on_access_request();
