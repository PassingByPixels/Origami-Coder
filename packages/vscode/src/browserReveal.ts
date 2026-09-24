// browserReveal.ts — WHETHER the agent's browser tab may be brought to the front.
//
// browserFocus.ts owns HOW a reveal is done without taking the cursor; this file
// owns whether it is done at all. The two are different questions and the second
// one is the user's: a reveal that preserves keyboard focus still moves the editor
// under their eyes, and it ran on every driven verb, so a ten-step run repainted
// the workbench ten times.
//
// The policy is `origami.browser.reveal`:
//   always — the old behaviour: any page VS Code lists "not visible" is revealed
//            before the verb, every time.
//   first  — the default: a page id is revealed ONCE. The first open (or the first
//            verb on a page this session never opened) reveals; every navigate,
//            screenshot, click and type after that leaves the tab where it is.
//   never  — no reveal is ever issued from here.
//
// What `never` CANNOT do, stated plainly: `open_browser_page` is VS Code's tool,
// not ours, and it creates and shows the editor itself. Neither it nor the open
// COMMANDS take a "do not show" option — see the inputSchema readings in
// browserViewport.ts and browserFocus.ts — so the FIRST open of a new page still
// puts a tab on screen under `never` exactly as it does under `first`. The
// difference between the two is everything afterwards, plus the case where the
// page was shared by someone else: `first` will reveal such a page once, `never`
// will not reveal it at all. `origami.browser.openBeside` is what keeps that one
// unavoidable tab out of the group the user is reading in.

import * as vscode from 'vscode';

export const REVEAL_SETTING = 'origami.browser.reveal';

export type RevealPolicy = 'never' | 'first' | 'always';

export const REVEAL_POLICIES: readonly RevealPolicy[] = ['never', 'first', 'always'];

/** Quiet by default. The old behaviour is still one setting away. */
export const DEFAULT_REVEAL: RevealPolicy = 'first';

/** A settings value turned into a policy. Anything that is not one of the three
 *  is the default rather than a failure: this is read on the path to a verb, and a
 *  hand-edited settings file must not be the reason a click does not run. */
export function toRevealPolicy(value: unknown): RevealPolicy {
  return REVEAL_POLICIES.includes(value as RevealPolicy) ? (value as RevealPolicy) : DEFAULT_REVEAL;
}

/** Read live on every verb, so a change in Settings applies to the next one
 *  without a window reload — the same contract readViewport() keeps. */
export function readRevealPolicy(): RevealPolicy {
  try {
    return toRevealPolicy(vscode.workspace.getConfiguration().get(REVEAL_SETTING));
  } catch {
    return DEFAULT_REVEAL;
  }
}

/** The page ids revealed since this extension host started — the "session" the
 *  policy is scoped to. Ids come from VS Code and are dropped when the workbench
 *  restarts, so the set can never outlive the pages it names; a reopened window
 *  starts over, which is what makes "first" mean "the first time you see it". */
const revealedPages = new Set<string>();

export function markRevealed(pageId: string): void {
  revealedPages.add(pageId);
}

export function wasRevealed(pageId: string): boolean {
  return revealedPages.has(pageId);
}

/** Tests only — the set is process-wide by design, so a suite that did not clear
 *  it would leak one case's page id into the next one's "first". */
export function resetRevealedPages(): void {
  revealedPages.clear();
}

/** The decision, pure: may this page be revealed now? `seen` is whether the id is
 *  already in the session's set. Taken as an argument rather than read here so the
 *  rule is testable without a workbench, exactly as planViewport and planForce are. */
export function allowReveal(policy: RevealPolicy, seen: boolean): boolean {
  if (policy === 'always') return true;
  if (policy === 'never') return false;
  return !seen;
}

/** The live form: policy from settings, "seen" from the session set. */
export function mayReveal(pageId: string): boolean {
  return allowReveal(readRevealPolicy(), wasRevealed(pageId));
}
