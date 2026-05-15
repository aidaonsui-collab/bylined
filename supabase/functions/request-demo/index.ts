// request-demo
//
// Public, UNAUTHENTICATED endpoint (verify_jwt=false). A marketing-site
// visitor pastes their URL; we validate it, rate-limit, and insert a
// demo_requests row. The worker picks it up, crawls the site, infers a
// keyword, and runs the real generate() pipeline.
//
// This is the one place where unauthenticated input reaches our
// infrastructure, so it does three jobs carefully:
//   1. URL validation + SSRF guard — reject non-http(s), localhost,
//      and private/link-local IP ranges so the worker never fetches
//      something internal on a visitor's behalf.
//   2. Rate limiting — per-IP and a global daily cap, both to stop
//      abuse and to protect the Minimax quota (each demo is a full
//      article generation).
//   3. Insert + return the demo id for the page to poll.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Tunables. Generous enough for genuine interest, tight enough that the
// Minimax quota can't be drained by a script.
const PER_IP_DAILY = 5;
const GLOBAL_DAILY = 100;

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

// Reject anything that isn't a public http(s) URL. Catches localhost,
// loopback, private RFC1918 ranges, link-local (incl. cloud metadata
// 169.254.169.254), and *.local — so the worker can't be tricked into
// fetching internal infrastructure.
function validatePublicUrl(raw: string): { ok: true; url: string } | { ok: false; error: string } {
  let u = (raw ?? "").trim();
  if (!u) return { ok: false, error: "Enter your website URL." };
  if (!/^https?:\/\//i.test(u)) u = `https://${u}`;

  let parsed: URL;
  try {
    parsed = new URL(u);
  } catch {
    return { ok: false, error: "That doesn't look like a valid URL." };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: "URL must start with http or https." };
  }

  const host = parsed.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host === "0.0.0.0"
  ) {
    return { ok: false, error: "Enter a public website URL." };
  }
  // IPv4 literal? Block loopback / private / link-local ranges.
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (
      a === 127 || a === 10 || a === 0 ||
      (a === 169 && b === 254) ||
      (a === 192 && b === 168) ||
      (a === 172 && b >= 16 && b <= 31)
    ) {
      return { ok: false, error: "Enter a public website URL." };
    }
  }
  // IPv6 loopback / link-local.
  if (host === "::1" || host.startsWith("fe80:") || host.startsWith("fc") || host.startsWith("fd")) {
    return { ok: false, error: "Enter a public website URL." };
  }

  // Normalize: keep scheme + host (+ path), drop fragments.
  parsed.hash = "";
  return { ok: true, url: parsed.toString() };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

  try {
    const body = (await req.json().catch(() => null)) as { url?: string } | null;
    const check = validatePublicUrl(body?.url ?? "");
    if (!check.ok) return jsonResponse(400, { error: check.error });

    // Best-effort client IP for rate limiting.
    const ip =
      req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      req.headers.get("cf-connecting-ip") ||
      "unknown";

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });

    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    // Global daily cap — protects the Minimax quota above all else.
    const { count: globalCount } = await admin
      .from("demo_requests")
      .select("id", { count: "exact", head: true })
      .gte("created_at", since);
    if ((globalCount ?? 0) >= GLOBAL_DAILY) {
      return jsonResponse(429, {
        error:
          "The live demo is at capacity for today. Sign up free to skip the " +
          "line — your first article runs immediately.",
      });
    }

    // Per-IP daily cap.
    if (ip !== "unknown") {
      const { count: ipCount } = await admin
        .from("demo_requests")
        .select("id", { count: "exact", head: true })
        .eq("ip", ip)
        .gte("created_at", since);
      if ((ipCount ?? 0) >= PER_IP_DAILY) {
        return jsonResponse(429, {
          error:
            "You've used today's free demo runs. Sign up free to generate " +
            "as many as your plan allows.",
        });
      }
    }

    const { data: inserted, error: insertErr } = await admin
      .from("demo_requests")
      .insert({ url: check.url, ip, status: "queued" })
      .select("id")
      .single();
    if (insertErr) {
      console.error("request-demo insert error:", insertErr.message);
      return jsonResponse(500, { error: "Could not start the demo. Try again." });
    }

    return jsonResponse(200, { ok: true, demo_id: inserted.id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("request-demo error:", msg);
    return jsonResponse(500, { error: "Could not start the demo. Try again." });
  }
});
