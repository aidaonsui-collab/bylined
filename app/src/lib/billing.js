// Billing helpers: invoke the Stripe-related edge functions.
// Uses invokeEdgeFunction from lib/stripe.js for consistent error handling.

import { invokeEdgeFunction } from './stripe.js';

// Hard-coded plan catalog. Price IDs are produced by
// scripts/setup-stripe.ts and synced here. To regenerate: run the
// script, then copy from scripts/.stripe-setup-output.json.
export const PLANS = [
  {
    id: 'solo',
    name: 'Solo',
    priceMonthly: 39,
    articles: 10,
    description: '10 articles / month',
    tagline: 'For first sites',
    priceId: 'price_1TUvxLIa0nbOr6yh344cOip6',
  },
  {
    id: 'studio',
    name: 'Studio',
    priceMonthly: 99,
    articles: 30,
    description: '30 articles / month',
    tagline: 'Most operators pick this',
    featured: true,
    priceId: 'price_1TUvxMIa0nbOr6yhyG8OMtw0',
  },
  {
    id: 'agency',
    name: 'Agency',
    priceMonthly: 299,
    articles: 100,
    description: '100 articles / month',
    tagline: 'White-label for clients',
    priceId: 'price_1TUvxNIa0nbOr6yhVpaaa4mg',
  },
  {
    id: 'scale',
    name: 'Scale',
    priceMonthly: 599,
    articles: 300,
    description: '300 articles / month',
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
