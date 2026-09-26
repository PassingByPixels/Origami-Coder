// The ManagerHost interface: the narrow window the fleet owner reaches DashboardPanel
// through. Every method is faked in tests, so the manager stays unit-testable.

export interface ManagerHost {
  /** Workspace root when it is a git repo, else undefined. */
  repoRoot(): string | undefined;
  /** The hub: registered repos + "Add repo…" picker. */
  knownRepos(): string[];
  saveKnownRepos(paths: string[]): void;
  pickRepoFolder(): Promise<string | undefined>;
  /** Board-only display-name overrides, keyed by the entry's `root`. Cosmetic. */
  repoDisplayNames(): Record<string, string>;
  saveRepoDisplayNames(names: Record<string, string>): void;
  /** Board-level "auto-approve agent permissions" toggle, owned by the panel's globalState. */
  autoApprove(): boolean;
  setAutoApprove(on: boolean): void;
  /** Create a background agent session (cwd = worktree); resolves with the UI session id. */
  createAgentSession(cwd: string, agentName?: string): Promise<string>;
  /** One turn on the session; resolves with the stop reason at idle. */
  promptSession(sessionId: string, text: string): Promise<string>;
  cancelSession(sessionId: string): Promise<void>;
  /** Close the session + kill its engine child, or Windows holds the worktree's file locks. */
  closeSession(sessionId: string): void;
  sessionAlive(sessionId: string): boolean;
  /** t-w2txb2: stop the session's engine, keeping the session (its transcript, its tab, its engine id);
   *  the next prompt or the Chat button starts it again. null = stopped, else why not. Optional: a host
   *  without elastic parking keeps the engine up, as before. */
  parkSession?(sessionId: string): Promise<string | null>;
  openChat(sessionId: string): void;
  /** Broadcast to every attached webview. */
  post(msg: object): void;
  openTerminal(cwd: string, title: string): void;
  /** Pin this session's model ONLY — no cross-session carry, no global-default write. */
  setSessionModel(sessionId: string, modelId: string): Promise<void>;
  /** THIS session's live agent-type (mode) options; null before the ACP client has them. */
  agentModes(sessionId: string): Array<{ id: string; name: string; default?: boolean; description?: string }> | null;
  /** Set this session's agent type (ACP 'mode'), validated against its live modes. */
  setSessionAgentMode(sessionId: string, modeId: string): Promise<void>;
  /** The persisted agent-type roster (globalState) + its writer (S6a). */
  agentTypes(): Array<{ id: string; name: string; default?: boolean; description?: string }>;
  saveAgentTypes(types: Array<{ id: string; name: string; default?: boolean; description?: string }>): void;
  /** The install-once archetype marker, so a deleted archetype is never re-written. */
  archetypeMarker(): { get(): boolean; set(): void };
  /** Roster pre-fill: the modes of the first live session that has them, else null. */
  harvestAnySessionModes(): Array<{ id: string; name: string; default?: boolean }> | null;
  /** Race compare: a native VS Code diff of two real on-disk worktree files. */
  openCrossDiff(leftFsPath: string, rightFsPath: string, title: string): void;
  /** Engine-store UUID of a live UI session (persisted for Chat-on-Done); undefined if gone. */
  engineSessionId(uiId: string): string | undefined;
  /** Reopen a past agent session from its engine id (loadSession replay); resolves the new UI id.
   */
  reopenAgentSession(cwd: string, engineId: string, agentName?: string): Promise<string>;
  /** Open a native VS Code diff: the worktree base (readonly, via the agent-base content provider)
   *  left, the working file right. */
  openFileDiff(worktree: string, base: string, relPath: string, rightFsPath: string, title: string): void;
  /** Non-modal information toast (apply success). */
  info(msg: string): void;
  /** Open each conflicted file (absolute paths) so the user can resolve markers. */
  openConflicted(absPaths: string[]): void;
  /** Open the Folds board ticket editor: the markdown file IS the full brief. */
  openFile(absPath: string): void;
}
