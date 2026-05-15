// start-pilot
//
// Creates a free 14-day Pilot subscription for the calling user. No
// Stripe, no card. Called once at signup when the user picked Pilot
// on the marketing pricing page. Idempotent: if the user already has
// a Pilot row (regardless of state), returns ok without creating a
// second one — the partial unique index unq_subscriptions_one_pilot_per_user
// also enforces this at the DB level.
//
// Pilot grants:
//   plan='pilot'
//   articles_quota=10
//   current_period_start=now, current_period_end=now+14 days
//   status='trialing'
//
// After expiry (period_end < now) or quota exhaustion, the existing
// enforce_jobs_quota trigger blocks new article jobs and the in-app
// banner prompts an upgrade to Studio+.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const PILOT_ARTICLES = 10;
const PILOT_DAYS = 14;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS")
    return new Response(null, { headers: CORS_HEADERS });

  try {
    const authHeader = req.headers.get("authorization") ?? "";
    if (!authHeader) return jsonResponse(401, { error: "Missing authorization" });

    // JWT-scoped client to identify the caller. RLS-safe.
    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false },
    });
    const {
      data: { user },
      error: userErr,
    } = await userClient.auth.getUser();
    if (userErr || !user) return jsonResponse(401, { error: "Unauthorized" });

    const now = new Date();
    const periodEnd = new Date(now.getTime() + PILOT_DAYS * 24 * 60 * 60 * 1000);

    // Service-role client to write the subscription row. subscriptions has
    // no INSERT policy by design — only the Stripe webhook (and now this
    // function) writes to it.
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });

    // Idempotent: if a pilot row already exists for this user, treat as
    // success rather than blowing up the signup flow on a refresh.
    const { data: existing } = await admin
      .from("subscriptions")
      .select("id, plan, status, current_period_end, articles_used_this_period, articles_quota")
      .eq("user_id", user.id)
      .eq("plan", "pilot")
      .maybeSingle();

    if (existing) {
      return jsonResponse(200, {
        ok: true,
        already_started: true,
        subscription: existing,
      });
    }

    // Also short-circuit if the user has an active paid sub already —
    // they shouldn't be on the Pilot path at all in that case.
    const { data: paidSub } = await admin
      .from("subscriptions")
      .select("id, plan, status")
      .eq("user_id", user.id)
      .in("plan", ["solo", "studio", "agency", "scale"])
      .in("status", ["active", "trialing"])
      .maybeSingle();
    if (paidSub) {
      return jsonResponse(200, {
        ok: true,
        already_paid: true,
        subscription: paidSub,
      });
    }

    const { data: inserted, error: insertErr } = await admin
      .from("subscriptions")
      .insert({
        user_id: user.id,
        stripe_subscription_id: null,
        stripe_price_id: null,
        plan: "pilot",
        status: "trialing",
        current_period_start: now.toISOString(),
        current_period_end: periodEnd.toISOString(),
        cancel_at_period_end: false,
        articles_used_this_period: 0,
        articles_quota: PILOT_ARTICLES,
      })
      .select("id, plan, status, current_period_end, articles_quota")
      .single();

    if (insertErr) {
      // Race: another concurrent call won the partial unique index. Treat
      // as success by re-reading.
      if (insertErr.code === "23505") {
        const { data: raceRow } = await admin
          .from("subscriptions")
          .select("id, plan, status, current_period_end, articles_quota")
          .eq("user_id", user.id)
          .eq("plan", "pilot")
          .maybeSingle();
        if (raceRow) {
          return jsonResponse(200, {
            ok: true,
            already_started: true,
            subscription: raceRow,
          });
        }
      }
      console.error("start-pilot insert error:", insertErr.message);
      return jsonResponse(500, {
        error: "Could not start your free trial. Try again.",
      });
    }

    return jsonResponse(200, { ok: true, subscription: inserted });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("start-pilot error:", msg);
    return jsonResponse(500, {
      error: "Could not start your free trial. Try again.",
    });
  }
});
