// Pure classification for the Add Connections picker: which section —
// Local/Self Hosted, Providers, Labs, or Other — a connection belongs in,
// decided from its id and baseURL alone. No DOM, no network, so the Add
// flow's catalog grouping and a Re-key both reuse the same function.
//
// The baseURL's host is ground truth when present; id is the fallback for
// cloud providers with no baseURL. Self-run servers (LM Studio, Ollama,
// SGLang, a Spark vLLM) are one 'selfhosted' section; the loopback-vs-LAN
// distinction survives only where a capability depends on it (the `lms`/
// Ollama CLIs can drive only a server on this machine).

export type ConnectionSection = 'selfhosted' | 'providers' | 'labs' | 'other';

export const SECTION_ORDER: ConnectionSection[] = ['selfhosted', 'providers', 'labs', 'other'];

export const SECTION_LABEL: Record<ConnectionSection, string> = {
  selfhosted: 'Local/Self Hosted',
  providers: 'Providers',
  labs: 'Labs',
  other: 'Other',
};

// Known aggregator domains/ids — one key, many models behind it.
const AGGREGATOR_HOSTS = ['openrouter.ai', 'opencode.ai'];
// 'github-copilot' joins the same way: one subscription, several labs'
// model families, no baseURL of its own, so only the id can classify it.
const AGGREGATOR_IDS = ['openrouter', 'opencode', 'opencode-go', 'github-copilot'];

// Known first-party lab domains/ids. Google/Gemini has no catalog entry
// yet, but is listed so a hand-configured "google" block still buckets right.
const LAB_HOSTS = [
  'api.anthropic.com',
  'api.openai.com',
  'api.x.ai',
  'generativelanguage.googleapis.com',
];
// 'claude-code' is the user's own installed Claude Code CLI (no baseURL);
// it's Anthropic's harness, so it buckets with Anthropic. 'claude-subscription'
// (t-tijdof) is the same subscription, a different route — same bucket.
const LAB_IDS = ['anthropic', 'openai', 'xai', 'google', 'claude-code', 'claude-subscription'];

function hostOf(baseURL: string | undefined): string | null {
  const s = (baseURL ?? '').trim();
  if (!s) return null;
  try {
    // A bare "host:port" has no scheme, so default to http:// to resolve it.
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `http://${s}`;
    return new URL(withScheme).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function isKnownHost(host: string, known: string[]): boolean {
  return known.some((h) => host === h || host.endsWith(`.${h}`));
}

function isLoopback(host: string): boolean {
  if (host === 'localhost' || host === '::1' || host === '[::1]') return true;
  // `.localhost` is reserved to loopback by RFC 6761 — matched so this
  // predicate agrees with its src/dashboard/selfHosted.ts mirror.
  if (host.endsWith('.localhost')) return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

// Private LAN (RFC1918) + Tailscale's CGNAT range (100.64.0.0/10 — every
// tailnet address, including the DGX Sparks, falls in here).
function isPrivateOrTailnet(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

/** A host the user runs the server on: loopback, private LAN, or a
 *  tailnet. Mirrored by src/dashboard/firstFold.ts's isSelfHostedBaseUrl;
 *  selfHosted.mirror.test.ts fails on drift. */
export function isSelfHostedHost(host: string): boolean {
  const h = host.toLowerCase();
  return isLoopback(h) || isPrivateOrTailnet(h);
}

/** Bucket a connection into Local/Self Hosted / Providers / Labs, or
 *  'other'. Order is load-bearing: aggregator and lab checks come before
 *  self-hosted, so a public gateway is never read as a private address. */
export function classifySection(input: { id?: string; baseURL?: string }): ConnectionSection {
  const host = hostOf(input.baseURL);
  if (host) {
    if (isLoopback(host)) return 'selfhosted';
    if (isKnownHost(host, AGGREGATOR_HOSTS)) return 'providers';
    if (isKnownHost(host, LAB_HOSTS)) return 'labs';
    if (isPrivateOrTailnet(host)) return 'selfhosted';
    return 'other';
  }
  // No baseURL — a baked-catalog cloud entry. id is the only signal left.
  const id = (input.id ?? '').toLowerCase();
  if (AGGREGATOR_IDS.includes(id)) return 'providers';
  if (LAB_IDS.includes(id)) return 'labs';
  return 'other';
}
