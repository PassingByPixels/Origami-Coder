// subagentLabel.ts — WHO a sub-agent is: the facts that name it, the number it
// is known by in this chat, and the one sentence every surface prints.
//
// The defect this exists for: each surface printed the card's own header, and a
// `task` card's header is the literal word `task`. The engine titles the PENDING
// tool call with the tool name (acp/tool.ts `toolTitle` falls back to it when the
// part has no title yet) and the extension freezes a card's label after that, so
// drawer rows, dock, map nodes and todo tabs all read `task`, `task`, `task`.
//
// The facts are on the wire already: a `task` call's `rawInput` carries the
// model's own 3-5 word `description` and the `subagent_type` it asked for. Those
// are read here — never by parsing the tool name or the child session title,
// which are display strings the engine is free to reword.
//
// The ORDINAL is this file's own invention: a per-chat T-number in spawn order,
// so an agent can be named out loud ("what is T2 doing?") when three of them
// carry near-identical descriptions. It is derived from the POSITION of the card
// in the transcript, never from a clock or a counter, which is what makes it
// survive a webview reload: a recalled chat replays its message log in the order
// it was written (chatRestore.ts), so the same card lands in the same place and
// keeps its number.
//
// Pure and DOM-free, like its siblings subagentFormat.ts and subagentTiming.ts.
// SubagentMap.svelte / subagentMapNodes.ts consume `subagentLabel` and
// `subagentShort` from here too, so the map and the drawer cannot drift.

import { entryKey } from './subagentEntry';
import { beatName, passthroughKey, type RosterMessage } from './subagentPassthrough';

/** The identity fields a row carries. Declared here rather than in
 *  subagentRows.ts so that the formatter, the row that uses it and the map's own
 *  node all take the SAME shape — `SubagentRow` extends this. */
export interface SubagentIdentity {
  /** This chat's T-number for the agent, 1-based in spawn order. 0 = never
   *  numbered (a hand-built fixture, or a card with no key at all). */
  ordinal: number;
  /** The model's own 3-5 word summary of the job, off the `task` call's input.
   *  Absent against an older engine, or for a passthrough child that never made
   *  a `task` call at all. */
  description?: string;
  /** The agent type asked for (`general-purpose`, `Explore`, ...), off the same input. */
  agentType?: string;
  /** t-z1xlfy. A nested sub-agent's tier id (`T3.1.2`), set by agentTree.ts; a direct
   *  child has none and prints `T<ordinal>`. */
  short?: string;
}

/** `description` + `subagent_type` off a `task` call's `rawInput`, as the two
 *  card fields. Returns an EMPTY object for every other tool and for an input
 *  that carries neither, so a caller can spread it unconditionally and a later
 *  frame with no input never erases what an earlier one knew. */
export function taskIdentity(toolName: unknown, rawInput: unknown): {
  taskDescription?: string;
  taskAgentType?: string;
} {
  if (toolName !== 'task' || !rawInput || typeof rawInput !== 'object') return {};
  const input = rawInput as Record<string, unknown>;
  const description = typeof input.description === 'string' ? input.description.trim() : '';
  const agentType = typeof input.subagent_type === 'string' ? input.subagent_type.trim() : '';
  return {
    ...(description ? { taskDescription: description } : {}),
    ...(agentType ? { taskAgentType: agentType } : {}),
  };
}

/**
 * Every sub-agent this transcript has spawned, numbered from 1 in the order its
 * card first appeared.
 *
 * FIRST appearance, not last: a resumed sub-agent writes a second `task` card
 * for the same child session, and it must keep the number it was given rather
 * than jumping to the end of the queue. The key rule is subagentRows.ts's own —
 * the child session id, or the launcher call's id for a spawn that never reached
 * a session — so the drawer, the transcript and the tabs number the same set.
 */
export function subagentOrdinals(messages: ReadonlyArray<RosterMessage>): Map<string, number> {
  const ordinals = new Map<string, number>();
  for (const m of messages) {
    const key = subagentKey(m);
    if (key && !ordinals.has(key)) ordinals.set(key, ordinals.size + 1);
  }
  return ordinals;
}

/** Which agent a card belongs to: the child's own session, or the launcher
 *  call's id for a spawn that never reached one. subagentRows.ts's dedupe rule,
 *  named here so the transcript can look a card's T-number up by exactly the key
 *  the drawer numbered it under. */
export function subagentKey(m: RosterMessage): string | undefined {
  return entryKey(m) ?? passthroughKey(m);
}

/** One card's identity, at the number the transcript gave it. A Claude
 *  passthrough child made no `task` call, so its description is the brief the
 *  model wrote on the heartbeat (subagentPassthrough.ts) — the same string its
 *  row has always been named after. */
export function subagentIdentity(m: RosterMessage, ordinal: number): SubagentIdentity {
  const description = m.taskDescription || beatName(m);
  return {
    ordinal,
    ...(description ? { description } : {}),
    ...(m.taskAgentType ? { agentType: m.taskAgentType } : {}),
  };
}

/** The T-number on its own, for a surface with no room for prose (a todo tab).
 *  `T?` for an unnumbered row rather than `T0`, which would read as a real
 *  ordinal zero — and a blank would leave an unclickable tab. */
export function subagentShort(row: SubagentIdentity): string {
  if (row.short) return row.short;
  return row.ordinal >= 1 ? `T${row.ordinal}` : 'T?';
}

/**
 * The ONE name every sub-agent surface prints: `<type> · T<n> · <description>`.
 *
 * A missing part is DROPPED, never padded: an engine that rides no `subagent_type`
 * gives `T2 · audit the bundle`, and a card with no description at all gives
 * `Explore · T2`. Falling back to the card's own header was the obvious other
 * option and is exactly the defect — that header is the word `task`.
 */
export function subagentLabel(row: SubagentIdentity): string {
  return [row.agentType, subagentShort(row), row.description].filter(Boolean).join(' · ');
}
