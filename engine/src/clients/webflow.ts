// Webflow CMS API v2 client.
// Webflow is harder than WordPress because every site has user-defined
// collections (content types) with custom field schemas. We can't ship a
// generic "post" — we need to discover the user's collection structure first.
//
// Setup: get a Site API token from Webflow dashboard →
//   Site Settings → Apps & integrations → API access → Generate API token
// Permissions needed: CMS read+write, Sites read+publish.
//
// Auth: Bearer token in Authorization header.
// Base: https://api.webflow.com/v2

const BASE_URL = "https://api.webflow.com/v2";
const USER_AGENT = "BylinedBot/0.1 (+https://getbylined.com/bot)";

export interface WebflowConfig {
  apiToken: string;
}

export interface WebflowCollection {
  id: string;
  displayName: string;
  slug: string;
  singularName?: string;
}

export interface WebflowField {
  id: string;
  displayName: string;
  slug: string;
  type: string; // "PlainText" | "RichText" | "Slug" | "Image" | "Date" | ...
  isRequired?: boolean;
  helpText?: string;
}

export interface WebflowCollectionSchema extends WebflowCollection {
  fields: WebflowField[];
}

interface ApiError {
  message: string;
  code?: string;
}

async function call<T>(
  cfg: WebflowConfig,
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${cfg.apiToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": USER_AGENT,
      ...(init.headers || {}),
    },
  });
  if (!res.ok) {
    let err: ApiError = { message: await res.text() };
    try {
      err = JSON.parse(err.message);
    } catch {
      /* fall through */
    }
    throw new Error(`Webflow ${res.status}: ${err.message}`);
  }
  return (await res.json()) as T;
}

// ─── Discovery ───────────────────────────────────────────────────────

export async function listSites(
  cfg: WebflowConfig
): Promise<Array<{ id: string; displayName: string; shortName: string }>> {
  const data = await call<{ sites: Array<{ id: string; displayName: string; shortName: string }> }>(
    cfg,
    "/sites"
  );
  return data.sites ?? [];
}

export async function listCollections(
  cfg: WebflowConfig,
  siteId: string
): Promise<WebflowCollection[]> {
  const data = await call<{ collections: WebflowCollection[] }>(
    cfg,
    `/sites/${siteId}/collections`
  );
  return data.collections ?? [];
}

export async function getCollectionSchema(
  cfg: WebflowConfig,
  collectionId: string
): Promise<WebflowCollectionSchema> {
  return call<WebflowCollectionSchema>(cfg, `/collections/${collectionId}`);
}

// ─── Publishing ──────────────────────────────────────────────────────

export interface FieldMapping {
  // Slug of the field (Webflow field.slug, not display name).
  // Each value is the field slug for that role on the user's site.
  title: string; // "name" by default in most Webflow blog templates
  slug: string; // "slug"
  body: string; // "post-body" / "content" — must be a RichText field
  excerpt?: string; // optional short summary field
}

// Best-effort auto-detection of field roles from a collection's schema.
// Falls back to nulls — caller should display these to the user and let
// them confirm or override before publishing.
export function autoDetectMapping(
  schema: WebflowCollectionSchema
): Partial<FieldMapping> {
  const out: Partial<FieldMapping> = {};
  for (const f of schema.fields) {
    const slug = f.slug.toLowerCase();
    const display = f.displayName.toLowerCase();

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

export interface CreateItemInput {
  collectionId: string;
  mapping: FieldMapping;
  values: {
    title: string;
    slug: string;
    body: string; // HTML — Webflow RichText accepts HTML
    excerpt?: string;
  };
  isDraft?: boolean; // true = staged, not yet published
}

export async function createItem(
  cfg: WebflowConfig,
  input: CreateItemInput
): Promise<{ id: string; lastUpdated: string }> {
  const fieldData: Record<string, string> = {
    [input.mapping.title]: input.values.title,
    [input.mapping.slug]: input.values.slug,
    [input.mapping.body]: input.values.body,
  };
  if (input.mapping.excerpt && input.values.excerpt) {
    fieldData[input.mapping.excerpt] = input.values.excerpt;
  }

  return call(cfg, `/collections/${input.collectionId}/items`, {
    method: "POST",
    body: JSON.stringify({
      isArchived: false,
      isDraft: input.isDraft ?? true,
      fieldData,
    }),
  });
}

// Publish staged items live on the site. Webflow distinguishes between
// "create item" (saved in CMS) and "publish site" (actually deployed).
// Most workflows want both unless you're queueing drafts for human review.
export async function publishSite(cfg: WebflowConfig, siteId: string): Promise<void> {
  await call(cfg, `/sites/${siteId}/publish`, {
    method: "POST",
    body: JSON.stringify({
      publishToWebflowSubdomain: true,
      // TODO: also accept an array of customDomains the user owns.
    }),
  });
}

export function configFromEnv(): WebflowConfig {
  const apiToken = process.env.WEBFLOW_API_TOKEN;
  if (!apiToken) {
    throw new Error(
      "WEBFLOW_API_TOKEN not set. Generate one in Webflow: Site Settings → " +
        "Apps & integrations → API access → Generate API token."
    );
  }
  return { apiToken };
}
