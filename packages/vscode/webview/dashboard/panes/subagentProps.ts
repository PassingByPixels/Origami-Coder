// subagentProps.ts — the prop shapes of the three sub-agent drawer components,
// declared ONCE, in a file the type gate actually reads.
//
// WHY THEY LEFT THE COMPONENTS. `tsconfig.webview.json` excludes
// `webview/**/__tests__/**` and `webview/**/*.test.ts`, and `webview/global.d.ts`
// types every `*.svelte` import as an untyped shim. Put together, a drawer test
// could pass `onOpenInTab` a year after the prop was renamed to `onOpen`, or a
// row fixture could carry a `stream` field that no longer exists, and nothing
// anywhere would say so: Svelte drops an undeclared prop in silence and no
// compiler ever looked at either side. That is exactly what had happened
// (report item 15) and exactly what a green suite was hiding.
//
// With the shape declared HERE, each component takes its `$props()` type from
// this file and the fixture factory (subagentRowFixture.ts) builds these same
// types. Rename a prop and `npm run typecheck` fails on the fixture — one
// gate, both directions, no mirror test to keep in step.
import type { SubagentMessage, SubagentRow } from './subagentRows';

export interface SubagentDockProps {
  /** This chat's transcript — the rows are DERIVED from it, never a second
   *  wire that could disagree with the tool cards it was read from. */
  messages: ReadonlyArray<SubagentMessage>;
  /** Roster keys retired by hand (the row's ×) or by the next turn's
   *  auto-clear of a failed spawn. Nothing retires a row on the clock — a
   *  finished row is history the drawer keeps (t-h8gv8w). */
  dismissed: ReadonlyArray<string>;
  open: boolean;
  /** What the agent map puts in the centre — this chat's own name. */
  chatTitle: string;
  onToggle: () => void;
  onDismiss: (key: string) => void;
  /** t-j50p3r. The parent chat cell's focus flag, passed straight through to a
   *  child's transcript overlay so the two views agree. Per SESSION and in
   *  memory (ChatPane.svelte's `cellSession.focusMode`) — there is no global
   *  focus setting to reuse. */
  focusMode: boolean;
  onToggleFocus: () => void;
}

export interface SubagentRowProps {
  row: SubagentRow;
  /** Only ever called for a FAILED row. Removes the row from the drawer's
   *  roster; the transcript's own card is untouched. */
  onDismiss: (key: string) => void;
  /** Read this child's OWN session — SubagentDock opens the read-only
   *  transcript over the chat cell. Running or settled alike. */
  onOpen: (row: SubagentRow) => void;
  /** t-q910fo: stop THIS child and nothing else. Only ever called for a RUNNING
   *  row with a session — a settled one has nothing to abort, and a spawn with no
   *  session was never registered as a job. Omitted by a read-only surface. */
  onStop?: (row: SubagentRow) => void;
  /** The sub-agent ceiling in ms, as the HOST reported it (subagentWarn.ts).
   *  0 = no usable setting, which turns the amber warning off rather than
   *  guessing a ceiling the engine was never spawned with. */
  limitMs?: number;
}

export interface SubagentGroupProps {
  /** 'Running' / 'Complete'. */
  label: string;
  rows: SubagentRow[];
  /** Fold the ROWS away, heading and count kept. Omitted by a band that never
   *  folds (Running), which then draws a plain heading rather than a dead
   *  button. State lives in the DRAWER: a band is re-created on every
   *  re-render, so a fold owned here would spring open on each tick. */
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  limitMs?: number;
  onDismiss: (key: string) => void;
  onOpen: (row: SubagentRow) => void;
  /** t-q910fo: passed straight down to the row. See SubagentRowProps. */
  onStop?: (row: SubagentRow) => void;
}

export interface SubagentDrawerProps {
  rows: SubagentRow[];
  open: boolean;
  onToggle: () => void;
  onDismiss: (key: string) => void;
  onOpen: (row: SubagentRow) => void;
  /** t-q910fo: passed straight down to the group. See SubagentRowProps. */
  onStop?: (row: SubagentRow) => void;
  /** Open the live agent map over the chat cell (SubagentMap.svelte). */
  onMap: () => void;
  limitMs?: number;
}
