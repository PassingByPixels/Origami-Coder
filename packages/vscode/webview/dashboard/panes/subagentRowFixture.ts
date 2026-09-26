// subagentRowFixture.ts — ONE typed factory for a sub-agent drawer row, and
// one typed prop bag per component that takes one.
//
// WHY THIS FILE EXISTS (report item 15). Each drawer test built its own row
// literal by hand and both had drifted: SubagentDrawer.test.ts still set a
// `stream` field removed months earlier, SubagentRow.test.ts still passed
// `onOpenInTab` after the prop was renamed to `onOpen`, and never set `settled`
// at all. Every one of those suites stayed green — Svelte drops an undeclared
// prop in silence, and nothing typechecked the tests.
//
// WHY IT LIVES IN panes/ AND NOT __tests__/. That is the whole mechanism. The
// type gate EXCLUDES `webview/**/__tests__/**` and `webview/**/*.test.ts`
// (tsconfig.webview.json), so a fixture in there cannot fail compilation, which
// is the only thing this file is for. Nothing in production imports it, so it
// is dropped by the bundler; it is source that exists to be TYPECHECKED.
import type { SubagentMessage, SubagentRow } from './subagentRows';
import type { SubagentTokens } from './subagentTokens';
import type { SubagentDockProps, SubagentDrawerProps, SubagentGroupProps, SubagentRowProps } from './subagentProps';

/** A live, silent, timed row. Override what a case is ABOUT and nothing else —
 *  a fixture that restates every field in every test hides which one matters. */
export function row(over: Partial<SubagentRow> = {}): SubagentRow {
  return {
    key: 'child-1',
    taskSessionId: 'child-1',
    // The card's own header (the word `task` in the real thing) AND the identity
    // every surface actually prints (subagentLabel.ts) — a fixture that carried
    // only the header would let a surface regress to it unnoticed.
    title: 'task',
    ordinal: 1,
    description: 'audit the bundle',
    state: 'running',
    elapsedMs: 5_000,
    settled: false,
    activity: '',
    // Not thinking: the default row is the ordinary case, and a fixture that
    // thinks by default would make the heartbeat's absence untestable.
    thinking: '',
    thought: '',
    ...over,
  };
}

/** Every prop SubagentDock.svelte declares. `chatTitle` is here because it was
 *  the next field to drift: the dock's suite had no compiler telling it the
 *  prop existed at all. */
export function dockProps(messages: SubagentMessage[], over: Partial<SubagentDockProps> = {}): SubagentDockProps {
  return {
    messages,
    sessionId: 'chat-1',
    dismissed: [],
    open: true,
    chatTitle: '#1 coder',
    onToggle: () => {},
    onDismiss: () => {},
    focusMode: false,
    onToggleFocus: () => {},
    ...over,
  };
}

/** A token rider, for the cases about the spend figure. */
export function tokens(over: Partial<SubagentTokens> = {}): SubagentTokens {
  return { input: 12_400, output: 2_100, ...over };
}

/** Every prop SubagentRow.svelte declares. The no-op handlers are the point: a
 *  test overrides only the one it asserts on, and a RENAMED prop stops
 *  compiling here instead of being silently ignored at render time. */
export function rowProps(over: Partial<SubagentRowProps> = {}): SubagentRowProps {
  return { row: row(), onDismiss: () => {}, onOpen: () => {}, limitMs: 0, ...over };
}

/** Every prop SubagentGroup.svelte declares. */
export function groupProps(label: string, rows: SubagentRow[], over: Partial<SubagentGroupProps> = {}): SubagentGroupProps {
  return { label, rows, onDismiss: () => {}, onOpen: () => {}, ...over };
}

/** Every prop SubagentDrawer.svelte declares. */
export function drawerProps(rows: SubagentRow[], over: Partial<SubagentDrawerProps> = {}): SubagentDrawerProps {
  return {
    rows,
    open: true,
    onToggle: () => {},
    onDismiss: () => {},
    onOpen: () => {},
    onMap: () => {},
    limitMs: 0,
    ...over,
  };
}
