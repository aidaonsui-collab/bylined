// request-access
//
// Public, UNAUTHENTICATED endpoint (verify_jwt=false). A marketing-site
// visitor fills in the "Request access" form — name, email, website, and
// one optional line about their business. Bylined is done-for-you, so
// these are onboarding leads, not self-serve signups.
//
// This is unauthenticated input reaching our infrastructure, so it:
//   1. Validates + normalizes name / email / website.
//   2. Drops bot submissions via a honeypot field.
//   3. Rate-limits per IP and globally.
//   4. Inserts an access_requests row. An AFTER INSERT trigger emails
//      the founder via Resend — see migration 20260522000000.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Generous for genuine interest, tight enough to blunt a spam script.
const PER_IP_DAILY = 5;
const GLOBAL_DAILY = 200;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Light website check — we never fetch this URL, so no SSRF guard is
// needed; just confirm it's a plausible public hostname and normalize a
// missing scheme.
function normalizeWebsite(raw: string): { ok: true; url: string } | { ok: false; error: string } {
  let u = (raw ?? "").trim();
  if (!u) return { ok: false, error: "Enter your website." };
  if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
  let parsed: URL;
  try {
    parsed = new URL(u);
  } catch {
    return { ok: false, error: "That doesn't look like a valid website." };
  }
  const host = parsed.hostname.toLowerCase();
  // Must look like a real domain (has a dot, no spaces).
  if (!host.includes(".") || host === "localhost") {
    return { ok: false, error: "Enter a full website address." };
  }
  parsed.hash = "";
  return { ok: true, url: parsed.toString() };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

  try {
    const body = (await req.json().catch(() => null)) as
      | { name?: string; email?: string; website?: string; note?: string; company_fax?: string }
      | null;

    // Honeypot — a hidden field real users never see or fill. If it has
    // any value, it's a bot. Return 200 so the bot thinks it succeeded.
    if (typeof body?.company_fax === "string" && body.company_fax.trim() !== "") {
      return jsonResponse(200, { ok: true });
    }

    const name = (body?.name ?? "").trim();
    const email = (body?.email ?? "").trim();
    const note = (body?.note ?? "").trim();

    if (name.length < 2) return jsonResponse(400, { error: "Enter your name." });
    if (name.length > 120) return jsonResponse(400, { error: "That name is too long." });
    if (!EMAIL_RE.test(email)) return jsonResponse(400, { error: "Enter a valid email address." });
    if (email.length > 200) return jsonResponse(400, { error: "That email is too long." });
    if (note.length > 600) return jsonResponse(400, { error: "Keep the note under 600 characters." });

    const site = normalizeWebsite(body?.website ?? "");
    if (!site.ok) return jsonResponse(400, { error: site.error });

    // Best-effort client IP for rate limiting.
    const ip =
      req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      req.headers.get("cf-connecting-ip") ||
      "unknown";

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });

    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    // Global daily cap.
    const { count: globalCount } = await admin
      .from("access_requests")
      .select("id", { count: "exact", head: true })
      .gte("created_at", since);
    if ((globalCount ?? 0) >= GLOBAL_DAILY) {
      return jsonResponse(429, {
        error: "We're getting a lot of requests today. Email founders@getbylined.com and we'll be in touch.",
      });
    }

    // Per-IP daily cap.
    if (ip !== "unknown") {
      const { count: ipCount } = await admin
        .from("access_requests")
        .select("id", { count: "exact", head: true })
        .eq("ip", ip)
        .gte("created_at", since);
      if ((ipCount ?? 0) >= PER_IP_DAILY) {
        return jsonResponse(429, {
          error: "Looks like you've already sent this. We've got it — we'll be in touch shortly.",
        });
      }
    }

    const { error: insertErr } = await admin
      .from("access_requests")
      .insert({ name, email, website: site.url, note: note || null, ip });
    if (insertErr) {
      console.error("request-access insert error:", insertErr.message);
      return jsonResponse(500, { error: "Could not send your request. Try again." });
    }

    return jsonResponse(200, { ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("request-access error:", msg);
    return jsonResponse(500, { error: "Could not send your request. Try again." });
  }
});
