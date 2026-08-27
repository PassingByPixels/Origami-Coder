// "Is this base URL a server the USER runs?" — loopback, private LAN (RFC1918),
// or a Tailscale CGNAT address. A pure predicate, no I/O, its own leaf so the
// three host-side callers can share one rule instead of three near-copies:
//
//   - setupProvider.ts   — may I auto-pick the loaded model off this endpoint?
//   - DashboardPanel.ts  — inferKind: does this block render the local fold?
//   - (indirectly) every probe that now threads an optional apiKey.
//
// MIRRORS webview/sidebar/connectionSection.ts's isSelfHostedHost, which answers
// the same question for the Add-Connections picker's grouping. The duplication is
// forced, not sloppy: tsconfig.webview.json pins rootDir to webview/, so the
// webview cannot import a runtime value out of src/. Per the repo's mirror rule
// (docs/WORKING_ON_ORIGAMI_CODER.md Part 5) the copy is guarded —
// selfHosted.mirror.test.ts parses BOTH files and fails if the ranges drift.
//
// WHY THIS EXISTS AT ALL, given firstFold.ts already has isLoopbackBaseUrl:
// they answer DIFFERENT questions and must not be collapsed. isLoopbackBaseUrl
// asks "is this server on THIS machine?", which is a CAPABILITY question — only
// then can the `lms` / Ollama CLIs drive it, so detectLocalProvider and
// detectLocalFlavor keep using it and a tailnet vLLM must keep answering false
// there. This asks "is this the user's own infrastructure?", which is a TRUST /
// grouping question, and a tailnet vLLM answers true. Deriving one from the
// other is what made vLLM's model-picker tab disagree with its own picker
// section before round 5.

/** Loopback: this machine, by any of its spellings. */
function isLoopbackHost(host: string): boolean {
  if (host === 'localhost' || host === '::1' || host === '[::1]') return true;
  if (host.endsWith('.localhost')) return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/** Private LAN (RFC1918) + Tailscale's CGNAT range (100.64.0.0/10 — every
 *  tailnet address, including the DGX Sparks, falls in here). */
function isPrivateOrTailnetHost(host: string): boolean {
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

/** The union, on a bare hostname. */
export function isSelfHostedHost(host: string): boolean {
  const h = host.toLowerCase();
  return isLoopbackHost(h) || isPrivateOrTailnetHost(h);
}

/** The union, on a base URL. Never throws: an unparseable or absent URL is
 *  simply not self-hosted, so a malformed config degrades to the cautious
 *  answer rather than taking the local path by accident. */
export function isSelfHostedBaseUrl(u: unknown): boolean {
  if (typeof u !== 'string' || !u.trim()) return false;
  const s = u.trim();
  try {
    // A bare "host:port" (no scheme) isn't a parseable URL on its own — default
    // to http:// so the host still resolves instead of throwing.
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `http://${s}`;
    return isSelfHostedHost(new URL(withScheme).hostname.replace(/^\[|\]$/g, ''));
  } catch {
    return false;
  }
}
