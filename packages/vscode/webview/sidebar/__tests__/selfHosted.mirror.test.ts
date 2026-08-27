// MIRROR DRIFT GUARD — the house rule from docs/WORKING_ON_ORIGAMI_CODER.md
// Part 5: "every mirror needs a test that reads BOTH files and asserts they
// still agree."
//
// The "is this a server the user runs?" predicate exists TWICE:
//
//   webview/sidebar/connectionSection.ts  isSelfHostedHost  (picker grouping)
//   src/dashboard/selfHosted.ts           isSelfHostedHost  (host-side kind +
//                                                            auto-pick gate)
//
// The duplication is forced — tsconfig.webview.json pins rootDir to webview/,
// so webview code cannot import a runtime value out of src/ (and a webview .ts
// leaf trips TS6059 on `import type` from src/ as well). What it must never
// become is a SILENT divergence: widen the tailnet range on one side only and
// the picker would file a Spark under "Local/Self Hosted" while the host still
// rendered it as a keyed cloud provider with the wrong fold — nothing would
// fail, and the mismatch would only surface as a confused bug report.
//
// This is a BEHAVIOURAL comparison, not a text diff: both implementations are
// run over the same table of hosts and must return the same answer for every
// one. That survives harmless refactors (a renamed local, a reordered clause)
// and catches the thing that matters — the two disagreeing about a real address.
//
// Importing the src/ copy is fine HERE: test files are excluded from
// tsconfig.webview.json's rootDir program, which is why the other cross-side
// tests (keyOnlyPresets.mirror.test.ts, setupProvider.test.ts) do the same.

import { describe, expect, it } from 'vitest';
import { isSelfHostedHost as webviewSide } from '../connectionSection';
import { isSelfHostedHost as hostSide, isSelfHostedBaseUrl } from '../../../src/dashboard/selfHosted';

// Every boundary that has bitten, plus the ordinary cases. Derived from the two
// implementations' actual ranges, not invented: RFC1918's three blocks with
// their edges, Tailscale's 100.64.0.0/10 with both ends and both near-misses,
// loopback's spellings, and public hosts that must never be read as private.
const HOSTS = [
  // loopback
  'localhost', 'foo.localhost', '127.0.0.1', '127.5.5.5', '127.255.255.255', '::1', '[::1]',
  // RFC1918 + edges
  '10.0.0.5', '10.255.255.255', '192.168.1.20', '192.169.1.20', '191.168.1.20',
  '172.15.0.5', '172.16.0.1', '172.20.0.5', '172.31.255.255', '172.32.0.5',
  // Tailscale CGNAT 100.64.0.0/10 + both near-misses
  '100.63.255.255', '100.64.0.0', '100.64.1.30', '100.64.1.20', '100.127.255.255', '100.128.0.0', '100.200.1.1',
  // public / not ours
  'example.com', 'api.anthropic.com', 'openrouter.ai', 'opencode.ai', '8.8.8.8', '1.1.1.1',
  // junk
  '', 'not a host', '999.999.999.999',
];

describe('isSelfHostedHost — the two copies agree on every host', () => {
  it.each(HOSTS)('%s', (host) => {
    expect(hostSide(host), `host-side and webview-side disagree on "${host}"`).toBe(webviewSide(host));
  });

  it('the table actually exercises BOTH answers (guards a vacuously-passing suite)', () => {
    // If a bug made both copies return a constant, every case above would still
    // "agree". Pin that the table spans true and false on both sides.
    expect(HOSTS.some(webviewSide)).toBe(true);
    expect(HOSTS.some((h) => !webviewSide(h))).toBe(true);
    expect(HOSTS.some(hostSide)).toBe(true);
    expect(HOSTS.some((h) => !hostSide(h))).toBe(true);
  });

  it('the ranges are the ones documented, not merely mutually consistent', () => {
    // Agreement is worthless if both drifted together, so pin the contract too.
    expect(hostSide('127.0.0.1')).toBe(true);
    expect(hostSide('100.64.0.0')).toBe(true);
    expect(hostSide('100.127.255.255')).toBe(true);
    expect(hostSide('100.63.255.255')).toBe(false);
    expect(hostSide('100.128.0.0')).toBe(false);
    expect(hostSide('172.16.0.1')).toBe(true);
    expect(hostSide('172.32.0.5')).toBe(false);
    expect(hostSide('api.anthropic.com')).toBe(false);
  });
});

describe('isSelfHostedBaseUrl — the URL wrapper the host side actually calls', () => {
  it('accepts the real preset URLs, scheme or not', () => {
    expect(isSelfHostedBaseUrl('http://127.0.0.1:1234/v1')).toBe(true);
    expect(isSelfHostedBaseUrl('http://100.64.1.10:8000/v1')).toBe(true);
    expect(isSelfHostedBaseUrl('100.64.1.30:8000')).toBe(true);
    expect(isSelfHostedBaseUrl('https://192.168.1.20:8443/v1')).toBe(true);
  });

  it('rejects remote endpoints, and never throws on junk', () => {
    expect(isSelfHostedBaseUrl('https://openrouter.ai/api/v1')).toBe(false);
    expect(isSelfHostedBaseUrl('https://x.example/v1')).toBe(false);
    expect(() => isSelfHostedBaseUrl('not a url at all ://')).not.toThrow();
    expect(isSelfHostedBaseUrl('not a url at all ://')).toBe(false);
  });

  it('an absent / blank / non-string URL is not self-hosted', () => {
    // The cautious answer: a malformed block must not take the local path.
    for (const v of [undefined, null, '', '   ', 42, {}]) expect(isSelfHostedBaseUrl(v)).toBe(false);
  });
});
