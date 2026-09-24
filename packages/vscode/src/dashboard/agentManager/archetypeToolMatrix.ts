// The owner-approved DEFAULT TOOL MATRIX for the six shipped archetypes (t-f3a74m),
// and the two frontmatter blocks it renders into each archetype's .md payload.
//
// WHY A TABLE AND NOT SIX HAND-WRITTEN YAML BLOCKS. The matrix was approved as one
// table - rows are tool groups, columns are agent types - and six transcriptions of
// it drift one cell at a time with nothing to say so. ROWS below IS that table, in
// its own row order, so a reviewer diffs the approved table against one thing.
//
// THE THREE STATES, and where each one lands (the same split the ledger writes, see
// src/dashboard/subagentToolConfig.ts):
//   L loaded   - `permission.<tool>: allow`, and NOT in `tool_search.defer`
//   D deferred - `permission.<tool>: allow`, and in `tool_search.defer`
//   O off      - no grant at all, so the leading `"*": deny` covers it
// Presentation (defer) and existence (permission) are different questions; a
// deferred tool is still granted, it just costs one `tool_search` round trip.
//
// KEY ORDER IS LOAD-BEARING. `Permission.disabled` (engine, permission/index.ts)
// resolves with `findLast`, so `"*": deny` must be the FIRST key and every re-grant
// must come after it.
//
// `screenshot` is granted `ask`, not `allow`: the matrix wants every sub-agent able
// to reach it while it still asks every time, and only `deny` reads as Off.

/** L = loaded, D = deferred, O = off. */
export type MatrixState = 'L' | 'D' | 'O';

export type ArchetypeName = 'debug' | 'orchestrator' | 'architect' | 'cartographer' | 'ask' | 'scout';

/** The matrix COLUMNS, in the approved table's order. `general` and `explore` are
 *  engine natives with no file to write; they are the engine lane's (t-f39xs2). */
export const ARCHETYPE_COLUMNS: readonly ArchetypeName[] = [
  'debug',
  'orchestrator',
  'architect',
  'cartographer',
  'ask',
  'scout',
];

/** One approved row: the tool ids it covers, then one state per column above, in
 *  that order. `states` is six characters so a row stays one line and a mis-typed
 *  row is a length error rather than a silent shift. */
export interface MatrixRow {
  readonly tools: readonly string[];
  readonly states: string;
}

/** THE APPROVED MATRIX (2026-09-15), rows in the table's own order.
 *  Columns: debug · orchestrator · architect · cartographer · ask · scout. */
export const ROWS: readonly MatrixRow[] = [
  // `list` was dropped (t-fisqjz): the engine's TOOL_IDS defines no such tool.
  { tools: ['read', 'grep', 'glob', 'wiki_search', 'wiki_related'], states: 'LLLLLL' },
  // write / edit / apply_patch all request the `edit` permission (engine
  // permission/index.ts), so the row is one key. architect and cartographer keep
  // their own path-scoped allowlists - see SCOPED.
  { tools: ['edit'], states: 'LOLLOO' },
  // The `file` tool (mkdir / delete / copy / move) follows the edit column, with
  // one correction the owner made explicit: the two archetypes whose edit grant is
  // PATH-SCOPED get no file ops at all. A scoped `edit` confines architect to
  // markdown and cartographer to the map dir; a file delete or move answers to
  // `file_delete` / `file_move`, not to `edit`, so granting it would hand both of
  // them back the whole disk through the side door. The tool id is listed beside
  // the four permission ids because `Permission.disabled` resolves the ledger's
  // cell from the tool NAME, while the operations ask under their own ids.
  { tools: ['file', 'file_mkdir', 'file_delete', 'file_copy', 'file_move'], states: 'LOOOOO' },
  { tools: ['bash', 'process'], states: 'LOOOOO' },
  { tools: ['todowrite'], states: 'LLLLOO' },
  // `task` is never Deferred. Each archetype's TARGET list is its own and is kept
  // verbatim in SCOPED; this row only says whether it is granted at all.
  { tools: ['task', 'task_list', 'task_stop'], states: 'OLLLLO' },
  { tools: ['question'], states: 'LLLLLO' },
  { tools: ['skill'], states: 'LLLDDD' },
  { tools: ['git_diff', 'lsp'], states: 'LDLLLD' },
  { tools: ['webfetch', 'websearch', 'session_search'], states: 'DDDDDD' },
  { tools: ['browser', 'board_*'], states: 'DDOOOO' },
  { tools: ['webmcp_*'], states: 'OOOOOO' },
  { tools: ['screenshot'], states: 'DDDDDD' },
  {
    tools: ['remember', 'chart', 'goal', 'plan', 'dream', 'flock_*', 'send_message', 'list_agents'],
    states: 'OOOOOO',
  },
  // t-f89g49. `side_quest` is the MAIN agent's tool and nothing else's, in every
  // column at once. A sub-agent that could raise one would fill the owner's list
  // from a session he never opened and may never read, and the whole point of the
  // feature is that the raiser moves on while the OWNER decides. A delegate with
  // follow-up work to report puts it in its result text, where the parent that
  // asked for the work reads it.
  { tools: ['side_quest'], states: 'OOOOOO' },
  { tools: ['tool_search'], states: 'LLLLLL' },
];

/** The path- and target-scoped grants each archetype ALREADY shipped with, kept
 *  verbatim: the matrix decides presentation and existence, never an archetype's
 *  own write scope or which agents its `task` may reach. Lines are emitted under
 *  the key in this order, `"*": deny` first for the same findLast reason. */
const SCOPED: Record<ArchetypeName, Record<string, readonly string[]>> = {
  debug: {},
  // The orchestrator delegates and does nothing itself, so its targets ARE its
  // definition: the two the prompt sends work to, and no third by accident.
  orchestrator: { task: ['"*": deny', 'explore: allow', 'general: allow'] },
  architect: {
    edit: ['"*": deny', '"*.md": allow', '"**/*.md": allow'],
    task: ['"*": deny', 'scout: allow'],
  },
  cartographer: {
    edit: ['"*": deny', '".origami/map/*": allow', '".origami/map/**": allow'],
    task: ['"*": deny', 'scout: allow'],
  },
  ask: { task: ['"*": deny', 'scout: allow'] },
  scout: {},
};

/** The two escape vectors, named OUTRIGHT even when the leading `"*": deny` would
 *  already close them: a reader of an agent definition should not have to derive
 *  "this one cannot write" or "this one has no shell" from an absence. */
const NAMED_WHEN_OFF = new Set(['edit', 'bash']);

/** `ask`, not `allow`: the owner wants sub-agents able to reach it, still asking
 *  every time. Only `deny` reads as Off, so the matrix state is unaffected. */
const GRANT_ACTION: Record<string, string> = { screenshot: 'ask' };

/** A YAML key: quoted when it carries a `*`, which a plain scalar may hold but
 *  which reads as an alias to anyone scanning the file. */
const key = (tool: string): string => (tool.includes('*') ? `"${tool}"` : tool);

/** This archetype's state for one row. */
function rowState(row: MatrixRow, name: ArchetypeName): MatrixState {
  const i = ARCHETYPE_COLUMNS.indexOf(name);
  return row.states[i] as MatrixState;
}

/** The whole matrix for one archetype: tool id -> state, in row order. */
export function statesFor(name: ArchetypeName): Map<string, MatrixState> {
  const out = new Map<string, MatrixState>();
  for (const row of ROWS) for (const tool of row.tools) out.set(tool, rowState(row, name));
  return out;
}

/** The `permission:` block, `"*": deny` first. */
export function permissionBlock(name: ArchetypeName): string {
  const lines = ['permission:', '  "*": deny'];
  for (const row of ROWS) {
    const state = rowState(row, name);
    for (const tool of row.tools) {
      const scoped = SCOPED[name][tool];
      if (scoped) {
        lines.push(`  ${key(tool)}:`, ...scoped.map((line) => `    ${line}`));
        continue;
      }
      if (state === 'O') {
        if (NAMED_WHEN_OFF.has(tool)) lines.push(`  ${key(tool)}: deny`);
        continue;
      }
      lines.push(`  ${key(tool)}: ${GRANT_ACTION[tool] ?? 'allow'}`);
    }
  }
  return lines.join('\n');
}

/** Every tool this archetype defers, in row order. */
export function deferList(name: ArchetypeName): string[] {
  return ROWS.filter((row) => rowState(row, name) === 'D').flatMap((row) => [...row.tools]);
}

/** The `tool_search:` block, or '' when this archetype defers nothing. Only
 *  `defer` is ever shipped: no archetype needs `always`, because nothing the
 *  matrix marks L is deferred by the engine's own defaults. */
export function toolSearchBlock(name: ArchetypeName): string {
  const defer = deferList(name);
  if (defer.length === 0) return '';
  return ['tool_search:', '  defer:', ...defer.map((tool) => `    - ${key(tool)}`)].join('\n');
}

/** Both blocks, ready to interpolate into an archetype's frontmatter between
 *  `mode:` and the closing `---`. No trailing newline. */
export function frontmatterBlocks(name: ArchetypeName): string {
  const search = toolSearchBlock(name);
  return search ? `${permissionBlock(name)}\n${search}` : permissionBlock(name);
}
