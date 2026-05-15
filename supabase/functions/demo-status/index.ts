// demo-status
//
// Public, UNAUTHENTICATED endpoint (verify_jwt=false). The marketing
// page polls this with a demo_id to drive the live "watching it work"
// panel. Returns status + progress line + (on completion) the result.
//
// demo_requests has RLS on with no anon policy, so this function — with
// the service_role key — is the only read path. We return strictly the
// display fields; never the ip or internal columns.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

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

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

  try {
    const body = (await req.json().catch(() => null)) as { demo_id?: string } | null;
    const demoId = body?.demo_id;
    if (!demoId || !UUID_RE.test(demoId)) {
      return jsonResponse(400, { error: "demo_id required" });
    }

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });

    const { data, error } = await admin
      .from("demo_requests")
      .select("status, progress, keyword, result, error")
      .eq("id", demoId)
      .maybeSingle();

    if (error) {
      console.error("demo-status query error:", error.message);
      return jsonResponse(500, { error: "Lookup failed." });
    }
    if (!data) return jsonResponse(404, { error: "Demo not found." });

    // Only surface display-safe fields. result is already an excerpt
    // shaped by the worker — no full body, no internal columns.
    return jsonResponse(200, {
      ok: true,
      status: data.status,
      progress: data.progress ?? null,
      keyword: data.keyword ?? null,
      result: data.status === "completed" ? data.result : null,
      error: data.status === "failed" ? data.error : null,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("demo-status error:", msg);
    return jsonResponse(500, { error: "Lookup failed." });
  }
});
