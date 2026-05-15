// verify-webflow
//
// Discovery cascade for Webflow site setup. Each step depends on the
// previous one's selection, so we expose all three in one function with
// optional params:
//
//   { api_token }                                  → list sites
//   { api_token, site_id }                         → also list collections
//   { api_token, site_id, collection_id }          → also fetch schema +
//                                                    auto-detected mapping
//
// Auto-detection follows the same heuristic as engine/src/clients/webflow.ts —
// kept inlined here since edge functions can't import from elsewhere in
// the repo without bundling. If the heuristic ever needs to evolve, sync
// both copies.
//
// On token failure (401/403) we return ok=false with a friendly message;
// on network failure we return ok=false too. 200 either way so the
// frontend can show the error inline like verify-wordpress-site does.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const WEBFLOW_BASE = "https://api.webflow.com/v2";

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

interface WfSite {
  id: string;
  displayName: string;
  shortName: string;
}
interface WfCollection {
  id: string;
  displayName: string;
  slug: string;
  singularName?: string;
}
interface WfField {
  id: string;
  displayName: string;
  slug: string;
  type: string;
  isRequired?: boolean;
}
interface WfSchema extends WfCollection {
  fields: WfField[];
}

interface FieldMapping {
  title: string | null;
  slug: string | null;
  body: string | null;
  excerpt: string | null;
}

// Heuristic: pick the most likely field for each role from a collection's
// schema. Returns nulls for unmatched roles — caller decides whether to
// require manual override.
function autoDetectMapping(schema: WfSchema): FieldMapping {
  const out: FieldMapping = { title: null, slug: null, body: null, excerpt: null };
  for (const f of schema.fields) {
    const slug = f.slug.toLowerCase();
    const display = (f.displayName ?? "").toLowerCase();

    if (!out.title && (slug === "name" || display === "name" || display === "title")) {
      out.title = f.slug;
    }
    if (!out.slug && (slug === "slug" || display === "slug")) {
      out.slug = f.slug;
    }
    if (!out.body && f.type === "RichText" && /(body|content|post|article)/.test(slug)) {
      out.body = f.slug;
    }
    if (!out.excerpt && /(excerpt|summary|description|meta)/.test(slug)) {
      out.excerpt = f.slug;
    }
  }
  return out;
}

async function wfCall<T>(token: string, path: string): Promise<{ ok: true; data: T } | { ok: false; status: number; error: string }> {
  let res: Response;
  try {
    res = await fetch(`${WEBFLOW_BASE}${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "User-Agent": "BylinedBot/0.1 (+https://getbylined.com/bot)",
      },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, status: 0, error: `Could not reach Webflow: ${msg}` };
  }

  if (!res.ok) {
    let detail = await res.text();
    try {
      const parsed = JSON.parse(detail);
      if (parsed?.message) detail = parsed.message;
    } catch {
      /* keep raw */
    }
    return { ok: false, status: res.status, error: detail };
  }
  return { ok: true, data: (await res.json()) as T };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

  try {
    const authHeader = req.headers.get("authorization") ?? "";
    if (!authHeader) return jsonResponse(401, { error: "Missing authorization" });

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
      | { api_token?: string; site_id?: string; collection_id?: string }
      | null;
    const token = body?.api_token?.trim();
    if (!token) {
      return jsonResponse(400, { error: "api_token required" });
    }

    // Step 1: always list sites — this also acts as the token check.
    const sitesRes = await wfCall<{ sites: WfSite[] }>(token, "/sites");
    if (!sitesRes.ok) {
      if (sitesRes.status === 401 || sitesRes.status === 403) {
        return jsonResponse(200, {
          ok: false,
          error:
            "Webflow rejected the API token. Generate a fresh one in " +
            "Site Settings → Apps & integrations → API access (CMS " +
            "read+write, Sites read+publish).",
        });
      }
      return jsonResponse(200, {
        ok: false,
        error: `Webflow API error: ${sitesRes.error}`,
      });
    }
    const sites = sitesRes.data.sites ?? [];

    const result: {
      ok: true;
      sites: WfSite[];
      collections?: WfCollection[];
      schema?: WfSchema;
      mapping?: FieldMapping;
      mapping_complete?: boolean;
    } = { ok: true, sites };

    // Step 2: collections (requires site_id)
    if (body?.site_id) {
      // Validate the site_id belongs to this token (prevents pivoting
      // off someone else's site_id if they sniffed it from the wire).
      if (!sites.some((s) => s.id === body.site_id)) {
        return jsonResponse(200, {
          ok: false,
          error: "Selected site is not visible to this API token.",
        });
      }
      const colsRes = await wfCall<{ collections: WfCollection[] }>(
        token,
        `/sites/${body.site_id}/collections`
      );
      if (!colsRes.ok) {
        return jsonResponse(200, {
          ok: false,
          error: `Could not list collections: ${colsRes.error}`,
        });
      }
      result.collections = colsRes.data.collections ?? [];
    }

    // Step 3: schema + auto-mapping (requires collection_id)
    if (body?.site_id && body?.collection_id) {
      const schemaRes = await wfCall<WfSchema>(
        token,
        `/collections/${body.collection_id}`
      );
      if (!schemaRes.ok) {
        return jsonResponse(200, {
          ok: false,
          error: `Could not load collection schema: ${schemaRes.error}`,
        });
      }
      const mapping = autoDetectMapping(schemaRes.data);
      result.schema = schemaRes.data;
      result.mapping = mapping;
      result.mapping_complete = Boolean(mapping.title && mapping.slug && mapping.body);
    }

    return jsonResponse(200, result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("verify-webflow error:", msg);
    return jsonResponse(500, { error: msg });
  }
});
