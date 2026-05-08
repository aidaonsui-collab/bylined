// stripe-webhook
//
// Receives subscription lifecycle events from Stripe and mirrors state
// into public.subscriptions. Authenticates via Stripe-Signature header
// (verify_jwt is FALSE — Stripe doesn't send a Supabase JWT).
//
// Events we handle:
//   customer.subscription.created/updated → upsert row by stripe_subscription_id
//   customer.subscription.deleted         → mark canceled
//   invoice.payment_succeeded             → reset articles_used_this_period to 0
//                                            (period rollover)
//   invoice.payment_failed                → log only; subscription stays active
//                                            until Stripe transitions it
//
// We resolve user_id by looking up profiles.stripe_customer_id; if no
// match, the event is ignored (could be a customer made outside our
// app, or a race with profile creation).

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const STRIPE_WEBHOOK_SECRET = Deno.env.get("STRIPE_WEBHOOK_SECRET")!;

const encoder = new TextEncoder();

// Stripe sends signatures as: t=<unix>,v1=<hex>,v0=<hex>
// We verify the v1 signature (HMAC-SHA256 over `${t}.${rawBody}`).
async function verifyStripeSignature(
  rawBody: string,
  sigHeader: string,
  secret: string
): Promise<boolean> {
  const parts = Object.fromEntries(
    sigHeader.split(",").map((kv) => {
      const [k, ...rest] = kv.split("=");
      return [k, rest.join("=")];
    })
  ) as Record<string, string>;
  const timestamp = parts.t;
  const signature = parts.v1;
  if (!timestamp || !signature) return false;

  const signedPayload = `${timestamp}.${rawBody}`;
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sigBuf = await crypto.subtle.sign("HMAC", key, encoder.encode(signedPayload));
  const expected = Array.from(new Uint8Array(sigBuf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  // Constant-time-ish compare
  if (expected.length !== signature.length) return false;
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) {
    mismatch |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return mismatch === 0;
}

interface StripeSubscription {
  id: string;
  customer: string;
  status: string;
  cancel_at_period_end: boolean;
  current_period_start: number;
  current_period_end: number;
  items: { data: Array<{ price: { id: string; metadata?: Record<string, string> } }> };
  metadata: Record<string, string>;
}

interface StripeInvoice {
  id: string;
  customer: string;
  subscription: string | null;
}

const PLAN_QUOTAS: Record<string, number> = {
  solo: 10,
  studio: 30,
  agency: 100,
  scale: 300,
};

function plan(planId: string | undefined): { plan: string; articles_quota: number } {
  const id = planId && PLAN_QUOTAS[planId] ? planId : "solo";
  return { plan: id, articles_quota: PLAN_QUOTAS[id] };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  if (!STRIPE_WEBHOOK_SECRET) {
    console.error("STRIPE_WEBHOOK_SECRET not configured");
    return new Response("Misconfigured", { status: 500 });
  }

  const sigHeader = req.headers.get("stripe-signature") ?? "";
  if (!sigHeader) return new Response("Missing stripe-signature", { status: 400 });

  const rawBody = await req.text();
  const ok = await verifyStripeSignature(rawBody, sigHeader, STRIPE_WEBHOOK_SECRET);
  if (!ok) return new Response("Invalid signature", { status: 400 });

  let event: { id: string; type: string; data: { object: unknown } };
  try {
    event = JSON.parse(rawBody);
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  try {
    if (
      event.type === "customer.subscription.created" ||
      event.type === "customer.subscription.updated"
    ) {
      const sub = event.data.object as StripeSubscription;

      // Resolve user_id: prefer the metadata we set at checkout, fall back
      // to a profile lookup by stripe_customer_id.
      let userId = sub.metadata?.user_id ?? null;
      if (!userId) {
        const { data } = await admin
          .from("profiles")
          .select("id")
          .eq("stripe_customer_id", sub.customer)
          .maybeSingle();
        userId = data?.id ?? null;
      }
      if (!userId) {
        console.warn("no user_id resolved for subscription", sub.id);
        return new Response("OK", { status: 200 });
      }

      const planId =
        sub.metadata?.plan_id ?? sub.items.data[0]?.price.metadata?.bylined_plan_id;
      const { plan: resolvedPlan, articles_quota } = plan(planId);
      const priceId = sub.items.data[0]?.price.id ?? "";

      await admin.from("subscriptions").upsert(
        {
          user_id: userId,
          stripe_subscription_id: sub.id,
          stripe_price_id: priceId,
          plan: resolvedPlan,
          status: sub.status,
          current_period_start: new Date(sub.current_period_start * 1000).toISOString(),
          current_period_end: new Date(sub.current_period_end * 1000).toISOString(),
          cancel_at_period_end: sub.cancel_at_period_end,
          articles_quota,
        },
        { onConflict: "stripe_subscription_id" }
      );

      // Mirror plan onto profile for fast reads (gates feature access etc).
      await admin
        .from("profiles")
        .update({ plan: resolvedPlan })
        .eq("id", userId);
    } else if (event.type === "customer.subscription.deleted") {
      const sub = event.data.object as StripeSubscription;
      await admin
        .from("subscriptions")
        .update({ status: "canceled" })
        .eq("stripe_subscription_id", sub.id);

      // Find the user and downgrade their plan to free.
      const { data: row } = await admin
        .from("subscriptions")
        .select("user_id")
        .eq("stripe_subscription_id", sub.id)
        .maybeSingle();
      if (row?.user_id) {
        await admin.from("profiles").update({ plan: "free" }).eq("id", row.user_id);
      }
    } else if (event.type === "invoice.payment_succeeded") {
      const invoice = event.data.object as StripeInvoice;
      if (invoice.subscription) {
        // Period renewed — reset usage counter.
        await admin
          .from("subscriptions")
          .update({ articles_used_this_period: 0 })
          .eq("stripe_subscription_id", invoice.subscription);
      }
    } else if (event.type === "invoice.payment_failed") {
      // Stripe will retry and may transition the subscription to past_due.
      // We rely on customer.subscription.updated to mirror that state.
      console.log("invoice.payment_failed for", (event.data.object as StripeInvoice).id);
    }
    // Ignore other event types.

    return new Response(JSON.stringify({ received: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("webhook handler error:", msg, "event:", event.id, event.type);
    // Return 500 so Stripe retries — this is critical for at-least-once delivery.
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
