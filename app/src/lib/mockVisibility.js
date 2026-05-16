// Client-side deterministic mock for the AI-visibility chart on the
// dashboard. v1 ships the UI with this fake series so the user can
// see the chart shape and copy before we wire the real cron pipeline
// (v2). DO NOT WRITE THIS TO SUPABASE — it's preview-only.
//
// The numbers are seeded off the user_id hash so they're stable
// across page refreshes (so a customer doesn't see different numbers
// every time, which would be obviously bogus). They're also kept
// modest (single digits early, low-double-digits by week 12) so
// nobody mistakes the preview chart for a real result they should
// brag about.

const QUESTIONS_PER_ENGINE = 5;
const MAX_WEEKS = 12;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function hashSeed(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h) ^ s.charCodeAt(i);
  }
  return Math.abs(h);
}

// mulberry32 — small, fast, deterministic PRNG. Same seed → same sequence,
// which is what we want for "same user always sees the same fake numbers."
function mulberry32(seed) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Returns one row per completed week since signup, capped at MAX_WEEKS.
// Each row: { week, snapshot_date, perplexity, chatgpt, claude,
// total, questions }. Shape matches the v2 visibility_snapshots row
// minus the database fields (id, user_id, created_at, results).
export function mockVisibilityHistory(userId, signupDateIso) {
  if (!userId || !signupDateIso) return [];
  const signupMs = new Date(signupDateIso).getTime();
  if (!Number.isFinite(signupMs)) return [];

  const weeksSinceSignup = Math.floor((Date.now() - signupMs) / WEEK_MS);
  const weeks = Math.max(1, Math.min(MAX_WEEKS, weeksSinceSignup + 1));

  const rand = mulberry32(hashSeed(userId));
  const history = [];

  for (let w = 0; w < weeks; w++) {
    // Slow upward growth curve with per-engine variation. Caps at
    // QUESTIONS_PER_ENGINE since you can't be cited more times than
    // questions you tested against.
    const baseline = Math.min(w * 0.55 + 0.4, 4.5);
    const perplexity = clamp(
      Math.round(baseline + (rand() - 0.5) * 1.6),
      0,
      QUESTIONS_PER_ENGINE,
    );
    const chatgpt = clamp(
      Math.round(baseline * 1.15 + (rand() - 0.5) * 1.6),
      0,
      QUESTIONS_PER_ENGINE,
    );
    const claude = clamp(
      Math.round(baseline * 0.9 + (rand() - 0.5) * 1.6),
      0,
      QUESTIONS_PER_ENGINE,
    );

    history.push({
      week: w,
      snapshot_date: new Date(signupMs + w * WEEK_MS).toISOString(),
      perplexity,
      chatgpt,
      claude,
      total: perplexity + chatgpt + claude,
      questions: QUESTIONS_PER_ENGINE,
    });
  }

  return history;
}

export const VISIBILITY_MAX_PER_WEEK = QUESTIONS_PER_ENGINE * 3;

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}
