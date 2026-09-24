// artifactAutoOpen.ts — the FIRST version of a new artifact opens itself,
// once, in the chat that made it (t-s49986). Later versions do not: they only
// move the list and the badge, which the ordinary refresh already does.
//
// Why each condition is here:
//   * `kind === 'published'` and `version === 1` — that is what "a new artifact"
//     is on the wire. A restore is also a new version, but of an artifact the
//     owner has already seen, so it never opens itself.
//   * `ownsSession(sessionID)` — every window on this machine hears every
//     change (the engine does not filter the push), and several chats in ONE
//     window hear it too. Only the chat whose tool call published it opens it.
//     A push with no sessionID came from something other than a tool call, so
//     nothing is opened.
//   * the `opened` set — a retried tool call replays its first result and
//     emits the same change again. One artifact opens at most once per
//     session, whatever the engine sends.
//
// No setting, on purpose: the owner asked for it, and the guard is what keeps
// it from being noisy.

import { handleArtifactsPaneMessage, type ArtifactsPaneHost } from './artifactsPane';
import type { ArtifactsChangedPush } from './artifactAcp';

/** `${sessionID} ${artifactId}` pairs already auto-opened in this window. */
const opened = new Set<string>();

/** Test seam — a fresh window has opened nothing. */
export function resetArtifactAutoOpen(): void {
  opened.clear();
}

/** The whole decision, pure except for the guard it records into. */
export function claimAutoOpen(push: ArtifactsChangedPush, ownsSession: (sessionID: string) => boolean): boolean {
  if (push.kind !== 'published' || push.version !== 1) return false;
  if (!push.artifactId || !push.sessionID || !ownsSession(push.sessionID)) return false;
  const key = `${push.sessionID} ${push.artifactId}`;
  if (opened.has(key)) return false;
  opened.add(key);
  return true;
}

/** Open it the SAME way the pane's Open does: `artifact_open` for the live
 *  url, then the integrated browser, reusing a tab that is already there. */
export async function autoOpenArtifact(
  host: ArtifactsPaneHost,
  push: ArtifactsChangedPush,
  ownsSession: (sessionID: string) => boolean,
): Promise<boolean> {
  if (!claimAutoOpen(push, ownsSession)) return false;
  await handleArtifactsPaneMessage(host, { type: 'artifactOpen', artifactId: push.artifactId, version: 1 });
  return true;
}
