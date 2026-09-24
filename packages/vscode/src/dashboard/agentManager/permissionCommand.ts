// Extract the literal shell command a permission ask is really about so the bar can render
// it verbatim. The shell tool fires two asks for one command — the in-repo `bash` ask and,
// when the command references an out-of-workspace path, an `external_directory` ask (kind
// 'other', no case in toToolKind) — and both carry the same shell command. Gating the
// display on kind==='execute' dropped the second, so a user could approve external-directory
// access for a command they never saw; surface `command` whenever present, kind-agnostic.
export function permissionCommand(rawInput: unknown): string | undefined {
  if (!rawInput || typeof rawInput !== 'object') return undefined;
  const cmd = (rawInput as Record<string, unknown>).command;
  return typeof cmd === 'string' && cmd.trim() ? cmd : undefined;
}
