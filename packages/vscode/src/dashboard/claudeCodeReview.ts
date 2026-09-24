// claudeCodeReview.ts — a second opinion from the user's own Claude Code
// install, rendered in the card the engine's reviewers already use.
//
// Picking a Claude row in the reviewer menu used to fail: the engine has no
// `claude-code` provider. The engine's own review digest is not reachable
// from here (engine code, behind an ACP method), so this builds a SMALLER
// one from `Session.messageLog` — a projection of what's visible, not engine
// truth. THE GAP IS REAL and is declared on the card: no file diffs, no
// compaction summary, bounded by the replay log's own cap.

import { ClaudeCodeDriver, type SpawnChild } from '../claudeCode/driver';
import type { ClaudeCliInfo } from '../claudeCode/discovery';
import { claudeCodeAlias } from '../claudeCode/models';
import type { ClaudeEvent } from '../claudeCode/protocol';
import type { ClaudeCodeHost } from './claudeCodeCell';
import type { SessionMessage } from './sessionLog';

/** Said on the card, under the reviewer's name. */
export const REVIEW_ATTRIBUTION = 'reviewed from the visible transcript — no file diffs';

/** Characters of digest — a flat figure deliberately under any Claude
 *  model's context, so the reviewer never spends its turn on a truncation error. */
const DIGEST_CAP = 24_000;
/** Per-entry ceiling, so one 8 KB tool result cannot eat the whole digest. */
const ENTRY_CAP = 1_500;

const PREAMBLE = [
  'You are giving a second opinion on work another AI model just did for the user.',
  '',
  'You are reading a TRANSCRIPT of that chat, not the code. You can see what was said and',
  'which tools ran, but NOT the file diffs. Judge what you can actually see, and say plainly',
  'when something cannot be judged without the diff rather than guessing at it.',
  '',
  'Be concise and specific. Lead with anything that looks wrong. Do not restate the plan back.',
  'Use no tools — answer in prose.',
  '',
  '--- transcript ---',
].join('\n');

function cut(text: string, cap: number): string {
  const flat = text.trim();
  return flat.length <= cap ? flat : `${flat.slice(0, cap)}\n…[truncated]`;
}

/**
 * The replay log → the digest text. Selected newest-first, rendered
 * oldest-first, so the budget spends on the recent half of the conversation
 * rather than running out partway through the first hour.
 */
export function reviewDigest(log: readonly SessionMessage[]): string {
  const picked: string[] = [];
  let budget = DIGEST_CAP;
  for (let i = log.length - 1; i >= 0; i--) {
    const entry = log[i]!;
    if (entry.kind === 'system') continue; // connection notices and dividers are ours, not the conversation's
    const who = entry.kind === 'user' ? 'User' : entry.kind === 'tool' ? 'Tool' : entry.kind === 'error' ? 'Error' : 'Assistant';
    const body = entry.kind === 'tool'
      ? [entry.text, typeof entry.tool?.result?.content === 'string' ? entry.tool.result.content : '']
        .filter(Boolean).join('\n')
      : entry.text;
    const line = `${who}: ${cut(body, ENTRY_CAP)}`;
    if (line.length > budget) break;
    budget -= line.length;
    picked.push(line);
  }
  picked.reverse();
  return picked.length ? `${PREAMBLE}\n${picked.join('\n\n')}` : '';
}

export interface ReviewHost {
  post(msg: Record<string, unknown>): void;
  log(line: string): void;
  cwd: string;
  spawn?: SpawnChild;
  /** Test seam. Production leaves it at `REVIEW_TIMEOUT_MS`. */
  timeoutMs?: number;
}

/**
 * How long a review may take before the card gives up. A review has no
 * cancel button and no visible process, so a stalled `claude` (network,
 * credential prompt, hung MCP handshake) used to leave a permanent spinner
 * and an orphaned process.
 */
export const REVIEW_TIMEOUT_MS = 120_000;

/** Assistant text out of one CLI event — the only thing a review reads. */
function textOf(ev: ClaudeEvent): string {
  const inner = (ev.event ?? {}) as Record<string, unknown>;
  if (ev.type === 'stream_event' && inner.type === 'content_block_delta') {
    const delta = (inner.delta ?? {}) as Record<string, unknown>;
    return delta.type === 'text_delta' && typeof delta.text === 'string' ? delta.text : '';
  }
  return '';
}

/**
 * Run one review and post the card's two messages.
 *
 * `pending` goes out first and unconditionally, so a review that failed
 * before it started still replaces a spinner. Every tool ask is denied —
 * a hung permission bar nobody is watching writes a worse answer than a refusal.
 */
export async function runClaudeReview(
  host: ReviewHost,
  cli: ClaudeCliInfo,
  modelId: string,
  base: Record<string, unknown>,
  digest: string,
): Promise<void> {
  host.post({ ...base, state: 'pending', attribution: REVIEW_ATTRIBUTION });
  if (!digest) {
    host.post({ ...base, state: 'error', error: 'This chat has no visible transcript yet — send a message first.' });
    return;
  }
  const alias = claudeCodeAlias(modelId);
  let text = '';
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
      // Dispose ALWAYS, on every exit path. A reviewer nobody is watching is
      // exactly the child that gets orphaned.
      driver.dispose();
      resolve();
    };
    const timer = setTimeout(
      () => finish(() => host.post({ ...base, state: 'error', error: `${String(base.modelLabel ?? 'Claude Code')} did not answer in time.` })),
      host.timeoutMs ?? REVIEW_TIMEOUT_MS,
    );
    (timer as { unref?: () => void }).unref?.();
    const driver = new ClaudeCodeDriver(
      {
        binary: cli.binary, cwd: host.cwd, mode: 'supervised', maxTurns: 1, isolated: true,
        // A parked reviewer is a leak, not a saving: the run is one turn long.
        idleParkMs: 0,
        ...(alias ? { model: alias } : {}),
        ...(host.spawn ? { spawn: host.spawn } : {}),
      },
      {
        onEvent: (ev) => {
          text += textOf(ev);
          if (ev.type !== 'result') return;
          finish(() => (text.trim()
            ? host.post({ ...base, state: 'ok', text: text.trim(), attribution: REVIEW_ATTRIBUTION })
            : host.post({ ...base, state: 'error', error: 'Claude Code returned no review.' })));
        },
        // Deny, with a message that tells the reviewer what to do instead —
        // otherwise a capable model reads a bare refusal as a failure and stops.
        onPermissionAsk: (ask) => driver.answerPermission(ask.requestId, false, ask.input,
          'Tools are disabled for a second opinion. Review what you were shown and answer in prose.'),
        // A one-shot reviewer holds no ask open long enough to be withdrawn; nothing to say.
        onPermissionCancel: () => {},
        onExit: (reason, expected) => {
          if (expected) return;
          finish(() => host.post({ ...base, state: 'error', error: reason }));
        },
        onLog: (line) => host.log(line),
      },
    );
    driver.prompt(digest);
  });
}

let reviewSeq = 0;

/**
 * A second opinion from the user's own Claude install.
 *
 * The id shape matches secondOpinion.ts's so the webview can't tell the two
 * producers apart — "hand the chat to the reviewer" binds the cell to the
 * model that wrote the review with no new wire. The digest is read from the
 * replay log, not the engine's message store.
 */
export async function reviewWithClaude(host: ClaudeCodeHost, cli: ClaudeCliInfo | null, sid: string, m: Record<string, unknown>): Promise<void> {
  reviewSeq += 1;
  const modelId = String(m.modelId ?? '');
  const base = {
    type: 'secondOpinionResult', id: `so-${Date.now()}-${reviewSeq}`, sessionId: sid, modelId,
    modelLabel: String(m.modelLabel ?? '') || modelId.slice(modelId.indexOf('/') + 1),
  };
  if (!cli) {
    host.post({ ...base, state: 'error', error: 'Claude Code was not found. Install it, then reload the window.' });
    return;
  }
  await runClaudeReview(
    { post: (x) => host.post(x), log: (l) => host.log(l), cwd: host.cwd, ...(host.spawn ? { spawn: host.spawn } : {}), ...(host.timeoutMs !== undefined ? { timeoutMs: host.timeoutMs } : {}) },
    cli, modelId, base, reviewDigest(host.replayLog?.(sid) ?? []),
  );
}
