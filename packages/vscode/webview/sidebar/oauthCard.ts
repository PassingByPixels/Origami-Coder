// oauthCard.ts — what a provider's settings fold offers about OAuth, as a
// pure rule. No DOM, no vscode import.
//
// Two invariants fix real failures:
//
// 1. Whether a provider CAN be signed into is a property of the catalog,
//    not of the `connected` map, which reads empty whenever the host could
//    not ask the engine. Gating the button on the catalog means it never
//    disappears at the moment the user needs it most.
// 2. A rotated/revoked refresh_token still leaves a well-formed `oauth`
//    entry on disk. The engine reports the provider's own refusal via
//    `needsReauth`, and this file turns that into the line and the label.

import { oauthEntryFor } from './providerIdentity';

/** One entry of `providerAuthData.connected` — types only, never a token. */
export interface OauthCredential {
  type: string;
  expires?: number;
  /** The provider's own words for why it refused to refresh this credential. */
  needsReauth?: string;
}

export interface OauthCardState {
  /** The catalog id whose sign-in form the action opens. '' = no OAuth entry. */
  entryId: string;
  /** Offer the sign-in action at all. Catalog-driven, so an empty/failed
   *  `connected` read can never take it away. */
  canAuthorize: boolean;
  /** An oauth credential is on file (working or refused). */
  signedIn: boolean;
  /** Non-empty when the provider refused the stored credential. */
  needsReauth: string;
  actionLabel: string;
  statusLabel: string;
  /** The explanatory line under the buttons. */
  hint: string;
}

/**
 * What the fold should offer for `providerId`.
 *
 * `live` is the host's own liveness probe, used only for the status word when
 * OAuth has nothing to say about this provider.
 */
export function oauthCardState(
  providerId: string,
  providerName: string,
  connected: Record<string, OauthCredential | undefined>,
  live = false,
): OauthCardState {
  const entryId = oauthEntryFor(providerId);
  const canAuthorize = entryId !== providerId;
  const cred = connected[providerId];
  const signedIn = cred?.type === 'oauth';
  const needsReauth = (signedIn && cred?.needsReauth) || '';
  return {
    entryId: canAuthorize ? entryId : '',
    canAuthorize,
    signedIn,
    needsReauth,
    actionLabel: signedIn ? 'Reauthorize…' : 'Sign in…',
    statusLabel: needsReauth ? 'Needs sign-in' : signedIn ? 'Signed in' : live ? 'Live' : 'Idle',
    hint: needsReauth
      ? // Say what the state IS before what to do: the stored credential is
        // kept, so "Reauthorize" is a replacement, not a recovery from a delete.
        `${providerName} refused your saved sign-in. Reauthorize to sign in again — the stored credential is kept until a new one replaces it. Re-key manages the separate API-key connection if you use one.`
      : signedIn
        ? `Signed in with your ${providerName} subscription. Reauthorize if sign-in has expired; Re-key manages the separate API-key connection if you use one. Pick a model in the chat pane.`
        : `${providerName} can connect two ways: an API key (Re-key) or a subscription sign-in (Sign in…). Pick a model in the chat pane.`,
  };
}

/** The browser flow every shipped OAuth plugin lists first. */
export const FALLBACK_SIGN_IN = { index: 0, label: 'Sign in with your browser' } as const;

/**
 * The sign-in buttons the OAuth form shows.
 *
 * Falls back to a browser sign-in button rather than an empty list: the
 * method list reads empty for reasons unrelated to the provider, and
 * index 0 is the browser flow in both shipped plugins.
 * `ProviderAuth.authorize` range-checks the index itself.
 */
export function signInOptions(
  methods: Array<{ index: number; label: string }> | undefined,
): Array<{ index: number; label: string }> {
  return methods && methods.length > 0 ? methods : [FALLBACK_SIGN_IN];
}
