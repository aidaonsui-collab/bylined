// Privacy Policy — placeholder content. Replace with reviewed legal
// copy before public launch; this exists so the SignUp link resolves
// and the shape is in place.

import DocLayout from '../components/DocLayout.jsx';

const H = ({ children }) => (
  <h2 style={{ fontSize: 17, fontWeight: 600, color: 'var(--fg)', margin: '28px 0 8px' }}>
    {children}
  </h2>
);

export default function Privacy() {
  return (
    <DocLayout eyebrow="Legal" title="Privacy Policy">
      <p style={{ color: 'var(--fg-subtle)', fontSize: 13 }}>
        Last updated: May 2026 · Placeholder — pending legal review.
      </p>

      <H>What we collect</H>
      <p>
        Account data (name, email), billing data (handled by Stripe — we never
        see full card numbers), the CMS credentials you connect, the keywords
        and voices you submit, the articles we generate, and operational
        metadata like job status and per-article cost events.
      </p>

      <H>How we use it</H>
      <p>
        To operate the service: generate and verify articles, publish to your
        connected sites, enforce plan quotas, and bill you. We use
        sub-processors for LLM inference, search, hosting, and payments. We
        don't sell your data.
      </p>

      <H>CMS credentials</H>
      <p>
        Credentials for connected sites (WordPress application passwords,
        Webflow API tokens) are stored to publish on your behalf and are only
        ever transmitted server-side to the relevant CMS. They're never exposed
        to the browser after you save them.
      </p>

      <H>Data retention</H>
      <p>
        We retain account and article data for as long as your account is
        active. Delete a voice, site, or your account and the associated rows
        are removed; articles already published to your CMS are unaffected.
      </p>

      <H>Your rights</H>
      <p>
        You can access, correct, export, or delete your data. For account
        deletion or a data export, email{' '}
        <a href="mailto:hi@getbylined.com">hi@getbylined.com</a>.
      </p>

      <H>Contact</H>
      <p>
        Privacy questions: <a href="mailto:hi@getbylined.com">hi@getbylined.com</a>.
      </p>
    </DocLayout>
  );
}
