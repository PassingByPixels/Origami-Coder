// t-yyz5je (redesign R4): the Side quests and Browser pull-outs in the rail
// language of the round-8 mockup ("Side quests and Browser pull-outs"): a tab
// with a count, a header that folds its list and stays with a summary, and rows
// that are one object each. Every assertion is on rendered DOM a user reads or
// clicks; jsdom has no layout, so positions and slides are not asserted here.
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SideQuest } from '../panes/sideQuestProps';
import { questAge } from '../panes/sideQuestAge';
import { viewportCaption, type BrowserFrame } from '../panes/browserFrames';
import SideQuestsDrawer from '../components/SideQuestsDrawer.svelte';
import SideQuestPopup from '../components/SideQuestPopup.svelte';
import BrowserOverlay from '../components/BrowserOverlay.svelte';

afterEach(cleanup);

const Q = (n: number, over: Partial<SideQuest> = {}): SideQuest => ({
  id: `SQ-${n}`,
  title: `Quest ${n}`,
  summary: `Summary of ${n}.`,
  rationale: '',
  instructions: `Do ${n}.`,
  created: '2026-09-25T10:00:00Z',
  ...over,
});

describe('side quest age', () => {
  const now = Date.parse('2026-09-26T12:00:00Z');
  it('reads "today" under a day, whole days after, and nothing for a bad date', () => {
    expect(questAge('2026-09-26T09:00:00Z', now)).toBe('today');
    expect(questAge('2026-09-25T10:00:00Z', now)).toBe('1 d');
    expect(questAge('2026-09-16T12:00:00Z', now)).toBe('10 d');
    expect(questAge('not a date', now)).toBe('');
    // A clock skewed behind the file's own stamp is still "today", never "-1 d".
    expect(questAge('2026-09-27T12:00:00Z', now)).toBe('today');
  });
});

describe('Side quests pull-out (t-yyz5je)', () => {
  const draw = (over: Record<string, unknown> = {}) =>
    render(SideQuestsDrawer, {
      props: { quests: [Q(8), Q(7, { created: 'bad' })], open: true, onToggle: vi.fn(), onOpen: vi.fn(), ...over },
    });

  it('a folded header keeps a summary: the newest quest title beside the count', () => {
    const { container } = draw();
    const head = container.querySelector('.rail-head') as HTMLElement;
    expect(head.getAttribute('aria-expanded')).toBe('false');
    expect(head.textContent).toContain('2 open');
    expect(head.querySelector('.rail-peek')?.textContent).toBe('Quest 8');
  });

  it('an open list hides the peek and draws one object per row: id, title, age, status, summary', async () => {
    const { container } = draw();
    await fireEvent.click(container.querySelector('.rail-head') as HTMLElement);
    expect(container.querySelector('.rail-peek')).toBeNull();
    const rows = [...container.querySelectorAll('.sq-row')] as HTMLElement[];
    expect(rows).toHaveLength(2);
    const first = rows[0];
    expect(first.querySelector('.sq-row-id')?.textContent).toBe('SQ-8');
    expect(first.querySelector('.sq-row-title')?.textContent).toBe('Quest 8');
    expect(first.querySelector('.sq-row-status')?.textContent).toBe('open');
    expect(first.querySelector('.sq-row-summary')?.textContent).toBe('Summary of 8.');
    expect(first.querySelector('.sq-row-age')?.textContent).not.toBe('');
    // A quest whose date will not parse shows no age rather than "NaN d".
    expect(rows[1].querySelector('.sq-row-age')).toBeNull();
  });

  it('the row whose quest is open beside the drawer is marked', async () => {
    const { container } = draw({ selectedId: 'SQ-7' });
    await fireEvent.click(container.querySelector('.rail-head') as HTMLElement);
    const rows = [...container.querySelectorAll('.sq-row')];
    expect(rows.map((r) => r.getAttribute('aria-current'))).toEqual([null, 'true']);
  });
});

describe('Side quest pop-out (t-yyz5je)', () => {
  const spies = () => ({ onStart: vi.fn(), onExport: vi.fn(), onDismiss: vi.fn(), onClose: vi.fn() });

  it('names the quest state in its header and folds the instructions behind "Show instructions"', async () => {
    const { container, getByText, queryByText } = render(SideQuestPopup, { props: { quest: Q(8), ...spies() } });
    expect(container.querySelector('.sqp-status')?.textContent).toBe('open');
    expect(queryByText('Do 8.')).toBeNull();
    await fireEvent.click(getByText(/Show instructions/));
    expect(getByText('Do 8.')).toBeInTheDocument();
    expect(getByText(/Hide instructions/)).toBeInTheDocument();
  });

  it('Dismiss sits apart from Start and Export (a spacer between them)', () => {
    const { container } = render(SideQuestPopup, { props: { quest: Q(8), ...spies() } });
    const kids = [...container.querySelector('.sqp-actions')!.children].map((c) => (c.classList.contains('sqp-gap') ? 'sqp-gap' : c.textContent?.trim()));
    expect(kids).toEqual(['Start in a new session', 'Export', 'sqp-gap', 'Dismiss']);
  });
});

describe('Browser pull-out (t-yyz5je)', () => {
  const frame = (seq: number, action: string, url = `https://a.test/p${seq}`): BrowserFrame => ({
    seq, action, ts: seq, url, imageDataUrl: `data:image/png;base64,F${seq}`,
  });
  const FR = [frame(0, 'open'), frame(1, 'click')];
  const draw = (over: Record<string, unknown> = {}) =>
    render(BrowserOverlay, {
      props: { frames: FR, collapsed: false, onToggleCollapse: vi.fn(), onOpen: vi.fn(), onReveal: vi.fn(), ...over },
    });

  it('the header is where the agent is and what it just did, and it folds the strip', async () => {
    const onToggleCollapse = vi.fn();
    const { container } = draw({ onToggleCollapse });
    const head = container.querySelector('.rail-head') as HTMLElement;
    expect(head.querySelector('.browser-caption')?.textContent).toBe('https://a.test/p1');
    expect(head.querySelector('.browser-action')?.textContent).toBe('click');
    expect(head.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('.browser-mini')).toBeNull();

    await fireEvent.click(head);
    expect(head.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('.browser-film')).toBeNull();
    // Folded, the header keeps the newest frame as a mini picture.
    expect(container.querySelector('.browser-mini img')?.getAttribute('src')).toBe('data:image/png;base64,F1');
    // Folding is not hiding: the parent's pull-out state is untouched.
    expect(onToggleCollapse).not.toHaveBeenCalled();
  });

  it('the tab carries the frame count only while the pull-out is hidden', () => {
    const shown = draw();
    expect(shown.container.querySelector('.browser-tab .rail-tab-count')).toBeNull();
    cleanup();
    const hidden = draw({ collapsed: true });
    expect(hidden.container.querySelector('.browser-tab .rail-tab-count')?.textContent).toBe('2');
  });

  it('the caption names the newest frame by the action that took it', () => {
    expect(viewportCaption(FR)).toBe('frame 2 of 2 · click');
    expect(viewportCaption([{ ...FR[1], width: 320, height: 180 }])).toBe('frame 1 of 1 · click · 320 × 180 px');
  });

  it('each frame names its action for the hover label', () => {
    const { container } = draw();
    expect([...container.querySelectorAll('.browser-frame-act')].map((s) => s.textContent)).toEqual(['open', 'click']);
  });
});
