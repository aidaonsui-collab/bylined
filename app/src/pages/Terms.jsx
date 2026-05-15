// Terms of Service — placeholder content. Replace with reviewed legal
// copy before public launch; this exists so the SignUp link resolves
// and the shape is in place.

import DocLayout from '../components/DocLayout.jsx';

const H = ({ children }) => (
  <h2 style={{ fontSize: 17, fontWeight: 600, color: 'var(--fg)', margin: '28px 0 8px' }}>
    {children}
  </h2>
);

export default function Terms() {
  return (
    <DocLayout eyebrow="Legal" title="Terms of Service">
      <p style={{ color: 'var(--fg-subtle)', fontSize: 13 }}>
        Last updated: May 2026 · Placeholder — pending legal review.
      </p>

      <H>1. Acceptance</H>
      <p>
        By creating a Bylined account or using the service you agree to these
        terms. If you're using Bylined on behalf of an organization, you
        represent that you have authority to bind that organization.
      </p>

      <H>2. The service</H>
      <p>
        Bylined generates SEO articles, verifies the claims in them against
        their cited sources, and — when you connect a CMS — publishes them on
        your behalf. We don't guarantee search rankings, traffic, or any
        specific business outcome.
      </p>

      <H>3. Your content and sites</H>
      <p>
        You're responsible for the CMS credentials you connect and for what
        gets published to your sites. You retain ownership of articles
        generated for your account. You grant Bylined the limited right to
        process and store that content to operate the service.
      </p>

      <H>4. Acceptable use</H>
      <p>
        Don't use Bylined to generate content that is unlawful, infringing,
        deceptive, or that you don't have the right to publish. We may suspend
        accounts that abuse the service or its underlying providers.
      </p>

      <H>5. Billing</H>
      <p>
        Paid plans are billed monthly or yearly through Stripe. Article quotas
        reset each billing period and don't roll over. You can change or cancel
        your plan at any time from the billing portal; cancellation takes
        effect at the end of the current period.
      </p>

      <H>6. Disclaimers</H>
      <p>
        The service is provided "as is." While every published article ships
        with source receipts, automated verification is not a substitute for
        your own editorial review. Bylined is not liable for content you choose
        to publish.
      </p>

      <H>7. Changes</H>
      <p>
        We may update these terms. Material changes will be communicated to the
        email on your account. Continued use after a change constitutes
        acceptance.
      </p>

      <H>8. Contact</H>
      <p>
        Questions about these terms: <a href="mailto:hi@getbylined.com">hi@getbylined.com</a>.
      </p>
    </DocLayout>
  );
}
