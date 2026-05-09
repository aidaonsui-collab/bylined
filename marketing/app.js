// Bylined marketing — interaction layer.
// Static HTML, vanilla JS. No bundler, no framework.

(function () {
  'use strict';

  // ─── Dev URL rewriter ──────────────────────────────────────────────
  // In production, marketing + app sit on the same host, so /sign-up,
  // /sign-in, /app/* all resolve cleanly. In dev they're on different
  // ports (marketing :5188, app Vite :5189) — Python's http.server has
  // no proxy, so plain anchors 404. We detect the dev host by port and
  // rewrite app-bound links to the Vite origin.
  //
  // Set window.BYLINED_APP_ORIGIN before this script loads to override
  // (e.g. for a staging environment).
  (() => {
    const onDevPort = location.port === '5188' || location.port === '5187';
    const origin = window.BYLINED_APP_ORIGIN
      ?? (onDevPort ? 'http://localhost:5189' : null);
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

  // ─── Dev review toolbar: theme + accent toggle ─────────────────────
  const root = document.documentElement;
  document.querySelectorAll('[data-theme]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const t = btn.dataset.theme;
      root.classList.toggle('light', t === 'light');
      document.querySelectorAll('[data-theme]').forEach((b) =>
        b.classList.toggle('is-on', b.dataset.theme === t)
      );
    });
  });
  document.querySelectorAll('[data-accent]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const a = btn.dataset.accent;
      root.classList.toggle('accent-teal', a === 'teal');
      document.querySelectorAll('[data-accent]').forEach((b) =>
        b.classList.toggle('is-on', b.dataset.accent === a)
      );
    });
  });

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
})();
