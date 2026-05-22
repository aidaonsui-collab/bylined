// Bylined marketing — interaction layer.
// Static HTML, vanilla JS. No bundler, no framework.

(function () {
  'use strict';

  // ─── App-origin rewriter ───────────────────────────────────────────
  // The marketing site and the React app are deployed separately — they
  // live on different origins. Every /sign-up, /sign-in, /app/*,
  // /auth/* link in this HTML has to be rewritten to the app's host.
  //
  // Dev:  marketing :5188, app Vite :5189.
  // Prod: marketing on one *.vercel.app, app on another (or a future
  //       app.getbylined.com once a domain is wired).
  //
  // BYLINED_APP_ORIGIN can be set inline on the page (e.g. a per-env
  // <script> baked into index.html) to override either default.
  const APP_ORIGIN_DEV = 'http://localhost:5189';
  const APP_ORIGIN_PROD = 'https://app.getbylined.com';
  (() => {
    const host = location.hostname;
    const onDevPort = location.port === '5188' || location.port === '5187';
    const onDevHost = host === 'localhost' || host === '127.0.0.1';
    const origin =
      window.BYLINED_APP_ORIGIN
      ?? (onDevHost && onDevPort ? APP_ORIGIN_DEV : null)
      ?? (onDevHost ? null : APP_ORIGIN_PROD);
    if (!origin) return;
    // Anything that should hop to the React app: auth flows + /app/*.
    const isAppPath = (href) =>
      /^\/(sign-up|sign-in|forgot-password|auth\/|app\/|app\b)/.test(href);
    document.querySelectorAll('a[href]').forEach((a) => {
      const href = a.getAttribute('href');
      if (href && isAppPath(href)) {
        a.setAttribute('href', origin + href);
      }
    });
  })();

// ─── Mobile nav: hamburger toggle ───────────────────────────────────
  (() => {
    const burger = document.querySelector('[data-mkt-burger]');
    const panel = document.querySelector('[data-mkt-panel]');
    if (!burger || !panel) return;

    const setOpen = (open) => {
      burger.classList.toggle('is-open', open);
      burger.setAttribute('aria-expanded', open ? 'true' : 'false');
      burger.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
      panel.classList.toggle('is-open', open);
      panel.hidden = !open;
      document.body.style.overflow = open ? 'hidden' : '';
    };

    burger.addEventListener('click', () => {
      setOpen(!panel.classList.contains('is-open'));
    });
    panel.querySelectorAll('a').forEach((a) =>
      a.addEventListener('click', () => setOpen(false)),
    );
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && panel.classList.contains('is-open')) setOpen(false);
    });
  })();

// ─── Hero demo: cite/receipt hover + pin + connecting line ─────────
  const demo = document.getElementById('hero-demo');
  if (demo) {
    const body = demo.querySelector('.hero-demo-body');
    const cites = Array.from(demo.querySelectorAll('.cite[data-cite-id]'));
    const receipts = Array.from(demo.querySelectorAll('.receipt[data-receipt-id]'));
    const svg = demo.querySelector('.hero-line-svg');

    let active = null;
    let pinned = 2; // pre-pinned to draw the eye on first paint
    let userInteracted = false; // pause auto-cycle once they touch it

    // Trigger the staggered intro animation when the demo enters the viewport.
    // Done via class toggle so the animation can replay if the demo re-enters.
    if ('IntersectionObserver' in window) {
      const io = new IntersectionObserver((entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) {
            demo.classList.add('is-revealing');
            io.disconnect();
          }
        });
      }, { threshold: 0.2 });
      io.observe(demo);
    } else {
      demo.classList.add('is-revealing');
    }

    function flash(id) {
      const cite = cites.find((c) => parseInt(c.dataset.citeId, 10) === id);
      const receipt = receipts.find((r) => parseInt(r.dataset.receiptId, 10) === id);
      if (cite) {
        cite.classList.remove('is-flashing');
        void cite.offsetWidth; // restart animation
        cite.classList.add('is-flashing');
        setTimeout(() => cite.classList.remove('is-flashing'), 800);
      }
      if (receipt) {
        receipt.classList.remove('is-flashing');
        void receipt.offsetWidth;
        receipt.classList.add('is-flashing');
        setTimeout(() => receipt.classList.remove('is-flashing'), 800);
      }
    }

    function setStateFor(id, classes) {
      cites.forEach((el) => {
        const i = parseInt(el.dataset.citeId, 10);
        el.classList.toggle('is-active', classes.active === i);
        el.classList.toggle('is-pinned', classes.pinned === i);
      });
      receipts.forEach((el) => {
        const i = parseInt(el.dataset.receiptId, 10);
        el.classList.toggle('is-active', classes.active === i);
        el.classList.toggle('is-pinned', classes.pinned === i);
      });
    }

    function drawLine(id) {
      if (!svg) return;
      while (svg.firstChild) svg.removeChild(svg.firstChild);
      if (!id) return;
      const cite = cites.find((c) => parseInt(c.dataset.citeId, 10) === id);
      const receipt = receipts.find((r) => parseInt(r.dataset.receiptId, 10) === id);
      if (!cite || !receipt) return;
      const c = body.getBoundingClientRect();
      const f = cite.getBoundingClientRect();
      const t = receipt.getBoundingClientRect();
      const x1 = f.right - c.left;
      const y1 = f.top + f.height / 2 - c.top;
      const x2 = t.left - c.left;
      const y2 = t.top + t.height / 2 - c.top;
      const cx = (x1 + x2) / 2;

      const ns = 'http://www.w3.org/2000/svg';
      const path = document.createElementNS(ns, 'path');
      path.setAttribute('class', 'cite-line');
      path.setAttribute('d', `M ${x1} ${y1} C ${cx} ${y1}, ${cx} ${y2}, ${x2} ${y2}`);
      svg.appendChild(path);

      const dotA = document.createElementNS(ns, 'circle');
      dotA.setAttribute('cx', x1);
      dotA.setAttribute('cy', y1);
      dotA.setAttribute('r', 3);
      dotA.setAttribute('fill', 'var(--accent)');
      svg.appendChild(dotA);

      const dotB = document.createElementNS(ns, 'circle');
      dotB.setAttribute('cx', x2);
      dotB.setAttribute('cy', y2);
      dotB.setAttribute('r', 3);
      dotB.setAttribute('fill', 'var(--accent)');
      svg.appendChild(dotB);
    }

    function render() {
      const showId = active ?? pinned;
      setStateFor(showId, { active, pinned });
      drawLine(showId);
    }

    function onHover(id) { active = id; render(); }
    function onLeave() { active = null; render(); }
    function onPin(id) {
      userInteracted = true;
      pinned = pinned === id ? null : id;
      render();
    }

    cites.forEach((el) => {
      const id = parseInt(el.dataset.citeId, 10);
      el.addEventListener('mouseenter', () => onHover(id));
      el.addEventListener('mouseleave', onLeave);
      el.addEventListener('click', (e) => { e.preventDefault(); onPin(id); });
    });
    receipts.forEach((el) => {
      const id = parseInt(el.dataset.receiptId, 10);
      el.addEventListener('mouseenter', () => onHover(id));
      el.addEventListener('mouseleave', onLeave);
      el.addEventListener('click', () => onPin(id));
    });

    // Auto-cycle the pinned receipt to draw the eye.
    const cycle = [2, 3, 1];
    let idx = 0;
    // Delay the first cycle until intro animation finishes (~1.8s).
    setTimeout(() => {
      flash(pinned);
      setInterval(() => {
        if (userInteracted) return;
        idx = (idx + 1) % cycle.length;
        pinned = cycle[idx];
        render();
        flash(pinned);
      }, 3200);
    }, 2000);

    window.addEventListener('resize', render);
    window.addEventListener('scroll', render, { passive: true });

    render();
  }

  // ─── Cursor-following spotlight on premium cards ──────────────────
  // Updates two CSS custom properties on each card so the radial-gradient
  // pseudo-element tracks the cursor. Pure DOM listener, no rAF — the
  // browser coalesces mousemove naturally.
  const spotlightCards = document.querySelectorAll('.pr-card, .truth, .stage, .quote-card');
  spotlightCards.forEach((card) => {
    card.addEventListener('mousemove', (e) => {
      const rect = card.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / rect.width) * 100;
      const y = ((e.clientY - rect.top) / rect.height) * 100;
      card.style.setProperty('--spotlight-x', `${x}%`);
      card.style.setProperty('--spotlight-y', `${y}%`);
    });
  });

  // ─── Pricing page: monthly / yearly toggle ──────────────────────────
  const ppToggle = document.querySelector('.pp-toggle');
  if (ppToggle) {
    const buttons = Array.from(ppToggle.querySelectorAll('button[data-period]'));
    const priceEls = Array.from(document.querySelectorAll('[data-monthly]'));
    const perEls = Array.from(document.querySelectorAll('[data-per]'));

    function setPeriod(p) {
      buttons.forEach((b) => b.classList.toggle('is-on', b.dataset.period === p));
      priceEls.forEach((el) => {
        const m = parseFloat(el.dataset.monthly);
        const v = p === 'yearly' ? Math.round(m * 0.8) : m;
        el.textContent = '$' + v;
      });
      perEls.forEach((el) => {
        el.textContent = p === 'yearly' ? '/mo, billed yearly' : '/month';
      });
    }
    buttons.forEach((b) => b.addEventListener('click', () => setPeriod(b.dataset.period)));
    setPeriod('monthly');
  }

  // ─── Live demo hook ────────────────────────────────────────────────
  // Two-phase flow off one URL input:
  //   1. audit   — "does AI recommend you?" — fast, shows the gap.
  //   2. article — "here's the article that fixes it" — the full
  //                generate() pipeline, triggered by the audit's CTA.
  // Both go through request-demo / demo-status; the worker branches on
  // `kind`. See supabase/functions/{request-demo,demo-status} and
  // engine/src/{audit,demo}.ts.
  const demoForm = document.getElementById('demo-form');
  if (demoForm) {
    const SUPABASE_FN = 'https://boatyhrefcilcxepnbbf.supabase.co/functions/v1';
    // Anon publishable key — public by design; the gateway wants it even
    // for verify_jwt=false functions.
    const ANON_KEY = 'sb_publishable_bpV29JM65vrJI1pgUVlKdg_5ZDisV3Y';
    const POLL_MS = 2500;

    // Admin bypass: if the visitor lands with ?admin=<token> in the URL,
    // capture it and persist for this tab only (sessionStorage so it
    // doesn't survive a tab close — keeps the surface small if someone
    // borrows the laptop). Then strip the param from the visible URL so
    // it doesn't sit in history/referrers/screenshots. The token rides
    // along in the request-demo body and is checked against the
    // ADMIN_DEMO_TOKEN env var on the function. Used to demo Bylined
    // live to multiple people without hitting the per-IP cap.
    const urlParams = new URLSearchParams(window.location.search);
    const incomingAdmin = urlParams.get('admin');
    if (incomingAdmin) {
      try { sessionStorage.setItem('bylined_admin_token', incomingAdmin); } catch {}
      urlParams.delete('admin');
      const cleanQs = urlParams.toString();
      const cleanUrl =
        window.location.pathname + (cleanQs ? '?' + cleanQs : '') + window.location.hash;
      window.history.replaceState({}, '', cleanUrl);
    }
    function getAdminToken() {
      try { return sessionStorage.getItem('bylined_admin_token') || null; } catch { return null; }
    }
    const POLL_TIMEOUT_MS = 240000; // give up after 4 min

    // App origin for the post-demo CTAs — same rule as the page-load
    // rewriter above; APP_ORIGIN_PROD is the placeholder to fill in
    // after the first prod app deploy.
    const _host = location.hostname;
    const _onDevPort = location.port === '5188' || location.port === '5187';
    const _onDevHost = _host === 'localhost' || _host === '127.0.0.1';
    const appOrigin = (() => {
      if (window.BYLINED_APP_ORIGIN) return window.BYLINED_APP_ORIGIN;
      if (_onDevHost && _onDevPort) return APP_ORIGIN_DEV;
      if (_onDevHost) return ''; // dev on some other port — leave links relative
      return APP_ORIGIN_PROD;
    })();

    const urlInput = document.getElementById('demo-url');
    const submitBtn = document.getElementById('demo-submit');
    const livePanel = document.getElementById('demo-live');

    const esc = (s) =>
      String(s ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
      }[c]));

    let pollTimer = null;
    let pollStartedAt = 0;
    let currentUrl = ''; // kept so the audit's "fix it" CTA can re-request
    let lastAudit = null; // the audit result, kept across the phase-2 re-render

    function panel(headLabel, dotClass, bodyHtml) {
      livePanel.hidden = false;
      livePanel.innerHTML =
        '<div class="demo-live-head">' +
        '<span class="demo-live-dot ' + dotClass + '"></span>' +
        '<span>' + esc(headLabel) + '</span>' +
        '</div>' +
        '<div class="demo-live-body">' + bodyHtml + '</div>';
    }

    // Compact strip that keeps the audit's finding visible once we move
    // to the article phase — without it, clicking "fix it" wipes the
    // problem and you lose the before/after punch. '' if no audit ran.
    function auditSummaryBanner() {
      if (!lastAudit) return '';
      const a = lastAudit;
      const total = a.total_runs || 0;
      const named = a.mention_count || 0;
      const compCount = (a.competitors || []).length;
      return (
        '<div class="demo-audit-banner">' +
          '<span class="demo-audit-banner-text">' +
            '<strong>AI visibility check:</strong> ' + esc(a.brand_name) +
            ' named in <strong>' + named + ' of ' + total + '</strong> AI answers' +
            (compCount
              ? ' · <strong>' + compCount + '</strong> competitor' +
                (compCount === 1 ? '' : 's') + ' named instead'
              : '') +
          '</span>' +
          '<span class="demo-audit-banner-tag">the fix ↓</span>' +
        '</div>'
      );
    }

    function showRunning(kind, progressText, keyword) {
      const head =
        kind === 'audit' ? 'Checking your AI visibility' : 'Watching Bylined work';
      panel(
        head,
        '',
        (kind === 'article' ? auditSummaryBanner() : '') +
        '<div class="demo-progress">' +
          '<span class="demo-spinner"></span>' +
          '<span>' + esc(progressText || 'Starting…') + '</span>' +
        '</div>' +
        (keyword && kind !== 'audit'
          ? '<div class="demo-progress-sub">Topic picked for your site: <strong>' +
            esc(keyword) + '</strong></div>'
          : '')
      );
    }

    function showError(message) {
      panel(
        'Demo',
        'is-error',
        '<div class="demo-error">' + esc(message) +
          '</div><div class="demo-result-cta" style="margin-top:14px">' +
          '<a class="btn btn-primary" href="' + appOrigin + '/sign-up">' +
          'Start free instead</a></div>'
      );
    }

    // ── Audit result — the "gap" half ──────────────────────────────
    function showAuditResult(r) {
      lastAudit = r; // preserved so the article phase can keep it in view
      const total = r.total_runs || 0;
      const named = r.mention_count || 0;
      const gap = named === 0;
      const headlineClass = gap ? 'is-gap' : '';

      const competitors = (r.competitors || [])
        .slice(0, 6)
        .map(
          (c) =>
            '<span class="demo-comp-chip">' + esc(c.name) +
            ' <b>&times;' + (c.count || 0) + '</b></span>'
        )
        .join('');

      const ts = r.transcript_sample || {};
      const transcript = ts.question
        ? '<div class="demo-transcript">' +
            '<div class="demo-transcript-q">We asked an AI: <em>&ldquo;' +
            esc(ts.question) + '&rdquo;</em></div>' +
            '<div class="demo-transcript-a">' + esc(ts.answer) + '</div>' +
            '<div class="demo-transcript-verdict ' +
            (ts.brand_mentioned ? 'is-named' : 'is-missing') + '">' +
            (ts.brand_mentioned
              ? '✓ ' + esc(r.brand_name) + ' was named'
              : '✗ ' + esc(r.brand_name) + ' was not named') +
            '</div>' +
          '</div>'
        : '';

      panel(
        'Your AI visibility — checked',
        'is-done',
        (r.category
          ? '<div class="demo-result-kw">' + esc(r.brand_name) + ' · ' +
            esc(r.category) + '</div>'
          : '') +
          '<div class="demo-audit-headline ' + headlineClass + '">' +
            esc(r.brand_name) + ' was named in <b>' + named + ' of ' + total +
            '</b> AI answers' +
          '</div>' +
          '<div class="demo-audit-sub">' +
            (gap
              ? 'We asked an AI ' + (total / 3 | 0) +
                ' questions your customers would ask — three times each. ' +
                'You didn’t come up. Here’s who did.'
              : 'We asked an AI the questions your customers ask. You came up ' +
                'some of the time — but there’s room to own the answer.') +
          '</div>' +
          (competitors
            ? '<div class="demo-receipts-h">Named instead of you</div>' +
              '<div class="demo-comp-chips">' + competitors + '</div>'
            : '') +
          transcript +
          '<div class="demo-result-cta">' +
            '<button type="button" class="btn btn-primary btn-lg" ' +
            'data-demo-action="fix-it">' +
            'Watch Bylined write the article that fixes this ' +
            '<svg class="icon"><use href="#i-arrow-right"/></svg></button>' +
            '<span class="demo-cta-note">A sourced, verified article on exactly ' +
            'this topic — the kind AI engines cite.</span>' +
          '</div>'
      );
    }

    // ── Article result — the "fix" half ────────────────────────────
    function showArticleResult(r) {
      const pct = Math.round((r.pass_rate || 0) * 100);
      const receipts = (r.receipts || [])
        .map(
          (rc) =>
            '<div class="demo-receipt">' +
            '<div class="demo-receipt-q">&ldquo;' + esc(rc.passage) + '&rdquo;</div>' +
            '<div class="demo-receipt-src">' + esc(rc.source_url) + '</div>' +
            '</div>'
        )
        .join('');

      panel(
        'Your article — written, sourced, verified',
        'is-done',
        auditSummaryBanner() +
          (r.keyword ? '<div class="demo-result-kw">Topic: ' + esc(r.keyword) + '</div>' : '') +
          '<h3 class="demo-result-title">' + esc(r.title) + '</h3>' +
          '<div class="demo-result-excerpt">' + esc(r.body_excerpt) +
          '…</div><div class="demo-result-fade"></div>' +
          '<div class="demo-stat-row">' +
            '<div class="demo-stat"><b>' + (r.body_chars ? r.body_chars.toLocaleString() : '—') +
            '</b><span>characters written</span></div>' +
            '<div class="demo-stat"><b>' + (r.receipts_verified ?? 0) + '/' +
            (r.receipts_total ?? 0) + '</b><span>claims verified</span></div>' +
            '<div class="demo-stat"><b>' + pct + '%</b><span>citation pass rate</span></div>' +
          '</div>' +
          (receipts
            ? '<div class="demo-receipts-h">Source receipts</div>' + receipts
            : '') +
          '<div class="demo-result-cta">' +
            '<a class="btn btn-primary btn-lg" href="' + appOrigin + '/sign-up">' +
            'Sign up free to publish this <svg class="icon"><use href="#i-arrow-right"/></svg></a>' +
            '<span class="demo-cta-note">Your draft is ready — publishing to your CMS takes one click.</span>' +
          '</div>'
      );
    }

    function stopPolling() {
      if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    }

    async function poll(demoId, kind) {
      if (Date.now() - pollStartedAt > POLL_TIMEOUT_MS) {
        showError(
          'This is taking longer than usual — the worker may be busy. ' +
          'Sign up free and your first article runs on a priority queue.'
        );
        stopPolling();
        return;
      }
      try {
        const res = await fetch(SUPABASE_FN + '/demo-status', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', apikey: ANON_KEY },
          body: JSON.stringify({ demo_id: demoId }),
        });
        const data = await res.json();
        if (!res.ok || !data.ok) {
          showError(data.error || 'Lost track of the run. Try again.');
          stopPolling();
          return;
        }
        if (data.status === 'completed' && data.result) {
          // Branch on what actually came back, not what we think we asked.
          if (data.result.kind === 'audit') showAuditResult(data.result);
          else showArticleResult(data.result);
          stopPolling();
          return;
        }
        if (data.status === 'failed') {
          showError(
            (data.error || 'The run hit an error.') +
              ' Try a different page, or start free.'
          );
          stopPolling();
          return;
        }
        // queued | running — keep the panel alive.
        showRunning(kind, data.progress, data.keyword);
        pollTimer = setTimeout(() => poll(demoId, kind), POLL_MS);
      } catch (e) {
        showError('Network hiccup talking to Bylined. Try again in a moment.');
        stopPolling();
      }
    }

    // Kick off either phase. `kind` is 'audit' or 'article'.
    async function requestDemo(url, kind) {
      stopPolling();
      showRunning(
        kind,
        kind === 'audit'
          ? 'Sending your site to Bylined…'
          : 'Queuing your article…'
      );
      try {
        const adminToken = getAdminToken();
        const res = await fetch(SUPABASE_FN + '/request-demo', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', apikey: ANON_KEY },
          body: JSON.stringify({
            url,
            kind,
            ...(adminToken ? { admin_token: adminToken } : {}),
          }),
        });
        const data = await res.json();
        if (!res.ok || !data.ok) {
          showError(data.error || 'Could not start the run. Try again.');
          return;
        }
        pollStartedAt = Date.now();
        showRunning(
          kind,
          kind === 'audit'
            ? 'Queued — about to read your site…'
            : 'Queued — Bylined is about to research your article…'
        );
        poll(data.demo_id, kind);
      } catch (e) {
        showError('Network hiccup reaching Bylined. Try again in a moment.');
      }
    }

    // Phase 1: the hero form runs the audit.
    demoForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const raw = (urlInput.value || '').trim();
      if (!raw) {
        urlInput.focus();
        return;
      }
      currentUrl = /^https?:\/\//i.test(raw) ? raw : 'https://' + raw;

      submitBtn.disabled = true;
      const submitLabel = submitBtn.innerHTML;
      submitBtn.textContent = 'Checking…';
      try {
        await requestDemo(currentUrl, 'audit');
      } finally {
        submitBtn.disabled = false;
        submitBtn.innerHTML = submitLabel;
      }
    });

    // Phase 2: the audit result's CTA runs the full article generation
    // for the same site. Delegated so it survives the panel re-render.
    livePanel.addEventListener('click', (e) => {
      const trigger = e.target.closest('[data-demo-action="fix-it"]');
      if (!trigger || !currentUrl) return;
      requestDemo(currentUrl, 'article');
    });
  }

  // ─── Request-access form (request-access.html) ─────────────────────
  // Posts name / email / website / note to the request-access edge
  // function. On success the form is swapped for the confirmation block;
  // the founder alert email is fired server-side by a DB trigger.
  (() => {
    const form = document.getElementById('access-form');
    if (!form) return;

    const SUPABASE_FN = 'https://boatyhrefcilcxepnbbf.supabase.co/functions/v1';
    // Anon publishable key — public by design.
    const ANON_KEY = 'sb_publishable_bpV29JM65vrJI1pgUVlKdg_5ZDisV3Y';

    const submitBtn = document.getElementById('access-submit');
    const statusEl = document.getElementById('access-status');
    const done = document.getElementById('access-done');
    const f = {
      name: document.getElementById('access-name'),
      email: document.getElementById('access-email'),
      website: document.getElementById('access-website'),
      note: document.getElementById('access-note'),
      hp: document.getElementById('access-company-fax'),
    };

    const setStatus = (msg, ok) => {
      statusEl.textContent = msg || '';
      statusEl.classList.toggle('is-ok', Boolean(ok));
    };
    const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      setStatus('');
      [f.name, f.email, f.website].forEach((el) => el.classList.remove('is-invalid'));

      const name = f.name.value.trim();
      const email = f.email.value.trim();
      const website = f.website.value.trim();
      const note = f.note.value.trim();

      // Client-side checks mirror the edge function — fail fast, no round-trip.
      if (name.length < 2) {
        f.name.classList.add('is-invalid');
        f.name.focus();
        setStatus('Enter your name.');
        return;
      }
      if (!emailRe.test(email)) {
        f.email.classList.add('is-invalid');
        f.email.focus();
        setStatus('Enter a valid email address.');
        return;
      }
      if (!website) {
        f.website.classList.add('is-invalid');
        f.website.focus();
        setStatus('Enter your website.');
        return;
      }

      const label = submitBtn.innerHTML;
      submitBtn.disabled = true;
      submitBtn.textContent = 'Sending…';
      try {
        const res = await fetch(SUPABASE_FN + '/request-access', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', apikey: ANON_KEY },
          body: JSON.stringify({
            name,
            email,
            website,
            note,
            company_fax: f.hp ? f.hp.value : '',
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok) {
          setStatus(data.error || 'Could not send your request. Try again.');
          submitBtn.disabled = false;
          submitBtn.innerHTML = label;
          return;
        }
        // Success — swap the form for the confirmation.
        form.hidden = true;
        if (done) {
          done.hidden = false;
          done.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      } catch (err) {
        setStatus('Network hiccup. Try again in a moment.');
        submitBtn.disabled = false;
        submitBtn.innerHTML = label;
      }
    });
  })();
})();
