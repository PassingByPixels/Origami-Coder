// Collabs — the stream as a markdown file.
//
// Its own leaf rather than a reuse of renderSessionMarkdown: that renderer
// prints a role ("Agent"), fine for one agent, useless for four. Every line
// here is attributed by name via the stream's own short-name rule, so an
// export never calls an agent something other than what was on screen.
//
// It mirrors the stream's own protocol handling (collabKinds' kindOf/
// kindLabel), so an `ask`, a task ledger line, or a multi-tool turn reads as
// what it was, not as one flat kind of paragraph.
//
// Absent fields (`kind`, `mentions`, `taskId`, `trace`) are optional on the
// wire, so a message from an older engine renders exactly as before.

import { collabShortName } from './collabNames';
import { isSystemMessage, kindLabel, kindOf, type MessageKind } from './collabKinds';

/** Mirrors the part of `TraceEntry` this file prints. */
export interface ExportTraceEntry {
  status: 'ok' | 'error';
}

export interface CollabExportMessage {
  authorId: string;
  authorKind: 'human' | 'agent';
  text: string;
  createdAt: string;
  /** ABSENT on an older engine — read as 'say', never as an error. */
  kind?: MessageKind;
  mentions?: string[];
  taskId?: string | null;
  trace?: ExportTraceEntry[] | null;
}

/** One task, as the board holds it. Mirrors `TaskEntry`'s printed fields. */
export interface CollabExportTask {
  title: string;
  owner: string | null;
  state: 'open' | 'claimed' | 'done' | 'accepted';
}

/** One agent's summed spend. Mirrors `CollabCostTotal`. */
export interface CollabExportCost {
  agentSlug: string;
  cost: number;
  tokensInput: number;
  tokensOutput: number;
}

/** The board half of the document. Both fields are absent when the engine has
 *  no board — an empty heading would falsely say "no tasks" for a build with none. */
export interface CollabExportBoard {
  tasks?: CollabExportTask[];
  costTotals?: CollabExportCost[];
}

/** A system row must be ONE line: markdown italics do not survive a newline,
 *  so a multi-line task note would break the emphasis open mid-sentence. */
const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** "3 tools ran, 1 failed" — printed only when a turn has a trace; no trace
 *  means the engine recorded none, not that zero tools ran. */
function traceLine(trace: readonly ExportTraceEntry[]): string {
  const failed = trace.filter((t) => t?.status === 'error').length;
  return `_${trace.length} tool${trace.length === 1 ? '' : 's'} ran, ${failed} failed_`;
}

/**
 * Render one collab's stream. A slug missing from the roster still gets a
 * name (falls back to the slug), and an empty stream yields the heading
 * alone, not an empty file.
 */
export function renderCollabMarkdown(
  title: string,
  names: Record<string, string>,
  messages: CollabExportMessage[],
  board?: CollabExportBoard,
): string {
  const head = `# Origami collab — ${title.trim() || 'untitled'}`;
  const shortOf = (slug: string): string => collabShortName(slug, names[slug]);
  const whoOf = (m: CollabExportMessage): string => (m.authorKind === 'human' ? 'You' : shortOf(m.authorId));

  const blocks = messages.map((m) => {
    const who = whoOf(m);
    const label = kindLabel(m, shortOf);
    const trace = Array.isArray(m.trace) && m.trace.length ? `\n\n${traceLine(m.trace)}` : '';

    // Bookkeeping (task_*/system) prints as one italic ledger line, not a
    // speech — a `system` line has no author verb; its text is the whole message.
    if (isSystemMessage(m)) {
      const parts = [kindOf(m) === 'system' ? '' : who, label, oneLine(m.text)].filter(Boolean);
      return `_${parts.join(' — ')} · ${m.createdAt}_${trace}`;
    }

    // A directed kind names its target in the header, so a reader can follow
    // who was asked what without reconstructing it from the prose.
    const kindPart = label ? ` (${label})` : '';
    return `**${who}**${kindPart} · ${m.createdAt}\n\n${m.text}${trace}`;
  });

  return [head, ...blocks, ...boardSection(board, names)].join('\n\n') + '\n';
}

/** The board, appended once at the end. Returns nothing when the engine
 *  reported no board — an empty section would claim a build that never made one. */
function boardSection(board: CollabExportBoard | undefined, names: Record<string, string>): string[] {
  const tasks = board?.tasks;
  const costs = board?.costTotals;
  if (!tasks?.length && !costs?.length) return [];

  const out = ['## Board'];
  for (const t of tasks ?? []) {
    // An unowned task says so rather than printing an empty column — "nobody
    // has claimed this" is the single most useful fact on an open task.
    const owner = t.owner ? collabShortName(t.owner, names[t.owner]) : 'unowned';
    out.push(`- **${t.state}** · ${owner} · ${oneLine(t.title)}`);
  }
  if (costs?.length) {
    const total = costs.reduce((n, c) => n + (Number(c.cost) || 0), 0);
    const tokens = costs.reduce((n, c) => n + (Number(c.tokensInput) || 0) + (Number(c.tokensOutput) || 0), 0);
    out.push(`Totals: ${costs.length} agent${costs.length === 1 ? '' : 's'} · ${tokens.toLocaleString()} tokens · $${total.toFixed(4)}`);
  }
  return [out.join('\n')];
}
