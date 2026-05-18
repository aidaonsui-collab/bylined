// Weekly AI-visibility check.
//
// For one user: takes the 5 cached buyer questions, asks each AI
// engine (Perplexity / ChatGPT / Claude — Perplexity only for v1),
// counts how many answers cited the user's domain, writes one row
// to visibility_snapshots. Called by the cron via pg_net or via
// extensions.http (one HTTP call per user per week).
//
// v1 ships Perplexity only — their API has a clean citations[]
// array that exactly answers "was my domain cited?". ChatGPT +
// Claude need web-search-enabled completions and brittle citation
// regex; deferred until usage proves the demand. Snapshot columns
// for those engines stay 0 in the meantime — frontend renders that
// as "not yet wired" rather than "not cited."
//
// Self-bootstrapping: if visibility_questions has no row for this
// user (or it's expired), this function calls
// derive-visibility-questions first.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const PERPLEXITY_API_KEY = Deno.env.get("PERPLEXITY_API_KEY") ?? "";
const PERPLEXITY_MODEL =
  Deno.env.get("PERPLEXITY_MODEL") ?? "sonar"; // online sonar model

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

interface QuestionResult {
  question: string;
  perplexity: { cited: boolean; citations: string[]; error?: string };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return jsonResponse(405, { error: "POST only" });
  }

  // Service-role only — this function does writes across users via cron.
  // Callers must pass the service role key as the bearer token.
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

  // Resolve target: explicit user_id, or claim the next due user.
  let userId = body.user_id ?? null;
  let weekNumber = body.week_number ?? null;
  if (!userId) {
    const { data: claimed } = await admin.rpc("claim_next_visibility_check");
    const row = Array.isArray(claimed) ? claimed[0] : claimed;
    if (!row?.user_id) {
      return jsonResponse(200, { ok: true, idle: true, reason: "no due users" });
    }
    userId = row.user_id;
    weekNumber = row.week_number;
  }

  // Need the user's domain to match citations against. Take it from
  // their first connected site, falling back to the first voice's host.
  const [{ data: sites }, { data: voices }] = await Promise.all([
    admin
      .from("sites")
      .select("name, cms_config")
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
  ]);

  const userDomain =
    extractDomain(sites?.[0]?.cms_config?.url) ||
    extractDomain(sites?.[0]?.name) ||
    extractDomain(voices?.[0]?.source_url);

  if (!userDomain) {
    return jsonResponse(400, {
      error:
        "Could not determine user's domain — connect a site or extract a voice first.",
    });
  }

  // Ensure we have a question list. Lazy-derive on first run / expiry.
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

  // Run the check per question. Sequential so we don't spike the
  // Perplexity rate limit; 5 questions × ~3s = ~15s total.
  const results: QuestionResult[] = [];
  let perplexityCitations = 0;
  for (const q of questions) {
    const r = await askPerplexity(q, userDomain);
    results.push({ question: q, perplexity: r });
    if (r.cited) perplexityCitations += 1;
  }

  // Snapshot week_number lookup if caller didn't supply one (e.g.
  // user_id passed but week_number omitted — manual trigger).
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
    chatgpt_citations: 0,
    claude_citations: 0,
    questions_asked: questions.length,
    results: { domain: userDomain, items: results },
  });
  if (writeErr) {
    return jsonResponse(500, { error: writeErr.message });
  }

  return jsonResponse(200, {
    ok: true,
    user_id: userId,
    week_number: weekNumber,
    domain: userDomain,
    perplexity_citations: perplexityCitations,
    questions_asked: questions.length,
    note: PERPLEXITY_API_KEY
      ? undefined
      : "PERPLEXITY_API_KEY not set — all checks recorded as not-cited.",
  });
});

// Ask Perplexity a question and check if the user's domain appears
// in the citations[] array. The sonar models return a flat list of
// URLs they consulted; matching is a simple hostname compare.
async function askPerplexity(
  question: string,
  userDomain: string,
): Promise<{ cited: boolean; citations: string[]; error?: string }> {
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
      // Some sonar variants embed citations inline as [N] with URLs in
      // the response text. Belt-and-suspenders regex on the body.
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

// Lower-case hostname, strip "www.". Returns null for non-URL strings
// (so we can pass it raw user input and it'll fail safely).
function extractDomain(value: string | undefined | null): string | null {
  if (!value) return null;
  try {
    const u = new URL(value.startsWith("http") ? value : `https://${value}`);
    return u.hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}
