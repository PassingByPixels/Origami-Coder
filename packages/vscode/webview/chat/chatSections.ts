// chatSections.ts — the sidebar's chat-grouping feature (t-kgserq, extended
// t-kgserq v2), pure leaf half. The webview side of a persistence-plus-
// grouping split: the EXTENSION half (persisted shape, memento glue, section
// CRUD) lives in src/dashboard/chatSections.ts — a SEPARATE file because
// webview code cannot import a runtime value from src/ (tsconfig.webview.json
// pins rootDir to webview/). There is no shared literal between the two that
// needs a drift guard: the extension persists whatever blob it is given and
// never inspects "Main"/"Loops" as strings, so this stays an ordinary leaf,
// not a mirror.
//
// DOM-free by design (repoMapPillars.ts's precedent) so the grouping rule and
// the divider-drag clamp are testable without jsdom's missing layout engine.

/** Mirrors src/dashboard/chatSections.ts's ChatSectionDef — see that file for
 *  why there is no shared import. */
export interface ChatSectionDef {
  id: string;
  name: string;
  collapsed: boolean;
}

export interface ChatSectionsState {
  membership: Record<string, string>;
  sections: ChatSectionDef[];
  mainCollapsed: boolean;
}

export function defaultChatSectionsState(): ChatSectionsState {
  return { membership: {}, sections: [], mainCollapsed: false };
}

/** Split an ordered id list into Main / each known custom section, each
 *  keeping the original relative order — the reorder array stays the single
 *  source of truth for WITHIN-section order too, sections are only a
 *  display filter.
 *
 * `knownSectionIds` guards against an ORPHANED membership entry — its
 * section was deleted, names a retired built-in (t-r43glr: the old 'loops'
 * and the pre-v2 "spare" section are gone and can never be "known" again),
 * or a stale message named one this client has not loaded yet: such a chat
 * goes to MAIN rather than vanishing — a chat silently dropped from every
 * visible list is worse than one that lands somewhere unexpected. */
export function groupSessionIds(
  order: readonly string[],
  membership: Readonly<Record<string, string>>,
  knownSectionIds: ReadonlySet<string>,
): { main: string[]; bySection: Record<string, string[]> } {
  const main: string[] = [];
  const bySection: Record<string, string[]> = {};
  for (const id of order) {
    const section = membership[id];
    if (section && knownSectionIds.has(section)) (bySection[section] ??= []).push(id);
    else main.push(id);
  }
  return { main, bySection };
}

/** Clamp a candidate Collabs-section height to the live split container's
 *  bounds, pulled out as a pure function because jsdom has no layout engine
 *  (getBoundingClientRect is always 0 there) — the drag math is verified here
 *  with plain numbers; the drag GESTURE itself needs a human eyeball. */
export function clampCollabsHeight(candidatePx: number, containerHeightPx: number, minPx = 60): number {
  const max = Math.max(minPx, containerHeightPx - minPx);
  return Math.min(max, Math.max(minPx, Math.round(candidatePx)));
}
