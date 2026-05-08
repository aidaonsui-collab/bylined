#!/usr/bin/env tsx
// Summarise cost events from local JSONL logs.
//
// Usage:
//   npm run costs                       # summary across all runs
//   npm run costs -- --run <run_id>     # detail for one run
//   npm run costs -- --since 7d         # last N days only

import "dotenv/config";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { CostEvent } from "./cost.js";

const args = process.argv.slice(2);
const runFlag = args.indexOf("--run");
const sinceFlag = args.indexOf("--since");
const runId = runFlag >= 0 ? args[runFlag + 1] : null;
const sinceArg = sinceFlag >= 0 ? args[sinceFlag + 1] : null;

const COSTS_DIR = "out/costs";

function parseSince(s: string | null): number | null {
  if (!s) return null;
  const m = s.match(/^(\d+)([dhm])$/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  const unit = m[2];
  const ms = unit === "d" ? 86400_000 : unit === "h" ? 3600_000 : 60_000;
  return Date.now() - n * ms;
}

function loadEvents(filterFile?: string): CostEvent[] {
  if (!existsSync(COSTS_DIR)) return [];
  const files = readdirSync(COSTS_DIR).filter((f) => f.endsWith(".jsonl"));
  const out: CostEvent[] = [];
  for (const f of files) {
    if (filterFile && !f.includes(filterFile)) continue;
    const lines = readFileSync(join(COSTS_DIR, f), "utf8").split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as CostEvent);
      } catch {
        /* skip malformed line */
      }
    }
  }
  return out;
}

function fmtUSD(n: number): string {
  if (n < 0.01) return `$${n.toFixed(6)}`;
  if (n < 1) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

function pad(s: string, w: number): string {
  return s.length >= w ? s : s + " ".repeat(w - s.length);
}

function summarize(events: CostEvent[]): void {
  if (events.length === 0) {
    console.log("No cost events found.");
    return;
  }

  const byType = new Map<string, { count: number; cost: number; ms: number }>();
  const byProvider = new Map<string, { count: number; cost: number }>();
  const byRun = new Map<string, { count: number; cost: number; first: string }>();
  let total = 0;
  let totalMs = 0;
  let totalIn = 0;
  let totalOut = 0;

  for (const e of events) {
    total += e.cost_usd ?? 0;
    totalMs += e.duration_ms ?? 0;
    totalIn += e.input_tokens ?? 0;
    totalOut += e.output_tokens ?? 0;

    const t = byType.get(e.event_type) ?? { count: 0, cost: 0, ms: 0 };
    t.count++;
    t.cost += e.cost_usd ?? 0;
    t.ms += e.duration_ms ?? 0;
    byType.set(e.event_type, t);

    const p = e.provider ?? "(none)";
    const pr = byProvider.get(p) ?? { count: 0, cost: 0 };
    pr.count++;
    pr.cost += e.cost_usd ?? 0;
    byProvider.set(p, pr);

    const r = byRun.get(e.run_id) ?? { count: 0, cost: 0, first: e.created_at };
    r.count++;
    r.cost += e.cost_usd ?? 0;
    if (e.created_at < r.first) r.first = e.created_at;
    byRun.set(e.run_id, r);
  }

  console.log(`\n${events.length} events · ${byRun.size} run(s) · ${fmtUSD(total)} total · ${(totalMs / 1000).toFixed(1)}s wall time\n`);

  console.log("By event type:");
  console.log("  " + pad("type", 22) + pad("count", 8) + pad("cost", 12) + "ms total");
  console.log("  " + "─".repeat(56));
  for (const [t, s] of [...byType.entries()].sort((a, b) => b[1].cost - a[1].cost)) {
    console.log("  " + pad(t, 22) + pad(String(s.count), 8) + pad(fmtUSD(s.cost), 12) + s.ms);
  }

  console.log("\nBy provider:");
  console.log("  " + pad("provider", 16) + pad("count", 8) + "cost");
  console.log("  " + "─".repeat(40));
  for (const [p, s] of [...byProvider.entries()].sort((a, b) => b[1].cost - a[1].cost)) {
    console.log("  " + pad(p, 16) + pad(String(s.count), 8) + fmtUSD(s.cost));
  }

  if (byRun.size > 1) {
    console.log("\nPer run:");
    console.log("  " + pad("run", 50) + pad("events", 8) + "cost");
    console.log("  " + "─".repeat(80));
    const sorted = [...byRun.entries()].sort((a, b) => (b[1].first > a[1].first ? 1 : -1));
    for (const [r, s] of sorted.slice(0, 20)) {
      console.log("  " + pad(r.slice(0, 48), 50) + pad(String(s.count), 8) + fmtUSD(s.cost));
    }
    if (sorted.length > 20) console.log(`  … and ${sorted.length - 20} more`);
  }

  if (totalIn > 0 || totalOut > 0) {
    console.log(`\nTokens: ${totalIn.toLocaleString()} in · ${totalOut.toLocaleString()} out`);
  }

  if (byRun.size === 1) {
    const cost = total / 1; // per article
    console.log(`\nPer-article cost (this run): ${fmtUSD(cost)}`);
    console.log(`Implied gross margin at $1.30 retail: ${(((1.3 - cost) / 1.3) * 100).toFixed(1)}%`);
  } else if (byRun.size > 1) {
    const perRun = total / byRun.size;
    console.log(`\nAvg per-article cost: ${fmtUSD(perRun)}`);
    console.log(`Implied gross margin at $1.30 retail: ${(((1.3 - perRun) / 1.3) * 100).toFixed(1)}%`);
  }
}

const since = parseSince(sinceArg);
let events = loadEvents(runId ?? undefined);
if (since !== null) {
  events = events.filter((e) => Date.parse(e.created_at) >= since);
}
summarize(events);
