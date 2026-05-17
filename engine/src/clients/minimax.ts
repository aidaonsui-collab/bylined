// Minimax 2.7 chat client.
// Their HTTP API resembles OpenAI's chat completions.
// Endpoint: <base>/text/chatcompletion_v2

import { logCost, type CostEventType } from "../cost.js";

export type Message = {
  role: "system" | "user" | "assistant";
  content: string;
};

interface MinimaxChoice {
  message: { role: string; content: string };
  finish_reason?: string;
}

// MiniMax's API mirrors OpenAI's response shape — usage block carries
// per-call token counts. We log them so cost_events stores real numbers
// instead of priceFor()'s fallback. If the field ever disappears or
// the names change, priceFor() falls back to a per-call estimate.
interface MinimaxUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

interface MinimaxResponse {
  choices: MinimaxChoice[];
  usage?: MinimaxUsage;
  base_resp?: { status_code: number; status_msg: string };
}

export interface ChatOptions {
  model?: string;
  temperature?: number;
  max_tokens?: number;
  // Used for cost tracking — defaults to "llm_other".
  costType?: CostEventType;
}

function getConfig() {
  const apiKey = process.env.MINIMAX_API_KEY;
  const baseUrl = process.env.MINIMAX_BASE_URL ?? "https://api.minimaxi.chat/v1";
  const model = process.env.MINIMAX_MODEL ?? "MiniMax-Text-01";
  if (!apiKey) {
    throw new Error("MINIMAX_API_KEY not set in env");
  }
  return { apiKey, baseUrl, model };
}

// Errors thrown by chat() when MiniMax cuts the response off because
// max_tokens was exhausted (vs an empty/unknown failure). chatJSON
// catches this and retries with a bigger budget — a plain temperature
// bump can't recover from a truncated response.
export class MinimaxTruncatedError extends Error {
  constructor(public attempt: number) {
    super(`Minimax truncated response (finish_reason=length, attempt=${attempt})`);
    this.name = "MinimaxTruncatedError";
  }
}

export async function chat(messages: Message[], opts: ChatOptions = {}): Promise<string> {
  const { apiKey, baseUrl, model: defaultModel } = getConfig();
  const model = opts.model ?? defaultModel;
  const baseTemp = opts.temperature ?? 0.4;
  const startedAt = Date.now();

  // Up to 2 attempts: empty responses can occur transiently. Slightly raise
  // temperature on retry so the model doesn't reproduce the exact empty path.
  // NOTE: a finish_reason="length" truncation is NOT retried here — temp
  // doesn't help when the model needed more budget. We throw
  // MinimaxTruncatedError so chatJSON can retry with a larger max_tokens.
  let lastDetail = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(`${baseUrl}/text/chatcompletion_v2`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: attempt === 0 ? baseTemp : Math.min(baseTemp + 0.2, 1.0),
        max_tokens: opts.max_tokens ?? 4000,
      }),
    });

    if (!res.ok) {
      throw new Error(`Minimax ${res.status}: ${await res.text()}`);
    }

    const data = (await res.json()) as MinimaxResponse;
    if (data.base_resp && data.base_resp.status_code !== 0) {
      throw new Error(
        `Minimax error ${data.base_resp.status_code}: ${data.base_resp.status_msg}`
      );
    }

    const choice = data.choices?.[0];
    const content = choice?.message?.content;
    const finishReason = choice?.finish_reason ?? "unknown";

    // Truncation = bad JSON. Surface it as a typed error so chatJSON can
    // grow the budget on retry instead of just bumping temperature.
    if (finishReason === "length") {
      throw new MinimaxTruncatedError(attempt);
    }

    if (content) {
      logCost({
        event_type: opts.costType ?? "llm_other",
        provider: "minimax",
        model,
        input_tokens: data.usage?.prompt_tokens,
        output_tokens: data.usage?.completion_tokens,
        duration_ms: Date.now() - startedAt,
        metadata: { attempt },
      });
      return content;
    }

    lastDetail = `finish_reason=${finishReason}`;
    if (attempt === 0) {
      console.warn(`[minimax] empty response (${lastDetail}), retrying with higher temp...`);
    }
  }

  throw new Error(`Minimax returned empty response after retry (${lastDetail})`);
}

// Same as chat() but instructs the model to return JSON, strips code fences,
// and retries on parse failure or truncation. Each retry grows max_tokens
// 1.5× because the most common cause of malformed JSON in our pipeline is
// MiniMax cutting off mid-string when the reasoning budget eats into the
// response budget (M2.7 is a reasoning model — hidden CoT tokens count).
const MIN_JSON_BUDGET = 4000;
const MAX_JSON_BUDGET = 24000;

export async function chatJSON<T>(
  messages: Message[],
  opts: ChatOptions = {}
): Promise<T> {
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
        // Likely a truncation that finish_reason didn't catch (some
        // model versions return content + finish_reason="stop" even
        // when the response is incomplete). Grow the budget anyway.
        budget = Math.min(Math.ceil(budget * 1.5), MAX_JSON_BUDGET);
        console.warn(
          `[minimax] JSON parse failed (attempt ${attempt}), growing budget to ${budget} and retrying...`
        );
      }
    } catch (e) {
      if (e instanceof MinimaxTruncatedError) {
        lastError = e;
        budget = Math.min(Math.ceil(budget * 1.5), MAX_JSON_BUDGET);
        console.warn(
          `[minimax] response truncated (attempt ${attempt}), growing budget to ${budget} and retrying...`
        );
        continue;
      }
      throw e;
    }
  }
  throw new Error(
    `Minimax did not return valid JSON after 3 attempts (final budget ${budget}): ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`
  );
}
