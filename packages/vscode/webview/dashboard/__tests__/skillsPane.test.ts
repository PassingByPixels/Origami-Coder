// SkillsPane — the pane had no tests, which is how its refresh button stayed a
// lie: it re-read a cache the engine only ever filled once, so it looked like a
// refresh and did nothing. A skill added mid-session never appeared until the
// window was reloaded. The two behaviours worth pinning are therefore (a) the
// button asks for a RE-SCAN, not another read, and (b) a SKILL.md that failed
// to load is shown rather than quietly missing from an otherwise clean list.
//
// BOTH HALVES now, the shape pluginsPane.test.ts already uses. The host side
// (src/dashboard/skillsPane.ts) was inline in DashboardPanel.ts until W8-L1,
// where it answered "Open a chat first" with two chats open — see the last
// describe block for the state that produced it.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/svelte';
import { tick } from 'svelte';
import SkillsPane from '../panes/SkillsPane.svelte';
import { groupByCategory, UNCATEGORISED } from '../panes/skillsGrouping';
import {
  SKILLS_PANE_MESSAGE_TYPES,
  handleSkillsPaneMessage,
  type SkillsPaneHost,
  type SkillsPaneSession,
} from '../../../src/dashboard/skillsPane';

const posts = () =>
  globalThis.__vscodeApiMock.postMessage.mock.calls.map((c: unknown[]) => c[0]) as Array<Record<string, unknown>>;

// `location` defaults to a real-shaped SKILL.md path — never left `undefined`,
// since an expanded card renders it verbatim and a stray "undefined" in the
// DOM would silently pass any test that doesn't look for it.
const skill = (name: string, description = '', extra: Record<string, unknown> = {}) => ({
  name, description, tier: 'base', ownerAgents: [], tags: [], immutable: false,
  location: `/ws/skills/${name}/SKILL.md`,
  ...extra,
});

async function withData(data: Record<string, unknown>) {
  const rendered = render(SkillsPane);
  window.dispatchEvent(new MessageEvent('message', { data: { type: 'skillsData', ...data } }));
  await tick();
  return rendered;
}

beforeEach(() => { globalThis.__vscodeApiMock.postMessage.mockClear(); });
afterEach(() => cleanup());

describe('SkillsPane — the refresh button must buy an actual re-scan', () => {
  it('does NOT ask for a re-scan on mount (the boot scan is already fresh)', () => {
    render(SkillsPane);
    expect(posts()).toEqual([{ type: 'listSkills', refresh: false }]);
  });

  it('asks for a re-scan when the button is clicked — the whole defect', async () => {
    const { container } = await withData({ skills: [skill('alpha')] });
    globalThis.__vscodeApiMock.postMessage.mockClear();

    await fireEvent.click(container.querySelector('.skills-refresh')!);

    // Without `refresh: true` the engine answers from its one-and-only boot
    // scan, so a skill added since then can never appear.
    expect(posts()).toEqual([{ type: 'listSkills', refresh: true }]);
  });

  it('re-scans on every click, not just the first', async () => {
    const { container } = await withData({ skills: [] });
    const button = container.querySelector('.skills-refresh')!;
    globalThis.__vscodeApiMock.postMessage.mockClear();

    await fireEvent.click(button);
    await fireEvent.click(button);

    expect(posts()).toEqual([
      { type: 'listSkills', refresh: true },
      { type: 'listSkills', refresh: true },
    ]);
  });
});

describe('SkillsPane — a skill that failed to load is shown, not dropped', () => {
  it('renders the offending path and the reason', async () => {
    const { container } = await withData({
      skills: [],
      problems: [{ location: 'C:\\ws\\.origami\\skill\\typo\\SKILL.md', message: 'frontmatter has no `name` field' }],
    });

    const text = container.querySelector('.skills-problems')!.textContent ?? '';
    expect(text).toContain('C:\\ws\\.origami\\skill\\typo\\SKILL.md');
    expect(text).toContain('frontmatter has no `name` field');
  });

  it('still warns when other skills DID load — a clean list must not paper over it', async () => {
    const { container } = await withData({
      skills: [skill('alpha', 'Loaded fine')],
      problems: [{ location: '/ws/skills/bad/SKILL.md', message: 'frontmatter is missing or is not a mapping' }],
    });

    // Both are on screen: the healthy card AND the warning.
    expect(container.querySelectorAll('.skill-card')).toHaveLength(1);
    expect(container.querySelector('.skills-problem')?.textContent).toContain('/ws/skills/bad/SKILL.md');
  });

  it('shows no banner at all on a clean scan', async () => {
    const { container } = await withData({ skills: [skill('alpha')] });
    expect(container.querySelector('.skills-problems')).toBeNull();
  });

  it('tolerates a host that sends no problems key rather than blanking the pane', async () => {
    // Older host, or an error response: absent must read as "none", not crash.
    const { container } = await withData({ skills: [skill('alpha')] });
    expect(container.querySelectorAll('.skill-card')).toHaveLength(1);
    expect(container.querySelector('.skills-problems')).toBeNull();
  });
});

// groupByCategory is the pure leaf behind the pane's group headers — tested
// directly so the ordering rule (fixed five, then anything else alphabetical,
// then Uncategorised last) is pinned without needing a DOM render per case.
describe('groupByCategory — the ordering rule', () => {
  it('puts the fixed five ahead of an unknown category, ahead of Uncategorised', () => {
    const groups = groupByCategory([
      { category: 'testing' },
      { category: 'zzz-custom' },
      { category: undefined },
      { category: 'workflow' },
      { category: 'planning' },
    ]);
    expect(groups.map((g) => g.label)).toEqual(['workflow', 'planning', 'testing', 'zzz-custom', UNCATEGORISED]);
  });

  it('never invents a group for a fixed category with no entries', () => {
    const groups = groupByCategory([{ category: 'testing' }]);
    expect(groups.map((g) => g.label)).toEqual(['testing']);
  });

  it('folds a blank or whitespace-only category into Uncategorised, same as a missing one', () => {
    const groups = groupByCategory([{ category: '' }, { category: '   ' }, { category: undefined }]);
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe(UNCATEGORISED);
    expect(groups[0].skills).toHaveLength(3);
  });

  it('sorts two unrecognised categories alphabetically between the fixed five and Uncategorised', () => {
    const groups = groupByCategory([{ category: 'zeta-tools' }, { category: 'alpha-tools' }, { category: undefined }]);
    expect(groups.map((g) => g.label)).toEqual(['alpha-tools', 'zeta-tools', UNCATEGORISED]);
  });

  it('returns no groups at all for an empty list', () => {
    expect(groupByCategory([])).toEqual([]);
  });
});

describe('SkillsPane — cards group by category', () => {
  it('renders group headers in fixed-then-alphabetical-then-Uncategorised order with correct counts', async () => {
    const { container } = await withData({
      skills: [
        skill('alpha', '', { category: 'testing' }),
        skill('beta', '', { category: 'testing' }),
        skill('gamma', '', { category: 'workflow' }),
        skill('delta'), // no category
        skill('epsilon', '', { category: 'zzz-tools' }),
        skill('zeta', '', { category: 'planning' }),
      ],
    });

    const headers = [...container.querySelectorAll('.skills-group-label')].map((el) => el.textContent);
    expect(headers).toEqual(['workflow', 'planning', 'testing', 'zzz-tools', UNCATEGORISED]);

    const counts = [...container.querySelectorAll('.skills-group-count')].map((el) => el.textContent);
    expect(counts).toEqual(['1', '1', '2', '1', '1']);

    // quality/reference are fixed categories with no matching skill — never invented.
    expect(headers).not.toContain('quality');
    expect(headers).not.toContain('reference');
  });

  it('search narrows within groups, and a group left with no matches disappears entirely', async () => {
    const { container } = await withData({
      skills: [
        skill('alpha', 'the target skill', { category: 'testing' }),
        skill('beta', 'unrelated', { category: 'testing' }),
        skill('gamma', 'unrelated', { category: 'workflow' }),
      ],
    });

    const input = container.querySelector('.skills-search') as HTMLInputElement;
    await fireEvent.input(input, { target: { value: 'target' } });
    await tick();

    expect([...container.querySelectorAll('.skills-group-label')].map((el) => el.textContent)).toEqual(['testing']);
    expect(container.querySelector('.skills-group-count')?.textContent).toBe('1');
    expect(container.querySelectorAll('.skill-card')).toHaveLength(1);
  });

  it('shows the no-match message, not an empty group list, when the query matches nothing', async () => {
    const { container } = await withData({ skills: [skill('alpha', '', { category: 'testing' })] });
    const input = container.querySelector('.skills-search') as HTMLInputElement;

    await fireEvent.input(input, { target: { value: 'nothing-matches-this' } });
    await tick();

    expect(container.querySelectorAll('.skills-group-label')).toHaveLength(0);
    expect(container.querySelector('.skills-empty')?.textContent).toContain('No skills match "nothing-matches-this"');
  });
});

describe('SkillsPane — expandable card + Edit', () => {
  it('is collapsed by default: no details block, no location/preview text on screen', async () => {
    const { container } = await withData({
      skills: [skill('alpha', 'desc', { category: 'testing', contentPreview: 'the body excerpt' })],
    });
    expect(container.querySelector('.skill-details')).toBeNull();
    expect(container.textContent).not.toContain('the body excerpt');
  });

  it('clicking a card expands it: category chip, location, contentPreview and an Edit button appear', async () => {
    const { container } = await withData({
      skills: [
        skill('alpha', 'desc', {
          category: 'testing',
          location: '/ws/skills/alpha/SKILL.md',
          contentPreview: 'the body excerpt',
        }),
      ],
    });

    await fireEvent.click(container.querySelector('.skill-card')!);
    await tick();

    const details = container.querySelector('.skill-details');
    expect(details).not.toBeNull();
    expect(details!.querySelector('.skill-category')?.textContent).toBe('testing');
    expect(details!.querySelector('.skill-location')?.textContent).toContain('/ws/skills/alpha/SKILL.md');
    const pre = details!.querySelector('.skill-preview');
    expect(pre?.tagName).toBe('PRE');
    expect(pre?.textContent).toBe('the body excerpt');
    expect(details!.querySelector('.skill-edit')).not.toBeNull();
  });

  it('clicking the same card again collapses it', async () => {
    const { container } = await withData({ skills: [skill('alpha', '', { category: 'testing' })] });
    const card = container.querySelector('.skill-card')!;

    await fireEvent.click(card);
    await tick();
    expect(container.querySelector('.skill-details')).not.toBeNull();

    await fireEvent.click(card);
    await tick();
    expect(container.querySelector('.skill-details')).toBeNull();
  });

  it('only one card is expanded at a time', async () => {
    const { container } = await withData({
      skills: [skill('alpha', '', { category: 'testing' }), skill('beta', '', { category: 'testing' })],
    });
    const cards = () => [...container.querySelectorAll('.skill-card')];

    await fireEvent.click(cards()[0]);
    await tick();
    expect(container.querySelectorAll('.skill-details')).toHaveLength(1);

    await fireEvent.click(cards()[1]);
    await tick();
    expect(container.querySelectorAll('.skill-details')).toHaveLength(1);
    // The expanded one is now beta's, not alpha's.
    expect(cards()[0].classList.contains('expanded')).toBe(false);
    expect(cards()[1].classList.contains('expanded')).toBe(true);
  });

  it('Edit posts openSkillFile with the entry\'s own location, and does not collapse the card', async () => {
    const { container } = await withData({
      skills: [skill('alpha', '', { category: 'testing', location: 'C:\\ws\\skills\\alpha\\SKILL.md' })],
    });

    await fireEvent.click(container.querySelector('.skill-card')!);
    await tick();
    globalThis.__vscodeApiMock.postMessage.mockClear();

    await fireEvent.click(container.querySelector('.skill-edit')!);

    expect(posts()).toEqual([{ type: 'openSkillFile', location: 'C:\\ws\\skills\\alpha\\SKILL.md' }]);
    // stopPropagation on the button means the card's own click handler never
    // fires, so the details stay open rather than toggling shut underneath it.
    expect(container.querySelector('.skill-details')).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// HOST SIDE (src/dashboard/skillsPane.ts) — and the regression that extracted it.
//
// LIVE UAT (W8-L1): "Open a chat first — listing skills needs an active
// session", posted while TWO chats were open and healthy. It followed a failed
// "Start session" on a bot: that path deletes the half-built session from the
// map without moving `activeSessionId` off it, so the pane looked up a corpse
// and read the miss as "no chat is open".
//
// The first case below is that exact state. It fails against the resolution the
// pane was extracted with (`activeSessionId` → `sessions.get`, verbatim from
// DashboardPanel.ts) and passes through activeSession.ts's rule. The fake
// client RECORDS what it was asked, so "it reached a live engine connection" is
// asserted as a call rather than inferred from the absence of an error.
// ---------------------------------------------------------------------------

describe('skillsPane host — which session the list is read from', () => {
  let posts: Array<Record<string, unknown>> = [];
  let asked: Array<[string, Record<string, unknown> | undefined]> = [];

  const client = (skills: unknown[] = [], fail?: string) => ({
    extMethod: async (method: string, params?: Record<string, unknown>) => {
      asked.push([method, params]);
      if (fail) throw new Error(fail);
      return { skills, problems: [] } as Record<string, unknown>;
    },
  });

  const host = (map: Map<string, SkillsPaneSession>, activeId: string | null): SkillsPaneHost => ({
    sessions: () => map,
    activeSessionId: () => activeId,
    post: (msg) => { posts.push(msg); },
  });

  const lastSkills = () => [...posts].reverse().find((p) => p['type'] === 'skillsData')!;

  beforeEach(() => { posts = []; asked = []; });

  it('claims listSkills and nothing else, and ignores a message that is not its own', async () => {
    expect([...SKILLS_PANE_MESSAGE_TYPES]).toEqual(['listSkills']);
    await handleSkillsPaneMessage(host(new Map(), null), { type: 'pluginsRequest' });
    expect(posts).toEqual([]);
  });

  it('resolves a LIVE client when the active id names a session that is GONE', async () => {
    // Two healthy chats. `session-3` was the bot chat the engine refused: it
    // was deleted from the map, and the active id was left pointing at it.
    const map = new Map<string, SkillsPaneSession>([
      ['session-1', { client: client([{ name: 'alpha' }]) }],
      ['session-2', { client: client([{ name: 'beta' }]) }],
    ]);

    await handleSkillsPaneMessage(host(map, 'session-3'), { type: 'listSkills' });

    // It ASKED an engine — the whole failure was that it never got that far.
    expect(asked).toEqual([['list_skills', {}]]);
    expect(lastSkills()['skills']).toEqual([{ name: 'beta' }]);
    expect(lastSkills()['error']).toBeUndefined();
  });

  it('still prefers the active chat when that chat is alive', async () => {
    const map = new Map<string, SkillsPaneSession>([
      ['session-1', { client: client([{ name: 'alpha' }]) }],
      ['session-2', { client: client([{ name: 'beta' }]) }],
    ]);

    await handleSkillsPaneMessage(host(map, 'session-1'), { type: 'listSkills' });

    expect(lastSkills()['skills']).toEqual([{ name: 'alpha' }]);
  });

  it('says "open a chat first" only when there is really no chat', async () => {
    await handleSkillsPaneMessage(host(new Map(), 'session-3'), { type: 'listSkills' });

    expect(asked).toEqual([]);
    expect(lastSkills()['error']).toContain('Open a chat first');
    expect(lastSkills()['skills']).toEqual([]);
  });

  it('says the same when the one session it holds never got a client', async () => {
    // A session mid-construction: registered, ACP client not built yet. There
    // is nothing to ask, and inventing an answer would be worse than saying so.
    const map = new Map<string, SkillsPaneSession>([['session-1', { client: null }]]);

    await handleSkillsPaneMessage(host(map, 'session-1'), { type: 'listSkills' });

    expect(lastSkills()['error']).toContain('Open a chat first');
  });

  it('asks for a rescan ONLY when the user pressed the button', async () => {
    const map = new Map<string, SkillsPaneSession>([['session-1', { client: client() }]]);

    await handleSkillsPaneMessage(host(map, 'session-1'), { type: 'listSkills', refresh: true });
    expect(asked).toEqual([['list_skills', { refresh: true }]]);
  });

  it("surfaces the engine's own failure rather than an empty list", async () => {
    const map = new Map<string, SkillsPaneSession>([['session-1', { client: client([], 'engine is down') }]]);

    await handleSkillsPaneMessage(host(map, 'session-1'), { type: 'listSkills' });

    expect(lastSkills()['error']).toBe('engine is down');
    expect(lastSkills()['skills']).toEqual([]);
  });
});
