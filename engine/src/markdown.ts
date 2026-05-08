// Minimal markdown → HTML converter for the article shapes Bylined produces.
// We control the markdown, so we only need to handle: H2/H3 headings, paragraphs,
// **bold**, _italic_, and [^N] footnote markers. Anything fancier is not in our
// generator's output, so we don't ship a full markdown parser.

import type { Receipt } from "./types.js";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function markdownToHtml(md: string): string {
  let html = md;

  // Headings — convert before paragraphing so blocks don't get re-wrapped.
  html = html.replace(/^### (.+)$/gm, "<h3>$1</h3>");
  html = html.replace(/^## (.+)$/gm, "<h2>$1</h2>");
  html = html.replace(/^# (.+)$/gm, "<h1>$1</h1>");

  // Bold + italic — operate on text only; safe because we control input.
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/(?:^|[^_])_([^_\n]+)_(?:[^_]|$)/g, (m, inner) =>
    m.replace(`_${inner}_`, `<em>${inner}</em>`)
  );

  // Footnote markers [^N] → superscript anchor linking to the source list.
  html = html.replace(
    /\[\^(\d+)\]/g,
    '<sup><a href="#receipt-$1" id="cite-$1" rel="nofollow">$1</a></sup>'
  );

  // Paragraphs — split on blank lines, wrap non-block content in <p>.
  const blocks = html.split(/\n\s*\n+/);
  return blocks
    .map((b) => {
      const t = b.trim();
      if (!t) return "";
      if (/^<(h[1-6]|ul|ol|blockquote|pre|table|div)\b/i.test(t)) return t;
      return `<p>${t}</p>`;
    })
    .filter(Boolean)
    .join("\n\n");
}

// Render a "Sources" section listing every verified receipt as a numbered
// list item with the original URL and (if present) a Wayback archive link.
export function buildSourcesHtml(receipts: Receipt[]): string {
  const verified = receipts.filter((r) => r.verified && r.source_url);
  if (verified.length === 0) return "";

  const items = verified
    .map((r) => {
      const passage = escapeHtml(r.passage);
      const url = escapeHtml(r.source_url);
      const wayback = r.wayback_url
        ? ` &nbsp;·&nbsp; <a href="${escapeHtml(r.wayback_url)}" rel="nofollow">archive</a>`
        : "";
      return `  <li id="receipt-${r.id}">&ldquo;${passage}&rdquo; &mdash; <a href="${url}" rel="nofollow">${url}</a>${wayback}</li>`;
    })
    .join("\n");

  return `<h2>Sources</h2>\n<ol>\n${items}\n</ol>`;
}
