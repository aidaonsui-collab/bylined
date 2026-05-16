import { z } from "zod";

export const SerpResultSchema = z.object({
  url: z.string().url(),
  title: z.string(),
  description: z.string().optional(),
  rank: z.number().int().min(1),
});
export type SerpResult = z.infer<typeof SerpResultSchema>;

export const FactSchema = z.object({
  source_url: z.string().url(),
  exact_passage: z.string(),
  retrieved_at: z.string(),
  type: z.enum(["stat", "quote", "claim"]),
  number: z.string().optional(),
});
export type Fact = z.infer<typeof FactSchema>;

export const ClaimSchema = z.object({
  source_id: z.string(),
  exact_quote_used: z.string(),
});
export type Claim = z.infer<typeof ClaimSchema>;

export const ReceiptSchema = z.object({
  id: z.number().int(),
  source_url: z.string(),
  passage: z.string(),
  type: z.enum(["stat", "quote", "claim"]),
  retrieved_at: z.string(),
  verified: z.boolean(),
  verification_notes: z.string().optional(),
  // Wayback calendar URL — survives source URL drift or 404. Set only when
  // verified=true, since we don't snapshot URLs that failed verification.
  wayback_url: z.string().optional(),
  archived_at: z.string().optional(),
});
export type Receipt = z.infer<typeof ReceiptSchema>;

export const ArticleSchema = z.object({
  title: z.string(),
  meta_description: z.string(),
  body_markdown: z.string(),
  receipts: z.array(ReceiptSchema),
  pass_rate: z.number().min(0).max(1),
  generated_at: z.string(),
  // Heuristic 0-100 scores feeding the in-app dashboard.
  // voice_match_score is null when no voice fingerprint was used.
  aeo_score: z.number().int().min(0).max(100).optional(),
  voice_match_score: z.number().int().min(0).max(100).nullable().optional(),
});
export type Article = z.infer<typeof ArticleSchema>;

export type VerificationResult =
  | { passed: true }
  | {
      passed: false;
      reason: "url_unreachable" | "passage_not_found" | "number_mismatch";
      detail: string;
    };
