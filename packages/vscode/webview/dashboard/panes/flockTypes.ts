// The shapes `flock_state` sends and the pane's five components read.
//
// One module rather than an interface block per component: Friend alone was
// declared four times, and a field added engine-side then has four places to
// arrive and three to be forgotten in. Types only — no values, so nothing is
// bundled and a component importing this pulls in nothing at runtime.

/** No `skills`: instructions are not secrets, so the desk reads them
 *  unconditionally. `folders` took that column — any absolute folder. */
export interface FlockScope {
  repos?: string[];
  wiki?: string[];
  folders?: string[];
}

export interface FlockIdentityRow {
  /** `name@fingerprint` IN FULL. What every write addresses. */
  handle: string;
  /** `name@` + eight characters. A label for a narrow column, never a key. */
  handleShort: string;
  /** The display name. Editable; the handle above does NOT follow it. */
  name: string;
  /** The sigil variant this owner shows as. Absent from an older engine. */
  icon?: string;
  /** The whole hash of the signing key, 43 characters. */
  fingerprint: string;
  signPublicKey: string;
  boxPublicKey: string;
}

export interface FlockFriendRow {
  handle: string;
  handleShort: string;
  /** What they call themselves NOW. Not editable here — only they can move it. */
  name: string;
  /** The sigil variant THEY picked. Absent from an older engine. */
  icon?: string;
  /** The owner's own label for them. Absent = they are shown as `name`. */
  displayName?: string;
  addedAt: string;
  relay?: string;
  policy: { autoAnswer?: boolean; dailyBudgetTokens?: number; model?: string; scope?: FlockScope };
  spentToday: number;
  budget?: number;
  effective: { model?: string; autoAnswer: boolean };
}

export interface FlockAnswerRow {
  at: string;
  from: string;
  question: string;
  tokens: number;
  ok: boolean;
}

export interface FlockFrontDeskState {
  model?: string;
  dailyBudgetTokens?: number;
  scope?: FlockScope;
  autoAnswer: boolean;
}

export interface FlockState {
  identity: FlockIdentityRow;
  /** What THIS window's engine has the friend links on. `other-engine` means
   *  another window's engine holds them and this one is deliberately silent —
   *  one relay socket per role per rid, so exactly one engine may dial. */
  transport: 'relay' | 'other-engine' | 'none';
  holder?: { pid: number; httpBase: string }; // flock-owner.json: the engine process that holds the links
  friends: FlockFriendRow[];
  frontDesk: FlockFrontDeskState;
  frontDeskPath: string;
  specialties: string[];
  availability: string;
  answers: FlockAnswerRow[];
}

export interface FlockQuestion {
  id: string;
  sessionID: string;
  from: string;
  name: string;
  question: string;
}

/** Which of the three scope lists a control is acting on. */
export type FlockScopeKind = 'repos' | 'wiki' | 'folders';

export interface FlockRepoOption {
  root: string;
  name: string;
}

/** No list for FOLDERS: no registry of them exists, so one is only ever browsed to. */
export interface FlockScopeOptions {
  repos: FlockRepoOption[];
  wiki: string[];
}

/** A folder the host's picker returned. The nonce makes the SAME path picked
 *  twice two events, which a plain string comparison would swallow. */
export interface FlockPickedFolder {
  kind: FlockScopeKind;
  path: string;
  nonce: number;
  /** The contact this pick was browsed FOR, '' for the desk defaults. Two
   *  pickers are live at once, and both would otherwise take the same folder. */
  target: string;
}
