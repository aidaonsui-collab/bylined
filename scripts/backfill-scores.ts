#!/usr/bin/env tsx
// One-shot backfill — compute aeo_score and voice_match_score for
// articles generated before engine/src/scorer.ts existed.
//
// Idempotent: only processes rows where aeo_score IS NULL. Run as
// often as you like; once a row has a score, this script skips it.
//
// Usage (local):
//   SUPABASE_URL=...                 \
//   SUPABASE_SERVICE_ROLE_KEY=...    \
//   tsx scripts/backfill-scores.ts
//
// For each article we look up the voice fingerprint via the job that
// produced it (jobs.voice_id → voices.fingerprint). If no voice was
// used, voice_match_score stays NULL — the dashboard treats NULL as
// "not scored" rather than zero, so it won't drag averages down.

import { createClient } from "@supabase/supabase-js";
import {
  computeAEOScore,
  computeVoiceMatchScore,
} from "../engine/src/scorer.js";
import type { Article, Receipt } from "../engine/src/types.js";
import type { VoiceFingerprint } from "../engine/src/clients/voice.js";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error(
    "Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY before running.",
  );
  process.exit(1);
}

const admin = createClient(url, key, {
  auth: { persistSession: false },
});

type ArticleRow = {
  id: string;
  title: string;
  meta_description: string | null;
  body_markdown: string;
  receipts: Receipt[] | null;
  pass_rate: number | null;
  generated_at: string;
};

type JobRow = {
  article_id: string;
  voice_id: string | null;
};

type VoiceRow = {
  id: string;
  fingerprint: VoiceFingerprint;
};

async function main() {
  const { data: rows, error } = await admin
    .from("articles")
    .select(
      "id, title, meta_description, body_markdown, receipts, pass_rate, generated_at",
    )
    .is("aeo_score", null)
    .order("generated_at", { ascending: true });
  if (error) throw error;

  const articles = (rows ?? []) as ArticleRow[];
  console.log(`Found ${articles.length} article(s) needing scores.\n`);
  if (articles.length === 0) return;

  // Pull the voice mapping in one query.
  const { data: jobs } = await admin
    .from("jobs")
    .select("article_id, voice_id")
    .in(
      "article_id",
      articles.map((a) => a.id),
    );
  const voiceIdByArticle = new Map<string, string>();
  for (const j of (jobs ?? []) as JobRow[]) {
    if (j.voice_id) voiceIdByArticle.set(j.article_id, j.voice_id);
  }

  // And the fingerprints for the voices that show up.
  const voiceIds = Array.from(new Set(voiceIdByArticle.values()));
  const fingerprintById = new Map<string, VoiceFingerprint>();
  if (voiceIds.length > 0) {
    const { data: voices } = await admin
      .from("voices")
      .select("id, fingerprint")
      .in("id", voiceIds);
    for (const v of (voices ?? []) as VoiceRow[]) {
      fingerprintById.set(v.id, v.fingerprint);
    }
  }

  let updated = 0;
  for (const row of articles) {
    const article: Article = {
      title: row.title,
      meta_description: row.meta_description ?? "",
      body_markdown: row.body_markdown,
      receipts: row.receipts ?? [],
      pass_rate: row.pass_rate ?? 0,
      generated_at: row.generated_at,
    };

    const aeo = computeAEOScore(article);
    const voiceId = voiceIdByArticle.get(row.id);
    const fingerprint = voiceId ? fingerprintById.get(voiceId) : undefined;
    const voiceMatch = fingerprint
      ? computeVoiceMatchScore(article, fingerprint)
      : null;

    const { error: upErr } = await admin
      .from("articles")
      .update({ aeo_score: aeo, voice_match_score: voiceMatch })
      .eq("id", row.id);
    if (upErr) {
      console.error(`  ✗ ${row.id} — ${upErr.message}`);
      continue;
    }
    console.log(
      `  ✓ ${row.title.slice(0, 60)} — aeo=${aeo} voice=${
        voiceMatch ?? "—"
      }`,
    );
    updated++;
  }

  console.log(`\nDone. Updated ${updated}/${articles.length} article(s).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
