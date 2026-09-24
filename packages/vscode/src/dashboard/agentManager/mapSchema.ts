// The repo architecture MAP schema + a structural validator. A cartographer run writes
// .origami/map/map.json to this shape; board tooling validates before stamping/rendering.
// Validation is structural and reference-checked: an out-of-range pillar, an edge/flow-step
// naming an unknown node id are errors, but empty edges/flows are fine. `builtAt` is
// optional — the agent writes without it and the tooling stamps it after a git rev-parse.
// `layers` was replaced by 5 fixed numbered pillars.

export interface MapBuiltAt {
  sha: string;
  branch: string;
  at: number;
}

/** A node status for diff-tracking across map rebuilds. The list is the single
 *  source: the type is derived from it, so validation and type cannot drift. */
export const MAP_NODE_STATUSES = ['new', 'modified', 'removed', 'unchanged'] as const;
export type MapNodeStatus = (typeof MAP_NODE_STATUSES)[number];

export interface MapNode {
  id: string;
  name: string;
  /** Pillar number 1-5. See PILLAR_NAMES for the fixed mapping. */
  pillar: number;
  kind: string;
  path?: string;
  summary: string;
  /** Optional diff-tracking status set by the cartographer when a prior map exists. */
  status?: MapNodeStatus;
  /** Optional sub-section group name for grouping nodes within a pillar column. */
  section?: string;
}

export interface MapEdge {
  from: string;
  to: string;
  label: string;
}
export interface MapFlowStep {
  node: string;
  note: string;
}
export interface MapFlow {
  id: string;
  name: string;
  description: string;
  steps: MapFlowStep[];
}
export interface MapKeyFile {
  path: string;
  why: string;
}

/** The 5 universal pillars. Every map uses exactly these, identical across all repos. */
export const PILLARS: ReadonlyArray<{ number: number; name: string; purpose: string }> = [
  { number: 1, name: 'Entry Points & Interfaces', purpose: 'CLI commands, API endpoints, UI entry points, public APIs' },
  { number: 2, name: 'Core Logic / Processing Pipeline', purpose: 'Business logic, data processing, orchestration, renderers' },
  { number: 3, name: 'Validation, Trust & Policy Gates', purpose: 'Schema checks, auth, evidence gates, path resolution' },
  { number: 4, name: 'External Dependencies & Infrastructure', purpose: 'CLI tools, databases, runtimes, third-party services' },
  { number: 5, name: 'Artifacts & Outputs', purpose: 'Generated files, build output, browser artifacts, reports' },
];

export const PILLAR_IDS: ReadonlySet<number> = new Set(PILLARS.map((p) => p.number));

export interface RepoMap {
  version: 2;
  builtAt?: MapBuiltAt;
  name: string;
  summary: string;
  nodes: MapNode[];
  edges: MapEdge[];
  flows: MapFlow[];
  keyFiles: MapKeyFile[];
  conventions: string[];
}

export type ValidateResult = { ok: true; map: RepoMap } | { ok: false; errors: string[] };

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function isStr(v: unknown): v is string {
  return typeof v === 'string';
}

/** Validate a parsed map against the schema: typed map on success, or precise errors (shape
 *  first, then the three reference checks: node->pillar, edge->node, flowStep->node). A
 *  present `builtAt` must be well-shaped; absent is fine (unstamped, agent-authored). */
export function validateMap(raw: unknown): ValidateResult {
  const errors: string[] = [];
  if (!isObj(raw)) return { ok: false, errors: ['map is not an object'] };

  if (raw.version !== 2) errors.push(`version must be 2 (got ${JSON.stringify(raw.version)})`);
  if (!isStr(raw.name) || raw.name.trim() === '') errors.push('name must be a non-empty string');
  if (!isStr(raw.summary)) errors.push('summary must be a string');

  // builtAt is optional; if present it must be a full stamp.
  if (raw.builtAt !== undefined) {
    const b = raw.builtAt;
    if (!isObj(b) || !isStr(b.sha) || !isStr(b.branch) || typeof b.at !== 'number') {
      errors.push('builtAt, when present, must be { sha: string, branch: string, at: number }');
    }
  }

  const nodes = validateNodes(raw.nodes, errors);
  validateEdges(raw.edges, nodes, errors);
  validateFlows(raw.flows, nodes, errors);
  validateKeyFiles(raw.keyFiles, errors);
  validateConventions(raw.conventions, errors);

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, map: raw as unknown as RepoMap };
}

function validateNodes(v: unknown, errors: string[]): Set<string> {
  const ids = new Set<string>();
  if (!Array.isArray(v)) { errors.push('nodes must be an array'); return ids; }
  v.forEach((n, i) => {
    if (!isObj(n) || !isStr(n.id) || !isStr(n.name) || typeof n.pillar !== 'number' || !isStr(n.kind) || !isStr(n.summary)) {
      errors.push(`nodes[${i}] must be { id, name, pillar: number, kind, summary: string, path?: string, status?: string, section?: string }`);
      return;
    }
    if (n.path !== undefined && !isStr(n.path)) errors.push(`nodes[${i}] ("${n.id}"): path, when present, must be a string`);
    if (n.status !== undefined && !(isStr(n.status) && (MAP_NODE_STATUSES as readonly string[]).includes(n.status))) {
      errors.push(`nodes[${i}] ("${n.id}"): status, when present, must be one of "new", "modified", "removed", "unchanged"`);
    }
    if (n.section !== undefined && !isStr(n.section)) errors.push(`nodes[${i}] ("${n.id}"): section, when present, must be a string`);
    if (ids.has(n.id)) errors.push(`nodes[${i}]: duplicate node id "${n.id}"`);
    ids.add(n.id);
    if (!PILLAR_IDS.has(n.pillar)) errors.push(`node "${n.id}": pillar "${n.pillar}" is not a valid pillar (must be 1-5)`);
  });
  return ids;
}

function validateEdges(v: unknown, nodeIds: Set<string>, errors: string[]): void {
  if (v === undefined || (Array.isArray(v) && v.length === 0)) return;
  if (!Array.isArray(v)) { errors.push('edges must be an array'); return; }
  v.forEach((e, i) => {
    if (!isObj(e) || !isStr(e.from) || !isStr(e.to)) { errors.push(`edges[${i}] must be { from: string, to: string, label: string }`); return; }
    if (!isStr(e.label)) errors.push(`edges[${i}]: label must be a string`);
    if (!nodeIds.has(e.from)) errors.push(`edges[${i}]: from "${e.from}" is not a node id`);
    if (!nodeIds.has(e.to)) errors.push(`edges[${i}]: to "${e.to}" is not a node id`);
  });
}

function validateFlows(v: unknown, nodeIds: Set<string>, errors: string[]): void {
  if (v === undefined || (Array.isArray(v) && v.length === 0)) return;
  if (!Array.isArray(v)) { errors.push('flows must be an array'); return; }
  v.forEach((f, i) => {
    if (!isObj(f) || !isStr(f.id) || !isStr(f.name) || !Array.isArray(f.steps)) {
      errors.push(`flows[${i}] must be { id: string, name: string, steps: [...], description: string }`);
      return;
    }
    if (!isStr(f.description)) errors.push(`flows[${i}] ("${f.id}"): description must be a string`);
    (f.steps as unknown[]).forEach((s, j) => {
      if (!isObj(s) || !isStr(s.node) || !isStr(s.note)) { errors.push(`flow "${f.id}" step ${j + 1} must be { node: string, note: string }`); return; }
      if (!nodeIds.has(s.node)) errors.push(`flow "${f.id}" step ${j + 1}: node "${s.node}" is not a node id`);
    });
  });
}

function validateKeyFiles(v: unknown, errors: string[]): void {
  if (v === undefined || (Array.isArray(v) && v.length === 0)) return;
  if (!Array.isArray(v)) { errors.push('keyFiles must be an array'); return; }
  v.forEach((k, i) => {
    if (!isObj(k) || !isStr(k.path) || !isStr(k.why)) errors.push(`keyFiles[${i}] must be { path: string, why: string }`);
  });
}

function validateConventions(v: unknown, errors: string[]): void {
  if (v === undefined || (Array.isArray(v) && v.length === 0)) return;
  if (!Array.isArray(v)) { errors.push('conventions must be an array'); return; }
  v.forEach((c, i) => { if (!isStr(c)) errors.push(`conventions[${i}] must be a string`); });
}
