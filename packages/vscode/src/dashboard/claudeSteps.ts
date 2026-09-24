// claudeSteps.ts — a Claude Code transcript, projected into the SAME step
// list the Labyrinth already draws for an Origami run.
//
// Pure — no fs — mirroring the engine's own `run_steps` conventions (a user
// text part is `prompt`, assistant text `reply`, a tool call `tool`, a task
// spawn `subagent`; usage is attached once per message id to the last step it produced).
//
// Where the CLI differs: it writes one record PER CONTENT BLOCK under one
// repeated cumulative usage, so records are not deduplicated but usage IS,
// once per id. A tool call and its result are two separate records, so a
// call with no matching result is left `running` rather than given a
// fabricated end. No `cost` field — the transcript records tokens, never
// money; the Labyrinth's own price table converts. Reasoning tokens are
// reported only when above 0, since the CLI writes 0 on every non-thinking turn.
import type { RunStep } from '../acpExtTypes';

/** Hard cap on any single `preview` excerpt, in code points. The engine's own
 *  PREVIEW_LIMIT (run-steps.ts), restated because a webview .ts cannot import
 *  from the engine package. */
export const PREVIEW_LIMIT = 400;
/** A step title's text half — one line of a run index, not a paragraph. */
export const TITLE_CHARS = 80;
/** The input excerpt inside a tool step's title: the file path, or the head of
 *  the command. Shorter than TITLE_CHARS because the tool NAME shares the line. */
export const INPUT_CHARS = 60;
/** Deepest sub-agent nesting expanded, mirroring the engine's MAX_SUBAGENT_DEPTH. */
export const MAX_SUBAGENT_DEPTH = 2;

/** Tools whose call IS a sub-agent spawn — Claude Code's two names for the same thing. */
const SPAWN_TOOLS = new Set(['Task', 'Agent']);

/** One line of a transcript, after JSON.parse. Every field is optional — a
 *  foreign file format, and an unrecognised record costs its own step, never the run. */
export interface ClaudeRecord {
  type?: unknown;
  timestamp?: unknown;
  isSidechain?: unknown;
  message?: unknown;
}

/** A sub-agent transcript, keyed by the `tool_use` id that spawned it. */
export interface ClaudeChild {
  /** The run id this child is opened under — a `claude:<session>#<stem>` id. */
  runId: string;
  /** The agent's name or type, for the step's lane label. */
  agent?: string;
  records: readonly ClaudeRecord[];
}

interface Block { type?: unknown; text?: unknown; id?: unknown; name?: unknown; input?: unknown; tool_use_id?: unknown; content?: unknown; is_error?: unknown; thinking?: unknown }
interface Result { at?: number; error: boolean; text: string }
type Draft = Omit<RunStep, 'ordinal'>;
type Pending = { draft: Draft; messageId: string };

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** A record's instant, epoch ms. Unparseable is ABSENT, never 0 — the map reads
 *  a 0 as 1970 and would stretch the whole time axis to reach it. */
export function recordTime(rec: ClaudeRecord): number | undefined {
  const t = Date.parse(str(rec?.timestamp));
  return Number.isFinite(t) ? t : undefined;
}

function message(rec: ClaudeRecord): Record<string, unknown> | undefined {
  const m = rec?.message;
  return m && typeof m === 'object' ? (m as Record<string, unknown>) : undefined;
}

/** The content blocks of one record. A bare string is one text block, which is
 *  how the CLI writes a typed prompt. */
function blocks(rec: ClaudeRecord): Block[] {
  const content = message(rec)?.['content'];
  if (typeof content === 'string') return content.trim() ? [{ type: 'text', text: content }] : [];
  if (!Array.isArray(content)) return [];
  return content.filter((b): b is Block => !!b && typeof b === 'object');
}

/** Truncate on CODE POINTS so a cut never splits a surrogate pair. */
function clip(text: string, limit: number): string {
  const points = Array.from(text);
  return points.length <= limit ? text : `${points.slice(0, limit - 1).join('')}…`;
}

function preview(text: string): string | undefined {
  const trimmed = (text ?? '').trim();
  return trimmed ? clip(trimmed, PREVIEW_LIMIT) : undefined;
}

/** The engine's `firstLine`: one line, capped, with a named fallback. */
function firstLine(text: string, fallback: string): string {
  const line = (text ?? '').trim().split('\n', 1)[0]?.trim();
  return line ? clip(line, TITLE_CHARS) : fallback;
}

/** The text of a `tool_result` content, which is a string or a block array. */
export function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((p) => ((p as Block)?.type === 'text' ? str((p as Block).text) : ''))
    .filter(Boolean)
    .join('\n');
}

/**
 * The fields of a tool call worth putting in its title, WHAT before HOW —
 * listed explicitly rather than "the first key", which is whatever order
 * the model happened to emit them in.
 */
const INPUT_KEYS = ['file_path', 'notebook_path', 'path', 'pattern', 'command', 'url', 'query', 'description', 'prompt', 'subagent_type'];

/** The short excerpt after a tool's name. Empty when the input says nothing a
 *  line can carry — the title is then the bare tool name, not a bare dash. */
export function inputDetail(input: unknown): string {
  if (typeof input === 'string') return clip(input.replace(/\s+/g, ' ').trim(), INPUT_CHARS);
  if (!input || typeof input !== 'object') return '';
  const bag = input as Record<string, unknown>;
  for (const key of INPUT_KEYS) {
    const value = bag[key];
    if (typeof value === 'string' && value.trim()) return clip(value.replace(/\s+/g, ' ').trim(), INPUT_CHARS);
  }
  return '';
}

/** `Bash — git status`, or `Bash` when the input carried nothing to show. */
export function toolTitle(name: string, input: unknown): string {
  const detail = inputDetail(input);
  return detail ? `${name} — ${detail}` : name || 'Tool';
}

/**
 * Every `tool_result` in these records, keyed by the call it answers. A
 * separate pass, not a lookahead — a background shell's result can arrive
 * turns later, and a parallel batch interleaves several calls and results.
 */
function indexResults(records: readonly ClaudeRecord[]): Map<string, Result> {
  const out = new Map<string, Result>();
  for (const rec of records ?? []) {
    if (rec?.type !== 'user') continue;
    const at = recordTime(rec);
    for (const block of blocks(rec)) {
      if (block.type !== 'tool_result') continue;
      const id = str(block.tool_use_id);
      // FIRST result wins: a retried call can report twice, and the first is
      // the one that belongs to the call already projected.
      if (id && !out.has(id)) out.set(id, { at, error: block.is_error === true, text: resultText(block.content) });
    }
  }
  return out;
}

/** One tool call's step: its own start, its result's end, and what it says. */
function toolDraft(block: Block, start: number | undefined, results: Map<string, Result>, child?: ClaudeChild): Draft {
  const name = str(block.name) || 'tool';
  const spawn = SPAWN_TOOLS.has(name);
  const done = results.get(str(block.id));
  const detached = spawn && (block.input as Record<string, unknown> | undefined)?.['run_in_background'] === true;
  const base: Draft = {
    kind: spawn ? 'subagent' : 'tool',
    tool: name,
    title: toolTitle(name, block.input),
    ...(start === undefined ? {} : { startedAt: start }),
    ...(child ? { childSessionId: child.runId } : {}),
    ...(spawn && child?.agent ? { agent: child.agent } : {}),
    ...(detached ? { background: true } : {}),
  };
    // An open call has no end and no outcome — said in words on the step,
    // since a killed session can leave one behind.
  if (!done) return { ...base, status: 'running', error: 'no result' };
  // The engine's `timing`: an end with no start yields no duration rather than
  // a span measured from an instant the file never recorded.
  const span = done.at === undefined ? {}
    : { endedAt: done.at, ...(start === undefined ? {} : { durationMs: Math.max(0, done.at - start) }) };
  return {
    ...base,
    ...span,
    status: done.error ? 'error' : 'completed',
    ...(done.error ? { error: firstLine(done.text, 'The tool reported an error.') } : {}),
    ...(preview(done.text) ? { preview: preview(done.text) } : {}),
  };
}

/** One content block's step, or nothing for a block that is not an action. */
function blockDraft(rec: ClaudeRecord, block: Block, results: Map<string, Result>, child?: ClaudeChild): Draft | undefined {
  const start = recordTime(rec);
  const timing = start === undefined ? {} : { startedAt: start };
  if (block.type === 'tool_use') return toolDraft(block, start, results, child);
  if (block.type === 'thinking' || block.type === 'redacted_thinking') {
    const text = str(block.thinking) || str(block.text);
    return { kind: 'thinking', title: 'Thinking', ...timing, ...(preview(text) ? { preview: preview(text) } : {}) };
  }
  if (block.type !== 'text') return undefined; // tool_result is indexed, not drawn
  const text = str(block.text);
  if (!text.trim()) return undefined;
  const kind = rec?.type === 'user' ? 'prompt' : 'reply';
  return { kind, title: firstLine(text, kind === 'prompt' ? 'Prompt' : 'Reply'), ...timing, ...(preview(text) ? { preview: preview(text) } : {}) };
}

/** This message's recorded usage, in the projected shape. `usageMissing` rather
 *  than zeros when the record holds none — see RunStep's own contract. */
function messageUsage(msg: Record<string, unknown> | undefined): Pick<RunStep, 'tokens' | 'usageMissing'> {
  const usage = msg?.['usage'] as Record<string, unknown> | undefined;
  const input = num(usage?.['input_tokens']);
  const output = num(usage?.['output_tokens']);
  if (input === undefined || output === undefined) return { usageMissing: true };
  const read = num(usage?.['cache_read_input_tokens']);
  const write = num(usage?.['cache_creation_input_tokens']);
  const cache = read === undefined && write === undefined ? undefined
    : { ...(read === undefined ? {} : { read }), ...(write === undefined ? {} : { write }) };
  const thinking = num((usage?.['output_tokens_details'] as Record<string, unknown> | undefined)?.['thinking_tokens']);
  return {
    tokens: {
      input,
      output,
      // Above 0 only — the CLI writes 0 on every message that did no thinking.
      ...(thinking === undefined || thinking <= 0 ? {} : { reasoning: thinking }),
      ...(cache === undefined ? {} : { cache }),
    },
  };
}

interface Collect {
  readonly children: ReadonlyMap<string, ClaudeChild> | undefined;
  readonly visited: Set<string>;
  readonly out: Pending[];
}

/**
 * Append these records' steps to `out`, expanding any supplied child records
 * inline right after their spawn — push order IS the ordinal order.
 */
function collect(ctx: Collect, records: readonly ClaudeRecord[], depth: number, parentOrdinal?: number, agent?: string): void {
  const nest = depth > 0 ? { depth, ...(parentOrdinal === undefined ? {} : { parentOrdinal }), ...(agent ? { agent } : {}) } : {};
  const results = indexResults(records);
  for (const rec of records ?? []) {
    const msg = message(rec);
    const messageId = str(msg?.['id']);
    const model = str(msg?.['model']);
    for (const block of blocks(rec)) {
      const child = block.type === 'tool_use' ? ctx.children?.get(str(block.id)) : undefined;
      const draft = blockDraft(rec, block, results, child);
      if (!draft) continue;
      const ordinal = ctx.out.length;
      ctx.out.push({ draft: { ...draft, ...nest, ...(model && !draft.model ? { model } : {}) }, messageId });
      if (!child || depth >= MAX_SUBAGENT_DEPTH) continue;
      // Guards a cycle and stops one child being expanded twice when two calls
      // named the same sub-agent transcript.
      if (ctx.visited.has(child.runId)) continue;
      ctx.visited.add(child.runId);
      collect(ctx, child.records, depth + 1, ordinal, child.agent);
    }
  }
}

/**
 * A transcript's records (and optional sub-agent records) as one ordered
 * step list. Usage is attached LAST, over the finished list, since the CLI
 * splits one message across records and its final step isn't known until
 * the next id appears.
 */
export function projectClaudeSteps(
  records: readonly ClaudeRecord[],
  children?: ReadonlyMap<string, ClaudeChild>,
): RunStep[] {
  const out: Pending[] = [];
  collect({ children, visited: new Set<string>(), out }, records ?? [], 0);

  const usageById = new Map<string, Pick<RunStep, 'tokens' | 'usageMissing'>>();
  const lastById = new Map<string, number>();
  for (const rec of records ?? []) {
    if (rec?.type !== 'assistant') continue;
    const msg = message(rec);
    const id = str(msg?.['id']);
    if (id && !usageById.has(id)) usageById.set(id, messageUsage(msg));
  }
  for (let i = 0; i < out.length; i++) {
    const id = out[i]!.messageId;
    if (id && usageById.has(id)) lastById.set(id, i);
  }
  for (const [id, index] of lastById) out[index]!.draft = { ...out[index]!.draft, ...usageById.get(id)! };

  return out.map((entry, ordinal) => ({ ordinal, ...entry.draft }));
}

/** Every `tool_use` id in these records that spawned a sub-agent. What a caller
 *  needs before it can decide which sub-agent transcripts are worth reading. */
export function spawnToolIds(records: readonly ClaudeRecord[]): string[] {
  const out = new Set<string>();
  for (const rec of records ?? []) {
    if (rec?.type !== 'assistant') continue;
    for (const block of blocks(rec)) {
      if (block.type === 'tool_use' && SPAWN_TOOLS.has(str(block.name)) && str(block.id)) out.add(str(block.id));
    }
  }
  return [...out];
}
