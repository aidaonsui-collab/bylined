// Job operations: regenerate an article, retry a failed job.
//
// Quota note — the BEFORE INSERT trigger on public.jobs
// (enforce_jobs_quota) only fires on INSERT:
//   * regenerateArticle does an INSERT → counts against quota.
//   * retryJob does an UPDATE on the existing failed row → does NOT
//     count. A failed run was already free; retrying it stays free.

import { supabase } from './supabase.js';

// Re-queue a fresh job for an article's keyword, carrying over the
// voice the original job used so the regenerated article keeps the
// same brand styling. New INSERT → consumes one article from quota.
export async function regenerateArticle(article, userId) {
  // Recover the voice the article's original job used, if any. The
  // article row itself doesn't store voice_id — the job does.
  const { data: origJob } = await supabase
    .from('jobs')
    .select('voice_id')
    .eq('article_id', article.id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const { error } = await supabase.from('jobs').insert({
    user_id: userId,
    keyword: article.keyword,
    voice_id: origJob?.voice_id ?? null,
  });
  if (error) {
    const msg = error.message || 'Could not queue regeneration.';
    if (msg.includes('quota_exceeded')) {
      return { ok: false, error: 'Quota exhausted for this period.' };
    }
    if (msg.includes('no_active_subscription')) {
      return { ok: false, error: 'Subscribe to a plan first.' };
    }
    return { ok: false, error: msg };
  }
  return { ok: true };
}

// Re-queue a FAILED job in place. UPDATE (not INSERT) so the quota
// trigger doesn't fire — retries are free. The .eq('status','failed')
// guard makes this a no-op on anything that isn't actually failed.
export async function retryJob(jobId) {
  const { data, error } = await supabase
    .from('jobs')
    .update({
      status: 'queued',
      error: null,
      started_at: null,
      completed_at: null,
    })
    .eq('id', jobId)
    .eq('status', 'failed')
    .select('id');
  if (error) return { ok: false, error: error.message };
  if (!data || data.length === 0) {
    return { ok: false, error: 'Job is no longer in a failed state.' };
  }
  return { ok: true };
}
