// The round-3 Sub-agents pull-out facelift (t-qn0lpl, CHANGES.md 53): three
// lines become two, the activity tail is set as a quotation, and a RUNNING row
// reports a sane elapsed.
//
// The elapsed case is the one that is a real defect rather than a restyle, and
// it is asserted end to end — restore a logged run through the same path the
// pane uses, then read the row the drawer would draw. A test against
// subagentElapsed alone would have passed all along: that function is correct
// about the inputs it is given, and the defect is WHICH input reaches it.

import { render, cleanup } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import SubagentRow from './SubagentRow.svelte';
import { rowProps, row } from '../panes/subagentRowFixture';
import { restoreLog } from '../panes/chatRestore';
import { subagentRows } from '../panes/subagentRows';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

afterEach(cleanup);

describe('a drawer row is TWO lines, not three', () => {
  // Supersedes t-f9jxl1's three-line contract (SubagentRow.test.ts): the middle
  // line was a run of unlabelled numbers and the model sat alone under it, so a
  // fan-out of six agents cost eighteen lines of a 280px rail.
  it('the model rides the metadata line, and there is no third line', () => {
    const { container } = render(SubagentRow, rowProps({
      row: row({ elapsedMs: 125_000, model: 'openrouter/qwen3-coder' }),
    }));
    expect(container.querySelector('.sa-line3')).toBeNull();
    const line2 = container.querySelector('.sa-line2') as HTMLElement;
    expect(line2.querySelector('.sa-model')?.textContent).toBe('openrouter/qwen3-coder');
    expect(line2.querySelector('.sa-age')?.textContent).toBe('2m 05s');
  });

  // jsdom loads no <style>, so this is a SOURCE assertion: the tail is a quote
  // (a rule down its left edge) and it is CAPPED, so a chatty child cannot
  // stretch the drawer past the rail.
  it('the activity tail is set as a capped quotation', () => {
    const src = readFileSync(path.resolve(__dirname, 'SubagentRow.svelte'), 'utf8');
    const start = src.indexOf('.sa-activity {');
    expect(start).toBeGreaterThan(-1);
    const rule = src.slice(start, src.indexOf('}', start));
    expect(rule).toMatch(/border-left:\s*1px solid/);
    expect(rule).toMatch(/max-height:\s*34px/);
  });
});

describe('a RUNNING row reports a sane elapsed', () => {
  const DAY = 24 * 60 * 60 * 1000;

  // The defect, reproduced. A `task` card that was STILL RUNNING when the
  // window shut has no `taskStartedAt` — the engine merges that rider on the
  // RESULT frame — and chatRestore.ts rewrites the rebuilt card's `timestamp`
  // to the instant the step originally ran. subagentElapsed's last-resort
  // fallback then aged the row off that historical stamp, so a run recalled
  // four days later read as an agent that had been out for 96 hours.
  it('a run restored from a four-day-old log does not claim four days', () => {
    const fourDaysAgo = Date.now() - 4 * DAY;
    const restored = restoreLog<Record<string, unknown> & { id: number; kind: string }>(
      [],
      [{
        kind: 'tool', text: '', timestamp: fourDaysAgo,
        tool: {
          call: {
            toolCallId: 'call-1', toolName: 'task', kind: 'task', status: 'in_progress',
            title: 'task', taskSessionId: 'child-1',
            rawInput: { description: 'audit the tool cards', subagent_type: 'explore' },
          },
        },
      }] as never,
      (() => { let n = 0; return () => n++; })(),
      'Origami',
    );
    const [drawn] = subagentRows(restored as never, Date.now());
    expect(drawn).toBeDefined();
    expect(drawn.state).toBe('running');
    expect(drawn.elapsedMs).toBeLessThan(DAY);
  });

  // ...and the live path is untouched: a task card built this second still ages
  // from now, so the fix cannot have been "print nothing".
  it('the engine’s own start still wins when it rides in', () => {
    const [drawn] = subagentRows(
      [{ toolName: 'task', toolCallId: 'c', taskSessionId: 'child-2', label: 'task',
         toolStatus: 'in_progress', taskStartedAt: Date.now() - 125_000 }] as never,
      Date.now(),
    );
    expect(drawn.elapsedMs).toBeGreaterThanOrEqual(125_000);
    expect(drawn.elapsedMs).toBeLessThan(130_000);
  });
});
