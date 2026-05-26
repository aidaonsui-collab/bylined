// OpenAI chat client — mirrors minimax.ts's chatJSON signature so
// generator.ts can swap providers without touching its call site.
//
// Used for the GPT-vs-MiniMax head-to-head test driven by
// compare-cli.ts. Production generation still defaults to MiniMax;
// this client is opt-in.
//
// Reasoning-family models (o1 / o3 / gpt-5) take a different request
// shape than gpt-4o: they want max_completion_tokens (not max_tokens)
// and they reject a custom temperature. We detect via model name and
// adapt.

import { logCost, type CostEventType } from "../cost.js";

export type Message = {
  role: "system" | "user" | "assistant";
  content: string;
};

export interface ChatOptions {
  model?: string;
  temperature?: number;
  max_tokens?: number;
  costType?: CostEventType;
}

interface OpenAIChoice {
  message: { role: string; content: string };
  finish_reason?: string;
}
interface OpenAIUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}
interface OpenAIResponse {
  choices?: OpenAIChoice[];
  usage?: OpenAIUsage;
  error?: { message: string; type?: string; code?: string };
}

const ENDPOINT = "https://api.openai.com/v1/chat/completions";
const MIN_JSON_BUDGET = 4000;
const MAX_JSON_BUDGET = 24000;

function getConfig() {
  const apiKey = process.env.OPENAI_API_KEY;
  // Default to gpt-5 — override via OPENAI_GENERATION_MODEL if the
  // account doesn't have access (e.g. OPENAI_GENERATION_MODEL=gpt-4o).
  const model = process.env.OPENAI_GENERATION_MODEL ?? "gpt-5";
  if (!apiKey) throw new Error("OPENAI_API_KEY not set in env");
  return { apiKey, model };
}

function isReasoningModel(model: string): boolean {
  // o1, o3, o4, … and the gpt-5 family share the reasoning-API shape.
  return /^(o\d|gpt-5)/i.test(model);
}

export async function chat(messages: Message[], opts: ChatOptions = {}): Promise<string> {
  const { apiKey, model: defaultModel } = getConfig();
  const model = opts.model ?? defaultModel;
  const reasoning = isReasoningModel(model);
  // Reasoning models burn hidden chain-of-thought tokens BEFORE the
  // JSON envelope, so the requested budget has to cover both. Give
  // reasoning models a higher floor.
  const minBudget = reasoning ? 16000 : 256;
  const budget = Math.max(opts.max_tokens ?? MIN_JSON_BUDGET, minBudget);
  const startedAt = Date.now();

  const body: Record<string, unknown> = {
    model,
    messages,
    // Force JSON output. OpenAI requires the prompt to mention "JSON"
    // somewhere — chatJSON below augments the user message so it does.
    response_format: { type: "json_object" },
  };
  if (reasoning) {
    body.max_completion_tokens = budget;
    // Reasoning models reject a custom temperature.
  } else {
    body.max_tokens = budget;
    body.temperature = opts.temperature ?? 0.4;
  }

  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    // Reasoning models (gpt-5, o-series) routinely take 3-5+ minutes
    // on long structured JSON. Allow up to 5 min before aborting.
    signal: AbortSignal.timeout(reasoning ? 300_000 : 120_000),
  });

  if (!res.ok) {
    const detail = (await res.text()).slice(0, 500);
    throw new Error(`OpenAI ${res.status}: ${detail}`);
  }
  const data = (await res.json()) as OpenAIResponse;
  if (data.error) {
    throw new Error(`OpenAI error: ${data.error.message}`);
  }
  const choice = data.choices?.[0];
  const content = choice?.message?.content;
  if (!content) {
    throw new Error(
      `OpenAI returned empty response (finish_reason=${choice?.finish_reason ?? "unknown"})`
    );
  }

  logCost({
    event_type: opts.costType ?? "llm_other",
    provider: "openai",
    model,
    input_tokens: data.usage?.prompt_tokens,
    output_tokens: data.usage?.completion_tokens,
    duration_ms: Date.now() - startedAt,
  });

  return content;
}

// JSON-mode wrapper. Same retry-with-bigger-budget strategy as
// minimax.ts so the two providers behave the same when the response
// is truncated.
export async function chatJSON<T>(
  messages: Message[],
  opts: ChatOptions = {}
): Promise<T> {
  // response_format=json_object requires the prompt to mention "JSON".
  // Append the same instruction MiniMax uses so prompts stay identical
  // across providers and the comparison is apples-to-apples.
  const lastIdx = messages.length - 1;
  const lastMsg = messages[lastIdx];
  const augmented: Message[] = [
    ...messages.slice(0, lastIdx),
    {
      role: lastMsg.role,
      content:
        lastMsg.content +
        "\n\nRespond with valid JSON only. No prose, no markdown, no code fences. " +
        "Keep the response concise enough to fit inside max_tokens — if you sense " +
        "you're running out of room, finish the current field and close the JSON.",
    },
  ];

  let budget = Math.max(opts.max_tokens ?? MIN_JSON_BUDGET, MIN_JSON_BUDGET);
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const raw = await chat(augmented, { ...opts, max_tokens: budget });
      const cleaned = raw
        .trim()
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/, "");
      try {
        return JSON.parse(cleaned) as T;
      } catch (e) {
        lastError = e;
        budget = Math.min(Math.ceil(budget * 1.5), MAX_JSON_BUDGET);
        console.warn(
          `[openai] JSON parse failed (attempt ${attempt}), growing budget to ${budget} and retrying...`
        );
      }
    } catch (e) {
      lastError = e;
      const msg = e instanceof Error ? e.message : String(e);
      // Reasoning models occasionally exhaust their token budget on
      // hidden chain-of-thought before emitting JSON — grow and retry.
      if (msg.includes("empty response") || msg.includes("length")) {
        budget = Math.min(Math.ceil(budget * 1.5), MAX_JSON_BUDGET);
        console.warn(`[openai] ${msg} — growing budget to ${budget} and retrying`);
        continue;
      }
      throw e;
    }
  }
  throw new Error(
    `OpenAI did not return valid JSON after 3 attempts (final budget ${budget}): ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`
  );
}
