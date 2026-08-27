// browserResult.ts — what VS Code ANSWERED, and what it means.
//
// Extracted from browserTools.ts (282/310, no room) when the bridge was taught
// to read failure. The split is along the line the two halves already had:
// browserTools.ts says what VS Code publishes and what to send it, this file
// reads what comes back — the page list, the opened page id, the withheld-page
// tail, the declined open, and the split of a tool result into text, image and
// ERROR. Pure and vscode-free, like the file it came out of.
//
// It exists because the first version of this bridge had no notion of failure
// at all: it returned ok:true for every verb whose tool did not THROW, and a
// click on a selector that is not on the page does not throw. Every value below
// was read off the SHIPPED bundle (VS Code 1.132.0,
// out/vs/workbench/workbench.desktop.main.js) — the function names in the
// comments are that bundle's, so a claim here can be checked against it.

import type { DrivenAction } from './browserTools';

/** VS Code prints exactly one of THREE states per line, never a bare id. */
export type PageState = 'active' | 'visible' | 'not visible';

export interface ListedPage {
  id: string;
  state: PageState;
}

/** `list_browser_pages` prints one line per shared page (`Lcn` in the bundle):
 *  `- [<id>] <title> (<url>) (active|visible|not visible)`. The state is the
 *  LAST parenthesis on the line, and it is always printed, so it anchors the
 *  match rather than being sniffed out of the tail. */
const PAGE_LINE = /^\s*-\s*\[([^\]]+)\][^\n]*\((active|visible|not visible)\)\s*$/;

export function parsePageList(text: string): ListedPage[] {
  const pages: ListedPage[] = [];
  for (const line of text.split('\n')) {
    const match = PAGE_LINE.exec(line);
    if (match) pages.push({ id: match[1], state: match[2] as PageState });
  }
  return pages;
}

/**
 * Which page a bare "read the page" means when several are shared.
 *
 * VS Code marks one line (active) — the browser page the user is LOOKING at —
 * but that is the uncommon case: while the agent works, the user is focused on
 * a source file or the chat view, so no browser page is active at all. Falling
 * straight from there to registration order drove an OFF-SCREEN page over the
 * one on screen. All three states are therefore used: active, then visible,
 * then VS Code's own order (the sort is stable, so ties keep it). Never a guess
 * by title or url — the model named no page, so where the user is looking is
 * the only honest answer.
 */
const RANK: Record<PageState, number> = { active: 0, visible: 1, 'not visible': 2 };

export function choosePageId(pages: readonly ListedPage[]): string | undefined {
  return [...pages].sort((a, b) => RANK[a.state] - RANK[b.state])[0]?.id;
}

/** Which page was driven, when the answer was not obvious. With two or more
 *  shared the model cannot otherwise tell WHICH it just read or clicked, and
 *  with none active the pick was the on-screen page rather than the user's
 *  focus — so both facts are said out loud. Silent for a single page. */
export function chosenPageNote(pages: readonly ListedPage[], pageId: string): string | undefined {
  if (pages.length < 2) return undefined;
  const state = pages.find((page) => page.id === pageId)?.state ?? 'not visible';
  return `${pages.length} browser pages are shared with the agent; this acted on ${pageId} (${state}).`;
}

/** `open_browser_page` answers `Page ID: <id>`, then the page summary. */
const OPENED_ID = /^Page ID:\s*(\S+)/m;

export function parseOpenedPageId(text: string): string | undefined {
  return OPENED_ID.exec(text)?.[1];
}

/** The tail `list_browser_pages` adds for pages that are open but withheld —
 *  the difference between "nothing is open" and "nothing is shared with you". */
const UNSHARED = /(\d+)\s+pages?\s+(?:is|are)\s+open but not shared/i;

export function unsharedPages(text: string): number {
  return Number(UNSHARED.exec(text)?.[1] ?? 0);
}

/**
 * `open_browser_page` opens NOTHING when a page it judges SIMILAR is already
 * shared (`_mi`): it lists the candidates and asks for one to be reused, or for
 * `forceNew`. "Similar" is far wider than same-url — `IPo` matches equal hosts,
 * OR both file: scheme, OR either host a subdomain of the other, with blanks
 * included — so opening a local report.html while ANY other local .html is
 * shared lands here. There is no page id in that reply, so an open that only
 * looked for one read the decline as the reduced open and called it a success.
 */
const DECLINED_OPEN = /^At least one similar page is already open:/m;

export function declinedOpen(text: string): boolean {
  return DECLINED_OPEN.test(text);
}

export interface ToolParts {
  text: string;
  /** VS Code's OWN words for an action it ran and reported failed. */
  error?: string;
  imageBase64?: string;
  imageMime?: string;
}

/**
 * Whether VS Code said the action FAILED. Two signals, because the workbench
 * emits two and `MainThreadLanguageModelTools.$invokeTool` forwards only
 * `{content, toolMetadata, toolResultError}` — nothing else survives.
 *
 *  1. Every `Nm(msg)` refusal — no pageId, "No browser page found with ID …",
 *     "No page summary available." — sets `toolResultError`, which the ext-host
 *     converter turns into `hasError` on the result the extension receives.
 *     Read by SHAPE, not off the type: @types/vscode 1.125.0 declares neither
 *     `hasError` nor `toolResultError` on LanguageModelToolResult, and this
 *     object has already crossed the ext-host boundary — the same reason the
 *     content parts are duck-typed below. A build that never sets it loses
 *     nothing; signal 2 still runs.
 *  2. A Playwright failure inside a driven verb sets NEITHER. PlaywrightSession
 *     .invokeFunction CATCHES the throw into `{result, error, summary}`, `xmi`
 *     pushes that error as a text part AHEAD of the summary, and the
 *     `toolResultDetails.isError` beside it is exactly what `$invokeTool`
 *     drops. Position is the only signal left: the LAST part is the summary, so
 *     an earlier part that is not one of the three notes `xmi` and
 *     `navigate_page` legitimately prepend is the message the verb failed with.
 */
const NOTE_PART = /^(?:Result: |\[deferredResultId=|Note: `)/;

/** The verbs whose tool runs through `fT`/`xmi` — on 1.133.0 that pair is
 *  `IT`/`cfi`, and `cfi` still pushes Result, then the error, then the summary.
 *  `hover_element` and `drag_element` go through the same `IT`; `raw` is here
 *  because `run_playwright_code` builds its reply with `cfi` directly, so a
 *  Playwright throw INSIDE a snippet arrives the same way. `read_page`,
 *  `screenshot_page` and `handle_dialog` answer in one part and fail through
 *  `toolResultError`, so a second text part from THEM is content, not an error. */
const XMI_ACTIONS: ReadonlySet<string> = new Set(['navigate', 'click', 'type', 'hover', 'drag', 'raw']);

function toolError(result: unknown, texts: string[], action?: DrivenAction): string | undefined {
  const said = result as { hasError?: unknown; toolResultError?: unknown };
  if (said?.hasError) {
    // The reason is not always in the CONTENT. A throw out of
    // `playwrightService.openPage` is caught into `v ??= { content: [] };
    // v.toolResultError = …`, which leaves the message in the signal and
    // nothing in the parts — so an error read out of the parts alone reports
    // a timeout as "without saying why". Read second, not first, because every
    // `Nm(msg)` refusal puts the same words in both.
    const spoken = typeof said.toolResultError === 'string' ? said.toolResultError.trim() : '';
    return texts.splice(0).join('\n').trim() || spoken || 'VS Code reported the action failed, without saying why.';
  }
  if (!action || !XMI_ACTIONS.has(action) || texts.length < 2) return undefined;
  const lead = texts.slice(0, -1);
  const errors = lead.filter((line) => !NOTE_PART.test(line));
  if (errors.length === 0) return undefined;
  texts.splice(0, lead.length, ...lead.filter((line) => NOTE_PART.test(line)));
  return errors.join('\n');
}

/**
 * Split a LanguageModelToolResult into the text, the FIRST image, and the error.
 * Duck-typed on shape, not `instanceof`: the result crosses an extension-host
 * boundary and the part classes are extended over time (the type itself admits
 * `unknown` members), so a class check would silently drop real content.
 *
 * ONLY an `image/*` part is a picture. A data part of any other type (a build
 * that answers `read` with an application/json accessibility snapshot, say) is
 * TEXT the model must still see — taking it for the screenshot loses it twice
 * over: the card shows a broken image, and `read` reports "no readable text"
 * about a page that answered in full.
 *
 * `action` is what tells signal 2 above apart from page content, so a caller
 * that omits it gets the structured signal only — never a false failure.
 */
/**
 * A tool result whose failure signals HAVE been read, and the ONLY way to get
 * one: the brand is a symbol with no runtime value, so `check` below is the
 * sole expression of this type. `browserTools.succeeded` demands one, which is
 * what makes a success unreachable without having come through here — see the
 * response constructors there for why that ceremony is worth its lines.
 */
declare const CHECKED: unique symbol;

export type Checked = ToolParts & { readonly [CHECKED]: true };

/** VS Code's own failure words, or the parts. Never both, never neither. */
export type Checkup = { failed: string; checked?: undefined } | { failed?: undefined; checked: Checked };

export function check(result: unknown, action?: DrivenAction): Checkup {
  const parts = readToolResult(result, action);
  return parts.error !== undefined ? { failed: parts.error } : { checked: parts as Checked };
}

export function readToolResult(result: unknown, action?: DrivenAction): ToolParts {
  const content = (result as { content?: unknown })?.content;
  const parts = Array.isArray(content) ? content : [];
  const texts: string[] = [];
  let imageBase64: string | undefined;
  let imageMime: string | undefined;
  for (const part of parts) {
    const p = part as { value?: unknown; data?: unknown; mimeType?: unknown };
    const mime = typeof p?.mimeType === 'string' && p.mimeType ? p.mimeType : undefined;
    if (mime && p?.data !== undefined && p?.data !== null) {
      if (/^image\//i.test(mime)) {
        if (imageBase64 === undefined) {
          imageBase64 = Buffer.from(p.data as Uint8Array).toString('base64');
          imageMime = mime;
        }
        continue;
      }
      texts.push(Buffer.from(p.data as Uint8Array).toString('utf8'));
      continue;
    }
    if (typeof p?.value === 'string') texts.push(p.value);
  }
  const error = toolError(result, texts, action);
  return { text: texts.join('\n').trim(), ...(error ? { error } : {}), imageBase64, imageMime };
}
