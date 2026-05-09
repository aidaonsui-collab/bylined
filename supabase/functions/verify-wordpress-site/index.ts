// verify-wordpress-site
//
// Tests a WordPress URL + username + Application Password by hitting
// /wp-json/wp/v2/users/me. Returns { ok, user_name, roles? } on success
// or { ok: false, error } with a friendly message.
//
// We never store the credentials here — that's the frontend's job after
// a successful verify. This function exists so the credentials never
// touch the browser's network log on the WP server (only on Supabase),
// AND so we can fix up sloppy URLs (missing scheme, trailing slash) in
// one place.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

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

// Normalize the URL the user pasted: prepend https:// if missing, strip
// trailing slash, reject empty/javascript: schemes.
function normalizeUrl(raw: string): string {
  let u = (raw ?? "").trim();
  if (!u) throw new Error("Site URL is required.");
  if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
  // Drop trailing slashes; we'll add the API path ourselves.
  u = u.replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(u);
  } catch {
    throw new Error("Site URL is not a valid URL.");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("Site URL must use http or https.");
  }
  return parsed.origin + parsed.pathname.replace(/\/+$/, "");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

  try {
    const authHeader = req.headers.get("authorization") ?? "";
    if (!authHeader) return jsonResponse(401, { error: "Missing authorization" });

    // Authenticate the caller — only logged-in users can probe arbitrary
    // URLs from our server.
    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false },
    });
    const {
      data: { user },
      error: userErr,
    } = await userClient.auth.getUser();
    if (userErr || !user) return jsonResponse(401, { error: "Unauthorized" });

    const body = (await req.json().catch(() => null)) as
      | { url?: string; username?: string; app_password?: string }
      | null;

    if (!body?.url || !body?.username || !body?.app_password) {
      return jsonResponse(400, {
        error: "url, username, and app_password are required.",
      });
    }

    const baseUrl = normalizeUrl(body.url);

    // WordPress Application Password format is "abcd efgh ijkl mnop ..." —
    // spaces are part of the password and must be preserved. Trim the
    // outer ends only.
    const username = body.username.trim();
    const appPassword = body.app_password.replace(/^\s+|\s+$/g, "");

    const creds = btoa(`${username}:${appPassword}`);
    const probeUrl = `${baseUrl}/wp-json/wp/v2/users/me?context=edit`;

    let res: Response;
    try {
      res = await fetch(probeUrl, {
        method: "GET",
        headers: {
          Authorization: `Basic ${creds}`,
          Accept: "application/json",
          "User-Agent": "BylinedBot/0.1 (+https://bylined.so/bot)",
        },
        // 10s upper bound on dead/slow hosts.
        signal: AbortSignal.timeout(10_000),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Distinguish DNS / TLS / 404 / timeout for the user.
      if (msg.includes("aborted") || msg.includes("timeout")) {
        return jsonResponse(200, {
          ok: false,
          error: "Site didn't respond within 10s. Check the URL.",
        });
      }
      return jsonResponse(200, {
        ok: false,
        error: `Could not reach the site: ${msg}`,
      });
    }

    if (res.status === 401 || res.status === 403) {
      return jsonResponse(200, {
        ok: false,
        error:
          "Authentication failed. Check the username and Application Password " +
          "(spaces are part of the password — paste it exactly as WP showed it).",
      });
    }
    if (res.status === 404) {
      return jsonResponse(200, {
        ok: false,
        error:
          "WordPress REST API not found at this URL. Make sure the URL points " +
          "at the WP root (not /wp-admin/) and that REST is enabled.",
      });
    }
    if (!res.ok) {
      return jsonResponse(200, {
        ok: false,
        error: `WordPress responded ${res.status}.`,
      });
    }

    const json = (await res.json().catch(() => null)) as
      | { id?: number; name?: string; slug?: string; roles?: string[] }
      | null;
    if (!json?.id) {
      return jsonResponse(200, {
        ok: false,
        error: "WordPress responded but the user payload was unexpected.",
      });
    }

    return jsonResponse(200, {
      ok: true,
      base_url: baseUrl, // normalized — frontend should save this, not the raw input
      user_name: json.name ?? json.slug ?? username,
      roles: json.roles ?? [],
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("verify-wordpress-site error:", msg);
    return jsonResponse(500, { error: msg });
  }
});
