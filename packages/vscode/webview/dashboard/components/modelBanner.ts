// modelBanner.ts — WHICH connectivity banner a chat has earned, as a pure rule.
//
// THE BUG THIS EXISTS TO FIX. `modelStatus.ok` is false in two completely
// different situations, and the composer used to draw the SAME alarm for both:
//
//   1. The provider was probed and did not answer. That is "unreachable", and
//      telling the user to go check the server is correct.
//   2. The provider has NOT BEEN PROBED YET. A remote provider with no cache
//      entry reports ok:false with the reason `Checking provider…`
//      (DashboardPanel.sessionModelStatus), and the very same broadcast asks
//      for a probe, which settles and re-broadcasts within seconds.
//
// Case 2 wearing case 1's copy is a lie the user acts on: every Spark/vLLM chat
// opened with "check the server, then type a message to retry" for the first
// beat of its life, so people went and restarted a server that was fine.
//
// The rule is here, not inline in the banner, because it is the one thing about
// this surface that can be WRONG rather than ugly, and it has to be testable
// with no DOM. Mirrors modelGrouping.ts's split from ModelPicker.svelte.

/**
 * The reason string a NOT-YET-PROBED remote provider reports.
 *
 * MIRRORED from DashboardPanel.sessionModelStatus rather than imported:
 * tsconfig.webview.json pins rootDir to `webview/`, so a webview .ts cannot
 * reach into src/ (same convention collabPersonaSeed.ts and collabKinds.ts
 * follow). modelBanner.test.ts reads DashboardPanel.ts and asserts the two
 * literals still match, so the mirror cannot drift in silence.
 */
export const PROVIDER_PROBING = 'Checking provider…';

/**
 * `ok`      — a model answered; no banner at all.
 * `probing` — no verdict yet. Neutral: it states what is happening and asks
 *             for nothing, because there is nothing for the user to do.
 * `offline-local`  — the loopback LM Studio has no model.
 * `offline-remote` — a named remote provider was asked and did not answer.
 */
export type BannerState = 'ok' | 'probing' | 'offline-local' | 'offline-remote';

/**
 * Which banner to draw.
 *
 * `probing` is checked BEFORE the local/remote split on purpose: the sentinel
 * is only produced on the remote path today, but "we have not asked yet" is
 * never "it is unreachable" for either kind of provider, and a future local
 * probe reporting the same reason must not fall through to alarm copy.
 */
export function bannerState(
  online: boolean,
  reason: string,
  providerIsLocal: boolean,
): BannerState {
  if (online) return 'ok';
  if (reason.trim() === PROVIDER_PROBING) return 'probing';
  return providerIsLocal ? 'offline-local' : 'offline-remote';
}

/**
 * What the neutral state SAYS. Names the provider being waited on when one is
 * known, and falls back to the generic word rather than printing "Checking …"
 * with a hole in it — an unnamed provider is still an honest sentence.
 */
export function probingText(providerLabel: string): string {
  const label = providerLabel.trim();
  return `Checking ${label || 'the provider'}…`;
}
