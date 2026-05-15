// Client-side preview renderer for article body_markdown.
//
// Mirrors engine/src/markdown.ts so the dashboard preview matches what
// publish-article emits to WordPress / Webflow / blog_posts. Kept tiny
// and dependency-free — we control the input markdown shape (only the
// subset our generator produces).
//
// Receipts are rendered as a "Sources" list at the bottom so the
// preview is what visitors will actually see on /blog/{slug}/. Failed
// receipts are excluded (matching publish-article's filter).

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function markdownToHtml(md) {
  let html = String(md ?? '');

  // Headings — convert before paragraphing so blocks don't get re-wrapped.
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

  // Bold + italic — operate on text only.
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/(?:^|[^_])_([^_\n]+)_(?:[^_]|$)/g, (m, inner) =>
    m.replace(`_${inner}_`, `<em>${inner}</em>`)
  );

  // Footnote markers [^N] → superscript anchor linking to the source list.
  html = html.replace(
    /\[\^(\d+)\]/g,
    '<sup><a href="#receipt-$1" id="cite-$1">$1</a></sup>'
  );

  // Paragraphs — split on blank lines, wrap non-block content in <p>.
  const blocks = html.split(/\n\s*\n+/);
  return blocks
    .map((b) => {
      const t = b.trim();
      if (!t) return '';
      if (/^<(h[1-6]|ul|ol|blockquote|pre|table|div)\b/i.test(t)) return t;
      return `<p>${t}</p>`;
    })
    .filter(Boolean)
    .join('\n\n');
}

export function buildSourcesHtml(receipts) {
  const verified = (receipts ?? []).filter((r) => r.verified && r.source_url);
  if (verified.length === 0) return '';

  const items = verified
    .map((r) => {
      const passage = escapeHtml(r.passage);
      const url = escapeHtml(r.source_url);
      const wayback = r.wayback_url
        ? ` &nbsp;·&nbsp; <a href="${escapeHtml(r.wayback_url)}" target="_blank" rel="noreferrer">archive</a>`
        : '';
      return `  <li id="receipt-${r.id}">&ldquo;${passage}&rdquo; &mdash; <a href="${url}" target="_blank" rel="noreferrer">${url}</a>${wayback}</li>`;
    })
    .join('\n');

  return `<h2>Sources</h2>\n<ol>\n${items}\n</ol>`;
}

// Convenience: full rendered article (body + sources) as one HTML string.
// Use with dangerouslySetInnerHTML in a styled container (.legal-prose
// or .blog-post-body on the marketing side share the same look).
export function renderArticle(bodyMarkdown, receipts) {
  const body = markdownToHtml(bodyMarkdown);
  const sources = buildSourcesHtml(receipts);
  return sources ? `${body}\n\n${sources}` : body;
}
