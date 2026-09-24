// THE ARTIFACTS ACP CONTRACT — one file, read by the host handler AND by the
// drift guard, so the names the extension sends and the names a test checks
// cannot disagree.
//
// The engine does not implement these methods yet (t-rz4555 landed first, on
// purpose). This file IS the specification the engine lanes implement: every
// method name, every parameter field, every result field and every row field
// the pane reads. Until an engine answers, `artifact_list` fails or returns
// "method not found", the host forwards that as an error string and the pane
// draws its empty state. That path is the normal one today, not a fault path.

/** The seven ext methods. Values are the literal wire names. */
export const ARTIFACT_METHODS = {
  list: 'artifact_list',
  versions: 'artifact_versions',
  open: 'artifact_open',
  restore: 'artifact_restore',
  diff: 'artifact_diff',
  rename: 'artifact_rename',
  delete: 'artifact_delete',
} as const;

/** Every method name, for a guard that has to iterate them. */
export const ARTIFACT_METHOD_NAMES: readonly string[] = Object.values(ARTIFACT_METHODS);

/**
 * The notification that says "the list moved". Two spellings are accepted
 * deliberately: the ticket body wrote `origami/artifacts`, the lane brief
 * wrote `origami/artifactsChanged`, and an engine picking either one must not
 * leave the pane stale. Whichever arrives, the host re-reads the list.
 */
export const ARTIFACTS_CHANGED_NOTIFICATIONS: readonly string[] = ['origami/artifactsChanged', 'origami/artifacts'];

/** Parameters, per method. A field absent here is a field the engine may drop. */
export const ARTIFACT_PARAM_FIELDS: Readonly<Record<string, readonly string[]>> = {
  artifact_list: ['all'],
  artifact_versions: ['artifactId'],
  artifact_open: ['artifactId', 'version'],
  artifact_restore: ['artifactId', 'version'],
  artifact_diff: ['artifactId', 'from', 'to'],
  artifact_rename: ['artifactId', 'title'],
  artifact_delete: ['artifactId'],
};

/** Result fields, per method. */
export const ARTIFACT_RESULT_FIELDS: Readonly<Record<string, readonly string[]>> = {
  artifact_list: ['artifacts', 'homeDevice'],
  artifact_versions: ['versions'],
  artifact_open: ['url', 'localPath'],
  artifact_restore: ['version'],
  artifact_diff: ['added', 'removed', 'changed'],
  artifact_rename: ['title'],
  artifact_delete: ['removedVersions', 'removedBlobs'],
};

/**
 * One row of `artifact_list`.
 *
 * `unopened` and `conflict` are this lane's ADDITIONS to the ticket's row
 * shape, and they are here rather than in the pane because the badge and the
 * banner are both acceptance items: a badge needs the engine to say which
 * arrivals are new, and a banner needs it to say who published over you.
 */
export const ARTIFACT_ROW_FIELDS: readonly string[] = [
  'id', 'title', 'latest', 'updated', 'ownerDevice', 'here', 'sessionID', 'project', 'unopened', 'conflict',
];

/** One row of `artifact_versions`. */
export const ARTIFACT_VERSION_FIELDS: readonly string[] = ['number', 'digest', 'created', 'device'];

/** `row.conflict` — the other device published while you held an older version. */
export const ARTIFACT_CONFLICT_FIELDS: readonly string[] = ['device', 'theirVersion', 'yourVersion'];

// ---------------------------------------------------------------- shapes
//
// The SAME contract as the field lists above, written as types: the lists are
// what a drift guard iterates, these are what a caller holds. They live here
// rather than beside acpClient.ts so there is one home for the contract (they
// were folded in from src/artifactsAcp.ts, t-rz3gfr).

/** One row of the artifacts list — `artifact_list`.
 *  `latest` is the newest version number; `here` says the BODIES are on this
 *  machine (always true until the device-group lane lands); `project` is the
 *  repo the artifact was made in. */
export interface ArtifactRow {
  id: string;
  title: string;
  latest: number;
  updated: number;
  ownerDevice: string;
  here: boolean;
  sessionID?: string;
  project?: string;
  /** Arrived from another device and not looked at yet — the dock badge.
   *  Always false until the device-group lane lands. */
  unopened?: boolean;
  /** That device published while you held an older version — the banner.
   *  Absent until the device-group lane lands. */
  conflict?: { device: string; theirVersion: number; yourVersion: number };
}

/** One row of the versions list — `artifact_versions`, newest first. */
export interface ArtifactVersion {
  number: number;
  digest: string;
  created: number;
  device?: string;
}

export interface ArtifactListResult {
  artifacts: ArtifactRow[];
  /** What THIS machine is called in an `ownerDevice`. */
  homeDevice?: string;
}

export interface ArtifactVersionsResult {
  versions: ArtifactVersion[];
}

/** `artifact_open` — the loopback url of the version's entry file. The engine
 *  builds it, because only the engine knows the port its server listened on.
 *  `localPath` is the entry's blob on THIS machine's disk (lane 1 is
 *  local-only, so it is always real) — never shown, only handed straight to
 *  `revealFileInOS` for the Show in Explorer button. */
export interface ArtifactOpenResult {
  url: string;
  localPath?: string;
}

/** `artifact_rename` — the title after the rename (echoed back rather than
 *  trusted from what the pane sent, since the engine trims it). */
export interface ArtifactRenameResult {
  title: string;
}

/** `artifact_delete` — what came off disk, for the log line if one is ever
 *  wanted; the pane itself already removed the row optimistically. */
export interface ArtifactDeleteResult {
  removedVersions: number;
  removedBlobs: number;
}

/** `artifact_restore` — the NEW version number the copy-forward minted. */
export interface ArtifactRestoreResult {
  version: number;
}

/** `artifact_diff` — which files changed between two versions, as paths. */
export interface ArtifactDiffResult {
  added: string[];
  removed: string[];
  changed: string[];
}

/** `origami/artifactsChanged` — a version landed in the store, in ANY window
 *  on this machine. It carries the change, not the list: the pane re-reads with
 *  `artifact_list` when it wants rows. */
export interface ArtifactsChangedPush {
  artifactId: string;
  version?: number;
  kind: string;
  /** The chat whose tool call made the change (t-s49986). The host auto-opens
   *  a NEW artifact only in the window holding this session. */
  sessionID?: string;
}

export function artifactsChangedFrom(p: Record<string, unknown>): ArtifactsChangedPush {
  const version = p.version;
  return {
    artifactId: typeof p.artifactId === 'string' ? p.artifactId : '',
    ...(typeof version === 'number' && Number.isFinite(version) ? { version: Math.floor(version) } : {}),
    kind: typeof p.kind === 'string' ? p.kind : 'published',
    ...(typeof p.sessionID === 'string' && p.sessionID ? { sessionID: p.sessionID } : {}),
  };
}
