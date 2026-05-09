#!/usr/bin/env tsx
// Bylined article-generation worker.
//
// Polls public.jobs for queued rows, runs the engine's generate()
// pipeline, writes the resulting article into public.articles, and
// updates the job's status. One job at a time — generation is
// CPU-light but network-heavy and we want predictable cost per run.
//
// Atomic claim is via the claim_next_job() RPC (SELECT ... FOR UPDATE
// SKIP LOCKED), so it's safe to run multiple workers.
//
// Usage:
//   SUPABASE_URL=...
//   SUPABASE_SERVICE_ROLE_KEY=...
//   MINIMAX_API_KEY=...
//   npm run worker
//
// Stop with Ctrl-C; in-flight job is given up to 30s to finish before
// we mark it `failed` with a 'worker_shutdown' note.

import "dotenv/config";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { generate } from "./orchestrator.js";
import { startRun, setRunContext, clearRunContext } from "./cost.js";
import type { Article } from "./types.js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const POLL_MS = Number(process.env.WORKER_POLL_MS ?? 5000);
const SHUTDOWN_GRACE_MS = 30_000;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error(
    "[worker] SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required.\n" +
      "         Add them to engine/.env (copy the service_role key from\n" +
      "         Supabase dashboard → Project Settings → API)."
  );
  process.exit(1);
}

const admin: SupabaseClient = createClient(
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

interface Job {
  id: string;
  user_id: string;
  site_id: string | null;
  voice_id: string | null;
  keyword: string;
  status: string;
}

let stopping = false;

async function claimNextJob(): Promise<Job | null> {
  const { data, error } = await admin.rpc("claim_next_job");
  if (error) {
    console.error("[worker] claim error:", error.message);
    return null;
  }
  if (!data) return null;
  // supabase-js sometimes wraps single-row returns in an object, sometimes
  // in a one-element array, depending on rpc inference. Normalize.
  const row = (Array.isArray(data) ? data[0] : data) as Partial<Job> | null;
  // RETURNS public.jobs gives a composite-NULL row (all fields null) when
  // no UPDATE matched. Treat that as "no job claimed".
  if (!row || row.id == null) return null;
  return row as Job;
}

async function failJob(jobId: string, message: string): Promise<void> {
  const { error } = await admin
    .from("jobs")
    .update({
      status: "failed",
      error: message.slice(0, 500),
      completed_at: new Date().toISOString(),
    })
    .eq("id", jobId);
  if (error) console.error("[worker] failJob update error:", error.message);
}

async function runJob(job: Job): Promise<void> {
  const slug = job.keyword
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 60);
  const runId = startRun(`${slug}-${job.id.slice(0, 8)}`);
  setRunContext({ user_id: job.user_id, job_id: job.id });
  const log = (msg: string) => console.log(`[worker:${job.id.slice(0, 8)}] ${msg}`);
  log(`claimed: keyword="${job.keyword}" run=${runId}`);

  try {
    // 1. Load voice fingerprint if the job pinned one. We pass it into
    //    generate() so the writer's prompt picks up the brand-style
    //    fragment. Failure to load is logged but non-fatal — better to
    //    generate a generic article than to fail the job.
    let voice: import("./clients/voice.js").VoiceFingerprint | undefined;
    if (job.voice_id) {
      const { data: voiceRow, error: vErr } = await admin
        .from("voices")
        .select("fingerprint")
        .eq("id", job.voice_id)
        .single();
      if (vErr) {
        log(`voice load failed (${vErr.message}); continuing without voice`);
      } else {
        voice = voiceRow?.fingerprint as
          | import("./clients/voice.js").VoiceFingerprint
          | undefined;
        log(`using voice fingerprint from ${voice?.source_url ?? "(unknown)"}`);
      }
    }

    // 2. Run the engine pipeline.
    const article: Article = await generate({
      keyword: job.keyword,
      voice,
      log,
    });

    // 3. Insert the article. Status='draft' until publish wires up.
    const { data: inserted, error: insertErr } = await admin
      .from("articles")
      .insert({
        user_id: job.user_id,
        site_id: job.site_id,
        keyword: job.keyword,
        title: article.title,
        meta_description: article.meta_description,
        body_markdown: article.body_markdown,
        receipts: article.receipts,
        pass_rate: article.pass_rate,
        status: "draft",
        generated_at: article.generated_at,
      })
      .select("id")
      .single();
    if (insertErr) throw new Error(`articles insert failed: ${insertErr.message}`);

    // 4. Mark job complete.
    const { error: jobErr } = await admin
      .from("jobs")
      .update({
        status: "completed",
        article_id: inserted.id,
        completed_at: new Date().toISOString(),
      })
      .eq("id", job.id);
    if (jobErr) throw new Error(`jobs update failed: ${jobErr.message}`);

    // 4b. Backfill article_id onto every cost_event we logged for this
    //     job. The article row didn't exist when those events fired, so
    //     they only carry job_id. cost_per_article rolls up by article_id.
    const { error: backfillErr } = await admin
      .from("cost_events")
      .update({ article_id: inserted.id })
      .eq("job_id", job.id)
      .is("article_id", null);
    if (backfillErr) {
      // Non-fatal — the events still exist with job_id set, so we can
      // join through public.jobs in views if needed. Just log.
      console.warn(
        `[worker:${job.id.slice(0, 8)}] cost_events backfill failed:`,
        backfillErr.message
      );
    }

    // 5. Increment quota usage (only on success).
    const { data: newUsed, error: incErr } = await admin.rpc(
      "increment_articles_used",
      { p_user_id: job.user_id }
    );
    if (incErr) {
      console.warn(
        `[worker:${job.id.slice(0, 8)}] increment_articles_used failed:`,
        incErr.message
      );
    } else {
      log(`✓ done — pass_rate=${(article.pass_rate * 100).toFixed(1)}% used=${newUsed}`);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[worker:${job.id.slice(0, 8)}] ✗ failed:`, msg);
    await failJob(job.id, msg);
  } finally {
    clearRunContext();
  }
}

async function loop(): Promise<void> {
  console.log(
    `[worker] up — polling ${SUPABASE_URL} every ${POLL_MS}ms (Ctrl-C to stop)`
  );
  while (!stopping) {
    const job = await claimNextJob();
    if (!job) {
      await sleep(POLL_MS);
      continue;
    }
    await runJob(job);
  }
  console.log("[worker] shutdown complete");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Graceful shutdown: stop after the current job finishes, but bail
// hard if it takes longer than SHUTDOWN_GRACE_MS.
let forceExitTimer: NodeJS.Timeout | undefined;
process.on("SIGINT", () => {
  if (stopping) {
    console.log("\n[worker] second SIGINT — exiting now");
    process.exit(1);
  }
  stopping = true;
  console.log(
    `\n[worker] SIGINT — finishing current job (max ${SHUTDOWN_GRACE_MS / 1000}s)`
  );
  forceExitTimer = setTimeout(() => {
    console.log("[worker] grace period expired — force exit");
    process.exit(1);
  }, SHUTDOWN_GRACE_MS);
  if (forceExitTimer.unref) forceExitTimer.unref();
});

loop().catch((e) => {
  console.error("[worker] fatal:", e instanceof Error ? e.message : e);
  process.exit(1);
});
