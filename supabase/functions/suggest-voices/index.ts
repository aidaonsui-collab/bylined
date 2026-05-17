// Brand-voice URL suggester.
//
// Mirror of suggest-keywords but for voices: asks MiniMax to recommend
// blog/publication URLs the user could extract a brand-voice fingerprint
// from. Grounded in (a) the user's existing voice's topical area if any,
// (b) the topics of their recent articles, and (c) a dedup list of
// already-extracted voice URLs so we don't re-suggest them.
//
// Each suggestion ships with brand_name + style descriptor + why_fit so
// the user can decide before paying the ~30-60s extraction cost. The
// frontend renders chips with a one-click "Extract this voice" that
// pipes straight into the existing extract-voice-fingerprint function.
//
// One LLM call per invocation. URLs are NOT pre-validated — extraction
// is the validation; if a hallucinated URL 404s, the extract step
// surfaces the failure cleanly.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const MINIMAX_API_KEY = Deno.env.get("MINIMAX_API_KEY")!;
const MINIMAX_BASE_URL =
  Deno.env.get("MINIMAX_BASE_URL") ?? "https://api.minimaxi.chat/v1";
// Matches what the engine + suggest-keywords use in prod.
const MINIMAX_MODEL = Deno.env.get("MINIMAX_MODEL") ?? "MiniMax-M2.7";

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

interface Suggestion {
  url: string;
  brand_name: string;
  style_descriptor: string;
  why_fit: string;
  // 0-100 — model's predicted "if extracted, what voice_match would
  // articles using this voice score?" Frontend maps this through the
  // same voiceStrength() helper to render the same Strong/Solid/Weak
  // badge as on already-extracted voices.
  fit_score?: number;
}

interface VoiceFingerprint {
  tone?: string;
  technical_level?: string;
  voice_traits?: string[];
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return jsonResponse(405, { error: "POST only" });
  }

  const authHeader = req.headers.get("authorization") ?? "";
  if (!authHeader) return jsonResponse(401, { error: "Missing authorization" });

  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const {
    data: { user },
    error: authErr,
  } = await userClient.auth.getUser();
  if (authErr || !user) {
    return jsonResponse(401, { error: "Invalid session" });
  }

  let body: { count?: number; context?: string } = {};
  try {
    body = await req.json();
  } catch {
    /* empty body ok */
  }
  const count = Math.min(Math.max(body.count ?? 12, 5), 20);
  const userContext = (body.context ?? "").trim().slice(0, 200);

  // Load context: existing voices (for dedup + tone reference) + recent
  // article topics (so suggestions feel relevant to what this user
  // actually writes about).
  const { data: voices } = await userClient
    .from("voices")
    .select("source_url, fingerprint")
    .order("created_at", { ascending: false });

  const { data: recent } = await userClient
    .from("articles")
    .select("keyword, title")
    .order("generated_at", { ascending: false })
    .limit(30);

  const existingUrls = (voices ?? [])
    .map((v: { source_url?: string }) => v.source_url)
    .filter(Boolean) as string[];
  const existingHosts = new Set(existingUrls.map(safeHost).filter(Boolean));

  // Take the FIRST voice's fingerprint as the user's "current style"
  // anchor. If they have multiple, the latest one is most likely the
  // direction they're moving toward.
  const anchorFp = (voices?.[0]?.fingerprint ?? {}) as VoiceFingerprint;

  const recentTopics = (recent ?? [])
    .map((r: { title?: string; keyword?: string }) => r.title || r.keyword)
    .filter(Boolean)
    .slice(0, 20) as string[];

  const prompt = buildPrompt({
    userContext,
    anchorTone: anchorFp.tone,
    anchorLevel: anchorFp.technical_level,
    anchorTraits: anchorFp.voice_traits ?? [],
    existingUrls,
    recentTopics,
    count,
  });

  try {
    const suggestions = await callMinimax(prompt, count);
    // Drop any suggestion that points at a host the user already
    // extracted (model sometimes echoes back the anchor URL despite
    // the prompt instruction).
    const filtered = suggestions.filter((s) => {
      const host = safeHost(s.url);
      return host && !existingHosts.has(host);
    });
    return jsonResponse(200, {
      ok: true,
      suggestions: filtered.slice(0, count),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("suggest-voices error:", msg);
    return jsonResponse(500, { error: msg });
  }
});

function buildPrompt({
  userContext,
  anchorTone,
  anchorLevel,
  anchorTraits,
  existingUrls,
  recentTopics,
  count,
}: {
  userContext: string;
  anchorTone?: string;
  anchorLevel?: string;
  anchorTraits: string[];
  existingUrls: string[];
  recentTopics: string[];
  count: number;
}): string {
  const ctxLine = userContext
    ? `User goal: ${userContext}`
    : "User goal: not specified — infer from anchor voice + recent topics.";
  const anchorBlock = anchorTone
    ? `CURRENT REFERENCE VOICE (the style they're already orbiting):
- Tone: ${anchorTone}
- Reader level: ${anchorLevel ?? "intermediate"}
${anchorTraits.length ? `- Traits:\n${anchorTraits.slice(0, 4).map((t) => `  - ${t}`).join("\n")}` : ""}`
    : "(no anchor voice yet — green field, pick high-quality candidates that match the user goal)";
  const excludeBlock = existingUrls.length
    ? `EXCLUDE — already extracted:
${existingUrls.map((u) => `- ${u}`).join("\n")}`
    : "";
  const topicsBlock = recentTopics.length
    ? `RECENT ARTICLE TOPICS (for vertical alignment):
${recentTopics.map((t) => `- ${t}`).join("\n")}`
    : "";

  return `You're recommending brand voices for a content team. They want to extract style fingerprints from existing blogs/publications they admire, so their AI-generated articles inherit that style.

${ctxLine}

${anchorBlock}

${topicsBlock}

${excludeBlock}

TASK
Suggest ${count} brand voices (blogs, publications, company-owned editorial sites) this team could extract a fingerprint from. Each must:
- Be a REAL public blog or publication that exists today, with a stable URL
- Have a consistent, distinctive voice (not a generic corporate blog)
- Match the topical area implied by recent topics + user goal
- Span a range — mix well-known (1-2) with lesser-known/under-the-radar picks (most of them)
- NOT be on the EXCLUDE list

For each suggestion provide:
- "url": the blog index URL, e.g. https://stripe.com/blog or https://every.to
- "brand_name": short human name (e.g. "Stripe Press", "Every", "First Round Review")
- "style_descriptor": 5-10 words capturing the voice (e.g. "long-form analytical with founder anecdotes")
- "why_fit": one sentence on why this fits the user's goal
- "fit_score": integer 0-100. Predict how closely articles generated against this voice would match the user's CURRENT REFERENCE VOICE on tone, structure, and reader level. Score honestly — be willing to give 50s and 60s; not every pick should score 80+. Rough rubric:
  - 85-100: near-twin of the reference voice; same tone, audience, content shapes
  - 70-84: same family, slightly different angle (e.g. similar tone, different vertical)
  - 50-69: useful adjacent voice but the generator would need to bridge real gaps
  - <50: stretch pick, included for diversity — flag honestly so the user can see it's a sidestep

Return JSON ONLY:
{
  "suggestions": [
    { "url": "...", "brand_name": "...", "style_descriptor": "...", "why_fit": "...", "fit_score": 78 }
  ]
}`;
}

interface MinimaxResponse {
  choices?: Array<{
    message?: { content?: string };
    finish_reason?: string;
  }>;
  base_resp?: { status_code: number; status_msg: string };
}

async function callMinimax(
  prompt: string,
  count: number,
): Promise<Suggestion[]> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    let res: Response;
    try {
      res = await fetch(`${MINIMAX_BASE_URL}/text/chatcompletion_v2`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${MINIMAX_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MINIMAX_MODEL,
        messages: [
          {
            role: "system",
            content:
              "You return JSON only. No prose before or after, no code fences.",
          },
          { role: "user", content: prompt },
        ],
        temperature: attempt === 0 ? 0.8 : 0.95,
        // Headroom for M2.7 reasoning + the JSON envelope. ~150 tokens
        // per suggestion (brand + descriptor + why) × count + buffer.
        max_tokens: Math.min(4000 + count * 150, 9000),
      }),
      // 60s timeout — M2.7's reasoning can stretch past 30s on the
      // "suggest 12 real-world brand voices" prompt because it does
      // a lot of "is this real?" deliberation. Edge function ceiling
      // is 150s so this leaves headroom for both attempts.
      signal: AbortSignal.timeout(60_000),
      });
    } catch (e) {
      // AbortSignal.timeout throws a TimeoutError. Don't retry on
      // timeout — the second attempt would just stretch the user's
      // wait without much chance of finishing faster. Bail out with
      // a clear, actionable error.
      const name = e instanceof Error ? e.name : "";
      if (name === "TimeoutError" || String(e).includes("timed out")) {
        throw new Error(
          "MiniMax took too long (>60s). The model gets stuck deliberating on large brand-voice prompts. Try again — it usually goes through on the second attempt.",
        );
      }
      throw e;
    }

    if (!res.ok) {
      throw new Error(`MiniMax HTTP ${res.status}: ${await res.text()}`);
    }
    const data = (await res.json()) as MinimaxResponse;
    if (data.base_resp && data.base_resp.status_code !== 0) {
      throw new Error(
        `MiniMax error ${data.base_resp.status_code}: ${data.base_resp.status_msg}`,
      );
    }
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      lastError = new Error(
        `Empty response (finish_reason=${data.choices?.[0]?.finish_reason})`,
      );
      continue;
    }

    const cleaned = content
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "");
    try {
      const parsed = JSON.parse(cleaned) as { suggestions?: Suggestion[] };
      if (Array.isArray(parsed.suggestions)) {
        return parsed.suggestions
          .filter(
            (s) =>
              typeof s.url === "string" &&
              s.url.trim() &&
              typeof s.brand_name === "string" &&
              s.brand_name.trim(),
          )
          .map((s) => ({
            url: s.url.trim(),
            brand_name: s.brand_name.trim(),
            style_descriptor:
              typeof s.style_descriptor === "string"
                ? s.style_descriptor.trim()
                : "",
            why_fit: typeof s.why_fit === "string" ? s.why_fit.trim() : "",
            fit_score:
              typeof s.fit_score === "number" && Number.isFinite(s.fit_score)
                ? Math.max(0, Math.min(100, Math.round(s.fit_score)))
                : undefined,
          }));
      }
      lastError = new Error("JSON missing 'suggestions' array");
    } catch (e) {
      lastError = e;
    }
  }
  throw new Error(
    `Failed to parse MiniMax suggestions: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

function safeHost(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url.startsWith("http") ? url : `https://${url}`).hostname
      .replace(/^www\./, "")
      .toLowerCase();
  } catch {
    return null;
  }
}
