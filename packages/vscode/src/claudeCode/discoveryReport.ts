// discoveryReport.ts — turning a probe trail into something a user can paste. The tooltip
// (probeSummary) and the clipboard blob (diagnosticsText) must stay in sync, so both are formatted
// here rather than in the webview.

import { CLAUDE_PATH_SETTING, SOURCE_LABELS, sourceLabel } from './discoveryProbes';
import type { DiscoveryResult, Probe, ProbeResult } from './discovery';

/** Most informative first: a source with one missing row and one that ran and
 *  failed should report the failure, because that is the actionable half. */
const RANK: ProbeResult[] = ['hit', 'version-failed', 'not-executable', 'missing'];

function verdictOf(rows: Probe[]): ProbeResult {
  for (const r of RANK) if (rows.some((p) => p.result === r)) return r;
  return 'missing';
}

/**
 * "PATH (missing), npm global (missing), native install (missing), …"
 *
 * Sources never reached — everything after the hit, and an unset setting — are omitted rather than
 *  guessed at.
 */
export function probeSummary(probes: Probe[]): string {
  const parts: string[] = [];
  for (const [source, label] of SOURCE_LABELS) {
    const rows = probes.filter((p) => p.source === source);
    if (!rows.length) continue;
    parts.push(`${label} (${verdictOf(rows)})`);
  }
  return parts.join(', ');
}

/** The pill's tooltip, both ways round. */
export function pillTooltip(result: DiscoveryResult): string {
  const f = result.found;
  if (f) {
    const via = sourceLabel(f.source);
    return `Claude Code ${f.version} — passthrough (${f.binary}, via ${via}); click to open a Claude Code chat`;
  }
  const tried = probeSummary(result.probes) || 'nothing';
  return `Claude Code — not found. Probed: ${tried}. Set ${CLAUDE_PATH_SETTING} to point at it, `
    + 'or run "Origami: Claude Code — copy diagnostics". Click to probe again.';
}

export interface DiagnosticsEnv {
  platform: string;
  /** The extension host's own PATH — the value `where claude` searched. */
  pathVar: string;
  /** Whatever `origamicoder.claudeCode.path` is set to right now. */
  setting: string;
  /** The transcript root and Labyrinth scan, and how many project folders were found — the facts an
   *  "it finds no sessions" report needs. Absent means the caller did not look. */
  projects?: { root: string; folders: number };
}

/**
 * The clipboard blob. Plain text and deliberately complete: it is pasted into a chat by someone on
 *  a machine we cannot reach, and a missing field costs a round trip.
 */
export function diagnosticsText(result: DiscoveryResult, env: DiagnosticsEnv): string {
  const lines = [
    'Origami — Claude Code discovery diagnostics',
    `platform: ${env.platform}`,
    `${CLAUDE_PATH_SETTING}: ${env.setting || '(unset)'}`,
    ...(env.projects ? [`transcripts: ${env.projects.root} (${env.projects.folders} project folders)`] : []),
    result.found
      ? `found: ${result.found.binary}  version ${result.found.version || '(unparsed)'}  via ${sourceLabel(result.found.source)}`
      : 'found: NOTHING',
    `probes (${result.probes.length}, in order):`,
  ];
  result.probes.forEach((p, i) => {
    lines.push(`  ${String(i + 1).padStart(2)}. [${sourceLabel(p.source)}] ${p.path}`);
    lines.push(`      ${p.result}${p.detail ? ` — ${p.detail}` : ''}`);
  });
  lines.push('PATH:');
  const sep = env.platform === 'win32' ? ';' : ':';
  for (const entry of env.pathVar.split(sep).filter((e) => e.trim())) lines.push(`  ${entry}`);
  return lines.join('\n');
}
