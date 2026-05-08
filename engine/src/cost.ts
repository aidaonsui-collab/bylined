// Cost tracking for the engine.
//
// Every billable event (LLM call, SERP fetch, page fetch, Wayback save,
// CMS publish) emits a CostEvent. Events are written to a JSONL file in
// the run's out directory (always) and optionally to Supabase
// public.cost_events when SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are
// set in env.
//
// Pricing tables live below — keep them current with provider rate cards
// or your effective per-call cost (e.g. Minimax plan price / monthly
// quota for "subscription" providers).

import { mkdirSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type CostEventType =
  | "llm_extraction"
  | "llm_generation"
  | "llm_voice"
  | "llm_other"
  | "serp_fetch"
  | "page_fetch"
  | "wayback_save"
  | "verification_fetch"
  | "cms_publish";

export interface CostEvent {
  event_type: CostEventType;
  provider?: string;
  model?: string;
  input_tokens?: number;
  output_tokens?: number;
  cost_usd: number;
  duration_ms?: number;
  metadata?: Record<string, unknown>;
  // App context — set when running inside the SaaS, undefined for CLI runs.
  user_id?: string;
  article_id?: string;
  job_id?: string;
  // Local-only.
  run_id: string;
  created_at: string; // ISO
}

// ─── Pricing tables (per-call effective cost in USD) ───────────────
// These represent what one call costs us. Update as plans / vendors
// change. Numbers are rough and biased toward over-estimating so we
// don't underprice.

// Minimax M2.7 Plus plan: $30/mo for 4500 req / 5h ≈ 270k req / mo.
// Effective per-request cost ≈ $30 / 270000 = $0.000111.
// For LLM calls we charge by request, not tokens (plan is request-quota).
const MINIMAX_REQ_COST = 0.000111;

// OpenAI GPT-5-mini approximate (Sept 2026 pricing; adjust if real).
// $0.25 / 1M input tokens, $1.50 / 1M output tokens.
const OPENAI_MINI_INPUT_PER_TOKEN = 0.25 / 1_000_000;
const OPENAI_MINI_OUTPUT_PER_TOKEN = 1.5 / 1_000_000;

// Claude Sonnet 4.6 approximate.
// $3 / 1M input, $15 / 1M output.
const CLAUDE_SONNET_INPUT_PER_TOKEN = 3 / 1_000_000;
const CLAUDE_SONNET_OUTPUT_PER_TOKEN = 15 / 1_000_000;

// SERP providers. DDG is free; Brave is ~$5/1000 once past the free tier.
const BRAVE_PER_QUERY = 5 / 1000;
const SERPER_PER_QUERY = 50 / 50_000; // $50 for 50k queries

// Bandwidth + compute for fetches: effectively free, but we log time so
// it shows up in dashboards. Cost is set to 0 unless you want to bill
// for compute time.
const FETCH_COST = 0;

// ─── Cost calculator ────────────────────────────────────────────────
export interface PricingHints {
  provider?: string;
  model?: string;
  input_tokens?: number;
  output_tokens?: number;
  // For SERP/page fetches, just count the call.
}

export function priceFor(opts: PricingHints): number {
  const provider = opts.provider?.toLowerCase();

  if (provider === "minimax") {
    return MINIMAX_REQ_COST;
  }

  if (provider === "openai") {
    const inT = opts.input_tokens ?? 0;
    const outT = opts.output_tokens ?? 0;
    return inT * OPENAI_MINI_INPUT_PER_TOKEN + outT * OPENAI_MINI_OUTPUT_PER_TOKEN;
  }

  if (provider === "anthropic") {
    const inT = opts.input_tokens ?? 0;
    const outT = opts.output_tokens ?? 0;
    return inT * CLAUDE_SONNET_INPUT_PER_TOKEN + outT * CLAUDE_SONNET_OUTPUT_PER_TOKEN;
  }

  if (provider === "brave") return BRAVE_PER_QUERY;
  if (provider === "serper") return SERPER_PER_QUERY;
  if (provider === "duckduckgo") return 0;
  if (provider === "wayback") return 0;

  return FETCH_COST;
}

// ─── Logger ─────────────────────────────────────────────────────────
let activeRunId: string | null = null;
let activeFilePath: string | null = null;

export function startRun(slug?: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  activeRunId = `${stamp}-${slug ?? "run"}`;
  activeFilePath = join("out", "costs", `${activeRunId}.jsonl`);
  mkdirSync(dirname(activeFilePath), { recursive: true });
  return activeRunId;
}

export function getRunId(): string {
  if (!activeRunId) startRun();
  return activeRunId!;
}

// Log a cost event. Writes to JSONL (always) and Supabase (if configured).
export function logCost(args: {
  event_type: CostEventType;
  provider?: string;
  model?: string;
  input_tokens?: number;
  output_tokens?: number;
  duration_ms?: number;
  metadata?: Record<string, unknown>;
  cost_usd?: number; // override the priced cost
  user_id?: string;
  article_id?: string;
  job_id?: string;
}): CostEvent {
  if (!activeRunId) startRun();

  const cost_usd =
    args.cost_usd ??
    priceFor({
      provider: args.provider,
      model: args.model,
      input_tokens: args.input_tokens,
      output_tokens: args.output_tokens,
    });

  const event: CostEvent = {
    run_id: activeRunId!,
    created_at: new Date().toISOString(),
    event_type: args.event_type,
    provider: args.provider,
    model: args.model,
    input_tokens: args.input_tokens,
    output_tokens: args.output_tokens,
    cost_usd,
    duration_ms: args.duration_ms,
    metadata: args.metadata,
    user_id: args.user_id,
    article_id: args.article_id,
    job_id: args.job_id,
  };

  // Local JSONL write (synchronous so we never lose events on crash).
  try {
    appendFileSync(activeFilePath!, JSON.stringify(event) + "\n");
  } catch (e) {
    console.warn(
      "[cost] failed to write JSONL:",
      e instanceof Error ? e.message : e
    );
  }

  // Supabase write (async, fire-and-forget). Only when service-role
  // creds + a user_id are present — otherwise the row violates RLS-in-
  // spirit even though service_role bypasses RLS.
  void writeToSupabase(event).catch((e: unknown) => {
    console.warn(
      "[cost] supabase log failed:",
      e instanceof Error ? e.message : e
    );
  });

  return event;
}

async function writeToSupabase(event: CostEvent): Promise<void> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return;
  if (!event.user_id) return; // CLI runs have no user — skip remote logging.

  await fetch(`${url}/rest/v1/cost_events`, {
    method: "POST",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify({
      user_id: event.user_id,
      article_id: event.article_id,
      job_id: event.job_id,
      event_type: event.event_type,
      provider: event.provider,
      model: event.model,
      input_tokens: event.input_tokens,
      output_tokens: event.output_tokens,
      cost_usd: event.cost_usd,
      duration_ms: event.duration_ms,
      metadata: event.metadata ?? {},
    }),
  });
}

// ─── Convenience timer ──────────────────────────────────────────────
// Wraps an async fn with timing + auto-logging. The fn returns its
// result; the wrapper additionally logs an event. Use sparingly — clear
// inline `logCost()` calls are usually more readable.
export async function timed<T>(
  args: Omit<Parameters<typeof logCost>[0], "duration_ms">,
  fn: () => Promise<T>
): Promise<T> {
  const start = Date.now();
  try {
    return await fn();
  } finally {
    const duration_ms = Date.now() - start;
    logCost({ ...args, duration_ms });
  }
}
