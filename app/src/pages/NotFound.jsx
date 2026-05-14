// 404 — shown for any unmatched route. Previously the catch-all route
// silently redirected to /app, which bounced unauthed users through
// sign-in for no reason. An explicit page is friendlier and honest.

import DocLayout from '../components/DocLayout.jsx';

export default function NotFound() {
  return (
    <DocLayout eyebrow="404" title="Page not found">
      <p>
        That page doesn't exist — it may have moved, or the link was mistyped.
      </p>
      <p style={{ marginTop: 16 }}>
        Head to your <a href="/app">dashboard</a>, or back to the{' '}
        <a href="/">homepage</a>.
      </p>
    </DocLayout>
  );
}
