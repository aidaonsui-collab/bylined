// Weekly AI-visibility check — multi-engine.
//
// Asks each AI engine the user's 5 cached buyer questions, counts
// how many answers cite the user's domain, writes one snapshot row.
// Engines run in parallel per question for speed.
//
// v2: Perplexity (citations[] array) + ChatGPT (gpt-4o-search-preview
// with web search, citations via message.annotations). Claude pending.
//
// Missing API key for any engine → that engine's count stays 0 for
// the snapshot, with the error string captured in results.items[].

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const PERPLEXITY_API_KEY = Deno.env.get("PERPLEXITY_API_KEY") ?? "";
const PERPLEXITY_MODEL = Deno.env.get("PERPLEXITY_MODEL") ?? "sonar";
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY") ?? "";
// Mini variant: same web_search capability, ~17× cheaper tokens.
// Web-search activation cost ($25/1000) dominates either way, but
// token cost goes from ~$0.006/query → ~$0.0004/query. Override
// via env if a higher-quality model is needed for a specific user.
const OPENAI_SEARCH_MODEL =
  Deno.env.get("OPENAI_SEARCH_MODEL") ?? "gpt-4o-mini-search-preview";
// SerpAPI key for Google AI Overviews lookup. No native API exists for
// AIO; SerpAPI scrapes Google SERPs and returns the ai_overview block
// in the same response. Free tier = 100 searches/month — enough for
// 5-10 weekly checks per single user. Paid plans start at $50/mo for
// 5,000 searches when more customers come online.
const SERPAPI_KEY = Deno.env.get("SERPAPI_KEY") ?? "";
// gl=us / hl=en defaults match what most B2B SaaS buyer queries default
// to. Override later if we add regional tracking.
const SERPAPI_GL = Deno.env.get("SERPAPI_GL") ?? "us";
const SERPAPI_HL = Deno.env.get("SERPAPI_HL") ?? "en";
// Where bylined_hosted blogs actually publish. Articles live at
// {base}/blog/{slug}, so this is the domain to search for citations
// of. Defaults match publish-article's default.
const BYLINED_HOSTED_PUBLIC_BASE =
  Deno.env.get("BYLINED_HOSTED_PUBLIC_BASE") ?? "https://getbylined.com";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

interface EngineResult {
  cited: boolean;
  citations: string[];
  error?: string;
}
interface QuestionResult {
  question: string;
  perplexity: EngineResult;
  chatgpt: EngineResult;
  google: EngineResult;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }
  if (req.method !== "POST") return jsonResponse(405, { error: "POST only" });

  const authHeader = req.headers.get("authorization") ?? "";
  if (!authHeader.includes(SUPABASE_SERVICE_ROLE_KEY)) {
    return jsonResponse(403, { error: "Service role required" });
  }

  let body: { user_id?: string; week_number?: number } = {};
  try {
    body = await req.json();
  } catch {
    /* empty ok */
  }

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  let userId = body.user_id ?? null;
  let weekNumber = body.week_number ?? null;
  if (!userId) {
    const { data: claimed } = await admin.rpc("claim_next_visibility_check");
    const row = Array.isArray(claimed) ? claimed[0] : claimed;
    if (!row?.out_user_id) {
      return jsonResponse(200, { ok: true, idle: true, reason: "no due users" });
    }
    userId = row.out_user_id;
    weekNumber = row.out_week_number;
  }

  const [{ data: sites }, { data: voices }, { data: sub }] = await Promise.all([
    admin
      .from("sites")
      .select("name, cms_type, cms_config")
      .eq("user_id", userId)
      .eq("is_active", true)
      .order("created_at", { ascending: true })
      .limit(1),
    admin
      .from("voices")
      .select("source_url")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(1),
    admin
      .from("subscriptions")
      .select("tracking_domain")
      .eq("user_id", userId)
      .in("status", ["active", "trialing"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  // Domain-detection priority:
  //   1. Customer-set subscriptions.tracking_domain (authoritative)
  //   2. WordPress/Webflow site's configured URL (auto-detect for
  //      customers who connected their own CMS)
  //   3. bylined_hosted shared base — accurate enough for "any post
  //      on the platform" but doesn't distinguish customers; only
  //      reached when the customer hasn't set tracking_domain yet
  //   4. Most-recent voice URL (least reliable: voice can be an
  //      emulation target, not the user's brand)
  const site = sites?.[0];
  let userDomain: string | null = extractDomain(sub?.tracking_domain);
  if (!userDomain) {
    userDomain = extractDomain(site?.cms_config?.url);
  }
  if (!userDomain && site?.cms_type === "bylined_hosted") {
    userDomain = extractDomain(BYLINED_HOSTED_PUBLIC_BASE);
  }
  if (!userDomain) {
    userDomain =
      extractDomain(site?.name) || extractDomain(voices?.[0]?.source_url);
  }

  if (!userDomain) {
    return jsonResponse(400, {
      error:
        "Could not determine user's domain — connect a site or extract a voice first.",
    });
  }

  let questionRow = await admin
    .from("visibility_questions")
    .select("questions, expires_at")
    .eq("user_id", userId)
    .maybeSingle();
  if (!questionRow.data || new Date(questionRow.data.expires_at) <= new Date()) {
    const derived = await fetch(
      `${SUPABASE_URL}/functions/v1/derive-visibility-questions`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ user_id: userId, force: true }),
      },
    );
    if (!derived.ok) {
      return jsonResponse(500, {
        error: `Question derivation failed: ${await derived.text()}`,
      });
    }
    questionRow = await admin
      .from("visibility_questions")
      .select("questions, expires_at")
      .eq("user_id", userId)
      .maybeSingle();
  }

  const questions = (questionRow.data?.questions ?? []) as string[];
  if (questions.length === 0) {
    return jsonResponse(500, { error: "No questions available after derive" });
  }

  // Parallel-per-question, sequential across questions (rate-limit
  // friendly). 5 questions × ~6s each = ~30s total (DataForSEO is
  // the slowest engine, ~5s per SERP scrape).
  const results: QuestionResult[] = [];
  let perplexityCitations = 0;
  let chatgptCitations = 0;
  let googleCitations = 0;
  for (const q of questions) {
    const [pplx, cgpt, ggl] = await Promise.all([
      askPerplexity(q, userDomain),
      askChatGPT(q, userDomain),
      askGoogleAIO(q, userDomain),
    ]);
    results.push({ question: q, perplexity: pplx, chatgpt: cgpt, google: ggl });
    if (pplx.cited) perplexityCitations += 1;
    if (cgpt.cited) chatgptCitations += 1;
    if (ggl.cited) googleCitations += 1;
  }

  if (weekNumber == null) {
    const { data: prev } = await admin
      .from("visibility_snapshots")
      .select("week_number")
      .eq("user_id", userId)
      .order("week_number", { ascending: false })
      .limit(1);
    weekNumber = (prev?.[0]?.week_number ?? 0) + 1;
  }

  const { error: writeErr } = await admin.from("visibility_snapshots").insert({
    user_id: userId,
    week_number: weekNumber,
    perplexity_citations: perplexityCitations,
    chatgpt_citations: chatgptCitations,
    claude_citations: 0,
    google_citations: googleCitations,
    questions_asked: questions.length,
    results: { domain: userDomain, items: results },
  });
  if (writeErr) return jsonResponse(500, { error: writeErr.message });

  return jsonResponse(200, {
    ok: true,
    user_id: userId,
    week_number: weekNumber,
    domain: userDomain,
    perplexity_citations: perplexityCitations,
    chatgpt_citations: chatgptCitations,
    google_citations: googleCitations,
    questions_asked: questions.length,
    notes: [
      !PERPLEXITY_API_KEY && "PERPLEXITY_API_KEY not set",
      !OPENAI_API_KEY && "OPENAI_API_KEY not set",
      !SERPAPI_KEY && "SERPAPI_KEY not set",
    ].filter(Boolean),
  });
});

async function askPerplexity(
  question: string,
  userDomain: string,
): Promise<EngineResult> {
  if (!PERPLEXITY_API_KEY) {
    return {
      cited: false,
      citations: [],
      error: "PERPLEXITY_API_KEY not set on this function",
    };
  }
  try {
    const res = await fetch("https://api.perplexity.ai/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${PERPLEXITY_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: PERPLEXITY_MODEL,
        messages: [
          {
            role: "system",
            content:
              "Answer the user's question concisely. Cite reputable sources.",
          },
          { role: "user", content: question },
        ],
        max_tokens: 512,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      return {
        cited: false,
        citations: [],
        error: `Perplexity ${res.status}: ${(await res.text()).slice(0, 200)}`,
      };
    }
    const data = await res.json() as {
      citations?: string[];
      choices?: Array<{ message?: { content?: string } }>;
    };
    const citations = Array.isArray(data.citations) ? data.citations : [];
    const target = userDomain.toLowerCase();
    const cited =
      citations.some((url) => extractDomain(url)?.includes(target)) ||
      (data.choices?.[0]?.message?.content ?? "")
        .toLowerCase()
        .includes(target);
    return { cited, citations };
  } catch (e) {
    return {
      cited: false,
      citations: [],
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

// ChatGPT via the web-search-enabled model. Citations arrive as
// message.annotations[] of type 'url_citation'; we extract them all
// and match the user's domain like the Perplexity flow.
async function askChatGPT(
  question: string,
  userDomain: string,
): Promise<EngineResult> {
  if (!OPENAI_API_KEY) {
    return {
      cited: false,
      citations: [],
      error: "OPENAI_API_KEY not set on this function",
    };
  }
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: OPENAI_SEARCH_MODEL,
        messages: [{ role: "user", content: question }],
        web_search_options: {},
      }),
      signal: AbortSignal.timeout(45_000),
    });
    if (!res.ok) {
      return {
        cited: false,
        citations: [],
        error: `OpenAI ${res.status}: ${(await res.text()).slice(0, 200)}`,
      };
    }
    const data = await res.json() as {
      choices?: Array<{
        message?: {
          content?: string;
          annotations?: Array<{
            type?: string;
            url_citation?: { url?: string; title?: string };
          }>;
        };
      }>;
    };
    const msg = data.choices?.[0]?.message;
    const annotations = Array.isArray(msg?.annotations) ? msg!.annotations : [];
    const citations = annotations
      .filter((a) => a?.type === "url_citation" && a.url_citation?.url)
      .map((a) => a.url_citation!.url!) as string[];
    const target = userDomain.toLowerCase();
    const cited =
      citations.some((url) => extractDomain(url)?.includes(target)) ||
      (msg?.content ?? "").toLowerCase().includes(target);
    return { cited, citations };
  } catch (e) {
    return {
      cited: false,
      citations: [],
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

// Google AI Overviews via SerpAPI. There's no native API for AIO;
// SerpAPI scrapes Google SERPs and returns the ai_overview block in
// the same response. AI Overviews don't appear on every query — when
// there's no ai_overview field we return cited=false with no error
// (that's just Google not showing one for this query).
//
// Sometimes SerpAPI returns ai_overview as just a page_token pointer
// (a "click to fetch full content" handle). When that happens we
// record cited=false with a note so we don't burn a 2nd billable
// call. Customers on paid plans can swap the function to chain that
// second call if they want fuller coverage.
async function askGoogleAIO(
  question: string,
  userDomain: string,
): Promise<EngineResult> {
  if (!SERPAPI_KEY) {
    return {
      cited: false,
      citations: [],
      error: "SERPAPI_KEY not set on this function",
    };
  }
  try {
    const url = new URL("https://serpapi.com/search.json");
    url.searchParams.set("engine", "google");
    url.searchParams.set("q", question);
    url.searchParams.set("gl", SERPAPI_GL);
    url.searchParams.set("hl", SERPAPI_HL);
    url.searchParams.set("num", "10");
    url.searchParams.set("api_key", SERPAPI_KEY);

    const res = await fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(45_000),
    });
    if (!res.ok) {
      return {
        cited: false,
        citations: [],
        error: `SerpAPI ${res.status}: ${(await res.text()).slice(0, 200)}`,
      };
    }
    const data = await res.json() as {
      ai_overview?: {
        text_blocks?: Array<unknown>;
        references?: Array<{ link?: string; source?: string; title?: string }>;
        page_token?: string;
      };
      error?: string;
    };
    if (data.error) {
      return {
        cited: false,
        citations: [],
        error: `SerpAPI: ${data.error}`,
      };
    }
    const aio = data.ai_overview;
    if (!aio) {
      // No AI Overview shown for this query — not a failure, just a
      // signal that Google didn't surface one. Record honestly.
      return { cited: false, citations: [] };
    }
    const refs = aio.references ?? [];
    if (refs.length === 0 && aio.page_token) {
      // SerpAPI returned a stub — full AIO content would need a
      // second billable fetch. Skip to preserve free-tier quota.
      return {
        cited: false,
        citations: [],
        error: "SerpAPI returned ai_overview stub (page_token only). Upgrade plan to follow.",
      };
    }
    const citations = refs
      .map((r) => r?.link)
      .filter((u): u is string => typeof u === "string" && u.length > 0);
    const target = userDomain.toLowerCase();
    const cited = citations.some((u) => extractDomain(u)?.includes(target));
    return { cited, citations };
  } catch (e) {
    return {
      cited: false,
      citations: [],
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

function extractDomain(value: string | undefined | null): string | null {
  if (!value) return null;
  try {
    const u = new URL(value.startsWith("http") ? value : `https://${value}`);
    return u.hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}
