// Thin client for the suggest-keywords edge function. Returns
// { ok: true, suggestions: [...] } or { ok: false, error }. Same
// shape as lib/jobs.js helpers so the dashboard's call sites stay
// uniform.

import { invokeEdgeFunction } from './stripe.js';

export async function fetchKeywordSuggestions({ voiceId, count = 15 } = {}) {
  const result = await invokeEdgeFunction('suggest-keywords', {
    voice_id: voiceId ?? undefined,
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
