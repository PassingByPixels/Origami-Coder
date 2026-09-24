// acpToolMeta.ts — the `_meta.origami_tool_name` rider the engine stamps on EVERY
// tool_call AND tool_call_update it emits (packages/engine/src/acp/tool.ts).
// Read through ONE accessor for both cases: two independent inline reads drifted,
// and a replayed update arriving without its matching tool_call fell back to a
// nameless card. A plain ACP server that never sets `_meta` reads as '', which the
// dashboard already treats as "unknown".
export function toolNameRider(update: unknown): string {
  const meta = (update as { _meta?: { origami_tool_name?: unknown } } | undefined)?._meta;
  return typeof meta?.origami_tool_name === 'string' ? meta.origami_tool_name : '';
}
