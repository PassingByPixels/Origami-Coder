// discovery.ts — which `claude` binary a passthrough session spawns, and what was tried when the
// answer is none. Every candidate is recorded so a "not available" pill is debuggable from another
// machine.

import {
  fileCandidates, needsShell, type Candidate, type ProbeSource,
} from './discoveryProbes';

export type { ProbeSource } from './discoveryProbes';

/** `missing` = no such file; `not-executable` = there, but not a runnable file;
 *  `version-failed` = it ran and gave no version (wrong binary, blocked, hung). */
export type ProbeResult = 'hit' | 'missing' | 'not-executable' | 'version-failed';

export interface Probe {
  source: ProbeSource;
  path: string;
  result: ProbeResult;
  /** The version on a hit; the failure reason otherwise. */
  detail?: string;
}

export interface ClaudeCliInfo {
  binary: string;
  version: string;
  /** How it was found — shown in the pill so "not detected" is debuggable. */
  source: ProbeSource;
}

/** What a probe run produces: the winner (if any) and the full trail. */
export interface DiscoveryResult {
  found?: ClaudeCliInfo;
  probes: Probe[];
}

/** Injected so the rules test without a filesystem or a child process. */
export interface DiscoveryDeps {
  platform: string;
  env: Record<string, string | undefined>;
  /** The MACHINE-scoped `origamicoder.claudeCode.path` override, or ''. */
  setting(): string;
  /** What is at this path: a runnable file, something else, or nothing. */
  stat(path: string): 'file' | 'other' | 'none';
  /** Names directly inside a directory; [] when it does not exist. */
  listDir(dir: string): string[];
  /** Run `<binary> --version`. `shell` is true for a .cmd/.bat shim. */
  version(binary: string, shell: boolean): Promise<{ ok: true; stdout: string } | { ok: false; error: string }>;
  /** `where claude` / `which claude` — the lines it printed, plus what the call
   *  itself did, so "nothing on PATH" and "the lookup was refused" read
   *  differently in the diagnostics. */
  which(): Promise<{ hits: string[]; detail: string }>;
  /** The file a path really names (symlinks followed), or the path itself. Optional: used only so
   *  one file reached two ways is asked `--version` once. */
  realpath?(path: string): string;
}

/** `claude --version` prints e.g. `2.1.198 (Claude Code)`. Take the first
 *  dotted number and nothing else; an unrecognised banner yields ''. */
export function parseVersion(stdout: string): string {
  const m = /(\d+\.\d+(?:\.\d+)?)/.exec(stdout);
  return m ? m[1]! : '';
}

/** Semver-ish "at least" check for the floor. Missing/unparsable versions pass:
 *  refusing to run because a banner changed shape is the worse failure. */
export function meetsFloor(version: string, floor: string): boolean {
  if (!version) return true;
  const a = version.split('.').map((n) => Number(n) || 0);
  const b = floor.split('.').map((n) => Number(n) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0; const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

/** The floor is the build the stream-json contract in protocol.ts was captured
 *  from. Below it we still run — we just cannot promise the wire matches. */
export const VERSION_FLOOR = '2.1.0';

/** Strictly higher. An unparsed version ('') ranks below any parsed one. */
export function newerThan(a: string, b: string): boolean {
  return !!a && (!b || (a !== b && meetsFloor(a, b)));
}

/** One candidate: stat, then `--version`. The row it records, and the hit if it answered. */
async function probeOne(deps: DiscoveryDeps, c: Candidate): Promise<{ probe: Probe; found?: ClaudeCliInfo }> {
  const row = { source: c.source, path: c.path };
  const kind = deps.stat(c.path);
  if (kind !== 'file') return { probe: { ...row, result: kind === 'none' ? 'missing' : 'not-executable' } };
  const out = await deps.version(c.path, c.shell);
  if (!out.ok) return { probe: { ...row, result: 'version-failed', detail: out.error } };
  const version = parseVersion(out.stdout);
  const detail = version || out.stdout.trim().slice(0, 60);
  return { probe: { ...row, result: 'hit', detail }, found: { binary: c.path, version, source: c.source } };
}

/** The setting, when it answers, wins outright: it is the user's explicit answer. Otherwise every
 *  other source is probed (PATH, then the file table) and the NEWEST binary that answers
 *  `--version` wins; a tie keeps probe order (t-vd9s7z: an old CLI on PATH hid the VS Code
 *  extension's newer one). A stale shim is a file too, so only an answer counts as a hit. Each file
 *  is asked once (same real path; any case on win32), in parallel. Every row is recorded in order. */
export async function discoverClaudeCli(deps: DiscoveryDeps): Promise<DiscoveryResult> {
  const probes: Probe[] = [];
  const seen = new Set<string>();
  const fresh = (p: string): boolean => {
    const real = deps.realpath?.(p) ?? p;
    const key = deps.platform === 'win32' ? real.toLowerCase() : real;
    return seen.has(key) ? false : (seen.add(key), true);
  };

  const configured = deps.setting().trim();
  if (configured && fresh(configured)) {
    const row = await probeOne(deps, { source: 'setting', path: configured, shell: needsShell(configured) });
    probes.push(row.probe);
    if (row.found) return { found: row.found, probes };
  }

  const path = await deps.which();
  if (!path.hits.length) probes.push({ source: 'path', path: 'claude', result: 'missing', detail: path.detail });
  const onPath = path.hits.map((h) => h.trim()).filter((h) => h.length > 0)
    .map((h): Candidate => ({ source: 'path', path: h, shell: needsShell(h) }));
  const candidates = [...onPath, ...fileCandidates(deps.platform, deps.env, deps.listDir)].filter((c) => fresh(c.path));

  let found: ClaudeCliInfo | undefined;
  for (const row of await Promise.all(candidates.map((c) => probeOne(deps, c)))) {
    probes.push(row.probe);
    if (row.found && (!found || newerThan(row.found.version, found.version))) found = row.found;
  }
  return found ? { found, probes } : { probes };
}
