// What two desks in a nest SAY to each other (t-sc093o), on the same sealed
// pairwise link as groupWire.ts's hello. Four messages:
//
//   nest/index           {rows}                 this desk's nest_index rows
//   nest/export-request  {sessionId, after}     "send me that chat after seq N"
//   nest/chunk           {chunk}                one nest_export reply
//   nest/release         {sessionId, newOwner, seq?, at?}  "I took this chat over at seq N, at time T"
//                        (t-t7lfho: `at` is the taker's clock; the old owner shows it)
//
// A message over 32 KB rides the frame chunker (chunk.ts). Everything off the
// wire is UNTRUSTED: a malformed message reads as null and is dropped.

import { encodeMessage } from './chunk';
import { NEST_ARTIFACT_VERBS, type NestArtifactMessage } from './nestArtifactWire';

export const NEST_INDEX = 'nest/index';
export const NEST_EXPORT_REQUEST = 'nest/export-request';
export const NEST_CHUNK = 'nest/chunk';
export const NEST_RELEASE = 'nest/release';

/** Desk-to-desk only. Named in groupRefusals.ts so the phone never sends one. */
export const NEST_GROUP_VERBS: readonly string[] = [NEST_INDEX, NEST_EXPORT_REQUEST, NEST_CHUNK, NEST_RELEASE, ...NEST_ARTIFACT_VERBS];

export type NestPeerMessage =
  | { type: typeof NEST_INDEX; rows: unknown[] }
  | { type: typeof NEST_EXPORT_REQUEST; sessionId: string; after: number }
  | { type: typeof NEST_CHUNK; chunk: Record<string, unknown> }
  | { type: typeof NEST_RELEASE; sessionId: string; newOwner: string; seq?: number; at?: number };

const text = (v: unknown): string => (typeof v === 'string' && v.length > 0 ? v : '');

export function readNestMessage(msg: Record<string, unknown>): NestPeerMessage | null {
  switch (msg['type']) {
    case NEST_INDEX:
      return Array.isArray(msg['rows']) ? { type: NEST_INDEX, rows: msg['rows'] } : null;
    case NEST_EXPORT_REQUEST: {
      const sessionId = text(msg['sessionId']);
      const after = msg['after'];
      if (!sessionId || typeof after !== 'number' || !Number.isInteger(after) || after < -1) return null;
      return { type: NEST_EXPORT_REQUEST, sessionId, after };
    }
    case NEST_CHUNK: {
      const chunk = msg['chunk'];
      if (!chunk || typeof chunk !== 'object' || !text((chunk as Record<string, unknown>)['sessionId'])) return null;
      return { type: NEST_CHUNK, chunk: chunk as Record<string, unknown> };
    }
    case NEST_RELEASE: {
      const sessionId = text(msg['sessionId']);
      const newOwner = text(msg['newOwner']);
      const seq = msg['seq'];
      const at = msg['at'];
      if (!sessionId || !newOwner) return null;
      return { type: NEST_RELEASE, sessionId, newOwner, ...(typeof seq === 'number' && Number.isInteger(seq) && seq >= -1 ? { seq } : {}),
        ...(typeof at === 'number' && Number.isFinite(at) && at > 0 ? { at } : {}) };
    }
    default:
      return null;
  }
}

/** The objects to seal for one message: itself, or its chunk run. */
export function nestFrames(msg: NestPeerMessage | NestArtifactMessage): Array<Record<string, unknown>> {
  return encodeMessage(msg).map((json) => JSON.parse(json) as Record<string, unknown>);
}
