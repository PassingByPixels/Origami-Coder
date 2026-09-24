// streamDropNotice.test.ts — the stream-drop card's rules, and the MIRROR guard
// that keeps this file's declaration and src/acpStreamDrop.ts's in step
// (t-q90gj9).
//
// Why a mirror at all: tsconfig.webview.json pins rootDir to webview/, so a
// webview .ts trips TS6059 on ANY import from src/, including `import type`.
// The shape is therefore declared twice, and per the agent guide's Part 5 a
// mirror is only safe with a test that reads BOTH files. Without it the host
// could rename a field, the rider would still arrive, `asStreamDropNotice`
// would reject it, and every dropped stream would silently draw no card.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  asStreamDropNotice,
  continuesCard,
  foldStreamDrop,
  lastUserText,
  recoverOpenCard,
  settleStreamDrop,
  streamDropState,
  streamDropTitle,
  type StreamDropNotice,
} from './streamDropNotice';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, '..', '..', '..');
const read = (rel: string) => readFileSync(path.join(pkgRoot, rel), 'utf8');

/** The field names out of an `interface X { … }` block. */
function fields(src: string, name: string): string[] {
  const start = src.indexOf('interface ' + name + ' {');
  expect(start, 'no interface ' + name).toBeGreaterThan(-1);
  const body = src.slice(start, src.indexOf('\n}', start));
  return [...body.matchAll(/^ {2}(\w+)\??:/gm)].map((m) => m[1]).sort();
}

const notice = (over: Partial<StreamDropNotice> = {}): StreamDropNotice => ({
  kind: 'retrying', attempt: 1, max: 3, detail: 'fetch failed (ECONNRESET)', terminal: false, ...over,
});

describe('the mirror with src/acpStreamDrop.ts', () => {
  it('declares the same fields on both sides', () => {
    const host = read('src/acpStreamDrop.ts');
    const web = read('webview/dashboard/panes/streamDropNotice.ts');
    expect(fields(web, 'StreamDropNotice')).toEqual(fields(host, 'StreamDropNotice'));
    expect(fields(web, 'StreamDropNotice').length).toBeGreaterThan(3);
  });
});

describe('reading a notice off the wire', () => {
  it('takes a whole notice', () => {
    expect(asStreamDropNotice(notice())).toEqual(notice());
  });

  // Fail-CLOSED. A card with `undefined` in it reads as a bug in the agent
  // rather than in the gateway, so a half-written rider draws nothing.
  it.each([
    ['no kind', { attempt: 1, max: 3, detail: 'x' }],
    ['an unknown kind', { kind: 'wobbling', attempt: 1, max: 3, detail: 'x' }],
    ['a non-integer attempt', { kind: 'retrying', attempt: 1.5, max: 3, detail: 'x' }],
    ['no detail', { kind: 'retrying', attempt: 1, max: 3 }],
    ['nothing at all', undefined],
  ])('refuses %s', (_why, value) => {
    expect(asStreamDropNotice(value)).toBeUndefined();
  });
});

describe('which card is showing', () => {
  it('is retrying until prose lands', () => {
    expect(streamDropState({ notice: notice() })).toBe('retrying');
  });
  it('is recovered once prose has landed', () => {
    expect(streamDropState({ notice: notice(), recovered: true })).toBe('recovered');
  });
  it('is stopped whatever came after, because the turn is dead', () => {
    expect(streamDropState({ notice: notice({ kind: 'stopped' }), recovered: true })).toBe('stopped');
  });
  it('counts attempts with the ENGINE numbers, never its own', () => {
    expect(streamDropTitle('retrying', notice({ attempt: 2, max: 5 }))).toBe('Retrying · attempt 2 of 5');
    expect(streamDropTitle('recovered', notice({ attempt: 2, max: 5 }))).toBe('Recovered on attempt 2 of 5');
    expect(streamDropTitle('stopped', notice({ attempt: 3, max: 3 }))).toBe('Stopped after 3 of 3 attempts');
  });
});

describe('a run of notices is ONE card', () => {
  const card = (n: StreamDropNotice) => ({ kind: 'streamDrop', streamDrop: { notice: n } });

  // The defect this feature exists to undo: the engine appends a notice per
  // attempt and the text form ran them together in one bubble.
  it('folds attempt 2 onto the card attempt 1 opened', () => {
    const rows = [card(notice({ attempt: 1 }))];
    const folded = foldStreamDrop(rows, notice({ attempt: 2 }));
    expect(folded).toHaveLength(1);
    expect(folded?.[0]?.streamDrop?.notice.attempt).toBe(2);
  });

  it('opens a NEW card after a recovery, because that is a fresh failure', () => {
    const rows = [{ kind: 'streamDrop', streamDrop: { notice: notice({ attempt: 1 }), recovered: true } }];
    expect(foldStreamDrop(rows, notice({ attempt: 1 }))).toBeUndefined();
  });

  it('opens a NEW card after a stop, because that card is closed', () => {
    const rows = [card(notice({ kind: 'stopped', attempt: 3, terminal: true }))];
    expect(foldStreamDrop(rows, notice({ attempt: 1 }))).toBeUndefined();
  });

  it('opens a card when the last row is not one', () => {
    expect(foldStreamDrop([{ kind: 'agent' }], notice())).toBeUndefined();
  });

  it('agrees with continuesCard', () => {
    expect(continuesCard({ notice: notice({ attempt: 1 }) }, notice({ attempt: 2 }))).toBe(true);
    expect(continuesCard({ notice: notice({ attempt: 1 }), recovered: true }, notice({ attempt: 2 }))).toBe(false);
  });
});

describe('recovery, and the bound on it', () => {
  it('closes the open card when prose lands', () => {
    const rows = [{ kind: 'streamDrop', streamDrop: { notice: notice({ attempt: 2 }) } }];
    expect(settleStreamDrop(rows)[0]?.streamDrop?.recovered).toBe(true);
  });

  // Measured failing in the mock before the bound existed: prose replayed after
  // a spent ladder flipped a `gave up after 3` card to `recovered on attempt 3`.
  it('never resurrects a STOPPED card', () => {
    const rows = [{ kind: 'streamDrop', streamDrop: { notice: notice({ kind: 'stopped', attempt: 3 }) } }];
    expect(settleStreamDrop(rows)).toBe(rows);
    expect(recoverOpenCard(rows[0].streamDrop)).toBeUndefined();
  });

  // The bound the other way: settling only ever targets the LATEST
  // stream-drop row, so a card a later drop pushed up the transcript can
  // never be re-opened.
  it('leaves an EARLIER card alone when a newer one is open', () => {
    const rows = [
      { kind: 'streamDrop', streamDrop: { notice: notice({ attempt: 1 }) } },
      { kind: 'streamDrop', streamDrop: { notice: notice({ attempt: 2 }) } },
    ];
    const out = settleStreamDrop(rows);
    expect(out[0]?.streamDrop?.recovered).toBeUndefined();
    expect(out[1]?.streamDrop?.recovered).toBe(true);
  });

  it('leaves a list with no card alone, by identity', () => {
    const rows = [{ kind: 'agent' }];
    expect(settleStreamDrop(rows)).toBe(rows);
  });

  // t-sj3fvo reproduction: after a retry the model resumes with reasoning and
  // tool calls BEFORE any prose, so those rows land after the card without the
  // card being their immediate neighbour — the card is no longer the LAST row,
  // only the last row of its OWN kind. The old rule (`rows[rows.length - 1]`)
  // never looked past the very end and left the card stuck on 'retrying',
  // which is exactly the owner's screenshot (Thought process + two tool rows
  // after a card that stayed yellow).
  it('recovers the card even when reasoning and a tool row land after it, not just prose', () => {
    const rows = [
      { kind: 'user' },
      { kind: 'streamDrop', streamDrop: { notice: notice({ attempt: 1 }) } },
      { kind: 'thought' },
      { kind: 'tool' },
    ];
    const out = settleStreamDrop(rows);
    expect(out[1]?.streamDrop?.recovered).toBe(true);
  });

  it('does not recover a card from an earlier turn when a new turn produces output', () => {
    const rows = [
      { kind: 'user' },
      { kind: 'streamDrop', streamDrop: { notice: notice({ attempt: 1 }) } },
      { kind: 'user' },
      { kind: 'tool' },
    ];
    expect(settleStreamDrop(rows)).toBe(rows);
  });
});

describe('what Retry sends', () => {
  it('is the last thing the USER typed', () => {
    expect(lastUserText([
      { kind: 'user', text: 'first' },
      { kind: 'agent', text: 'partial' },
      { kind: 'user', text: 'second' },
      { kind: 'streamDrop', text: '' },
    ])).toBe('second');
  });
  it('is empty when the card has no prompt above it', () => {
    expect(lastUserText([{ kind: 'streamDrop', text: '' }])).toBe('');
  });
});
