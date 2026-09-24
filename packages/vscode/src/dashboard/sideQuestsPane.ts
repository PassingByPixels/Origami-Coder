// sideQuestsPane.ts — the four messages behind the left Side quests pull-out
// (t-f89g49): list the folder, start one in a new chat, export one, dismiss one.
//
// Its own module rather than four more cases in DashboardPanel.ts, on the
// precedent subagentLimitPane.ts and remotePane.ts set: the panel spends one
// routing line and owns no handler.
//
// NO `vscode` IMPORT, on purpose. Everything this file needs from the editor —
// opening a chat, a save dialog — arrives as a callback on `SideQuestsHost`, so
// the folder logic (which files are open, which id maps to which path, what a
// stamp does to the bytes) is testable against a real temp directory with no
// editor stub at all. The two callbacks that DO need VS Code are one line each
// at the panel's routing site.
//
// THE FOLDER IS THE STATE. Nothing about a quest lives in the webview, in a
// session or in globalState: the drawer is a projection of `.origami/sidequests`
// and is rebuilt from it on every list. That is what makes a webview reload and
// a chat close cost nothing — there is no state to lose — and it is why Start
// and Dismiss write the file rather than filtering a list in the pane.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseSideQuest, sideQuestNumber, stampStatus, type SideQuest, type SideQuestStatus } from './sideQuestFile';

/** The four types the panel routes here. The READ takes the house `request*`
 *  prefix, which Origami Remote's allowlist treats as a read a phone may make;
 *  the three WRITES are refused for the phone by name — see remoteVerbsTable.ts. */
export const SIDE_QUESTS_MESSAGE_TYPES = new Set([
  'requestSideQuests',
  'sideQuestStart',
  'sideQuestExport',
  'sideQuestDismiss',
]);

/** Where the engine writes them, relative to the workspace root. */
export const SIDE_QUESTS_DIR = path.join('.origami', 'sidequests');

export interface SideQuestsHost {
  /** The workspace root. */
  cwd: string;
  post(message: Record<string, unknown>): void;
  /** Is ORIGAMI_EXPERIMENTAL_SIDE_QUESTS on? Injected rather than read here so a
   *  test can drive both sides of the flag without touching `process.env`. */
  enabled(): boolean;
  /** Open a NEW, EMPTY chat and answer with its local session id (or nothing,
   *  when the host could not make one). It does NOT prompt: see `sideQuestStart`
   *  below for why the brief is prefilled rather than sent. */
  createChat(): Promise<string | undefined> | string | undefined;
  /** Hand these exact bytes to a save dialog under this suggested file name. */
  save(fileName: string, bytes: string): Promise<void> | void;
}

/** The absolute path of one quest's file. The id is WEBVIEW INPUT, so it is
 *  matched against `SQ-<n>` before it ever reaches `path.join` — a bare join on
 *  an unchecked string is how `../../` gets to write outside the folder. */
export function questPath(cwd: string, id: string): string | null {
  return sideQuestNumber(id) < 0 ? null : path.join(cwd, SIDE_QUESTS_DIR, `${id}.md`);
}

/** Every quest in the folder with `status: open`, oldest number first.
 *  A missing folder is the ordinary case (nothing has ever raised one) and reads
 *  as an empty list, not an error. */
export function readOpenSideQuests(cwd: string): SideQuest[] {
  const dir = path.join(cwd, SIDE_QUESTS_DIR);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: SideQuest[] = [];
  for (const name of names) {
    if (!name.endsWith('.md')) continue;
    let text: string;
    try {
      text = fs.readFileSync(path.join(dir, name), 'utf8');
    } catch {
      continue; // half-written by the engine this millisecond; the next list gets it
    }
    const quest = parseSideQuest(text);
    if (quest && quest.status === 'open') out.push(quest);
  }
  return out.sort((a, b) => sideQuestNumber(a.id) - sideQuestNumber(b.id));
}

/** Rewrite one quest's `status:` in place. Returns the parsed quest as it was
 *  BEFORE the stamp (Start needs its instructions), or null when the id names no
 *  readable quest file. */
export function stampSideQuest(cwd: string, id: string, status: SideQuestStatus): SideQuest | null {
  const file = questPath(cwd, id);
  if (!file) return null;
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const quest = parseSideQuest(text);
  if (!quest) return null;
  try {
    fs.writeFileSync(file, stampStatus(text, status), 'utf8');
  } catch {
    return null;
  }
  return quest;
}

// --- the folder watcher -------------------------------------------------------
//
// One `fs.watch` per workspace root, started on the first list: the panel
// outlives every chat in it, and a watcher on a directory of small markdown
// files costs one handle. A workspace whose folder does not exist yet gets NO
// watcher — `fs.watch` throws on a missing directory — and picks the first quest
// up on the next list, which the webview asks for on mount and on window focus.
// The entry holds the HOST as well as the handle, and a later `watch()` for the
// same cwd RE-POINTS it (t-fisfs5 R4): the map is module state while a host is
// one DashboardPanel, so a reopened panel inherited a watcher still posting into
// the dead panel's webview. The handle is closed from the panel's `dispose()`.
interface WatchEntry { watcher: fs.FSWatcher; host: SideQuestsHost; }
const WATCHING = new Map<string, WatchEntry>();

function watch(host: SideQuestsHost): void {
  const existing = WATCHING.get(host.cwd);
  if (existing) { existing.host = host; return; }
  try {
    // The callback reads `entry.host`, NOT the captured `host`, so a re-point
    // takes effect on the watcher that is already running.
    const entry = { host } as WatchEntry;
    entry.watcher = fs.watch(path.join(host.cwd, SIDE_QUESTS_DIR), () => list(entry.host));
    WATCHING.set(host.cwd, entry);
  } catch {
    // No folder yet. Nothing to report: the list below is still correct (empty).
  }
}

/** Closes every watcher. Called from `DashboardPanel.dispose()`, beside the
 *  other module-global workspace watch, and from tests. */
export function stopSideQuestWatchers(): void {
  for (const entry of WATCHING.values()) entry.watcher.close();
  WATCHING.clear();
}

function list(host: SideQuestsHost): void {
  host.post({ type: 'sideQuestsData', quests: host.enabled() ? readOpenSideQuests(host.cwd) : [] });
}

export async function handleSideQuestMessage(
  host: SideQuestsHost,
  m: { type?: string; [k: string]: unknown },
): Promise<void> {
  // FLAG OFF = NOTHING. Not an empty drawer that could fill later, not a watcher,
  // not a folder read: the feature is absent, and `sideQuestsData` is never posted
  // so the webview's drawer has nothing to mount on.
  if (!host.enabled()) return;
  const id = typeof m['id'] === 'string' ? m['id'] : '';
  switch (m.type) {
    case 'requestSideQuests':
      watch(host);
      list(host);
      return;
    case 'sideQuestStart': {
      // STAMP FIRST, then open. A chat that opened on a quest the stamp then
      // failed to write would come back on the next list and be startable twice.
      const quest = stampSideQuest(host.cwd, id, 'started');
      if (quest) {
        // PREFILL, NEVER SEND. A brand-new chat has no model yet, and the owner
        // is prompted for this chat's model AND its sub-agent model
        // (ModelPicker.svelte + ModelPickerFollowUp.svelte) before any turn goes
        // out. Sending the brief here would spend that choice on whatever the
        // new cell defaulted to — so the brief lands in the composer and the
        // owner presses Send when he has picked. The empty-composer rule is
        // composerPrefill.ts's, on the webview side.
        const chat = await host.createChat();
        if (chat) host.post({ type: 'composerPrefill', sessionId: chat, text: quest.instructions });
      }
      list(host);
      return;
    }
    case 'sideQuestExport': {
      const file = questPath(host.cwd, id);
      if (!file) return;
      try {
        // The file's own BYTES, not a re-render of the parsed struct: an export
        // the owner mails to someone is the engine's file or it is a lie.
        await host.save(`${id}.md`, fs.readFileSync(file, 'utf8'));
      } catch {
        // Gone between the click and the read. The list below says so.
      }
      list(host);
      return;
    }
    case 'sideQuestDismiss':
      stampSideQuest(host.cwd, id, 'dismissed');
      list(host);
      return;
    default:
      return;
  }
}
