// Race Compare SCREEN (S6d) — the full editor-tab compare view that replaced the
// S6c in-column numbers table. These assert the observable behaviour Passing's UAT
// demanded: for the file UNION of two siblings it renders TWO columns of REAL diff
// content (coloured add/remove lines), a "not touched" placeholder + a truncation
// notice where they apply, a working sibling gets a drift note, the selectors swap
// the compared pair, and the per-file actions post the right host messages.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/svelte';
import { tick } from 'svelte';
import RaceCompareScreen from '../panes/RaceCompareScreen.svelte';

interface Sibling { id: string; name: string; state: string; agentName: string; model: string; }
interface FileDiff { path: string; adds: number; dels: number; binary: boolean; text: string; truncated: boolean; }

const RACE_GLOBAL = '__ORIGAMI_RACE_COMPARE__';
function setRace(siblings: Sibling[]): void {
  (window as unknown as Record<string, unknown>)[RACE_GLOBAL] = { root: '/repo/a', groupId: 'g1', base: 'race', siblings };
}
function raceDiffs(diffs: Record<string, FileDiff[]>, ids: string[]): void {
  window.dispatchEvent(new MessageEvent('message', { data: { type: 'amRaceFileDiffs', ids, diffs } }));
}
const posts = () => globalThis.__vscodeApiMock.postMessage.mock.calls.map((c: unknown[]) => c[0]) as Array<Record<string, unknown>>;
const files = (c: HTMLElement) => Array.from(c.querySelectorAll('.rcs-file')) as HTMLElement[];
const fileByPath = (c: HTMLElement, p: string) => files(c).find((f) => f.querySelector('.rcs-path')!.textContent === p)!;

// A minimal but real unified-diff body — enough to classify add/context lines.
const diffText = (added: string) =>
  `diff --git a/shared.txt b/shared.txt\nindex 111..222 100644\n--- a/shared.txt\n+++ b/shared.txt\n@@ -1,2 +1,3 @@\n ctx\n-old\n+${added}\n`;

const threeSiblings: Sibling[] = [
  { id: 's1', name: 'race-1', state: 'idle', agentName: 'reviewer', model: 'lmstudio/qwen' },
  { id: 's2', name: 'race-2', state: 'working', agentName: 'tsuru', model: 'openai/gpt' },
  { id: 's3', name: 'race-3', state: 'idle', agentName: 'plan', model: 'anthropic/opus' },
];

beforeEach(() => { globalThis.__vscodeApiMock.postMessage.mockClear(); });
afterEach(() => { cleanup(); delete (window as unknown as Record<string, unknown>)[RACE_GLOBAL]; });

describe('RaceCompareScreen — mount + fetch', () => {
  it('(rs1) fetches the first two siblings on mount', async () => {
    setRace(threeSiblings);
    render(RaceCompareScreen);
    await tick();
    expect(posts().some((p) => p.type === 'amRaceFileDiffs' && (p.ids as string[]).join() === 's1,s2')).toBe(true);
  });

  it('(rs0) no injected race identity renders the empty stub, fetches nothing', async () => {
    render(RaceCompareScreen);
    await tick();
    expect(document.querySelector('.rcs-empty')).not.toBeNull();
    expect(posts().some((p) => p.type === 'amRaceFileDiffs')).toBe(false);
  });
});

describe('RaceCompareScreen — column identity (S6e)', () => {
  it('(id1) each column shows WHO it is (name + agent type + model), and the selectors carry it too', async () => {
    setRace(threeSiblings);
    const { container } = render(RaceCompareScreen);
    await tick();
    // The two-column identity strip names the selected pair's agent type + model.
    const cols = Array.from(container.querySelectorAll('.rcs-idcol')) as HTMLElement[];
    expect(cols.length).toBe(2);
    expect(cols[0].querySelector('.rcs-id-name')!.textContent).toBe('race-1');
    expect(cols[0].querySelector('.rcs-id-meta')!.textContent).toBe('reviewer · lmstudio/qwen');
    expect(cols[1].querySelector('.rcs-id-meta')!.textContent).toBe('tsuru · openai/gpt');
    // The selector option labels also carry name · type · model.
    const optA = (container.querySelector('.rcs-selA') as HTMLSelectElement).options[0];
    expect(optA.textContent).toContain('race-1');
    expect(optA.textContent).toContain('reviewer');
    expect(optA.textContent).toContain('lmstudio/qwen');
  });

  it('(id2) falls back to honest placeholders when a snapshot predates agent type / model', async () => {
    setRace([
      { id: 's1', name: 'race-1', state: 'idle', agentName: '', model: '' } as Sibling,
      { id: 's2', name: 'race-2', state: 'idle', agentName: '', model: '' } as Sibling,
    ]);
    const { container } = render(RaceCompareScreen);
    await tick();
    expect((container.querySelector('.rcs-idcol .rcs-id-meta') as HTMLElement).textContent).toBe('agent · default model');
  });
});

describe('RaceCompareScreen — file union renders both columns of real diff', () => {
  it('(rs2) unions both siblings, shows real add lines, a not-touched placeholder, and gates A-vs-B on both-touched', async () => {
    setRace(threeSiblings);
    const { container } = render(RaceCompareScreen);
    await tick();
    raceDiffs({
      s1: [
        { path: 'shared.txt', adds: 2, dels: 1, binary: false, text: diffText('newA'), truncated: false },
        { path: 'a-only.txt', adds: 1, dels: 0, binary: false, text: diffText('onlyA'), truncated: false },
      ],
      s2: [{ path: 'shared.txt', adds: 3, dels: 1, binary: false, text: diffText('newB'), truncated: false }],
    }, ['s1', 's2']);
    await tick();

    // Union of both siblings' paths, sorted.
    expect(files(container).map((f) => f.querySelector('.rcs-path')!.textContent)).toEqual(['a-only.txt', 'shared.txt']);

    // shared.txt: BOTH columns carry the sibling's own real hunk text.
    const shared = fileByPath(container, 'shared.txt');
    const cols = shared.querySelectorAll('.rcs-col');
    expect(cols.length).toBe(2);
    expect(cols[0].querySelector('.rcs-diff')!.textContent).toContain('+newA');
    expect(cols[1].querySelector('.rcs-diff')!.textContent).toContain('+newB');
    // The added line is coloured (asserts the classifier ran, not just raw text).
    expect(Array.from(cols[0].querySelectorAll('.rcs-line.add')).some((l) => l.textContent!.includes('+newA'))).toBe(true);
    // Both touched -> A-vs-B enabled.
    expect((shared.querySelector('.rcs-avsb') as HTMLButtonElement).disabled).toBe(false);

    // a-only.txt: s2 didn't touch it -> its column is the "not touched" placeholder,
    // and A-vs-B is disabled.
    const aOnly = fileByPath(container, 'a-only.txt');
    const aCols = aOnly.querySelectorAll('.rcs-col');
    expect(aCols[0].querySelector('.rcs-diff')).not.toBeNull();      // s1 has the diff
    expect(aCols[1].querySelector('.rcs-untouched')).not.toBeNull(); // s2 placeholder
    expect((aOnly.querySelector('.rcs-avsb') as HTMLButtonElement).disabled).toBe(true);

    // A working sibling (s2) is selected -> drift note is shown.
    expect(container.querySelector('.rcs-note')).not.toBeNull();
  });

  it('(rs3) a truncated file shows the honest truncation notice', async () => {
    setRace(threeSiblings);
    const { container } = render(RaceCompareScreen);
    await tick();
    raceDiffs({
      s1: [{ path: 'big.txt', adds: 9000, dels: 0, binary: false, text: diffText('x'), truncated: true }],
      s2: [{ path: 'big.txt', adds: 9000, dels: 0, binary: false, text: diffText('y'), truncated: false }],
    }, ['s1', 's2']);
    await tick();
    const big = fileByPath(container, 'big.txt');
    // s1's column carries the truncation notice; s2's (not truncated) does not.
    const cols = big.querySelectorAll('.rcs-col');
    expect(cols[0].querySelector('.rcs-trunc')).not.toBeNull();
    expect(cols[1].querySelector('.rcs-trunc')).toBeNull();
  });

  it('(rs4) a binary file shows a binary marker, not a diff pre', async () => {
    setRace(threeSiblings);
    const { container } = render(RaceCompareScreen);
    await tick();
    raceDiffs({
      s1: [{ path: 'img.png', adds: 0, dels: 0, binary: true, text: '', truncated: false }],
      s2: [{ path: 'img.png', adds: 0, dels: 0, binary: true, text: '', truncated: false }],
    }, ['s1', 's2']);
    await tick();
    const img = fileByPath(container, 'img.png');
    expect(img.querySelector('.rcs-diff')).toBeNull();
    expect(img.querySelector('.rcs-untouched')!.textContent).toContain('binary');
  });
});

describe('RaceCompareScreen — interactions', () => {
  it('(rs5) swapping sibling B requests the new pair and re-tables its data', async () => {
    setRace(threeSiblings);
    const { container } = render(RaceCompareScreen);
    await tick();
    raceDiffs({ s1: [{ path: 'x.txt', adds: 1, dels: 0, binary: false, text: diffText('a'), truncated: false }], s2: [{ path: 'x.txt', adds: 1, dels: 0, binary: false, text: diffText('b'), truncated: false }] }, ['s1', 's2']);
    await tick();
    await fireEvent.change(container.querySelector('.rcs-selB') as HTMLSelectElement, { target: { value: 's3' } });
    await tick();
    expect(posts().some((p) => p.type === 'amRaceFileDiffs' && (p.ids as string[]).join() === 's1,s3')).toBe(true);
    raceDiffs({ s1: [{ path: 'x.txt', adds: 1, dels: 0, binary: false, text: diffText('a'), truncated: false }], s3: [{ path: 'y.txt', adds: 1, dels: 0, binary: false, text: diffText('c'), truncated: false }] }, ['s1', 's3']);
    await tick();
    expect(files(container).map((f) => f.querySelector('.rcs-path')!.textContent)).toEqual(['x.txt', 'y.txt']);
  });

  it('(rs6) per-file actions post: open THAT sibling\'s diff, and A-vs-B cross-diff', async () => {
    setRace(threeSiblings);
    const { container } = render(RaceCompareScreen);
    await tick();
    raceDiffs({
      s1: [{ path: 'shared.txt', adds: 2, dels: 0, binary: false, text: diffText('a'), truncated: false }],
      s2: [{ path: 'shared.txt', adds: 3, dels: 0, binary: false, text: diffText('b'), truncated: false }],
    }, ['s1', 's2']);
    await tick();
    const shared = fileByPath(container, 'shared.txt');
    const opens = shared.querySelectorAll('.rcs-open');
    // Left column opens s1's diff, right column opens s2's — proves each targets its OWN sibling.
    await fireEvent.click(opens[0]);
    expect(posts().some((p) => p.type === 'amOpenFileDiff' && p.id === 's1' && p.path === 'shared.txt')).toBe(true);
    await fireEvent.click(opens[1]);
    expect(posts().some((p) => p.type === 'amOpenFileDiff' && p.id === 's2' && p.path === 'shared.txt')).toBe(true);
    // A-vs-B posts the cross-diff with both ids + the path.
    await fireEvent.click(shared.querySelector('.rcs-avsb')!);
    expect(posts().find((p) => p.type === 'amCrossDiff')).toMatchObject({ root: '/repo/a', ids: ['s1', 's2'], path: 'shared.txt' });
  });

  it('(rs7) refresh re-fetches the current pair', async () => {
    setRace(threeSiblings);
    const { container } = render(RaceCompareScreen);
    await tick();
    globalThis.__vscodeApiMock.postMessage.mockClear();
    await fireEvent.click(container.querySelector('.rcs-refresh')!);
    expect(posts().some((p) => p.type === 'amRaceFileDiffs' && (p.ids as string[]).join() === 's1,s2')).toBe(true);
  });
});
