// The A2 redesign port's rules, tested where they are decidable without a
// browser. jsdom has no layout engine and this suite loads no <style>, so
// NOTHING here asserts a colour, a radius or a position — those claims are the
// Playwright probe's and the owner's eye. What IS decidable: which rows the
// empty-state gate counts, what the scroll anchor says about a tail of
// messages, and that the re-pin keeps re-assigning against a bottom that moves.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { hasConversation } from '../panes/chatEmptyGate';
import { anchorCounts, anchorLabel } from '../panes/scrollAnchor';
import { isPinning, pinToBottom } from '../panes/chatPin';
import { isLive, settleDelay, SETTLE_MS } from '../components/streamSettle';
import { spotPercent } from '../../shared/spotlight';
import type { Message } from '../panes/chatMessage';

let next = 1;
function msg(kind: Message['kind'], extra: Partial<Message> = {}): Message {
  return { id: next++, kind, label: '', text: '', timestamp: 0, ...extra } as Message;
}

describe('empty-state gate — the crane never draws over content', () => {
  it('a session holding ONLY a tool card is not empty (the defect)', () => {
    expect(hasConversation([msg('system'), msg('tool', { toolName: 'read' })])).toBe(true);
  });

  it('a session holding ONLY a thought is not empty', () => {
    expect(hasConversation([msg('thought')])).toBe(true);
  });

  it('an error, a peer handoff and a dropped-stream alert all count as content', () => {
    for (const kind of ['error', 'peer', 'streamDrop'] as const) {
      expect(hasConversation([msg(kind)]), kind).toBe(true);
    }
  });

  it('pane scaffolding alone still shows the empty state', () => {
    expect(hasConversation([msg('system'), msg('verdict'), msg('todoSummary'), msg('compacted')])).toBe(false);
    expect(hasConversation([])).toBe(false);
  });
});

describe('scroll anchor — counted off the MESSAGE LIST, not the DOM', () => {
  it('counts only what landed AFTER the row the reader had seen', () => {
    const seen = msg('agent');
    const rows = [msg('user'), seen, msg('tool', { toolName: 'read' }), msg('agent')];
    expect(anchorCounts(rows, seen.id)).toEqual({ files: 1, tools: 0, thoughts: 0, messages: 1 });
  });

  it('a read/edit is a FILE operation even before its card has painted a path', () => {
    // The mock had to read `.tool-path` off the DOM and filed these as plain
    // tools until the path committed; the row itself always knew.
    const rows = [msg('user'), msg('tool', { toolName: 'read' }), msg('tool', { toolName: 'write' })];
    expect(anchorCounts(rows, rows[0].id).files).toBe(2);
  });

  it('a tool with no file family is a plain tool, and a thought is a thought', () => {
    const rows = [msg('user'), msg('tool', { toolName: 'bash' }), msg('thought')];
    expect(anchorCounts(rows, rows[0].id)).toEqual({ files: 0, tools: 1, thoughts: 1, messages: 0 });
  });

  it('wording: fixed order, zeros omitted, singular when one', () => {
    const rows = [
      msg('user'),
      msg('tool', { toolName: 'read' }), msg('tool', { toolName: 'read' }),
      msg('tool', { toolName: 'bash' }),
      msg('thought'),
      msg('agent'), msg('agent'),
    ];
    expect(anchorLabel(rows, rows[0].id)).toBe('2 files · 1 tool · 1 thought · 2 messages');
  });

  it('no marker, or a marker a rewind dropped, means NO pill rather than "everything is new"', () => {
    const rows = [msg('user'), msg('agent')];
    expect(anchorLabel(rows, null)).toBe('');
    expect(anchorLabel(rows, 999999)).toBe('');
  });

  it('nothing arrived since the marker → empty label, so the pill stays away', () => {
    const rows = [msg('user'), msg('agent')];
    expect(anchorLabel(rows, rows[1].id)).toBe('');
  });
});

describe('re-pin — one assignment loses to a message landing mid-click', () => {
  function scroller(height: number) {
    return { scrollTop: 0, scrollHeight: height, clientHeight: 100 } as unknown as Element & {
      scrollTop: number; scrollHeight: number;
    };
  }

  it('keeps re-assigning across frames, so a later arrival is still caught', () => {
    const el = scroller(500);
    const frames: Array<() => void> = [];
    pinToBottom(el, (cb) => frames.push(cb), 3);
    expect(el.scrollTop).toBe(500);
    // A message lands between the click and the next frame: the bottom moved.
    el.scrollHeight = 900;
    frames.shift()!();
    expect(el.scrollTop).toBe(900);
  });

  it('flags `pinning` while it runs and clears it at the last frame, so our own scroll handler does not read the attempt as the reader moving away', () => {
    const el = scroller(500);
    const frames: Array<() => void> = [];
    pinToBottom(el, (cb) => frames.push(cb), 2);
    expect(isPinning(el)).toBe(true);
    frames.shift()!();
    expect(isPinning(el)).toBe(false);
  });
});

describe('streaming settle', () => {
  it('live while the text is still arriving', () => {
    expect(isLive(true, 1000, 1000 + SETTLE_MS - 1)).toBe(true);
  });

  it('settles after 420ms of quiet, even though the turn is still open', () => {
    expect(isLive(true, 1000, 1000 + SETTLE_MS)).toBe(false);
  });

  it('a row that is no longer the open message is settled whatever its timings say', () => {
    expect(isLive(false, 1000, 1000)).toBe(false);
    expect(settleDelay(false, 1000, 1000)).toBeNull();
  });

  it('asks to be woken exactly when the quiet window ends', () => {
    expect(settleDelay(true, 1000, 1100)).toBe(SETTLE_MS - 100);
    expect(settleDelay(true, 1000, 9999)).toBe(0);
  });
});

describe('spotlight geometry', () => {
  it('reports the pointer as a percentage of the box', () => {
    expect(spotPercent(150, 100, 200)).toBe(25);
  });

  it('clamps a pointer that lands a fraction outside, and survives a zero-size box', () => {
    expect(spotPercent(90, 100, 200)).toBe(0);
    expect(spotPercent(400, 100, 200)).toBe(100);
    expect(spotPercent(5, 0, 0)).toBe(50);
  });
});

// t-qi09w0 item 1 — the A2 pill wrapper around the chat stream, reverted.
// Read off the CSS SOURCE, not a computed style: this suite loads no <style>,
// so getComputedStyle would return '' for every one of these and the test
// would pass on a file that still carried the wrapper.
describe('the chat stream wears NO wrapper surface', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const pane = readFileSync(path.join(here, '..', 'panes', 'ChatPane.svelte'), 'utf8');

  /** The body of one CSS rule in the pane's <style>, by exact selector. */
  function ruleBody(selector: string): string {
    // Anchored at a line start so `.chat-cell` cannot match inside
    // `.chat-cell.single`; EOL-agnostic, since this file and the pane can be
    // checked out with different line endings.
    const literal = selector.replace(/\./g, '\\.');
    const m = new RegExp(`^\\s*${literal}\\s*\\{([^}]*)\\}`, 'm').exec(pane);
    expect(m, `${selector} rule exists`).not.toBeNull();
    return m![1];
  }

  it('the pane is not inset and paints no background of its own', () => {
    const body = ruleBody('.chat-pane');
    expect(body).not.toMatch(/padding\s*:/);
    expect(body).not.toMatch(/background\s*:/);
  });

  it('the cell keeps a hairline edge, not a pill: no 14px radius and no drop shadow', () => {
    const body = ruleBody('.chat-cell');
    expect(body).toMatch(/border-radius:\s*4px/);
    expect(body).not.toMatch(/box-shadow\s*:/);
  });

  it('single mode dissolves the cell again — the layout most people use has no card', () => {
    const body = ruleBody('.chat-cell.single');
    expect(body).toMatch(/background:\s*transparent/);
    expect(body).toMatch(/border:\s*none/);
    expect(body).toMatch(/border-radius:\s*0/);
  });
});
