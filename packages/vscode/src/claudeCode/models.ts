// models.ts — the Claude Code rows the model picker offers, and the prefix that routes a pick away
// from the engine.
// The rows are static: the CLI resolves `fable`/`opus`/`sonnet`/`haiku` itself against the user's
// plan and reports the concrete id back on `system/init`, so a table of dated model ids here would
// be a second source of truth that goes stale.

/** The synthetic provider id these rows live under. NOT a configured provider:
 *  there is no baseURL, no key and nothing to probe, so `providerStatus` never
 *  lists it — see offeredProviders.ts for how the picker gets a tab anyway. */
export const CLAUDE_CODE_PROVIDER = 'claude-code';

const PREFIX = `${CLAUDE_CODE_PROVIDER}/`;

/** The aliases, in the order the picker shows them (most capable first). */
export const CLAUDE_CODE_ALIASES: readonly string[] = ['fable', 'opus', 'sonnet', 'haiku'];

const LABEL: Record<string, string> = { fable: 'Fable', opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku' };

/** One picker row, in the shape `modelOptions` already carries. */
export interface ClaudeCodeRow {
  value: string;
  name: string;
  /** Never a config model — nothing about these is written to origami.json. */
  configured: false;
  /** Honest ABSENCE, not a claim: the picker draws no chip for '' (see
   *  ModelPickerRow's `{#if visionState}`). We have no vision probe for a CLI
   *  that reads images through its own harness. */
  visionState: '';
  /** The tier-1 tab these rows ask the picker to open. Carried on the ROW
   *  because the host has no other channel to name a provider it does not
   *  configure. */
  group: string;
  /**
   * The tab's tooltip text. Separate from `group`: the label names the harness and must stay
   *  stable, while this carries the version, which changes on every CLI upgrade.
   */
  groupDetail: string;
}

/** Is this a pick the passthrough owns rather than the engine? */
export function isClaudeCodeModel(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

/** The bare alias the CLI takes on `--model` ('' for anything else). */
export function claudeCodeAlias(value: string): string {
  return isClaudeCodeModel(value) ? value.slice(PREFIX.length) : '';
}

/** `claude-code/<alias>` for an alias this file knows, else ''. */
export function claudeCodeValue(alias: string): string {
  return CLAUDE_CODE_ALIASES.includes(alias) ? `${PREFIX}${alias}` : '';
}

/**
 * The rows to append to `modelOptions`, given whatever detection found. No CLI means no rows — the
 *  group must not appear on a machine where picking it would fail.
 */
export function claudeCodeModelRows(cli: { version?: string } | null | undefined): ClaudeCodeRow[] {
  if (!cli) return [];
  const groupDetail = cli.version ? `Claude Code ${cli.version}` : 'Claude Code';
  return CLAUDE_CODE_ALIASES.map((alias) => ({
    value: `${PREFIX}${alias}`,
    name: LABEL[alias] ?? alias,
    configured: false as const,
    visionState: '' as const,
    group: 'Claude Code',
    groupDetail,
  }));
}
