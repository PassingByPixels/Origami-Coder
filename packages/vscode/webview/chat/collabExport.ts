// Collabs — the stream as a markdown file.
//
// Its own leaf rather than a reuse of the chat's renderSessionMarkdown: that
// renderer prints a ROLE ("Agent"), which is enough when a transcript has one
// agent in it and useless when it has four. In a collab, WHO said a line is
// most of the information, so every line here is attributed by name.
//
// The names come from the roster the pane already holds, through the SAME
// short-name rule the stream draws with — an exported document that calls an
// agent something other than what was on screen is a small lie about a
// conversation the reader was in.
//
// Flock M4.1: the export now tells the same PROTOCOL truth the stream does.
// Before this it printed ten kinds of message as one kind of paragraph, so an
// exported transcript read as prose where the room had actually run a protocol:
// an `ask` with an owner looked like a remark, a task ledger line looked like
// something an agent said, and a turn that ran twelve tools looked like a turn
// that ran none. Every rule below exists to close one of those gaps, and each
// reuses the leaf the SCREEN uses (collabKinds' kindOf/kindLabel), so the
// document and the pane cannot disagree about what a message was.
//
// Absent fields stay absent-shaped: `kind`, `mentions`, `taskId` and `trace`
// are all optional on the wire, so a message from an older engine renders
// EXACTLY as it did before this change — a name, a time and its text.

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

/** The board half of the document. Both fields are ABSENT on an engine with no
 *  board at all, which is why there is no `## Board` section then — an empty
 *  heading would report "no tasks" for a build that has no tasks to report. */
export interface CollabExportBoard {
  tasks?: CollabExportTask[];
  costTotals?: CollabExportCost[];
}

/** A system row must be ONE line: markdown italics do not survive a newline,
 *  so a multi-line task note would break the emphasis open mid-sentence. */
const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** "3 tools ran, 1 failed". Printed for a turn that HAS a trace and never
 *  synthesised for one that does not — no trace means the engine recorded
 *  none, which is not the same as a turn that ran zero tools. */
function traceLine(trace: readonly ExportTraceEntry[]): string {
  const failed = trace.filter((t) => t?.status === 'error').length;
  return `_${trace.length} tool${trace.length === 1 ? '' : 's'} ran, ${failed} failed_`;
}

/**
 * Render one collab's stream.
 *
 * `names` is the roster's slug -> displayName map; a slug the roster does not
 * know still gets a name (collabShortName falls back to the slug itself), so an
 * agent that left the roster mid-conversation is never exported as anonymous.
 * An empty stream yields the heading alone rather than an empty file — the
 * export said what it was, it simply had nothing to say yet.
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

    // Bookkeeping (task_*/system) is a LEDGER LINE, not a speech: full width,
    // one italic line, exactly as the stream draws it. A `system` line has no
    // author verb — its own text is the whole message.
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

/** The board, appended once at the end. Returns NOTHING when the engine
 *  reported no board — an empty section would be a claim about a build that
 *  never made one. */
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
