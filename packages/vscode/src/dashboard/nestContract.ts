// The engine's nest method shapes, as the host reads them (t-sc093o).
//
// MIRROR, not a second contract: the engine is the contract. L4a's six methods
// are copied from packages/engine/src/storage/nests.ts and src/acp/nests.ts
// (master e343edabf1); nest_continue / nest_release / nest_reconcile are L5's
// (t-sb9tlk, master 37d81c7910: src/acp/nests.ts + storage/nests-handover.ts).
// An older engine answers a method it lacks with JSON-RPC -32601 and the host
// says so. The vscode package cannot import the engine's types, so a change
// there must be copied here.

export type NestState = 'running' | 'open' | 'closed';

export interface NestIndexRow {
  id: string;
  title: string;
  /** Device id of the desk that HOLDS this copy. */
  desk: string;
  deskName: string;
  state: NestState;
  /** Device id of the desk that WRITES it. */
  owner: string;
  lastAt: number;
  forkOf?: { id: string; desk: string; at: number };
  size: number;
  seq: number;
}

/** nest_index -> rows = this desk's (send them), others = the other desks' (show them). */
export interface NestIndexResult {
  rows: NestIndexRow[];
  others: NestIndexRow[];
}

/** One nest_export reply. `from === 0` chunks also carry the project row. */
export interface NestChunk {
  sessionId: string;
  owner: string;
  from: number;
  to: number;
  last: number;
  done: boolean;
  events: unknown[];
  project?: unknown;
}
export type NestExportResult = NestChunk | { refused: 'not-found'; sessionId: string };

export interface NestImportResult {
  sessionId: string;
  /** Send as `after` on the next nest_export. */
  have: number;
  applied: number;
  done: boolean;
  refused?: 'gap' | 'owner' | 'diverged' | 'bad-chunk';
}

export type NestRetentionClass = 'chats' | 'subagents' | 'toolOutput' | 'journal' | 'artifacts';

export interface NestStorageResult {
  deviceId: string;
  classes: Record<NestRetentionClass, number>;
  fileBytes: number;
  journalEventsPerPart: number;
  method: 'length-sums';
  measuredMs: number;
  /** t-vbivj4: false on a partial answer to `waitMs` (the sums so far); `progress` 0..1.
   *  An older engine sends neither: its one answer is final. */
  done?: boolean;
  progress?: number;
}

/** StorageRetention.PruneResult, the fields the host reads. */
export interface NestPruneResult {
  dryRun: boolean;
  olderThanDays: number;
  bytes: number;
}

export interface NestRetentionResult {
  windows: Record<NestRetentionClass, number | null>;
  /** t-vb87lt: each prune is present only when its class has a window. `artifacts`
   *  is StorageNests.ArtifactPruneResult: the files of versions older than the window. */
  applied?: { toolOutput?: NestPruneResult; artifacts?: NestPruneResult };
  /** Windows set that no prune reads yet. */
  unapplied: NestRetentionClass[];
}

/** L5 nest_continue. `seq` = the seq it was taken or forked at. */
export type NestContinueResult =
  | { result: 'taken'; sessionId: string; seq: number }
  | { result: 'forked'; sessionId: string; forkOf: { id: string; desk: string; at: number }; seq: number }
  | { refused: 'not-found'; sessionId: string };

/** L5 nest_release. `seq` = this desk's last seq AFTER the turn stop. */
export type NestReleaseResult =
  | { sessionId: string; owner: string; seq: number; aborted: boolean }
  | { refused: 'not-found' | 'unknown-owner'; sessionId: string };

/** L5 nest_reconcile. On `forked`, pull the original from `have + 1` from `owner`. */
export type NestReconcileResult =
  | { result: 'clean'; sessionId: string; have: number }
  | { result: 'forked'; sessionId: string; have: number; owner: string; fork: { sessionId: string; title: string; forkOf: { id: string; desk: string; at: number } } }
  | { refused: 'not-found' | 'unknown-owner'; sessionId: string };

/** An engine that predates a method answers with JSON-RPC -32601. */
export function isMissingMethod(error: unknown): boolean {
  const e = error as { code?: unknown; message?: unknown } | null;
  return e?.code === -32601 || /method not found/i.test(String(e?.message ?? error));
}
