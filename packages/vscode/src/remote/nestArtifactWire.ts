// What two desks say to each other about ARTIFACTS (t-sj39jx, artifacts lane
// 4), beside nestWire.ts's session verbs on the same sealed pairwise link:
//
//   nest/artifact-index    {rows}                                  this desk's nest_artifact_index rows
//   nest/artifact-request  {artifactId, version, sha256?, offset?} "send me that manifest / that piece"
//   nest/artifact-chunk    {chunk}                                 one nest_artifact_export reply
//
// A message over 32 KB rides the frame chunker. Everything off the wire is
// UNTRUSTED: a malformed message reads as null and is dropped, and the engine
// checks every field again before it writes.

export const NEST_ARTIFACT_INDEX = 'nest/artifact-index';
export const NEST_ARTIFACT_REQUEST = 'nest/artifact-request';
export const NEST_ARTIFACT_CHUNK = 'nest/artifact-chunk';

/** Desk-to-desk only: spread into nestWire.ts NEST_GROUP_VERBS, so the phone is refused them. */
export const NEST_ARTIFACT_VERBS: readonly string[] = [NEST_ARTIFACT_INDEX, NEST_ARTIFACT_REQUEST, NEST_ARTIFACT_CHUNK];

export type NestArtifactMessage =
  | { type: typeof NEST_ARTIFACT_INDEX; rows: unknown[] }
  | { type: typeof NEST_ARTIFACT_REQUEST; artifactId: string; version: number; sha256?: string; offset?: number }
  | { type: typeof NEST_ARTIFACT_CHUNK; chunk: Record<string, unknown> };

const ID = /^art_[0-9a-f]{24}$/;
const SHA = /^[0-9a-f]{64}$/;
const int = (v: unknown, min: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min;

export function isNestArtifactMessage(msg: Record<string, unknown>): boolean {
  return typeof msg['type'] === 'string' && NEST_ARTIFACT_VERBS.includes(msg['type']);
}

export function readNestArtifactMessage(msg: Record<string, unknown>): NestArtifactMessage | null {
  switch (msg['type']) {
    case NEST_ARTIFACT_INDEX:
      return Array.isArray(msg['rows']) ? { type: NEST_ARTIFACT_INDEX, rows: msg['rows'] } : null;
    case NEST_ARTIFACT_REQUEST: {
      const { artifactId, version, sha256, offset } = msg;
      if (typeof artifactId !== 'string' || !ID.test(artifactId) || !int(version, 1)) return null;
      if (sha256 === undefined) return { type: NEST_ARTIFACT_REQUEST, artifactId, version };
      if (typeof sha256 !== 'string' || !SHA.test(sha256) || !int(offset, 0)) return null;
      return { type: NEST_ARTIFACT_REQUEST, artifactId, version, sha256, offset };
    }
    case NEST_ARTIFACT_CHUNK: {
      const chunk = msg['chunk'];
      if (!chunk || typeof chunk !== 'object') return null;
      const c = chunk as Record<string, unknown>;
      if (typeof c['artifactId'] !== 'string' || !int(c['version'], 1)) return null;
      return { type: NEST_ARTIFACT_CHUNK, chunk: c };
    }
    default:
      return null;
  }
}
