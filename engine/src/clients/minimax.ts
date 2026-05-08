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

interface MinimaxResponse {
  choices: MinimaxChoice[];
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

export async function chat(messages: Message[], opts: ChatOptions = {}): Promise<string> {
  const { apiKey, baseUrl, model: defaultModel } = getConfig();
  const model = opts.model ?? defaultModel;
  const baseTemp = opts.temperature ?? 0.4;
  const startedAt = Date.now();

  // Up to 2 attempts: empty responses can occur transiently. Slightly raise
  // temperature on retry so the model doesn't reproduce the exact empty path.
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
    if (content) {
      logCost({
        event_type: opts.costType ?? "llm_other",
        provider: "minimax",
        model,
        duration_ms: Date.now() - startedAt,
        metadata: { attempt },
      });
      return content;
    }

    lastDetail = `finish_reason=${choice?.finish_reason ?? "unknown"}`;
    if (attempt === 0) {
      console.warn(`[minimax] empty response (${lastDetail}), retrying with higher temp...`);
    }
  }

  throw new Error(`Minimax returned empty response after retry (${lastDetail})`);
}

// Same as chat() but instructs the model to return JSON, strips code fences,
// and retries once on parse failure.
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
        "\n\nRespond with valid JSON only. No prose, no markdown, no code fences.",
    },
  ];

  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await chat(augmented, opts);
    const cleaned = raw
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "");
    try {
      return JSON.parse(cleaned) as T;
    } catch (e) {
      lastError = e;
    }
  }
  throw new Error(
    `Minimax did not return valid JSON after 2 attempts: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`
  );
}
