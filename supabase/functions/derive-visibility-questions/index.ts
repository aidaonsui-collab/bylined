// Visibility-question deriver.
//
// Picks 5 buyer-intent questions per user where they'd want their
// domain to be cited by AI engines. Used as inputs to the weekly
// visibility check (Perplexity / ChatGPT / Claude).
//
// Cached for 30 days in public.visibility_questions. Re-derives when
// expired so the question list evolves as the user's topics evolve.
//
// Called by:
//   - the visibility cron (lazy: if no row exists or it's expired)
//   - on-demand from /app/visibility (future "Refresh questions" button)
//
// Auth modes:
//   - Service-role bearer + user_id in body → cron usage
//   - User JWT (no body user_id) → on-demand usage; user_id from JWT

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const MINIMAX_API_KEY = Deno.env.get("MINIMAX_API_KEY")!;
const MINIMAX_BASE_URL =
  Deno.env.get("MINIMAX_BASE_URL") ?? "https://api.minimaxi.chat/v1";
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

const QUESTION_COUNT = 5;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return jsonResponse(405, { error: "POST only" });
  }

  const authHeader = req.headers.get("authorization") ?? "";
  if (!authHeader) return jsonResponse(401, { error: "Missing authorization" });

  let body: { user_id?: string; force?: boolean } = {};
  try {
    body = await req.json();
  } catch {
    /* empty ok */
  }

  // Two callers: cron (service role + body.user_id) or end-user (JWT).
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  let userId: string | null = body.user_id ?? null;
  if (!userId) {
    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return jsonResponse(401, { error: "Invalid session" });
    userId = user.id;
  }

  // Short-circuit on a fresh cached row unless force=true.
  if (!body.force) {
    const { data: existing } = await admin
      .from("visibility_questions")
      .select("questions, expires_at")
      .eq("user_id", userId)
      .maybeSingle();
    if (existing && new Date(existing.expires_at) > new Date()) {
      return jsonResponse(200, {
        ok: true,
        cached: true,
        questions: existing.questions,
      });
    }
  }

  // Pull anchor context for the prompt.
  const [{ data: voices }, { data: articles }] = await Promise.all([
    admin
      .from("voices")
      .select("id, source_url, fingerprint")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(1),
    admin
      .from("articles")
      .select("id, keyword, title")
      .eq("user_id", userId)
      .order("generated_at", { ascending: false })
      .limit(30),
  ]);

  const voice = voices?.[0];
  const recentTopics = (articles ?? [])
    .map((a: { title?: string; keyword?: string }) => a.title || a.keyword)
    .filter(Boolean)
    .slice(0, 20) as string[];

  const sourceUrl = voice?.source_url ?? null;
  const fp = voice?.fingerprint as { tone?: string; technical_level?: string } | undefined;
  const prompt = buildPrompt({
    sourceUrl,
    tone: fp?.tone,
    technicalLevel: fp?.technical_level,
    recentTopics,
  });

  try {
    const questions = await callMinimax(prompt);
    if (!Array.isArray(questions) || questions.length === 0) {
      return jsonResponse(500, { error: "Model returned no questions" });
    }

    // Upsert into the cache. ON CONFLICT updates the questions + bumps
    // expires_at, so a force=true re-derive resets the 30-day clock.
    const { error: writeErr } = await admin
      .from("visibility_questions")
      .upsert(
        {
          user_id: userId,
          questions: questions.slice(0, QUESTION_COUNT),
          derived_from: {
            voice_id: voice?.id ?? null,
            voice_source_url: sourceUrl,
            recent_topic_count: recentTopics.length,
            model: MINIMAX_MODEL,
            generated_at: new Date().toISOString(),
          },
          created_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
        },
        { onConflict: "user_id" },
      );
    if (writeErr) {
      console.error("derive-visibility-questions write error:", writeErr.message);
      return jsonResponse(500, { error: writeErr.message });
    }

    return jsonResponse(200, {
      ok: true,
      cached: false,
      questions: questions.slice(0, QUESTION_COUNT),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("derive-visibility-questions error:", msg);
    return jsonResponse(500, { error: msg });
  }
});

function buildPrompt({
  sourceUrl,
  tone,
  technicalLevel,
  recentTopics,
}: {
  sourceUrl: string | null;
  tone?: string;
  technicalLevel?: string;
  recentTopics: string[];
}): string {
  const topicsBlock = recentTopics.length
    ? `RECENT ARTICLE TOPICS:\n${recentTopics.map((t) => `- ${t}`).join("\n")}`
    : "(no prior articles — green field)";

  return `You're shaping a recurring "AM I CITED?" test for a brand. The test runs against AI engines (Perplexity, ChatGPT, Claude) — for each engine we ask the question and check whether the brand's domain shows up in the answer.

BRAND
- Domain: ${sourceUrl ?? "unknown"}
- Tone: ${tone ?? "professional"}
- Reader level: ${technicalLevel ?? "intermediate"}

${topicsBlock}

TASK
Write exactly 5 buyer-intent questions a person in this brand's audience would naturally type into an AI engine. Questions that, if the AI answered well, the brand would benefit from being cited.

CONSTRAINTS
- Each question is 5–15 words
- Phrase as a question a buyer would actually ask ("how do I…", "what's the difference between…", "best way to…")
- Stay in the brand's vertical — don't pivot
- Avoid brand-name questions (don't ask "is X any good?") — those are vanity tests
- Lean toward questions where multiple credible sources exist (so being cited means something)
- Spread across buyer stages: 2 awareness ("what is X"), 2 consideration ("how to choose X"), 1 decision ("X vs Y for [use case]")

Return JSON ONLY:
{
  "questions": [
    "question 1",
    "question 2",
    "question 3",
    "question 4",
    "question 5"
  ]
}`;
}

interface MinimaxResponse {
  choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
  base_resp?: { status_code: number; status_msg: string };
}

async function callMinimax(prompt: string): Promise<string[]> {
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
          temperature: attempt === 0 ? 0.6 : 0.8,
          max_tokens: 4000,
        }),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (e) {
      if (e instanceof Error && e.name === "TimeoutError") {
        throw new Error("MiniMax timed out deriving visibility questions");
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
      const parsed = JSON.parse(cleaned) as { questions?: string[] };
      if (Array.isArray(parsed.questions)) {
        return parsed.questions
          .filter((q) => typeof q === "string" && q.trim())
          .map((q) => q.trim());
      }
      lastError = new Error("JSON missing 'questions' array");
    } catch (e) {
      lastError = e;
    }
  }
  throw new Error(
    `Failed to parse MiniMax questions: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}
