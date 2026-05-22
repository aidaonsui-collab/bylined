-- Repoint the signup alert to the address the Resend account is
-- registered under (aidaonsui@gmail.com). With the onboarding@resend.dev
-- shared sender (no verified domain), Resend only delivers to the
-- account's own registered email. Switch to founders@getbylined.com
-- later if getbylined.com gets verified in Resend.

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
        'to', jsonb_build_array('aidaonsui@gmail.com'),
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
    raise warning 'notify_founder_on_signup: alert failed (signup unaffected): %', sqlerrm;
  end;
  return new;
end;
$$;
