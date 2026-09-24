// Artifacts pane — host side, the seam flockMailbox.ts/skillsPane.ts use: the
// engine owns the artifacts, this only asks, forwards and opens a url.
//
// NOTHING here throws at the pane. The engine has no artifact_* handler yet, so
// the ordinary answer today is "method not found"; that arrives as an ERROR
// STRING beside an empty list, which is what the pane draws its empty state
// from. A pane that breaks because a method is missing would be the defect.
//
// The "unopened arrival" badge is counted here and not in the webview because
// the count has to survive the sidebar being rebuilt: a dock that recounts from
// its own DOM would show the badge again every reload.

import { ARTIFACT_METHODS } from './artifactAcp';
import { nestHub } from './nestHubWindow';

export const ARTIFACTS_PANE_MESSAGE_TYPES = new Set([
  'artifactsRequest',
  'artifactVersionsRequest',
  'artifactOpen',
  'artifactRestore',
  'artifactDiff',
  'artifactsOpened',
  // Round 3 (t-s9kc6o): rename, delete, "open chat about" and Show in Explorer.
  'artifactRename',
  'artifactDelete',
  'artifactOpenChatAbout',
  'artifactReveal',
]);

export interface ArtifactsPaneClient {
  extMethod(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export interface ArtifactsPaneHost {
  /** The active chat's engine connection. Absent = no live session. */
  client?: ArtifactsPaneClient;
  post(message: Record<string, unknown>): void;
  /** Opens a url in the integrated browser. Injected so a test can watch it;
   *  the real one is browserBridge's `open`, which goes through browserVsCode. */
  openUrl?(url: string): Promise<void> | void;
  /** Opens the OS file manager on a local path. Injected so a test can watch
   *  it; the real one runs `revealFileInOS`. The path never reaches the
   *  webview — it goes straight from the engine's answer to here. */
  revealPath?(path: string): Promise<void> | void;
  /** Opens a NEW, empty chat and answers with its local session id (or
   *  nothing, when the host could not make one) — the same seam
   *  sideQuestsPane.ts's `createChat` is, for "Open chat about". */
  createChat?(): Promise<string | undefined> | string | undefined;
  /** The nest's artifacts (t-sj39jx). Absent = this window's hub (nestHubWindow.ts). */
  nest?: NestArtifactSource;
}

/** What the pane needs from the nest (nestArtifacts.ts): its rows merged into the
 *  list, and a pull before an Open. Both are no-ops while Nests is off. */
export interface NestArtifactSource {
  merge(rows: Record<string, unknown>[]): Record<string, unknown>[];
  ensure(artifactId: string, version?: number): Promise<void>;
  /** Each version's `device` id as a name (nestOwnRows.ts). */
  nameVersions(versions: Record<string, unknown>[]): Record<string, unknown>[];
  /** t-vbj8xu: the desk the roster marks as the mother base; undefined with Nests off. */
  motherBase?(): { self: boolean; name: string } | undefined;
}
const nestOf = (host: ArtifactsPaneHost): NestArtifactSource => host.nest ?? nestHub.artifacts;

const NO_SESSION = 'Open a chat first — artifacts are read from a live engine connection.';

/** Artifacts opened in THIS window, so an arrival counted once is not counted
 *  again. Cleared by `artifactsOpened` (the pill was clicked: you saw them). */
const seen = new Set<string>();

/** Test seam only — module state that a suite must be able to put back. */
export function resetArtifactsSeen(): void {
  seen.clear();
}

function rows(result: Record<string, unknown>): Record<string, unknown>[] {
  const list = result['artifacts'];
  return Array.isArray(list) ? (list.filter((r) => r && typeof r === 'object') as Record<string, unknown>[]) : [];
}

/** Arrivals from another device that nobody has opened yet. */
export function unopenedCount(artifacts: Record<string, unknown>[]): number {
  return artifacts.filter((r) => r['unopened'] === true && !seen.has(String(r['id'] ?? ''))).length;
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** t-v47qh6: how long the list waits for the engine. An engine that never
 *  answers used to leave the pane with no reply at all, which reads as "No
 *  artifacts yet"; past this it gets a reason and the Refresh button. */
export const ARTIFACT_LIST_WAIT_MS = 15_000;

function answerWithin<T>(pending: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`The engine did not answer in ${ms / 1000} s. Press Refresh to ask again.`)), ms);
  });
  return Promise.race([pending, late]).finally(() => clearTimeout(timer));
}

/** One read, posted as the list AND as the badge — two consumers, one answer. */
async function refresh(host: ArtifactsPaneHost): Promise<void> {
  if (!host.client) {
    host.post({ type: 'artifactsData', artifacts: [], error: NO_SESSION });
    host.post({ type: 'artifactsBadge', count: 0 });
    return;
  }
  try {
    const result = await answerWithin(host.client.extMethod(ARTIFACT_METHODS.list, {}), ARTIFACT_LIST_WAIT_MS);
    const local = rows(result);
    const artifacts = nestOf(host).merge(local);
    // `homeDevice` is how the engine names THIS machine; the pane labels it "this
    // desk". Forwarded only when the engine names one: guessing it would put the
    // label on the wrong row. `motherBase` is the Nests role (t-vbj8xu).
    const home = typeof result['homeDevice'] === 'string' ? (result['homeDevice'] as string) : '';
    const base = nestOf(host).motherBase?.();
    host.post({ type: 'artifactsData', artifacts, ...(home ? { homeDevice: home } : {}), ...(base ? { motherBase: base } : {}) });
    host.post({ type: 'artifactsBadge', count: unopenedCount(artifacts) });
  } catch (e) {
    // An engine with no artifact_list answers exactly here. The pane shows the
    // empty state and says why; it does not show a broken pane.
    host.post({ type: 'artifactsData', artifacts: [], error: errorText(e) });
    host.post({ type: 'artifactsBadge', count: 0 });
  }
}

function str(m: Record<string, unknown>, key: string): string {
  return typeof m[key] === 'string' ? (m[key] as string).trim() : '';
}

function num(m: Record<string, unknown>, key: string): number | undefined {
  return typeof m[key] === 'number' ? (m[key] as number) : undefined;
}

async function versions(host: ArtifactsPaneHost, artifactId: string): Promise<void> {
  if (!host.client) {
    host.post({ type: 'artifactVersions', artifactId, versions: [], error: NO_SESSION });
    return;
  }
  try {
    const result = await host.client.extMethod(ARTIFACT_METHODS.versions, { artifactId });
    const list = result['versions'];
    // t-v7i2au: each version's device id becomes a name here, where the roster is.
    host.post({ type: 'artifactVersions', artifactId, versions: nestOf(host).nameVersions(Array.isArray(list) ? list.filter((v) => v && typeof v === 'object') : []) });
  } catch (e) {
    host.post({ type: 'artifactVersions', artifactId, versions: [], error: errorText(e) });
  }
}

/** artifact_open answers with a url; the url goes to the integrated browser.
 *  Opening also marks the artifact seen — the badge counts what you have NOT
 *  looked at, and this is the one moment that is known for certain. */
async function open(host: ArtifactsPaneHost, artifactId: string, version: number | undefined): Promise<void> {
  if (!host.client) {
    host.post({ type: 'artifactOpened', artifactId, error: NO_SESSION });
    return;
  }
  try {
    // A version only another desk holds is pulled first, then served by the same route.
    await nestOf(host).ensure(artifactId, version);
    const result = await host.client.extMethod(ARTIFACT_METHODS.open, {
      artifactId,
      ...(version === undefined ? {} : { version }),
    });
    const url = typeof result['url'] === 'string' ? (result['url'] as string) : '';
    if (!url) {
      host.post({ type: 'artifactOpened', artifactId, error: 'The engine returned no url for that artifact.' });
      return;
    }
    seen.add(artifactId);
    await host.openUrl?.(url);
    host.post({ type: 'artifactOpened', artifactId, ...(version === undefined ? {} : { version }), url });
  } catch (e) {
    host.post({ type: 'artifactOpened', artifactId, error: errorText(e) });
  }
}

/** Restore = publish that version again as a NEW one. It is also the conflict
 *  banner's "Keep mine as a sibling": the version you had becomes the latest,
 *  beside theirs, and neither is lost. */
async function restore(host: ArtifactsPaneHost, artifactId: string, version: number): Promise<void> {
  if (!host.client) {
    host.post({ type: 'artifactRestored', artifactId, error: NO_SESSION });
    return;
  }
  try {
    const result = await host.client.extMethod(ARTIFACT_METHODS.restore, { artifactId, version });
    host.post({ type: 'artifactRestored', artifactId, version: num(result, 'version') ?? version });
  } catch (e) {
    host.post({ type: 'artifactRestored', artifactId, error: errorText(e) });
  }
  await refresh(host);
}

async function diff(host: ArtifactsPaneHost, artifactId: string, from: number, to: number): Promise<void> {
  if (!host.client) {
    host.post({ type: 'artifactDiffData', artifactId, from, to, added: [], removed: [], changed: [], error: NO_SESSION });
    return;
  }
  try {
    const r = await host.client.extMethod(ARTIFACT_METHODS.diff, { artifactId, from, to });
    const files = (key: string): unknown[] => (Array.isArray(r[key]) ? (r[key] as unknown[]) : []);
    host.post({
      type: 'artifactDiffData', artifactId, from, to,
      added: files('added'), removed: files('removed'), changed: files('changed'),
    });
  } catch (e) {
    host.post({
      type: 'artifactDiffData', artifactId, from, to,
      added: [], removed: [], changed: [], error: errorText(e),
    });
  }
}

/** Rename — title only, no new version. The row already shows the new title
 *  optimistically (the pane edits its own `rows` state on Enter); this is the
 *  host telling the engine and, on failure, the pane's way of learning that. */
async function rename(host: ArtifactsPaneHost, artifactId: string, title: string): Promise<void> {
  if (!host.client) {
    host.post({ type: 'artifactRenamed', artifactId, error: NO_SESSION });
    return;
  }
  try {
    const result = await host.client.extMethod(ARTIFACT_METHODS.rename, { artifactId, title });
    host.post({ type: 'artifactRenamed', artifactId, title: str(result, 'title') || title });
  } catch (e) {
    host.post({ type: 'artifactRenamed', artifactId, error: errorText(e) });
  }
  await refresh(host);
}

/** Delete. The pane has ALREADY taken the row off screen and run its own 4s
 *  Undo toast (pendingClose.ts's shape) before this is ever posted — this is
 *  only reached once the fuse burns, exactly like `closeSession`. */
async function remove(host: ArtifactsPaneHost, artifactId: string): Promise<void> {
  if (!host.client) {
    host.post({ type: 'artifactDeleted', artifactId, error: NO_SESSION });
    return;
  }
  try {
    await host.client.extMethod(ARTIFACT_METHODS.delete, { artifactId });
    host.post({ type: 'artifactDeleted', artifactId });
  } catch (e) {
    host.post({ type: 'artifactDeleted', artifactId, error: errorText(e) });
  }
  await refresh(host);
}

/** "Open chat about": a new, empty chat with the composer seeded (never
 *  sent — composerPrefill.ts's rule, same as sideQuestsPane.ts's Start), then
 *  the artifact tab opens beside it. `title` and `version` come from the row
 *  the pane already holds, so this costs no extra read. */
async function openChatAbout(
  host: ArtifactsPaneHost,
  artifactId: string,
  title: string,
  version: number,
): Promise<void> {
  const chat = await host.createChat?.();
  if (!chat) {
    host.post({ type: 'artifactChatOpened', artifactId, error: 'Could not open a new chat.' });
    return;
  }
  const text = `About the artifact ${title} (origami://artifact/${artifactId}?v=${version}): `;
  host.post({ type: 'composerPrefill', sessionId: chat, text });
  await open(host, artifactId, version);
  host.post({ type: 'artifactChatOpened', artifactId, sessionId: chat });
}

/** Show in Explorer. The engine's `artifact_open` answer already carries the
 *  entry's local path (lane 1 is local-only) — read it here and hand it
 *  straight to `revealPath`, so the path itself never crosses into the
 *  webview at all. */
async function reveal(host: ArtifactsPaneHost, artifactId: string, version: number | undefined): Promise<void> {
  if (!host.client) {
    host.post({ type: 'artifactRevealed', artifactId, error: NO_SESSION });
    return;
  }
  try {
    const result = await host.client.extMethod(ARTIFACT_METHODS.open, {
      artifactId,
      ...(version === undefined ? {} : { version }),
    });
    const localPath = str(result, 'localPath');
    if (!localPath) {
      host.post({ type: 'artifactRevealed', artifactId, error: 'The engine returned no local path for that artifact.' });
      return;
    }
    await host.revealPath?.(localPath);
    host.post({ type: 'artifactRevealed', artifactId });
  } catch (e) {
    host.post({ type: 'artifactRevealed', artifactId, error: errorText(e) });
  }
}

/** Route one artifacts message. The `origami/artifactsChanged` notification
 *  lands here too, as an `artifactsRequest` — one refresh path, not two. */
export async function handleArtifactsPaneMessage(
  host: ArtifactsPaneHost,
  m: { type?: string; [k: string]: unknown },
): Promise<void> {
  const artifactId = str(m, 'artifactId');
  switch (m.type) {
    case 'artifactsRequest':
      await refresh(host);
      return;
    case 'artifactsOpened':
      // The pill was clicked and the list is on screen: every arrival counted
      // so far has now been seen, so the badge goes and stays gone.
      for (const id of str(m, 'ids').split(',')) if (id) seen.add(id);
      host.post({ type: 'artifactsBadge', count: 0 });
      return;
    case 'artifactVersionsRequest':
      if (artifactId) await versions(host, artifactId);
      return;
    case 'artifactOpen':
      if (artifactId) await open(host, artifactId, num(m, 'version'));
      return;
    case 'artifactRestore': {
      const version = num(m, 'version');
      if (artifactId && version !== undefined) await restore(host, artifactId, version);
      return;
    }
    case 'artifactDiff': {
      const from = num(m, 'from');
      const to = num(m, 'to');
      if (artifactId && from !== undefined && to !== undefined) await diff(host, artifactId, from, to);
      return;
    }
    case 'artifactRename': {
      const title = str(m, 'title');
      if (artifactId && title) await rename(host, artifactId, title);
      return;
    }
    case 'artifactDelete':
      if (artifactId) await remove(host, artifactId);
      return;
    case 'artifactOpenChatAbout': {
      const title = str(m, 'title');
      const version = num(m, 'version');
      if (artifactId && title && version !== undefined) await openChatAbout(host, artifactId, title, version);
      return;
    }
    case 'artifactReveal':
      if (artifactId) await reveal(host, artifactId, num(m, 'version'));
      return;
    default:
      return;
  }
}
