-- Pending-review flow.
--
-- Generated articles no longer auto-publish. They land in a new
-- 'pending_review' state, the founder is alerted, audits the article,
-- and approves it (→ 'draft', a normal publishable article) or rejects
-- it (→ 'failed'). The review surface is cross-account and admin-gated.

-- 1. New article state.
alter table public.articles drop constraint if exists articles_status_check;
alter table public.articles add constraint articles_status_check
  check (status in ('draft', 'scheduled', 'published', 'failed', 'pending_review'));

-- 2. Admin flag — gates the cross-account review surface.
alter table public.profiles
  add column if not exists is_admin boolean not null default false;

-- 3. Cross-account review queue. SECURITY DEFINER so it can read every
--    account's articles; the body of the function refuses non-admins,
--    so a normal user calling it gets nothing.
create or replace function public.admin_list_pending_articles()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.profiles where id = auth.uid() and is_admin = true
  ) then
    raise exception 'not authorized';
  end if;

  return coalesce((
    select jsonb_agg(
      jsonb_build_object(
        'id', a.id,
        'keyword', a.keyword,
        'title', a.title,
        'meta_description', a.meta_description,
        'body_markdown', a.body_markdown,
        'receipts', a.receipts,
        'pass_rate', a.pass_rate,
        'generated_at', a.generated_at,
        'owner_email', p.email,
        'site_id', a.site_id
      )
      order by a.generated_at desc
    )
    from public.articles a
    join public.profiles p on p.id = a.user_id
    where a.status = 'pending_review'
  ), '[]'::jsonb);
end;
$$;

-- 4. Approve (→ draft) or reject (→ failed) a reviewed article.
--    Admin-only. Approving just clears the review gate — the article
--    becomes a normal draft that publishes through the existing flow.
create or replace function public.admin_set_article_status(
  p_article_id uuid,
  p_status text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.profiles where id = auth.uid() and is_admin = true
  ) then
    raise exception 'not authorized';
  end if;
  if p_status not in ('draft', 'failed') then
    raise exception 'invalid target status: %', p_status;
  end if;
  update public.articles set status = p_status where id = p_article_id;
end;
$$;

-- 5. Alert the founder the moment an article enters pending_review.
--    Same fire-and-forget Resend pattern as the signup alert; reads the
--    key from Vault, exception-wrapped so a failed alert never breaks
--    article generation.
create or replace function public.notify_founder_on_pending_review()
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
    from vault.decrypted_secrets where name = 'resend_api_key' limit 1;
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
        'from', 'Bylined Review <alerts@glossi.cc>',
        'to', jsonb_build_array('yoda.h79@gmail.com'),
        'subject', 'Article pending review: ' ||
          coalesce(new.keyword, new.title, '(untitled)'),
        'text',
          'A generated article is waiting for your audit.' || E'\n\n' ||
          '  Keyword: ' || coalesce(new.keyword, '—') || E'\n' ||
          '  Title:   ' || coalesce(new.title, '—') || E'\n' ||
          '  Pass:    ' || coalesce(new.pass_rate::text, '—') || E'\n' ||
          '  Time:    ' || coalesce(new.generated_at::text, now()::text) || E'\n\n' ||
          'Review it: https://app.getbylined.com/app/review'
      )
    );
  exception when others then
    raise warning 'notify_founder_on_pending_review failed (non-fatal): %', sqlerrm;
  end;
  return new;
end;
$$;

drop trigger if exists trg_notify_pending_review on public.articles;
create trigger trg_notify_pending_review
  after insert on public.articles
  for each row when (new.status = 'pending_review')
  execute function public.notify_founder_on_pending_review();
