-- Founder signup alert.
--
-- Every new account — free trial or paid — first creates a row in
-- public.profiles (via the handle_new_user trigger on auth.users). So an
-- AFTER INSERT trigger on profiles catches 100% of signups. It emails
-- founders@getbylined.com through Resend, fire-and-forget via pg_net.
--
-- SETUP: add the Resend API key to Supabase Vault as a secret named
-- exactly `resend_api_key`. Until that secret exists, the trigger
-- no-ops (signups still work, no alert is sent).
--
-- SAFETY: the whole body is wrapped in an exception block. An alert
-- failure (missing key, Resend down, malformed response) must NEVER
-- roll back a user's signup — account creation always wins.

create or replace function public.notify_founder_on_signup()
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

    -- Not configured yet → skip silently; the signup still succeeds.
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
        'from', 'Bylined Signups <onboarding@resend.dev>',
        'to', jsonb_build_array('founders@getbylined.com'),
        'subject', 'New Bylined signup: ' || coalesce(new.email, '(no email)'),
        'text',
          'A new account just signed up for Bylined.' || E'\n\n' ||
          '  Email: ' || coalesce(new.email, '—') || E'\n' ||
          '  Name:  ' || coalesce(new.full_name, '—') || E'\n' ||
          '  Plan:  ' || coalesce(new.plan, 'free') || E'\n' ||
          '  Time:  ' || coalesce(new.created_at::text, '') || E'\n' ||
          '  User:  ' || new.id::text
      )
    );
  exception when others then
    -- Alert failed — log it, but never abort the signup transaction.
    raise warning 'notify_founder_on_signup: alert failed (signup unaffected): %', sqlerrm;
  end;
  return new;
end;
$$;

drop trigger if exists trg_notify_founder_on_signup on public.profiles;
create trigger trg_notify_founder_on_signup
  after insert on public.profiles
  for each row execute function public.notify_founder_on_signup();
