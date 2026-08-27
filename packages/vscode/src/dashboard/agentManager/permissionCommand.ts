// Tweak 1 — extract the literal shell command an approval is really about so the
// permission bar can render it verbatim. Only the shell tool writes a `command`
// into a permission ask's metadata: tool/shell.ts fires TWO asks — the in-repo
// `bash` ask (ToolKind 'execute') AND an `external_directory` ask (ToolKind
// 'other', because acp/tool.ts toToolKind has no case for it) whenever the parsed
// command references a path outside the workspace. Both carry the SAME genuine
// shell command; gating the display on kind==='execute' dropped the second one,
// so the user approved external-directory access for a command they never saw.
// Presence of a string `command` in the ask metadata already means it is a real
// shell command — surface it whenever present, never invented, kind-agnostic.
export function permissionCommand(rawInput: unknown): string | undefined {
  if (!rawInput || typeof rawInput !== 'object') return undefined;
  const cmd = (rawInput as Record<string, unknown>).command;
  return typeof cmd === 'string' && cmd.trim() ? cmd : undefined;
}
