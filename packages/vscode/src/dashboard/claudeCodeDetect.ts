// claudeCodeDetect.ts — the memo in front of discovery, plus a pill status
// and a paste-able diagnostic.
//
// Cache is PER WINDOW: dropped when the CLI path setting changes or the user
// clicks the pill to re-probe.

import { discoverClaudeCli, type ClaudeCliInfo, type DiscoveryResult } from '../claudeCode/discovery';
import { nodeDiscoveryDeps, settingValue } from '../claudeCode/discoveryNode';
import { diagnosticsText, pillTooltip } from '../claudeCode/discoveryReport';
import { writeClaudeCliHandoff } from '../claudeCode/handoff';
import { claudeProjectsRoot, listProjectDirs } from './claudeProjects';

// The promise, not the result: callers that arrive while a probe runs share it
// (activation starts one, the dashboard asks moments later).
let cached: Promise<DiscoveryResult> | undefined;

/** Drop the memo. The next ask re-probes from scratch. */
export function resetClaudeCliCache(): void { cached = undefined; }

/** The full probe trail, memoised. Each fresh probe also writes its winner to
 *  the engine's hand-off file (claudeCode/handoff.ts, t-vd9s7z) — unless a
 *  newer probe replaced it meanwhile, so an old answer never overwrites a new one. */
export function claudeCliDiscovery(): Promise<DiscoveryResult> {
  if (cached) return cached;
  const run: Promise<DiscoveryResult> = discoverClaudeCli(nodeDiscoveryDeps()).then((r) => {
    if (cached === run) writeClaudeCliHandoff(r.found);
    return r;
  }, (e: unknown) => { if (cached === run) cached = undefined; throw e; });
  cached = run;
  return run;
}

/** Start a probe and do not wait for it (activation; `fresh` after the path
 *  setting changes), so the engine's hand-off file is current before a chat asks. */
export function probeClaudeCliInBackground(fresh = false): void {
  if (fresh) resetClaudeCliCache();
  claudeCliDiscovery().catch(() => undefined);
}

/** Just the winner — what everything that only wants to SPAWN needs. */
export async function claudeCli(): Promise<ClaudeCliInfo | null> {
  return (await claudeCliDiscovery()).found ?? null;
}

/** The two test seams a host may carry. `discovery` wins: a host that supplies
 *  both means the probe trail, not just the winner. */
export interface DetectHost {
  cli?(): Promise<ClaudeCliInfo | null>;
  discovery?(): Promise<DiscoveryResult>;
}

export async function detectReport(host: DetectHost): Promise<DiscoveryResult> {
  if (host.discovery) return host.discovery();
  if (!host.cli) return claudeCliDiscovery();
  const found = await host.cli();
  return found ? { found, probes: [] } : { probes: [] };
}

export function detectCli(host: DetectHost): Promise<ClaudeCliInfo | null> {
  return detectReport(host).then((r) => r.found ?? null);
}

/**
 * The `claudeCodeStatus` post. `tooltip` is built HERE rather than in the
 * webview, so the sentence the user reads and the blob they paste come from
 * one formatter.
 */
export function statusPost(result: DiscoveryResult): Record<string, unknown> {
  const f = result.found;
  return {
    type: 'claudeCodeStatus',
    installed: !!f,
    version: f?.version ?? '',
    binary: f?.binary ?? '',
    source: f?.source ?? '',
    tooltip: pillTooltip(result),
  };
}

/** What "Origami: Claude Code — copy diagnostics" puts on the clipboard. Always
 *  a FRESH probe: the user runs it because the last answer was wrong. */
export async function claudeCliDiagnostics(): Promise<string> {
  resetClaudeCliCache();
    // The transcript root is included because "installed but History lists
    // nothing" is a different failure from "no CLI".
  const root = claudeProjectsRoot();
  return diagnosticsText(await claudeCliDiscovery(), {
    platform: process.platform,
    pathVar: process.env.PATH ?? process.env.Path ?? '',
    setting: settingValue(),
    projects: { root, folders: (await listProjectDirs(root)).length },
  });
}
