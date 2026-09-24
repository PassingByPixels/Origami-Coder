// toolCards.ts — what a Claude Code tool call is called on its card, and which ACP kind draws it.
// Extracted from translator.ts at its architecture cap; re-exported so no caller changed an import.

/** ACP tool kinds, which is the vocabulary ToolCard already renders. Anything
 *  unlisted (an MCP tool, a future built-in) falls through to 'other' — a
 *  generic card, never a crash. */
const TOOL_KINDS: Record<string, string> = {
  Read: 'read', NotebookRead: 'read', Glob: 'search', Grep: 'search',
  Edit: 'edit', Write: 'edit', NotebookEdit: 'edit', MultiEdit: 'edit',
  Bash: 'execute', BashOutput: 'execute', KillShell: 'execute',
  WebFetch: 'fetch', WebSearch: 'fetch',
  // `Agent` is CLI 2.1.198's BACKGROUND launcher — the same family as `Task`,
  // and the drawer derives its row from the same card (subagentClose.ts).
  Task: 'think', Agent: 'think', TodoWrite: 'other', ExitPlanMode: 'think',
};

export function toolKind(name: string): string {
  return TOOL_KINDS[name] ?? 'other';
}

/** The one-line card label. The path/command is what the user actually scans
 *  for, so it rides the title when the input carries one. */
export function toolTitle(name: string, input: Record<string, unknown>): string {
  const detail = ['file_path', 'path', 'pattern', 'command', 'url', 'description']
    .map((k) => (typeof input[k] === 'string' ? (input[k] as string) : ''))
    .find((v) => v.length > 0);
  return detail ? `${name}: ${detail}` : name;
}
