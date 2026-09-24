// modelBanner.ts — which connectivity banner a chat has earned, as a pure
// rule. `modelStatus.ok` is false in two different situations: the provider
// was probed and didn't answer (unreachable), or it hasn't been probed yet
// (a remote provider with no cache entry reports ok:false with the reason
// `Checking provider…`, and the same broadcast asks for a probe that settles
// within seconds). Case 2 wearing case 1's copy is a lie the user acts on:
// every Spark/vLLM chat opened telling people to restart a server that was
// fine. The rule lives here, testable with no DOM.

/** The reason string a not-yet-probed remote provider reports. Mirrored from
 *  DashboardPanel.sessionModelStatus rather than imported (webview .ts can't
 *  reach into src/); modelBanner.test.ts asserts the two literals still match. */
export const PROVIDER_PROBING = 'Checking provider…';

/** The reason a host with no configured connection at all reports, mirrored
 *  and guarded the same way. "No model" and "no connection" are different
 *  problems: "start LM Studio" names a product a fresh install never
 *  installed, and "unreachable" names a machine they don't own. */
export const NO_CONNECTIONS = 'No connections yet';

/**
 * `ok`      — a model answered; no banner at all.
 * `probing` — no verdict yet. Neutral: it states what is happening and asks
 *             for nothing, because there is nothing for the user to do.
 * `no-connections` — nothing is configured. Not a failure: setup has not
 *             happened yet, and the only useful thing to say is where to start.
 * `offline-local`  — the loopback LM Studio has no model.
 * `offline-remote` — a named remote provider was asked and did not answer.
 */
export type BannerState = 'ok' | 'probing' | 'no-connections' | 'offline-local' | 'offline-remote';

/** Which banner to draw. `probing` is checked before the local/remote split
 *  on purpose: "we have not asked yet" is never "it is unreachable" for
 *  either kind of provider. */
export function bannerState(
  online: boolean,
  reason: string,
  providerIsLocal: boolean,
): BannerState {
  if (online) return 'ok';
  // Before the local/remote split: `providerIsLocal` defaults true on the
  // wire, so without this the empty state would wear LM Studio's copy.
  if (reason.trim() === NO_CONNECTIONS) return 'no-connections';
  if (reason.trim() === PROVIDER_PROBING) return 'probing';
  return providerIsLocal ? 'offline-local' : 'offline-remote';
}

/** What the neutral state says. Names the provider being waited on when
 *  known, and falls back to the generic word rather than "Checking …" with a
 *  hole in it. */
export function probingText(providerLabel: string): string {
  const label = providerLabel.trim();
  return `Checking ${label || 'the provider'}…`;
}

/** The one sentence the no-connection state says wherever it's drawn, so the
 *  composer strip and model picker can't describe the same install
 *  differently. */
export const NO_CONNECTIONS_TEXT = 'No connections yet — add a provider';
