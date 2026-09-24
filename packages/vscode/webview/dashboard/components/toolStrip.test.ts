// t-qmzegs item 3 — a run of tool calls is ONE stepped strip, a card showing
// only its header is a compact strip, and the tick is a mark that DRAWS.
//
// Layout and colour are not claimed here and cannot be: this suite loads no
// <style>, so a computed-style assertion would pass on an empty string. What is
// decidable in jsdom is STRUCTURE — which element wraps which, which class is
// on which node, and whether the mark's node survives a status change, which is
// the whole reason the tick animates instead of appearing already finished.
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import ChatTranscript from './ChatTranscript.svelte';
import StatusMark from './StatusMark.svelte';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ToolCard from './ToolCard.svelte';
import type { Message } from '../panes/chatMessage';

afterEach(cleanup);

let next = 1;
function tool(extra: Partial<Message> = {}): Message {
  return {
    id: next++, kind: 'tool', label: 'read src/main.ts', text: '',
    toolName: 'read', toolKind: 'read', toolStatus: 'completed', ...extra,
  } as Message;
}
function say(kind: 'agent' | 'user', text = 'hello'): Message {
  return { id: next++, kind, label: kind, text } as Message;
}

function transcript(messages: Message[], props: Record<string, unknown> = {}) {
  return render(ChatTranscript, {
    messages, sessionId: 's1', inFlight: false,
    currentThoughtMsgId: null, currentAgentMsgId: null,
    openThoughtIds: undefined, onThoughtOpenIds: () => {}, ...props,
  });
}

describe('change 21 — adjacent tool calls draw as one stepped strip', () => {
  it('two calls in one turn share a single strip', () => {
    const { container } = transcript([say('agent'), tool(), tool()]);
    const runs = container.querySelectorAll('.tool-run.stepped');
    expect(runs).toHaveLength(1);
    expect(runs[0].querySelectorAll('.tool-card')).toHaveLength(2);
  });

  it('a lone call is NOT stepped — a rail with one node connects nothing', () => {
    const { container } = transcript([say('agent'), tool()]);
    expect(container.querySelector('.tool-run')).not.toBeNull();
    expect(container.querySelector('.tool-run.stepped')).toBeNull();
  });

  it('calls either side of a turn boundary are two strips, not one', () => {
    const { container } = transcript([tool(), tool(), say('agent'), tool(), tool()]);
    expect(container.querySelectorAll('.tool-run.stepped')).toHaveLength(2);
  });

  it('each step node carries its OWN call\'s verdict, so the rail reads as progress', () => {
    const { container } = transcript([
      tool({ toolStatus: 'completed' }),
      tool({ toolStatus: 'failed' }),
    ]);
    const steps = container.querySelectorAll('.tool-run.stepped > .tool-step');
    expect(steps).toHaveLength(2);
    expect(steps[0].classList.contains('done')).toBe(true);
    expect(steps[1].classList.contains('failed')).toBe(true);
  });

  it('FOCUS MODE still folds first — the strip only groups what survived the fold', () => {
    // The fold is focusGaps.ts's and is not changed by the grouping; this is the
    // guard that the two are composed in that order. In focus view the tool
    // rows collapse into a counted divider, so there is no strip left to draw.
    const { container } = transcript([say('user'), tool(), tool(), say('agent')], { focusMode: true });
    expect(container.querySelector('.tool-run')).toBeNull();
    expect(container.querySelector('.focus-gap')).not.toBeNull();
  });
});

describe('change 18b — a card showing only its header draws as a compact strip', () => {
  it('a collapsed card is a strip', () => {
    const { container } = render(ToolCard, {
      title: 'read src/main.ts', kind: 'read', toolName: 'read',
      status: 'completed', result: 'export const x = 1;',
    });
    expect(container.querySelector('.tool-card.strip')).not.toBeNull();
  });

  it('clicking the header — the product\'s OWN expand control — opens the full card and the strip comes off', async () => {
    const { container } = render(ToolCard, {
      title: 'read src/main.ts', kind: 'read', toolName: 'read',
      status: 'completed', result: 'export const x = 1;',
    });
    await fireEvent.click(screen.getByRole('button'));
    expect(container.querySelector('.tool-result')).not.toBeNull();
    expect(container.querySelector('.tool-card.strip')).toBeNull();
  });

  it('a card carrying a live shell line is NOT a strip — it is already drawing more than its header', () => {
    const { container } = render(ToolCard, {
      title: 'npm test', kind: 'execute', toolName: 'bash', status: 'in_progress',
      shell: { startedAt: Date.now() - 2000 },
    });
    expect(container.querySelector('.tool-shell-live')).not.toBeNull();
    expect(container.querySelector('.tool-card.strip')).toBeNull();
  });
});

describe('StatusMark — the tick draws when the result lands', () => {
  it('names the verdict in the class the honest-status guards read', () => {
    for (const [status, cls] of [['done', 'check'], ['failed', 'cross'], ['running', 'spinner']] as const) {
      cleanup();
      const { container } = render(StatusMark, { status });
      expect(container.querySelector(`.status-mark.${cls}`), status).not.toBeNull();
      expect(container.querySelector('.status-mark')?.getAttribute('data-status')).toBe(status);
    }
  });

  it('the SAME node survives a running → done change, which is what makes it an animation', async () => {
    // Swapping one element for another would draw the check already finished:
    // there would be no `before` for the browser to interpolate from. This is
    // the structural half of the claim; that the transition itself runs is a
    // browser fact and is checked in the Playwright probe, not here.
    const { container, rerender } = render(StatusMark, { status: 'running' });
    const before = container.querySelector('.status-mark');
    expect(before?.classList.contains('spinner')).toBe(true);
    await rerender({ status: 'done' });
    const after = container.querySelector('.status-mark');
    expect(after).toBe(before);
    expect(after?.classList.contains('check')).toBe(true);
    expect(after?.getAttribute('data-status')).toBe('done');
  });

  it('carries both paths at all times, so neither has to be created to be drawn', () => {
    const { container } = render(StatusMark, { status: 'running' });
    expect(container.querySelector('.sm-check')).not.toBeNull();
    expect(container.querySelector('.sm-cross')).not.toBeNull();
  });
});

describe('StatusMark — the running arc spins about the track centre (owner, 0.4.157)', () => {
  const SRC = readFileSync(resolve(__dirname, 'StatusMark.svelte'), 'utf8');
  it('the ring has no attribute transform: an attribute rotate becomes a translated matrix once CSS animates transform, and the arc drifts off centre', () => {
    expect(SRC).not.toMatch(/class="sm-ring"[^>]*transform=/);
  });
  it('the -90deg start lives in the keyframes and the origin is the view box centre', () => {
    expect(SRC).toMatch(/@keyframes sm-spin \{ from \{ transform: rotate\(-90deg\); \} to \{ transform: rotate\(270deg\); \} \}/);
    expect(SRC).toMatch(/transform-box: view-box;\s*transform-origin: 12px 12px;\s*animation: sm-spin/);
  });
});

