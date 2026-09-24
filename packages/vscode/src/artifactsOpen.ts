// artifactsOpen.ts — "Open" on an artifact, in the integrated browser.
//
// The rule the button has to keep (design section 6): the SAME TAB is reused.
// Clicking Open twice must not leave two tabs of the same page behind, and the
// second click has to bring the tab that is already there to the front.
//
// Why this is not just `handleBrowserRequest({ action: 'open' })`. That path
// is the agent's browser TOOL: it applies the open-beside setting, parses VS
// Code's prose into a tool answer, and — the part that matters here — has
// nowhere to remember which page it opened, so a second open is a second tab
// (or VS Code's "a similar page is already shared" decline, which is about
// same-HOST similarity and would reuse the tab of a DIFFERENT artifact, since
// every artifact url shares the host `127.0.0.1:<port>`).
//
// So the page id is remembered per url, and it is re-checked against
// `list_browser_pages` before it is used: a tab the user closed must open
// again, not reveal an id VS Code no longer has (`revealPage` on an unlisted
// id opens a BLANK page — browserPage.ts says why).
//
// Everything it acts through is browserVsCode.ts's probed surface: no tool and
// no command is assumed to exist on the build the user is running.

import { isCancellation, LIST_TOOL, OPEN_TOOL } from './browserTools';
import { check, parseOpenedPageId, parsePageList } from './browserResult';
import { discoverTools, findOpenCommand, invoke, revealPage, runOpenCommand, toBrowserUrl } from './browserVsCode';

/** url -> the page VS Code opened for it. Module state, like
 *  browserReveal.ts's revealed-page set, and for the same reason: it is a fact
 *  about this window's tabs, not about any one caller. */
const openedPages = new Map<string, string>();

/** Test seam — a fresh window has no tabs. */
export function resetOpenedArtifacts(): void {
  openedPages.clear();
}

/**
 * Show an artifact url. Opens it the first time; on every later call for the
 * same url it reveals the tab that is already open.
 *
 * Throws only when this build publishes no way to show a url at all. A reveal
 * that fails is NOT fatal: the page is opened again instead, because the user
 * asked to see it.
 */
export async function openArtifactUrl(url: string): Promise<void> {
  const target = toBrowserUrl(url);
  const tools = discoverTools();
  const known = openedPages.get(target);
  if (known && (await stillOpen(known, tools))) {
    try {
      await revealPage(known);
      return;
    } catch {
      // The tab went away between the list and the reveal.
      openedPages.delete(target);
    }
  }
  await openFresh(target, tools);
}

/** Is that page id still one VS Code lists? A stale id is worse than no id. */
async function stillOpen(pageId: string, tools: readonly string[]): Promise<boolean> {
  if (!tools.includes(LIST_TOOL)) return false;
  try {
    const seen = check(await invoke(LIST_TOOL, {}));
    if (seen.failed !== undefined) return false;
    return parsePageList(seen.checked.text).some((page) => page.id === pageId);
  } catch {
    return false;
  }
}

/** The open itself. `open_browser_page` is preferred over the open COMMAND for
 *  browserBridge.ts's reason AND for one of this file's own: only the tool
 *  answers with the page id, and without an id there is nothing to reveal next
 *  time. The command stays the fallback — one tab is better than none. */
async function openFresh(url: string, tools: readonly string[]): Promise<void> {
  if (tools.includes(OPEN_TOOL)) {
    try {
      const seen = check(await invoke(OPEN_TOOL, { url }));
      if (seen.failed === undefined) {
        const pageId = parseOpenedPageId(seen.checked.text);
        // No id means the reduced open (page sharing off). The page IS on
        // screen; it simply cannot be revealed by id later, so nothing is
        // remembered and the next click opens again.
        if (pageId) openedPages.set(url, pageId);
        return;
      }
    } catch (error) {
      // A REFUSED confirmation modal is an answer, and falling through would
      // put the very url the user just declined on screen (browserBridge.ts
      // learned this the hard way). Every other throw is a capability failure,
      // in which nobody was asked, so the command below still stands.
      if (isCancellation(error)) throw error;
    }
  }
  const command = await findOpenCommand();
  if (!command) throw new Error('This VS Code build publishes no way to open a page in the integrated browser.');
  await runOpenCommand(command, url);
}
