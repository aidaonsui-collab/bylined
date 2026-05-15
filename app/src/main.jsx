import React from 'react';
import ReactDOM from 'react-dom/client';
import * as Sentry from '@sentry/react';
import App from './App.jsx';
import './styles.css';
import './app.css';

// Sentry — capture uncaught errors from the SPA. Init is no-op when
// VITE_SENTRY_DSN is unset (e.g. local dev with .env.local missing).
// Skip tracing + replays — the worker is where the real action is; we
// just want runtime crashes from the browser surfaced.
const SENTRY_DSN = import.meta.env.VITE_SENTRY_DSN;
if (SENTRY_DSN) {
  Sentry.init({
    dsn: SENTRY_DSN,
    environment: import.meta.env.VITE_SENTRY_ENV ?? 'production',
    tracesSampleRate: 0,
  });
  // TODO(revert): one-shot smoke test to confirm Sentry is wired end-to-end.
  Sentry.captureMessage('app boot', 'info');
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <Sentry.ErrorBoundary
      fallback={
        <div style={{ padding: 24, fontFamily: 'system-ui', lineHeight: 1.5 }}>
          <h2 style={{ margin: '0 0 8px' }}>Something broke.</h2>
          <p style={{ margin: 0, color: '#666' }}>
            Refresh to try again. We've been notified.
          </p>
        </div>
      }
    >
      <App />
    </Sentry.ErrorBoundary>
  </React.StrictMode>
);
