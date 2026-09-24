// The SUB-AGENT LEDGER's arithmetic, with no DOM in it: how the tool rows
// group, what a cell's state is, which cells cannot be clicked, and what the
// next click would set. Extracted as a pure leaf (t-f1j2y3) so
// SubagentLedger.svelte carries only the markup, the same split
// repoMapPillars.ts made out of RepoMapScreen.svelte — and so the lock rules,
// which are the part a screenshot cannot check, are testable with no DOM.
//
// Types are declared here rather than imported: tsconfig.webview.json pins
// rootDir to `webview/`, so a .ts file under it cannot import from `src/` even
// type-only (docs Part 5), and a .svelte file is not in tsc's program either.
// They mirror ToolCatalogEntry / SubagentToolRow in src/acpExtTypes.ts.

export type LedgerState = 'loaded' | 'deferred' | 'off';

export interface LedgerTool {
  id: string;
  description: string;
  deferred: boolean;
  disabled: boolean;
  source: 'builtin' | 'mcp' | 'user-file' | 'plugin';
  hardRequired: boolean;
}

export interface LedgerAgent {
  agent: string;
  native: boolean;
  description?: string;
  states: Record<string, string>;
  /** Tool id -> why this cell is off and cannot be set, straight from the
   *  engine (t-h8s3xg). Absent on an older engine and on every row with
   *  nothing to explain. */
  unavailable?: Record<string, string>;
}

export const SOURCE_LABEL: Record<LedgerTool['source'], string> = {
  builtin: 'builtin',
  mcp: 'mcp server',
  plugin: 'plugin',
  'user-file': 'user file',
};

/** Group order, fixed rather than first-seen: the sheet must read the same way
 *  after a search narrows it, and a filter that happens to drop every builtin
 *  should not promote `user file` to the top of the page. */
const SOURCE_ORDER: Array<LedgerTool['source']> = ['builtin', 'mcp', 'plugin', 'user-file'];

const ORDER: LedgerState[] = ['loaded', 'deferred', 'off'];

/** The peer tools. They reach ACROSS the delegation tree to sessions the child
 *  has no standing to interrupt, so the engine denies each one to every
 *  sub-agent whose OWN definition does not name it
 *  (agent/subagent-permissions.ts). */
export const NESTING_TOOLS = new Set(['task', 'send_message', 'list_agents']);

/** The tool's own state, the one the card pill shows. OFF outranks DEFERRED,
 *  the same order the card and the engine take them in. */
export function workspaceState(tool: LedgerTool): LedgerState {
  return tool.disabled ? 'off' : tool.deferred ? 'deferred' : 'loaded';
}

/** What the engine says this agent gets. `loaded` for a tool the row says
 *  nothing about — an older engine's rows carry fewer tools than the list. */
export function cellState(row: LedgerAgent, id: string): LedgerState {
  const raw = row.states?.[id];
  return raw === 'deferred' || raw === 'off' ? raw : 'loaded';
}

export interface LedgerGroup {
  source: LedgerTool['source'];
  label: string;
  tools: LedgerTool[];
}

/** The rows, in groups. Tool order inside a group is the order given (the pane
 *  hands over the engine's own id sort, narrowed by its filter). */
export function groupBySource(tools: readonly LedgerTool[]): LedgerGroup[] {
  return SOURCE_ORDER.map((source) => ({
    source,
    label: SOURCE_LABEL[source],
    tools: tools.filter((t) => t.source === source),
  })).filter((g) => g.tools.length > 0);
}

/** Why this cell cannot be clicked, or null when it can.
 *
 *  Two reasons, and only the first is a fact the payload states outright.
 *  `hardRequired` is the catalog's own flag. The nesting lock is DERIVED: the
 *  engine reports a state, not a lock, and a peer tool the agent's definition
 *  names comes back loaded or deferred rather than off — so a peer tool
 *  reported OFF is one the definition did not name, which is exactly the cell
 *  a click cannot move. Erring that way costs a user an `allow` they could
 *  have hand-written in origami.json; the other way would draw a live control
 *  over a tool the spawn path denies anyway. */
export function cellLock(tool: LedgerTool, state: LedgerState, row?: LedgerAgent): string | null {
  // The engine's OWN reason first, because it is the only one of the three
  // that is a fact rather than a reading: `unavailable` is written where the
  // child's catalog is decided (t-h8s3xg), so a cell it names cannot be set
  // by any config line this sheet could write.
  const stated = row?.unavailable?.[tool.id];
  if (stated) return `${tool.id} is unavailable here: ${stated}.`;
  if (tool.hardRequired) return `${tool.id} is always registered; the engine relies on it.`;
  if (NESTING_TOOLS.has(tool.id) && state === 'off')
    return `${tool.id} reaches across the delegation tree — a sub-agent gets it only if its own agent definition names it.`;
  return null;
}

/** The Workspace column locks on the catalog's flag alone: it edits the same
 *  setting the card pill does, so it locks exactly where the card does. */
export const workspaceLock = (tool: LedgerTool): string | null =>
  tool.hardRequired ? `${tool.id} is always registered; the engine relies on it.` : null;

/** Loaded -> Deferred -> Off -> Loaded, skipping Deferred for a tool that
 *  cannot be deferred. Nothing in the catalog reports that today (the engine's
 *  own blind spot, named in acp/subagent-tools.ts), so the flag is a parameter
 *  rather than a read: the day a `deferrable` lands, one call site changes. */
export function nextState(current: LedgerState, deferrable = true): LedgerState {
  let i = (ORDER.indexOf(current) + 1) % ORDER.length;
  if (ORDER[i] === 'deferred' && !deferrable) i = (i + 1) % ORDER.length;
  return ORDER[i]!;
}

/** How many of these tools this agent actually gets — the header's "N of M on". */
export function onCount(row: LedgerAgent, tools: readonly LedgerTool[]): number {
  return tools.filter((t) => cellState(row, t.id) !== 'off').length;
}

/** What a click on this agent's column header sets: the next state of its
 *  FIRST settable cell, so the header moves the column the way a cell moves
 *  itself rather than inventing a fourth verb. Null when every cell is locked. */
export function columnNext(row: LedgerAgent, tools: readonly LedgerTool[]): LedgerState | null {
  const first = tools.find((t) => cellLock(t, cellState(row, t.id), row) === null);
  return first ? nextState(cellState(row, first.id)) : null;
}
