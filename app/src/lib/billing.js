// Billing helpers: invoke the Stripe-related edge functions.
// Uses invokeEdgeFunction from lib/stripe.js for consistent error handling.

import { invokeEdgeFunction } from './stripe.js';

// Hard-coded plan catalog. Price IDs are produced by
// scripts/setup-stripe.ts and synced here. To regenerate: run the
// script, then copy from scripts/.stripe-setup-output.json.
//
// 'solo' ($39/10 articles) was removed from the public catalog when
// we shipped the free Pilot trial — new signups never see it. The
// Stripe price still exists for any legacy customer on the tier;
// they keep working unchanged because quota enforcement reads the
// subscriptions row, not this list.
// Pricing catalog — matches the marketing /pricing page persona text
// + the homepage rail (synced 2026-05-18). When marketing copy changes,
// update both this file and marketing/{index,pricing}.html together.
//
// `rank` controls ordering for the in-app comparison grid. Lower =
// cheaper; we use it to compute "upgrade" vs "downgrade" relative to
// the current plan. Pilot is rank 0 (free trial); paid plans go 1-3.
//
// Pilot is included in the catalog so the Billing page can show
// "Current plan" against a customer in their trial, but it isn't
// directly purchasable (no priceId) — signups land on it via the
// pilot-onboarding flow.
export const PLANS = [
  {
    id: 'pilot',
    rank: 0,
    name: 'Pilot',
    priceMonthly: 0,
    priceLabel: 'Free',
    pricePer: '14 days',
    articles: 10,
    description: '10 articles / trial',
    persona: 'Evaluating Bylined — see receipts on a real draft first.',
    delta: 'No card. The same engine, capped at 10 articles.',
    priceId: null,
  },
  {
    id: 'studio',
    rank: 1,
    name: 'Studio',
    priceMonthly: 99,
    priceLabel: '$99',
    pricePer: '/mo',
    articles: 30,
    description: '30 articles / mo',
    persona: 'Solo founders + content ops shipping ~1 article/day on one brand.',
    delta: 'Everything in Pilot, plus auto-publish, approval workflow, and the full CMS roster.',
    tagline: 'Most operators pick this',
    featured: true,
    priceId: 'price_1TUvxMIa0nbOr6yhyG8OMtw0',
  },
  {
    id: 'agency',
    rank: 2,
    name: 'Agency',
    priceMonthly: 299,
    priceLabel: '$299',
    pricePer: '/mo',
    articles: 100,
    description: '100 articles / mo',
    persona: 'Agencies managing 3–10 client sites — white-label + per-client branding.',
    delta: 'Everything in Studio, plus white-label, bulk publishing across clients, and a 99.5% SLA.',
    tagline: 'White-label for clients',
    priceId: 'price_1TUvxNIa0nbOr6yhVpaaa4mg',
  },
  {
    id: 'scale',
    rank: 3,
    name: 'Scale',
    priceMonthly: 599,
    priceLabel: '$599',
    pricePer: '/mo',
    articles: 300,
    description: '300 articles / mo',
    persona: 'Programmatic SEO + multi-brand portfolios. Volume, SLA, Slack support.',
    delta: 'Everything in Agency, plus reseller billing, a success manager, and a 99.9% SLA.',
    tagline: 'Volume + SLA',
    priceId: 'price_1TUvxOIa0nbOr6yh6rcfq1Z3',
  },
];

export async function startCheckout(priceId, planId) {
  const result = await invokeEdgeFunction('create-checkout-session', { priceId, planId });
  if (!result.ok) return result;
  const url = result.data?.url;
  if (!url) return { ok: false, error: 'Checkout session created but no URL returned.' };
  window.location.assign(url);
  return { ok: true };
}

export async function openCustomerPortal() {
  const result = await invokeEdgeFunction('create-portal-session', {});
  if (!result.ok) return result;
  const url = result.data?.url;
  if (!url) return { ok: false, error: 'Portal session created but no URL returned.' };
  window.location.assign(url);
  return { ok: true };
}
