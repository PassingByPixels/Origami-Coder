// t-t7lfho — the hand-over words and the transcript block, as the desk that
// LOST the chat shows them. The push is the host's origami/nestIndex with the
// `away` list (src/dashboard/nestAway.ts).
import { render, cleanup } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tick } from 'svelte';
import NestAwayBlock from './NestAwayBlock.svelte';
import { awayName, awayLine, arrive } from './nestAway';
import { parseNestIndex } from './nestIndex';
import { nestPush, ROWS } from '../dashboard/__tests__/nestFixture';

afterEach(() => cleanup());

const at = new Date(2026, 8, 22, 9, 5).getTime();
async function post(data: unknown): Promise<void> {
  window.dispatchEvent(new MessageEvent('message', { data }));
  await tick();
}

describe('NestAwayBlock — the transcript row', () => {
  it('shows "Continued on <desk> at <time>" for a chat this desk gave away, and nothing for any other chat', async () => {
    const { container } = render(NestAwayBlock, { props: { sessionId: 'a-mine' } });
    await post(nestPush());
    expect(container.querySelector('.nest-away-block')).toBeNull();
    await post({ ...nestPush(), away: [{ id: 'a-mine', desk: 'dev-mac', at }] });
    expect(container.querySelector('.nest-away-block')?.getAttribute('role')).toBe('note');
    expect(container.querySelector('.nest-away-text')?.textContent).toBe(
      'Continued on MacBook at 09:05. You can read this chat here, but you cannot write in it. To write in it, click Take back here.');
    // Taken back: the record is gone from the next push, and so is the block.
    await post(nestPush());
    expect(container.querySelector('.nest-away-block')).toBeNull();
  });
  it('uses theme tokens only (CSS source: jsdom has no layout)', () => {
    const style = readFileSync(join(__dirname, 'NestAwayBlock.svelte'), 'utf-8').split('<style>')[1] ?? '';
    expect(style).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
  });
});

describe('desk names — the roster, never a device id', () => {
  const index = parseNestIndex({ ...nestPush(), away: [{ id: 'x', desk: 'dev-5090', at }] });
  it('the roster name first', () => {
    expect(awayName(index, 'dev-5090')).toBe('5090');
    expect(awayLine(index, index.away![0]!)).toBe('Continued on 5090 at 09:05');
  });
  it('a roster entry with no name of its own (the parser fills its id) falls to a row\'s name, else "another desk"', () => {
    const bare = parseNestIndex({ rows: ROWS, desks: [{ id: 'dev-5090', name: '' }] });
    expect(awayName(bare, 'dev-5090')).toBe('5090');
    expect(awayName(parseNestIndex({ rows: [], desks: [{ id: 'dev-x' }] }), 'dev-x')).toBe('another desk');
    expect(awayName(index, 'nobody-knows')).toBe('another desk');
  });
});

describe('arrive — the Continue result read from the row that was clicked', () => {
  const index = parseNestIndex(nestPush());
  const row = ROWS.find((r) => r.id === 'n-cron')!;
  it('taken: gone from the Nest, marked moved; forked: the new id, the parent kept', () => {
    expect(arrive(index, row, { result: 'taken', newId: 'n-cron' })).toEqual({ gone: 'n-cron', id: 'n-cron', arrival: { kind: 'moved', fromDesk: '5090' } });
    expect(arrive(index, row, { result: 'forked', newId: 'f1' })).toEqual({
      id: 'f1', arrival: { kind: 'forked', fromDesk: '5090', parent: { id: 'n-cron', title: row.title, desk: 'dev-5090' } } });
  });
  it('an error result, or no row asked for, records nothing', () => {
    expect(arrive(index, row, { error: 'Nests is off.' })).toBeNull();
    expect(arrive(index, undefined, { result: 'taken' })).toBeNull();
  });
});
