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
// Sentry first — must initialize before anything we want it to wrap.
import * as Sentry from "@sentry/node";

const SENTRY_DSN = process.env.SENTRY_DSN;
if (SENTRY_DSN) {
  Sentry.init({
    dsn: SENTRY_DSN,
    environment: process.env.SENTRY_ENV ?? "production",
    // Capture every uncaught error from the worker; tracing is overkill
    // for an LLM-bound process where one job = many minutes.
    tracesSampleRate: 0,
  });
}

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { generate } from "./orchestrator.js";
import { inferKeywordFromSite } from "./demo.js";
import { auditSite } from "./audit.js";
import { startRun, setRunContext, clearRunContext } from "./cost.js";
import { markdownToHtml, buildSourcesHtml } from "./markdown.js";
import type { Article } from "./types.js";

const BYLINED_HOSTED_DEPLOY_HOOK = process.env.BYLINED_HOSTED_DEPLOY_HOOK;

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 70);
}

// Auto-publish a freshly-generated article when the job carries an
// auto_publish_site_id. Mirrors the publish-article edge function's
// bylined_hosted branch but runs server-side as service-role so we
// don't have to mint a user JWT.
//
// Only handles cms_type='bylined_hosted' right now — WordPress and
// Webflow auto-publish are deliberately deferred until we want the
// worker handling those credential paths. For other site types this
// helper logs a warning and returns; the article remains a draft and
// the user can publish manually from the dashboard.
async function autoPublishToSite(args: {
  articleId: string;
  article: Article;
  userId: string;
  siteId: string;
  live: boolean;
  log: (msg: string) => void;
}): Promise<void> {
  const { articleId, article, userId, siteId, live, log } = args;

  const { data: site, error: sErr } = await admin
    .from("sites")
    .select("id, name, cms_type, is_active, user_id")
    .eq("id", siteId)
    .single();
  if (sErr || !site) throw new Error(`auto-publish: site not found (${sErr?.message ?? siteId})`);
  if (site.user_id !== userId) throw new Error(`auto-publish: site doesn't belong to caller`);
  if (!site.is_active) throw new Error(`auto-publish: site is paused`);

  if (site.cms_type !== "bylined_hosted") {
    log(
      `auto-publish skipped: site cms_type '${site.cms_type}' isn't supported ` +
        `by the worker yet — publish manually from the dashboard. ` +
        `Article saved as draft.`
    );
    return;
  }

  const bodyHtml = markdownToHtml(article.body_markdown);
  const sourcesHtml = buildSourcesHtml(article.receipts ?? []);
  const slug = slugify(article.title);

  const { error: upErr } = await admin
    .from("blog_posts")
    .upsert(
      {
        user_id: userId,
        article_id: articleId,
        site_id: siteId,
        slug,
        title: article.title,
        meta_description: article.meta_description,
        body_html: bodyHtml,
        sources_html: sourcesHtml,
        status: live ? "published" : "draft",
        published_at: live ? new Date().toISOString() : null,
      },
      { onConflict: "article_id,site_id" }
    );
  if (upErr) throw new Error(`blog_posts upsert failed: ${upErr.message}`);

  // Mirror the article row's published state so the dashboard "Published"
  // chip lights up without the user clicking anywhere.
  if (live) {
    await admin
      .from("articles")
      .update({
        site_id: siteId,
        cms_post_url: `https://getbylined.com/blog/${slug}`,
        status: "published",
        published_at: new Date().toISOString(),
      })
      .eq("id", articleId);
  }

  // Fire the marketing rebuild hook so the static page goes live
  // within ~30s. Drafts skip the rebuild — no point in burning a
  // Vercel build for something the visitor can't see anyway.
  if (live && BYLINED_HOSTED_DEPLOY_HOOK) {
    try {
      await fetch(BYLINED_HOSTED_DEPLOY_HOOK, {
        method: "POST",
        signal: AbortSignal.timeout(10_000),
      });
    } catch (e) {
      // Don't fail auto-publish on a flapping hook — the blog_posts
      // row is committed and the next deploy will pick it up.
      console.error(
        `[worker] BYLINED_HOSTED_DEPLOY_HOOK failed (article still in DB):`,
        e instanceof Error ? e.message : String(e)
      );
    }
  }

  log(`auto-published to ${site.name} as ${live ? "live" : "draft"}`);
}

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
  // Set by the dashboard's bulk-queue form. When non-null, the worker
  // publishes the generated article to this site as soon as the article
  // row lands — no manual click required. auto_publish_live=true means
  // "ship as published", false means "stage as draft on the CMS side".
  auto_publish_site_id: string | null;
  auto_publish_live: boolean;
}

interface DemoRequest {
  id: string;
  url: string;
  status: string;
  kind: "audit" | "article";
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
        aeo_score: article.aeo_score ?? null,
        voice_match_score: article.voice_match_score ?? null,
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

    // 4c. Auto-publish if the job asked for it. Currently only the
    //     bylined_hosted target is wired here — WordPress / Webflow
    //     credentials live on the site row and we don't want the
    //     worker reaching into those flows yet. Sites of those types
    //     emit a warning and the article stays a draft (user can
    //     publish manually from the dashboard).
    if (job.auto_publish_site_id) {
      try {
        await autoPublishToSite({
          articleId: inserted.id,
          article,
          userId: job.user_id,
          siteId: job.auto_publish_site_id,
          live: job.auto_publish_live,
          log,
        });
      } catch (e) {
        // Auto-publish failure is logged + reported but does NOT fail
        // the whole job — the article was generated and stored. The
        // user can retry publish from the dashboard.
        const msg = e instanceof Error ? e.message : String(e);
        log(`auto-publish failed (article still saved as draft): ${msg}`);
        Sentry.captureException(e, {
          tags: { worker_path: "auto_publish" },
          contexts: { job: { id: job.id, keyword: job.keyword } },
        });
      }
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
    Sentry.captureException(e, {
      tags: { worker_path: "job" },
      contexts: { job: { id: job.id, keyword: job.keyword } },
    });
    await failJob(job.id, msg);
  } finally {
    clearRunContext();
  }
}

// ─── Demo requests ─────────────────────────────────────────────────
// Unauthenticated "watch it write your first article" runs from the
// marketing site. Same engine, but: no user, no quota, no article row
// — we write a trimmed result excerpt straight onto the demo_requests
// row for the landing page to poll. Real jobs always take priority.

async function claimNextDemo(): Promise<DemoRequest | null> {
  const { data, error } = await admin.rpc("claim_next_demo");
  if (error) {
    console.error("[worker] demo claim error:", error.message);
    return null;
  }
  if (!data) return null;
  const row = (Array.isArray(data) ? data[0] : data) as Partial<DemoRequest> | null;
  if (!row || row.id == null) return null;
  return row as DemoRequest;
}

async function setDemoProgress(demoId: string, progress: string): Promise<void> {
  // Fire-and-forget — a missed progress line just means the landing
  // page shows a slightly stale step. Not worth failing the run over.
  await admin
    .from("demo_requests")
    .update({ progress })
    .eq("id", demoId)
    .then(undefined, () => {});
}

// Map the orchestrator's internal log lines to friendly progress text
// for the landing page. Anything unmapped is ignored (stays on the
// previous step).
function friendlyProgress(logLine: string): string | null {
  if (logLine.startsWith("searching SERP")) return "Searching the web for sources…";
  if (/^fetched \d+\/\d+ pages/.test(logLine)) return "Reading the top sources…";
  if (/^extracted \d+ facts/.test(logLine)) return "Extracting verifiable facts…";
  if (logLine.startsWith("generating article")) return "Writing your article…";
  if (logLine.startsWith("running validation")) return "Verifying every claim…";
  if (/^triggered \d+ Wayback/.test(logLine)) return "Archiving the sources…";
  return null;
}

async function failDemo(demoId: string, message: string): Promise<void> {
  const { error } = await admin
    .from("demo_requests")
    .update({
      status: "failed",
      error: message.slice(0, 300),
      completed_at: new Date().toISOString(),
    })
    .eq("id", demoId);
  if (error) console.error("[worker] failDemo update error:", error.message);
}

// AI-visibility audit — the fast "what's the gap" half of the demo
// flow. Crawls the site, asks an AI 5 buyer questions ×3, tallies who
// got named. Cheap-ish (16 short LLM calls) and reads back in ~20-40s.
async function runDemoAudit(demo: DemoRequest): Promise<void> {
  const tag = `[worker:audit:${demo.id.slice(0, 8)}]`;
  startRun(`audit-${demo.id.slice(0, 8)}`);
  clearRunContext(); // demos have no user — keep cost events local-only
  console.log(`${tag} claimed: url="${demo.url}"`);

  try {
    await setDemoProgress(demo.id, "Reading your site…");
    const audit = await auditSite(demo.url, (msg) => {
      console.log(`${tag} ${msg}`);
      // Map the audit's internal log lines to friendly progress.
      if (msg.startsWith("working out")) {
        void setDemoProgress(demo.id, "Working out what your customers ask…");
      } else if (msg.startsWith("asking the AI")) {
        void setDemoProgress(demo.id, "Asking an AI what your customers ask…");
      }
    });

    const result = { kind: "audit", ...audit };
    const { error: doneErr } = await admin
      .from("demo_requests")
      .update({
        status: "completed",
        progress: "Done.",
        keyword: audit.category,
        result,
        completed_at: new Date().toISOString(),
      })
      .eq("id", demo.id);
    if (doneErr) throw new Error(`demo update failed: ${doneErr.message}`);
    console.log(
      `${tag} ✓ done — "${audit.brand_name}" mentioned in ` +
        `${audit.mention_count}/${audit.total_runs} runs`
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`${tag} ✗ failed:`, msg);
    Sentry.captureException(e, {
      tags: { worker_path: "audit" },
      contexts: { demo: { id: demo.id, url: demo.url } },
    });
    await failDemo(demo.id, msg);
  } finally {
    clearRunContext();
  }
}

async function runDemoArticle(demo: DemoRequest): Promise<void> {
  const tag = `[worker:demo:${demo.id.slice(0, 8)}]`;
  const runId = startRun(`demo-${demo.id.slice(0, 8)}`);
  // Demos have no user — leave runContext empty so cost events stay
  // local-JSONL only (writeToSupabase skips events without a user_id).
  clearRunContext();
  console.log(`${tag} claimed: url="${demo.url}" run=${runId}`);

  try {
    // 1. Crawl the site and infer one keyword to generate against.
    await setDemoProgress(demo.id, "Reading your site…");
    const { keyword, site_summary } = await inferKeywordFromSite(demo.url);
    console.log(`${tag} inferred keyword: "${keyword}"`);
    await admin
      .from("demo_requests")
      .update({ keyword, progress: `Researching “${keyword}”…` })
      .eq("id", demo.id);

    // 2. Run the real pipeline. The log callback doubles as a progress
    //    feed for the landing page.
    const article: Article = await generate({
      keyword,
      log: (msg: string) => {
        console.log(`${tag} ${msg}`);
        const friendly = friendlyProgress(msg);
        if (friendly) void setDemoProgress(demo.id, friendly);
      },
    });

    // 3. Trim to a result excerpt — an anonymous visitor sees enough to
    //    be convinced, not the full 10k-char body.
    const verifiedReceipts = (article.receipts ?? [])
      .filter((r) => r.verified)
      .slice(0, 6)
      .map((r) => ({
        passage: r.passage,
        source_url: r.source_url,
      }));
    const result = {
      keyword,
      site_summary,
      title: article.title,
      meta_description: article.meta_description,
      body_excerpt: article.body_markdown.slice(0, 900),
      body_chars: article.body_markdown.length,
      receipts: verifiedReceipts,
      receipts_verified: (article.receipts ?? []).filter((r) => r.verified).length,
      receipts_total: (article.receipts ?? []).length,
      pass_rate: article.pass_rate,
    };

    const { error: doneErr } = await admin
      .from("demo_requests")
      .update({
        status: "completed",
        progress: "Done.",
        result,
        completed_at: new Date().toISOString(),
      })
      .eq("id", demo.id);
    if (doneErr) throw new Error(`demo update failed: ${doneErr.message}`);
    console.log(
      `${tag} ✓ done — "${article.title}" pass_rate=${(article.pass_rate * 100).toFixed(1)}%`
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`${tag} ✗ failed:`, msg);
    Sentry.captureException(e, {
      tags: { worker_path: "demo_article" },
      contexts: { demo: { id: demo.id, url: demo.url } },
    });
    await failDemo(demo.id, msg);
  } finally {
    clearRunContext();
  }
}

// On startup, mark any jobs left in 'running' as failed. This catches
// rows that were orphaned by the previous worker crashing or being
// restarted mid-job (Railway redeploy, OOM, segfault, etc). Without
// this they sit in 'running' forever and block the user — there is
// no other process that ever moves them off that state.
//
// 10 minutes is well above the longest legitimate per-job runtime
// (typical: 30-120s; pathological: ~5 min). Any 'running' row older
// than that is definitely orphaned, not in-progress.
async function reapStaleRunning(): Promise<void> {
  const cutoffMs = Date.now() - 10 * 60 * 1000;
  const { data, error } = await admin
    .from("jobs")
    .update({
      status: "failed",
      error:
        "Worker process crashed or was restarted while this job was running. Retry to re-queue (no quota charge).",
      completed_at: new Date().toISOString(),
    })
    .eq("status", "running")
    .lt("created_at", new Date(cutoffMs).toISOString())
    .select("id, keyword");
  if (error) {
    console.error("[worker] reapStaleRunning error:", error.message);
    return;
  }
  if (data && data.length > 0) {
    console.log(
      `[worker] reaped ${data.length} stale running job(s): ${data
        .map((r) => `"${r.keyword}"`)
        .join(", ")}`
    );
  }
}

async function loop(): Promise<void> {
  console.log(
    `[worker] up — polling ${SUPABASE_URL} every ${POLL_MS}ms (Ctrl-C to stop)`
  );
  await reapStaleRunning();
  while (!stopping) {
    // Paying jobs always take priority over anonymous demo runs.
    const job = await claimNextJob();
    if (job) {
      await runJob(job);
      continue;
    }
    const demo = await claimNextDemo();
    if (demo) {
      if (demo.kind === "audit") await runDemoAudit(demo);
      else await runDemoArticle(demo);
      continue;
    }
    await sleep(POLL_MS);
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

loop().catch(async (e) => {
  console.error("[worker] fatal:", e instanceof Error ? e.message : e);
  Sentry.captureException(e, { tags: { worker_path: "fatal" } });
  // Give Sentry a moment to flush before we die.
  if (SENTRY_DSN) await Sentry.close(2000);
  process.exit(1);
});
