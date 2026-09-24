// Is this base URL a server the user runs? Loopback, private LAN (RFC1918), or Tailscale CGNAT. A
// pure predicate shared by setupProvider.ts, DashboardPanel.ts and every probe that threads an
// apiKey.
// Mirrors webview/sidebar/connectionSection.ts's isSelfHostedHost — the webview cannot import
// runtime code from src/, so the copy is guarded by selfHosted.mirror.test.ts.
// Different question from firstFold.ts's isLoopbackBaseUrl (a CAPABILITY question — is this machine
// driveable by the local CLIs) — collapsing the two broke the vLLM model picker before.

/** Loopback: this machine, by any of its spellings. */
function isLoopbackHost(host: string): boolean {
  if (host === 'localhost' || host === '::1' || host === '[::1]') return true;
  if (host.endsWith('.localhost')) return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/** Private LAN (RFC1918) plus Tailscale's CGNAT range (100.64.0.0/10), which covers every tailnet
 *  address. */
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

/** The union, on a base URL. Never throws: an unparseable or absent URL degrades to "not
 *  self-hosted" rather than taking the local path by accident. */
export function isSelfHostedBaseUrl(u: unknown): boolean {
  if (typeof u !== 'string' || !u.trim()) return false;
  const s = u.trim();
  try {
    // A bare "host:port" isn't parseable on its own — default to http:// so it still resolves.
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `http://${s}`;
    return isSelfHostedHost(new URL(withScheme).hostname.replace(/^\[|\]$/g, ''));
  } catch {
    return false;
  }
}
