// The `annotations.audience` rider on replayed content: who this text is FOR.
// Replay (`session/load`) ships synthetic parts — interject envelopes, system
// reminders, a sub-agent `<task_result>` blob — stamped
// `annotations: { audience: ['assistant'] }`; without this reader they render as
// the human's own words. The live stream drops them instead.
//
// FAIL OPEN, the opposite of acpPeerMeta.ts: only an EXPLICIT, well-formed list
// that leaves the user out suppresses anything. `ignored` parts replay as
// `audience: ['user']`, which is why the rule is "excludes the user".

/** True when this content block is addressed away from the human and so must not
 *  be rendered as their — or the agent's — visible words. */
export function modelOnlyContent(content: unknown): boolean {
  const annotations = (content as { annotations?: { audience?: unknown } } | undefined)?.annotations;
  const audience = annotations?.audience;
  if (!Array.isArray(audience) || audience.length === 0) return false;
  return !audience.includes('user');
}
