// create-checkout-session
//
// User clicks "Subscribe to Studio" on /app/pricing. Frontend posts
// { priceId, planId } here. We:
//
//   1. Authenticate the caller via the Supabase JWT in the Authorization
//      header (verify_jwt=true gates this for us).
//   2. Find or create a Stripe Customer mapped to the user's profile.
//   3. Create a Checkout Session in subscription mode.
//   4. Return { url } so the frontend can window.location to it.
//
// State doesn't change in our DB until the webhook fires
// customer.subscription.created — that's when we insert the
// subscriptions row. This keeps half-completed checkouts from leaving
// stranded rows.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const APP_URL = Deno.env.get("APP_URL") ?? "http://localhost:5189";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

async function stripeForm(path: string, params: Record<string, string>) {
  const body = new URLSearchParams(params);
  const r = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "Stripe-Version": "2024-09-30.acacia",
    },
    body,
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error?.message || `Stripe ${path} failed`);
  return j;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

  try {
    if (!STRIPE_SECRET_KEY) throw new Error("STRIPE_SECRET_KEY not configured");

    const authHeader = req.headers.get("authorization") ?? "";
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Missing authorization" }), {
        status: 401,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    // User-scoped client to read the calling user's identity.
    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false },
    });
    const {
      data: { user },
      error: userErr,
    } = await userClient.auth.getUser();
    if (userErr || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    const body = (await req.json().catch(() => null)) as
      | { priceId?: string; planId?: string }
      | null;
    if (!body?.priceId) {
      return new Response(JSON.stringify({ error: "priceId required" }), {
        status: 400,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    // Service-role client to read/write profile rows server-side.
    const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });

    // Look up or create the Stripe customer for this user.
    const { data: profile } = await adminClient
      .from("profiles")
      .select("stripe_customer_id, email, full_name")
      .eq("id", user.id)
      .single();

    let stripeCustomerId = profile?.stripe_customer_id ?? null;
    if (!stripeCustomerId) {
      const created = await stripeForm("customers", {
        email: profile?.email ?? user.email ?? "",
        name: profile?.full_name ?? "",
        "metadata[user_id]": user.id,
      });
      stripeCustomerId = created.id as string;
      await adminClient
        .from("profiles")
        .update({ stripe_customer_id: stripeCustomerId })
        .eq("id", user.id);
    }

    // Create the Checkout Session.
    const session = await stripeForm("checkout/sessions", {
      mode: "subscription",
      customer: stripeCustomerId,
      "line_items[0][price]": body.priceId,
      "line_items[0][quantity]": "1",
      success_url: `${APP_URL}/app/billing?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${APP_URL}/app/pricing?checkout=cancelled`,
      "subscription_data[metadata][user_id]": user.id,
      "subscription_data[metadata][plan_id]": body.planId ?? "",
      allow_promotion_codes: "true",
      "metadata[user_id]": user.id,
    });

    return new Response(JSON.stringify({ url: session.url }), {
      status: 200,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("create-checkout-session error:", msg);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
});
