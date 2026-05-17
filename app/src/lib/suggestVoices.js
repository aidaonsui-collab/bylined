// Thin client for the suggest-voices edge function. Returns
// { ok, suggestions: [{url, brand_name, style_descriptor, why_fit}] }
// or { ok: false, error }. Same shape as suggestKeywords.js.

import { invokeEdgeFunction } from './stripe.js';

export async function fetchVoiceSuggestions({ context, count = 12 } = {}) {
  const result = await invokeEdgeFunction('suggest-voices', {
    context: context || undefined,
    count,
  });
  if (!result.ok) return { ok: false, error: result.error };
  return {
    ok: true,
    suggestions: Array.isArray(result.data?.suggestions)
      ? result.data.suggestions
      : [],
  };
}

// Maps an avg_voice_match score to a 4-tier badge: strong / solid /
// weak / unscored. Used by both Voice.jsx (list rows) and the keyword
// form dropdown options so the rating is consistent across surfaces.
export function voiceStrength({ avgVoiceMatch, pages = 0, articlesScored = 0 }) {
  if (articlesScored === 0) {
    // No articles scored yet — use fingerprint quality as a proxy.
    if (pages >= 6) return { label: 'New · ready', score: null, tone: 'neutral' };
    return { label: 'New', score: null, tone: 'neutral' };
  }
  const s = Number(avgVoiceMatch);
  if (!Number.isFinite(s)) return { label: '—', score: null, tone: 'neutral' };
  if (s >= 75) return { label: 'Strong', score: Math.round(s), tone: 'good' };
  if (s >= 60) return { label: 'Solid', score: Math.round(s), tone: 'good' };
  if (s >= 40) return { label: 'Weak', score: Math.round(s), tone: 'warn' };
  return { label: 'Off-voice', score: Math.round(s), tone: 'bad' };
}
