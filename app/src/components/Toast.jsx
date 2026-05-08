// Tiny toast: a single-slot notification that auto-dismisses.
// Sufficient for auth flows; can be expanded later if needed.

import { createContext, useCallback, useContext, useEffect, useState } from 'react';

const ToastCtx = createContext(null);

export function ToastProvider({ children }) {
  const [t, setT] = useState(null);

  const show = useCallback((message, opts = {}) => {
    const tone = opts.tone || 'info'; // 'success' | 'warn' | 'danger' | 'info'
    const ttl = opts.ttl ?? 4500;
    setT({ message, tone, id: Date.now() });
    if (ttl > 0) setTimeout(() => setT((cur) => (cur && cur.id ? null : cur)), ttl);
  }, []);

  return (
    <ToastCtx.Provider value={show}>
      {children}
      {t && (
        <div className={`toast toast-${t.tone}`} role="status" aria-live="polite">
          {t.message}
        </div>
      )}
    </ToastCtx.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastCtx);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
}
