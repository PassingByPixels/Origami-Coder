// The live pill grew a BRAIN BLOCK. A collab turn runs for minutes; the
// one-line activity says what the agent is on right now, and `liveThought`
// says everything it has reasoned so far. Two fields, because they answer two
// questions — and the pill has to keep them apart:
//
//   - the SUMMARY stays the one-line activity. Putting 4000 characters of
//     reasoning on the summary line would be a row that fills the pane.
//   - the BODY becomes the thought. It grows in place as polls land, and the
//     block stays COLLAPSED while it grows, or the transcript jumps under the
//     reader every second.
//   - EITHER field may be absent, independently, on any engine. An
//     activity-only build keeps today's pill exactly; neither still says
//     "thinking…" rather than drawing a blank row.
//
// The dishonest failures are the ones worth catching: a body that shows the
// activity line when a whole thought was available (the block would say less
// than it was given), and a block that claims a thought when the engine sent
// none.

import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import CollabStream from './CollabStream.svelte';
import { livePills, THOUGHT_MAX } from './collabActivity';

const NAMES = { 'collab-crane': 'Crane - the builder' };
const mount = (props: Record<string, unknown> = {}) =>
  render(CollabStream, { messages: [], loaded: true, names: NAMES, glyphs: {}, ...props });

const pill = (c: Element) => c.querySelector('.cs-pill') as HTMLElement;
const block = (c: Element) => pill(c).querySelector('details.thought-block') as HTMLDetailsElement;
const summary = (c: Element) => block(c).querySelector('.thought-label')!.textContent ?? '';
const body = (c: Element) => block(c).querySelector('.thought-text')!.textContent ?? '';
const brain = (c: Element) => (pill(c).querySelector('summary')!.textContent ?? '').includes('🧠');

const running = (over: Record<string, unknown> = {}) => [{ slug: 'collab-crane', state: 'running', ...over }];

afterEach(() => cleanup());

describe('CollabLivePill — the thought block', () => {
  it('puts the ACTIVITY on the summary and the whole THOUGHT in the body', () => {
    const { container } = mount({
      agents: running({
        liveActivity: { kind: 'thought', text: 'weighing two parser designs' },
        liveThought: 'first I read the schema\nthen I weighed two parser designs',
      }),
    });
    expect(summary(container)).toContain('weighing two parser designs');
    expect(body(container)).toBe('first I read the schema\nthen I weighed two parser designs');
  });

  // W2 (report 1.12 / F11) REVERSES the M4.2 default this test used to pin.
  // Collapsed-while-streaming was chosen so a growing thought could not shove
  // the transcript around — but the stream now FOLLOWS itself (report 1.11,
  // collabStreamFollow.ts), so that movement is the follow doing its job, and
  // the price was a room showing one line and a ring while four agents worked.
  it('renders OPEN while the turn runs, so a working room shows its reasoning', () => {
    const { container } = mount({ agents: running({ liveThought: 'thinking out loud' }) });
    expect(block(container).open).toBe(true);
    // ...and it is still a real disclosure: a summary to fold it away with.
    expect(block(container).querySelector('summary')).not.toBeNull();
    expect(body(container)).toBe('thinking out loud');
  });

  // Nothing to read is not worth opening: the body would be the "nothing
  // reported yet" placeholder, which says less than the summary already does.
  it('stays shut when the engine sent an activity but no reasoning', () => {
    const { container } = mount({ agents: running({ liveActivity: { kind: 'tool', text: 'read src/x.ts' } }) });
    expect(block(container).open).toBe(false);
  });

  it('the body ACCUMULATES in place as polls land — the same block, more text', async () => {
    const { container, rerender } = mount({
      agents: running({ liveActivity: { kind: 'thought', text: 'reading' }, liveThought: 'step one' }),
    });
    const first = block(container);
    expect(body(container)).toBe('step one');

    await rerender({
      messages: [], loaded: true, names: NAMES, glyphs: {},
      agents: running({ liveActivity: { kind: 'thought', text: 'weighing' }, liveThought: 'step one\nstep two' }),
    });
    expect(body(container)).toBe('step one\nstep two');
    expect(summary(container)).toContain('weighing');
    // The SAME element grew; it was not torn down and rebuilt, which would
    // throw away an expansion the reader had opened.
    expect(block(container)).toBe(first);
  });

  it('marks a thought with the brain, and a plain tool line without one', () => {
    const withThought = mount({ agents: running({ liveActivity: { kind: 'tool', text: 'read parser.ts' }, liveThought: 'why I read it' }) });
    expect(brain(withThought.container)).toBe(true);
    cleanup();

    const toolOnly = mount({ agents: running({ liveActivity: { kind: 'tool', text: 'read parser.ts' } }) });
    expect(brain(toolOnly.container)).toBe(false);
  });
});

describe('CollabLivePill — every engine still reads honestly', () => {
  // An older engine sends no liveThought at all. The pill it earned is the one
  // it keeps: the activity in the summary AND in the body, exactly as before.
  it('an ACTIVITY-ONLY engine keeps today\'s pill, byte for byte', () => {
    const { container } = mount({ agents: running({ liveActivity: { kind: 'tool', text: 'grep -n parse src/' } }) });
    expect(summary(container)).toContain('grep -n parse src/');
    expect(body(container)).toBe('grep -n parse src/');
    expect(block(container).querySelector('.thought-label')!.classList.contains('mono')).toBe(true);
  });

  it('neither field says "thinking…" and admits the engine reported nothing', () => {
    const { container } = mount({ agents: running() });
    expect(summary(container)).toContain('thinking');
    expect(body(container)).toContain('Nothing reported yet');
  });

  // A thought with NO activity is a real wire state (reasoning before the first
  // tool call). The summary has nothing to say, so it says the honest thing.
  it('a THOUGHT with no activity still reads the thought, under a "thinking…" summary', () => {
    const { container } = mount({ agents: running({ liveThought: 'no tool yet, still reading' }) });
    expect(summary(container)).toContain('thinking');
    expect(body(container)).toBe('no tool yet, still reading');
    expect(brain(container)).toBe(true);
  });

  it('a pill is still ONLY for a running agent — a thought on an idle one is stale, not live', () => {
    const { container } = mount({
      agents: [
        { slug: 'collab-crane', state: 'idle', liveThought: 'left over from last turn' },
        { slug: 'collab-heron', state: 'queued', liveThought: 'not started' },
      ],
    });
    expect(container.querySelectorAll('.cs-pill')).toHaveLength(0);
  });
});

// The leaf's own input classes — the shapes a wire can arrive in that a
// rendered test cannot reach comfortably.
describe('collabActivity — liveThought is validated like everything else', () => {
  it('a non-string thought is NO thought, not a rendered "42"', () => {
    expect(livePills([{ slug: 'a', state: 'running', liveThought: 42 }])[0].thought).toBe('');
    expect(livePills([{ slug: 'a', state: 'running', liveThought: { text: 'x' } }])[0].thought).toBe('');
    expect(livePills([{ slug: 'a', state: 'running', liveThought: null }])[0].thought).toBe('');
  });

  it('re-applies the engine\'s own 4000-char bound, so a mis-bounded build cannot flood the block', () => {
    const long = 'x'.repeat(THOUGHT_MAX + 500);
    expect(livePills([{ slug: 'a', state: 'running', liveThought: long }])[0].thought).toHaveLength(THOUGHT_MAX);
  });

  // The bound is 20x the activity's on purpose: the two are different things,
  // and cutting a whole reasoning trace to 200 chars would make it useless.
  it('the thought bound is far larger than the activity bound', () => {
    const long = 'y'.repeat(1000);
    const [p] = livePills([{ slug: 'a', state: 'running', liveActivity: { kind: 'thought', text: long }, liveThought: long }]);
    expect(p.text).toHaveLength(200);
    expect(p.thought).toHaveLength(1000);
  });

  it('the two fields are independent — either can arrive without the other', () => {
    expect(livePills([{ slug: 'a', state: 'running', liveThought: 'only a thought' }]))
      .toEqual([{ slug: 'a', kind: '', text: '', thought: 'only a thought' }]);
    expect(livePills([{ slug: 'a', state: 'running', liveActivity: { kind: 'tool', text: 'ls' } }]))
      .toEqual([{ slug: 'a', kind: 'tool', text: 'ls', thought: '' }]);
  });
});
