// WordPress REST API client.
// Auth via Application Passwords — modern WP (5.6+) supports them natively
// and they're scoped per-application without exposing the user's main password.
//
// To create an Application Password in WordPress:
//   WP Admin → Users → Profile → Application Passwords → "Add New"
//   Name it (e.g. "Bylined") → Copy the generated 24-char string with spaces.
//
// The generated password format is "abcd efgh ijkl mnop qrst uvwx" — spaces
// are part of the password and must be preserved.

export interface WpSiteConfig {
  baseUrl: string; // e.g. "https://yoursite.com" — trailing slash OK
  username: string;
  appPassword: string;
}

export interface WpPostInput {
  title: string;
  content: string; // HTML
  excerpt?: string;
  slug?: string;
  status: "draft" | "publish" | "pending" | "private";
}

export interface WpPostResult {
  id: number;
  url: string; // public link
  status: string;
  edit_url: string; // wp-admin edit screen
}

function authHeader(cfg: WpSiteConfig): string {
  const creds = Buffer.from(`${cfg.username}:${cfg.appPassword}`).toString("base64");
  return `Basic ${creds}`;
}

function normalizeBase(url: string): string {
  return url.replace(/\/+$/, "");
}

interface WpPostResponse {
  id: number;
  link: string;
  status: string;
  guid?: { rendered: string };
}

export async function createPost(
  cfg: WpSiteConfig,
  input: WpPostInput
): Promise<WpPostResult> {
  const base = normalizeBase(cfg.baseUrl);
  const url = `${base}/wp-json/wp/v2/posts`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: authHeader(cfg),
      "Content-Type": "application/json",
      "User-Agent": "BylinedBot/0.1 (+https://bylined.so/bot)",
    },
    body: JSON.stringify({
      title: input.title,
      content: input.content,
      excerpt: input.excerpt ?? "",
      slug: input.slug,
      status: input.status,
    }),
  });

  if (!res.ok) {
    let detail = await res.text();
    try {
      // WP returns JSON errors with code/message; surface the message if present.
      const parsed = JSON.parse(detail);
      if (parsed.message) detail = parsed.message;
    } catch {
      /* fall through with raw text */
    }
    throw new Error(`WordPress ${res.status}: ${detail}`);
  }

  const data = (await res.json()) as WpPostResponse;
  return {
    id: data.id,
    url: data.link,
    status: data.status,
    edit_url: `${base}/wp-admin/post.php?post=${data.id}&action=edit`,
  };
}

export function configFromEnv(): WpSiteConfig {
  const baseUrl = process.env.WORDPRESS_URL;
  const username = process.env.WORDPRESS_USERNAME;
  const appPassword = process.env.WORDPRESS_APP_PASSWORD;
  if (!baseUrl || !username || !appPassword) {
    throw new Error(
      "WordPress credentials missing. Set WORDPRESS_URL, WORDPRESS_USERNAME, " +
        "and WORDPRESS_APP_PASSWORD in your .env (see .env.example)."
    );
  }
  return { baseUrl, username, appPassword };
}
