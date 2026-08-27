// The `annotations.audience` rider on replayed content: "who is this text FOR".
//
// Its own leaf beside acpPeerMeta.ts / acpTaskMeta.ts, which decode the other
// riders acpClient.ts routes on — that file sits exactly on its line cap, and
// the ratchet's remedy is a module, not a bigger number.
//
// WHY IT EXISTS. The engine writes conversation parts flagged `synthetic`: the
// interject envelope (session/prompt.ts), plan-mode preambles, system reminders,
// a background sub-agent's `<task_result>` blob (tool/task.ts), compaction
// scratch. They are instructions the MODEL reads and the human must never see.
// The LIVE stream never emits them — acp/run-steps.ts drops
// `part.synthetic || part.ignored`, and acp/event.ts forwards a live user text
// part only when it carries a peer rider. REPLAY does not: on `session/load`,
// acp/content.ts's partToContentChunks stamps a synthetic part with
// `annotations: { audience: ['assistant'] }` and ships it anyway. Without this
// reader, a reloaded chat rendered the model's own instructions as the human's
// words — the interject envelope directly under the user's name.
//
// FAIL OPEN, and that is the opposite of acpPeerMeta.ts on purpose. There, a
// half-formed rider must read as no rider because mislabelling the operator's
// words is worse than losing a badge. Here the cost is reversed: suppressing a
// turn is silent data loss from the transcript, while a stray instruction line
// is visible and reportable. So only an EXPLICIT, well-formed audience list that
// leaves the user out suppresses anything; anything else renders.
//
// The inverse flag round-trips through the same field: `ignored` parts (text the
// human sees and the model does not) replay as `audience: ['user']`, which is
// why the rule is "excludes the user", not "carries an audience".

/** True when this content block is addressed away from the human and so must not
 *  be rendered as their — or the agent's — visible words. */
export function modelOnlyContent(content: unknown): boolean {
  const annotations = (content as { annotations?: { audience?: unknown } } | undefined)?.annotations;
  const audience = annotations?.audience;
  if (!Array.isArray(audience) || audience.length === 0) return false;
  return !audience.includes('user');
}
