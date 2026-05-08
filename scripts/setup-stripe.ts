#!/usr/bin/env tsx
// One-shot: creates Bylined's 4 products, monthly prices, and the webhook
// endpoint that points at our Supabase edge function. Idempotent — uses
// metadata to find existing rows before creating new ones, so re-running
// is safe.
//
// Usage:
//   STRIPE_SECRET_KEY=sk_test_... tsx scripts/setup-stripe.ts
//
// Output:
//   scripts/.stripe-setup-output.json  (gitignored — contains price IDs +
//                                        webhook signing secret)
//   stdout: human summary + next-step instructions

import { writeFileSync } from "node:fs";
import { join } from "node:path";

const STRIPE_KEY = process.env.STRIPE_SECRET_KEY;
if (!STRIPE_KEY) {
  console.error("STRIPE_SECRET_KEY not set. Export it before running this script:");
  console.error("  export STRIPE_SECRET_KEY=sk_test_...  &&  tsx scripts/setup-stripe.ts");
  process.exit(1);
}
if (!STRIPE_KEY.startsWith("sk_test_")) {
  console.error(
    "Refusing to run with a non-test secret key. This script is intended for test mode only."
  );
  console.error("Pass an sk_test_... key, not an sk_live_... one.");
  process.exit(1);
}

// Webhook URL points at the deployed Supabase edge function.
// boatyhrefcilcxepnbbf is the Bylined project ref.
const WEBHOOK_URL =
  process.env.WEBHOOK_URL ??
  "https://boatyhrefcilcxepnbbf.supabase.co/functions/v1/stripe-webhook";

// Plans must match the values used elsewhere in the codebase (the
// `subscriptions.plan` CHECK constraint, the marketing pricing tiers,
// and the in-app billing UI).
const PLANS = [
  { id: "solo",   name: "Bylined Solo",   description: "10 articles / month",  unit_amount: 3900,  articles_quota: 10 },
  { id: "studio", name: "Bylined Studio", description: "30 articles / month",  unit_amount: 9900,  articles_quota: 30 },
  { id: "agency", name: "Bylined Agency", description: "100 articles / month", unit_amount: 29900, articles_quota: 100 },
  { id: "scale",  name: "Bylined Scale",  description: "300 articles / month", unit_amount: 59900, articles_quota: 300 },
];

const STRIPE_API = "https://api.stripe.com/v1";

interface StripeError {
  error?: { message: string; type?: string; code?: string };
}

async function stripe<T>(
  path: string,
  method: "GET" | "POST",
  params?: Record<string, string | string[]>
): Promise<T> {
  const url = method === "GET" && params
    ? `${STRIPE_API}/${path}?${encodeForm(params)}`
    : `${STRIPE_API}/${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${STRIPE_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "Stripe-Version": "2024-09-30.acacia",
    },
    body: method === "POST" && params ? encodeForm(params) : undefined,
  });
  const json = (await res.json()) as T & StripeError;
  if (!res.ok) {
    const msg = json.error?.message || `Stripe ${path} failed (${res.status})`;
    throw new Error(msg);
  }
  return json;
}

// Stripe wants form-urlencoded with bracket notation for nested arrays:
// enabled_events[] = a; enabled_events[] = b
function encodeForm(params: Record<string, string | string[]>): string {
  const out: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) {
      for (const item of v) {
        out.push(`${encodeURIComponent(k)}[]=${encodeURIComponent(item)}`);
      }
    } else {
      out.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
    }
  }
  return out.join("&");
}

interface StripeProduct { id: string; name: string; metadata: Record<string, string>; }
interface StripePrice { id: string; product: string; unit_amount: number; recurring: { interval: string }; metadata: Record<string, string>; lookup_key?: string | null; active: boolean; }
interface StripeWebhookEndpoint { id: string; url: string; secret?: string; status: string; }
interface StripeList<T> { data: T[]; has_more: boolean; }

async function findExistingProduct(planId: string): Promise<StripeProduct | null> {
  // Stripe's GET /v1/products doesn't accept metadata filters; we list
  // and filter client-side. With ~4 Bylined products this is fine.
  const list = await stripe<StripeList<StripeProduct>>("products", "GET", {
    limit: "100",
    active: "true",
  });
  return list.data.find((p) => p.metadata?.bylined_plan_id === planId) ?? null;
}

async function findExistingPrice(productId: string, unitAmount: number): Promise<StripePrice | null> {
  const list = await stripe<StripeList<StripePrice>>("prices", "GET", {
    product: productId,
    active: "true",
    limit: "100",
  });
  return list.data.find(
    (p) => p.unit_amount === unitAmount && p.recurring?.interval === "month"
  ) ?? null;
}

async function findExistingWebhook(url: string): Promise<StripeWebhookEndpoint | null> {
  const list = await stripe<StripeList<StripeWebhookEndpoint>>("webhook_endpoints", "GET", {
    limit: "100",
  });
  return list.data.find((w) => w.url === url) ?? null;
}

async function ensureProduct(plan: typeof PLANS[number]): Promise<{ product: StripeProduct; price: StripePrice }> {
  let product = await findExistingProduct(plan.id);
  if (product) {
    console.log(`  ✓ product exists: ${product.id} (${plan.name})`);
  } else {
    product = await stripe<StripeProduct>("products", "POST", {
      name: plan.name,
      description: plan.description,
      "metadata[bylined_plan_id]": plan.id,
      "metadata[articles_quota]": String(plan.articles_quota),
    });
    console.log(`  + product created: ${product.id} (${plan.name})`);
  }

  let price = await findExistingPrice(product.id, plan.unit_amount);
  if (price) {
    console.log(`    ✓ price exists: ${price.id} ($${plan.unit_amount / 100}/mo)`);
  } else {
    price = await stripe<StripePrice>("prices", "POST", {
      product: product.id,
      unit_amount: String(plan.unit_amount),
      currency: "usd",
      "recurring[interval]": "month",
      "metadata[bylined_plan_id]": plan.id,
      "metadata[articles_quota]": String(plan.articles_quota),
    });
    console.log(`    + price created: ${price.id} ($${plan.unit_amount / 100}/mo)`);
  }

  return { product, price };
}

async function ensureWebhook(): Promise<StripeWebhookEndpoint> {
  const events = [
    "customer.subscription.created",
    "customer.subscription.updated",
    "customer.subscription.deleted",
    "invoice.payment_succeeded",
    "invoice.payment_failed",
  ];

  let hook = await findExistingWebhook(WEBHOOK_URL);
  if (hook) {
    console.log(`  ✓ webhook exists: ${hook.id} → ${WEBHOOK_URL}`);
    console.log(`    (signing secret only revealed at creation — re-create if you've lost it)`);
    return hook;
  }
  hook = await stripe<StripeWebhookEndpoint>("webhook_endpoints", "POST", {
    url: WEBHOOK_URL,
    enabled_events: events,
    description: "Bylined subscription events → Supabase edge function",
  });
  console.log(`  + webhook created: ${hook.id} → ${WEBHOOK_URL}`);
  console.log(`    signing secret: ${hook.secret} (save this; only shown once)`);
  return hook;
}

(async () => {
  console.log("─── Bylined Stripe setup ───────────────────────────────");
  console.log(`Mode: TEST`);
  console.log(`Webhook URL: ${WEBHOOK_URL}\n`);

  console.log("Products + prices:");
  const plans: Array<{
    id: string;
    name: string;
    productId: string;
    priceId: string;
    unit_amount: number;
    articles_quota: number;
  }> = [];

  for (const plan of PLANS) {
    const { product, price } = await ensureProduct(plan);
    plans.push({
      id: plan.id,
      name: plan.name,
      productId: product.id,
      priceId: price.id,
      unit_amount: plan.unit_amount,
      articles_quota: plan.articles_quota,
    });
  }

  console.log("\nWebhook endpoint:");
  const hook = await ensureWebhook();

  const output = {
    mode: "test",
    plans,
    webhook: {
      id: hook.id,
      url: hook.url,
      secret: hook.secret ?? "(re-create endpoint to reveal)",
    },
    generated_at: new Date().toISOString(),
  };

  const outPath = join("scripts", ".stripe-setup-output.json");
  writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`\n✓ Wrote ${outPath}\n`);

  console.log("Next steps:");
  console.log("  1. Set Supabase secrets (Edge Functions → Secrets):");
  console.log(`     STRIPE_SECRET_KEY=${STRIPE_KEY.slice(0, 10)}…`);
  if (hook.secret) {
    console.log(`     STRIPE_WEBHOOK_SECRET=${hook.secret}`);
  }
  console.log("  2. Deploy edge functions: handled by the agent.");
  console.log("  3. Subscribe via /app/pricing to verify the flow.");
})().catch((e) => {
  console.error("\n✗ Setup failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
