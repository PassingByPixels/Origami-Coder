// acpToolMeta.ts — the `_meta.origami_tool_name` rider the engine stamps on
// EVERY tool_call AND tool_call_update it emits (packages/engine/src/acp/tool.ts:
// pendingToolCall, runningToolUpdate, duplicateRunningToolUpdate,
// completedToolUpdate, errorToolUpdate all set it).
//
// Extracted so acpClient.ts's session-update switch reads it through ONE
// accessor for both cases instead of two independent inline reads drifting
// apart — replay-toolcards was exactly that drift: the tool_call_update case
// never read it at all, so a replayed/reordered update that arrived without
// its matching tool_call fell back to a nameless card (GenericCard) even
// though the engine had sent the real tool name right there on the update.
//
// A plain ACP server that never sets `_meta` sees this return '' — the
// dashboard already treats an empty toolName as "unknown" (GenericCard).
export function toolNameRider(update: unknown): string {
  const meta = (update as { _meta?: { origami_tool_name?: unknown } } | undefined)?._meta;
  return typeof meta?.origami_tool_name === 'string' ? meta.origami_tool_name : '';
}
