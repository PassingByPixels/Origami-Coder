// Agent Manager - host.ts (S6b): the ManagerHost interface, extracted verbatim
// from manager.ts to keep the fleet owner under its line cap.
// ManagerHost is the narrow window the fleet owner reaches DashboardPanel
// through - every method is implemented by the panel and faked in tests, so the
// manager stays unit-testable and the panel monolith only grows a thin dispatch.

export interface ManagerHost {
  /** Workspace root when it is a git repo, else undefined. */
  repoRoot(): string | undefined;
  /** The hub: registered repos + "Add repo…" picker. */
  knownRepos(): string[];
  saveKnownRepos(paths: string[]): void;
  pickRepoFolder(): Promise<string | undefined>;
  /** Board-only display-name overrides, keyed by the composed entry's `root`
   *  (never the real `name` a ticket/board_* tool keys by). Cosmetic. */
  repoDisplayNames(): Record<string, string>;
  saveRepoDisplayNames(names: Record<string, string>): void;
  /** Board-level "auto-approve agent permissions" toggle (S5.2). Read for the
   *  broadcast; written by the header checkbox. Owned by the panel's globalState. */
  autoApprove(): boolean;
  setAutoApprove(on: boolean): void;
  /** Create a background agent session (engine child, cwd = worktree).
   *  Resolves with the UI session id once ACP is up. */
  createAgentSession(cwd: string, agentName?: string): Promise<string>;
  /** One turn on the session; resolves with the stop reason at idle. */
  promptSession(sessionId: string, text: string): Promise<string>;
  cancelSession(sessionId: string): Promise<void>;
  /** Close the session + kill its engine child (worktree delete needs the
   *  child gone or Windows holds file locks). */
  closeSession(sessionId: string): void;
  sessionAlive(sessionId: string): boolean;
  openChat(sessionId: string): void;
  /** Broadcast to every attached webview. */
  post(msg: object): void;
  openTerminal(cwd: string, title: string): void;
  /** Pin THIS session's model (raw AcpClient.setModel scoped to the one session
   *  - NO lms load/unload, NO cross-session carry, NO global-default write, so a
   *  background agent pin can never retarget the user's live chat). Throws on an
   *  invalid model id (the honest failure, never a silent no-op). */
  setSessionModel(sessionId: string, modelId: string): Promise<void>;
  /** THIS session's live agent-type (mode) options, or null before the ACP
   *  client has them - harvested into the roster (S6a); the current mode carries default:true. */
  agentModes(sessionId: string): Array<{ id: string; name: string; default?: boolean; description?: string }> | null;
  /** Set THIS session's agent type (ACP 'mode'), validating the id against the
   *  session's live modes; throws (listing the available ids) when absent. */
  setSessionAgentMode(sessionId: string, modeId: string): Promise<void>;
  /** The persisted agent-type roster (globalState) + its writer (S6a). */
  agentTypes(): Array<{ id: string; name: string; default?: boolean; description?: string }>;
  saveAgentTypes(types: Array<{ id: string; name: string; default?: boolean; description?: string }>): void;
  /** S9 Folds archetypes: the install-once marker (globalState-backed in the panel,
   *  faked in tests) that ensureArchetypes reads/sets so a deleted archetype is
   *  never re-written on the next board boot. */
  archetypeMarker(): { get(): boolean; set(): void };
  /** S6c roster pre-fill: the modes of the FIRST live session that already has
   *  them (the user's open chat qualifies), mapped exactly like agentModes; null
   *  when nothing live knows its modes yet (fresh window before any client is up). */
  harvestAnySessionModes(): Array<{ id: string; name: string; default?: boolean }> | null;
  /** S6c race compare: a native VS Code diff of two REAL on-disk files - sibling
   *  A's worktree file vs sibling B's (both exist, even mid-run, so no content
   *  provider). Used by the race Compare view's "A vs B" action. */
  openCrossDiff(leftFsPath: string, rightFsPath: string, title: string): void;
  /** Engine-store UUID of a live UI session (persisted for Chat-on-Done); undefined if gone. */
  engineSessionId(uiId: string): string | undefined;
  /** Reopen a past agent session from its engine id (loadSession replay), cwd =
   *  the worktree. Resolves the NEW UI session id. */
  reopenAgentSession(cwd: string, engineId: string, agentName?: string): Promise<string>;
  /** Open a native VS Code diff: the worktree base (readonly, via the agent-base
   *  content provider) on the left, the worktree working file on the right. */
  openFileDiff(worktree: string, base: string, relPath: string, rightFsPath: string, title: string): void;
  /** Non-modal information toast (apply success). */
  info(msg: string): void;
  /** Open each conflicted file (absolute paths) so the user can resolve markers. */
  openConflicted(absPaths: string[]): void;
  /** Open a file in the editor (the Folds board's ticket ✎: the ticket markdown
   *  IS the full-brief editor, so the board opens the file rather than mirroring
   *  it in a form that could drift from it). */
  openFile(absPath: string): void;
}
