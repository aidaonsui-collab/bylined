// Thin client for the suggest-keywords edge function. Returns
// { ok: true, suggestions: [...] } or { ok: false, error }. Same
// shape as lib/jobs.js helpers so the dashboard's call sites stay
// uniform.

import { invokeEdgeFunction } from './stripe.js';

export async function fetchKeywordSuggestions({ voiceId, siteId, seed, count = 15 } = {}) {
  const result = await invokeEdgeFunction('suggest-keywords', {
    voice_id: voiceId ?? undefined,
    // Scope dedup/grounding to one site so a different brand's article
    // history can't drag suggestions off-topic.
    site_id: siteId ?? undefined,
    // Optional explicit topic to steer suggestions regardless of history.
    seed: seed ?? undefined,
    count,
  });
  if (!result.ok) return { ok: false, error: result.error };
  // Edge function returns { ok, voice, suggestions } — pass through.
  return {
    ok: true,
    voice: result.data?.voice ?? null,
    suggestions: Array.isArray(result.data?.suggestions)
      ? result.data.suggestions
      : [],
  };
}
