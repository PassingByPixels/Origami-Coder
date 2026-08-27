// Pure classification for the Add Connections picker: which of the three
// sections — Local/Self Hosted, Providers, Labs — a connection belongs in
// (plus a visible Other fallback), decided from its id and baseURL alone. No
// DOM, no network — mirrors the providerGrid.ts pattern: the DECISION lives
// here, unit-testable, and both the ADD flow's catalog grouping and a
// Re-key's "which section to reveal" reuse the same function, so a live
// configured provider (a real baseURL, possibly a custom/renamed id) is
// bucketed the same way a catalog template is.
//
// The baseURL's host is the ground truth when present (it's where the thing
// actually runs); id is the fallback for cloud providers that carry no
// baseURL at all (the SDK bakes it in). Nothing recognised falls to 'other'
// — never hidden, per t-kgt7wh.
//
// THE LOCAL/HOSTED MERGE. This file once split self-run servers two ways:
// 'local' for loopback, 'hosted' for a LAN/tailnet address. That split asked
// the user a question they do not have — LM Studio, Ollama, SGLang and a
// vLLM on the Spark are all "a server I run", and which NIC it answers on is
// not what someone is choosing between when they open the picker. The two
// are now ONE section, 'selfhosted', labelled "Local/Self Hosted".
//
// The loopback-vs-LAN distinction itself is NOT gone — it was load-bearing in
// exactly one place and stays there, on its own signal: only a server on THIS
// machine can be driven by the `lms` / Ollama CLIs, so
// DashboardPanel.detectLocalFlavor and firstFold.detectLocalProvider still
// gate on firstFold.isLoopbackBaseUrl. That is a CAPABILITY question. This
// file answers a GROUPING question. Keeping them separate is the point of the
// merge; re-deriving one from the other is what made vLLM's tab disagree with
// its own picker section before round 5.

export type ConnectionSection = 'selfhosted' | 'providers' | 'labs' | 'other';

export const SECTION_ORDER: ConnectionSection[] = ['selfhosted', 'providers', 'labs', 'other'];

export const SECTION_LABEL: Record<ConnectionSection, string> = {
  selfhosted: 'Local/Self Hosted',
  providers: 'Providers',
  labs: 'Labs',
  other: 'Other',
};

// Known aggregator domains/ids — one key, many models behind it.
//
// opencode.ai (t-o92558) joined this list in round 5. Round 4 shipped it as a
// DELIBERATE exception under Labs: by shape it is an aggregator — one key,
// many model families (Zen, Go) behind it, same as openrouter.ai — so the
// mechanical reading always put it here, but the owner asked for Labs anyway.
// The owner reversed that call in round 5: shape and decision now agree, so
// it buckets here like everything else, mechanically, with no override.
const AGGREGATOR_HOSTS = ['openrouter.ai', 'opencode.ai'];
const AGGREGATOR_IDS = ['openrouter', 'opencode', 'opencode-go'];

// Known first-party lab domains, and the ids their cloud catalog entries use
// when they carry no baseURL at all. Google/Gemini has no catalog entry yet
// (adding one is provider wire-up, out of scope for t-kgt7wh) but is listed
// explicitly as a Labs example in the ticket, so a hand-configured "google"
// block still buckets correctly rather than falling to Other.
const LAB_HOSTS = [
  'api.anthropic.com',
  'api.openai.com',
  'api.x.ai',
  'generativelanguage.googleapis.com',
];
const LAB_IDS = ['anthropic', 'openai', 'xai', 'google'];

function hostOf(baseURL: string | undefined): string | null {
  const s = (baseURL ?? '').trim();
  if (!s) return null;
  try {
    // A bare "host:port" (no scheme) isn't a parseable URL on its own —
    // default to http:// so the host still resolves instead of throwing.
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
  // `.localhost` is reserved to loopback by RFC 6761 — matched here so this
  // predicate agrees exactly with its src/dashboard/selfHosted.ts mirror
  // (which inherited the case from firstFold.ts's isLoopbackBaseUrl).
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

/** A host the USER runs the server on: loopback, private LAN, or a tailnet.
 *
 *  The union of the two halves above, named once so the grouping decision below
 *  and the host-side `kind` inference read the same rule. MIRRORED by
 *  src/dashboard/firstFold.ts's isSelfHostedBaseUrl — the webview cannot import
 *  a runtime value out of src/ (tsconfig.webview.json pins rootDir to webview/)
 *  — and selfHosted.mirror.test.ts reads both files and fails on drift. */
export function isSelfHostedHost(host: string): boolean {
  const h = host.toLowerCase();
  return isLoopback(h) || isPrivateOrTailnet(h);
}

/** Bucket a connection (a catalog template or a live configured provider)
 *  into Local/Self Hosted / Providers / Labs, falling back to the visible
 *  'other' when nothing matches.
 *
 *  ORDER IS LOAD-BEARING: the aggregator and lab host checks come BEFORE the
 *  self-hosted one so a public gateway can never be read as a private address,
 *  and after loopback so nothing shadows a local server. */
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
