// BoardShell (the Agents board's nav rail + view routing) — the board grew
// from a single AgentManagerPane mount into a multi-view surface: Folds
// (unchanged AgentManagerPane), Labyrinth, Skills, Loops,
// Instructions. These tests pin down the two behaviours the task cares
// about: Folds is the
// default (Passing: "when users click Agents they go to folds"), and each
// rail entry swaps the body + marks itself active — not an echo of the
// VIEWS array, but a DOM assertion per pane's own root class, so a wiring
// regression (wrong component mounted, active class stuck) fails the test.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/svelte';
import { tick } from 'svelte';
import BoardShell from '../panes/BoardShell.svelte';

const railButtons = (c: HTMLElement) => Array.from(c.querySelectorAll('.nav-btn')) as HTMLButtonElement[];
const railButton = (c: HTMLElement, titlePrefix: string): HTMLButtonElement =>
  railButtons(c).find((b) => (b.getAttribute('title') ?? '').startsWith(titlePrefix))!;

beforeEach(() => {
  globalThis.__vscodeApiMock.postMessage.mockClear();
  globalThis.__vscodeApiMock.getState.mockReset();
  globalThis.__vscodeApiMock.getState.mockReturnValue(undefined);
  globalThis.__vscodeApiMock.setState.mockClear();
});
afterEach(() => cleanup());

describe('BoardShell — Folds is the default view', () => {
  it('mounts AgentManagerPane (Folds) on first render, with the Folds rail entry active', async () => {
    const { container } = render(BoardShell);
    await tick();
    expect(container.querySelector('.am-root')).not.toBeNull();
    expect(container.querySelector('.skills-pane')).toBeNull();
    expect(container.querySelector('.loops-pane')).toBeNull();
    expect(container.querySelector('.lab-pane')).toBeNull();
    expect(container.querySelector('.ins-pane')).toBeNull();
    expect(railButton(container, 'Folds').classList.contains('active')).toBe(true);
  });

  // The rail order is the OWNER's, so it is asserted exactly rather than as a
  // set: a view drifting back to build order is the regression, and a
  // set-comparison would pass straight through it.
  it('exposes the ten views in the owner order, then the spacer, then Docs alone at the foot', async () => {
    const { container } = render(BoardShell);
    await tick();
    const titles = railButtons(container).map((b) => (b.getAttribute('title') ?? '').split(' — ')[0]);
    expect(titles).toEqual([
      'Folds', 'Bots', 'Loops', 'Crons', 'Skills', 'Labyrinth', 'Insights', 'Tools', 'Plugins', 'MCP', 'Docs',
    ]);
    // Docs is a LINK, not a view (owner ruling): it sits after the flex spacer
    // — physically separated from the view stack — and never joins VIEWS.
    const docs = railButtons(container).at(-1)!;
    expect(docs.previousElementSibling?.classList.contains('nav-spacer')).toBe(true);
  });

  // Owner ruling: the rail's three-letter captions should name what each view
  // DOES — Fol named nothing (it abbreviated a name, not a function), so the
  // Folds rail entry's short caption becomes Git (the CSS text-transform
  // renders it GIT). The full name (Folds) and the persisted id (flock) are
  // unchanged — only the rail's short caption moves.
  it('captions the Folds rail entry Git, not Fol, so the short label names its function', async () => {
    const { container } = render(BoardShell);
    await tick();
    const label = railButton(container, 'Folds').querySelector('.nav-label');
    expect(label!.textContent).toBe('Git');
  });

  // W6-L3 (owner ruling): the Collabs OVERVIEW rail entry is GONE — a live
  // collab is already visible in the Collabs half of the sidebar, the same
  // place an active chat session is. This pins the negative directly (no rail
  // button answers to it any more) rather than relying only on the generic
  // deleted-id fallback below to prove it.
  it('has no Collabs rail entry', async () => {
    const { container } = render(BoardShell);
    await tick();
    expect(railButtons(container).map((b) => b.getAttribute('title')).some((t) => (t ?? '').startsWith('Collabs'))).toBe(false);
  });

  // A user who had the deleted view open still carries `origami.board.view:
  // 'collabs'` in webview state — same migration rule as the 'routings' case
  // below, pinned for this specific id since it is a real saved value, not a
  // hypothetical one.
  it('a saved `collabs` view id (the deleted rail entry) falls back to Folds, not a blank board', async () => {
    globalThis.__vscodeApiMock.getState.mockReturnValue({ 'origami.board.view': 'collabs' });
    const { container } = render(BoardShell);
    await tick();
    expect(container.querySelector('.am-root')).not.toBeNull();
    expect(railButton(container, 'Folds').classList.contains('active')).toBe(true);
  });

  // The rename is DISPLAY only. The id is the persisted state key, so renaming
  // it would silently reset every user who had that view open — this pins the
  // two apart: the caption reads Insights, the saved key still says instructions.
  it('the Instructions view is captioned Insights but still persists under its old id', async () => {
    const { container } = render(BoardShell);
    await tick();
    expect(railButtons(container).map((b) => b.getAttribute('title'))
      .some((t) => (t ?? '').startsWith('Instructions'))).toBe(false);
    await fireEvent.click(railButton(container, 'Insights'));
    await tick();
    expect(container.querySelector('.ins-pane')).not.toBeNull();
    expect(globalThis.__vscodeApiMock.setState.mock.calls.at(-1)?.[0])
      .toMatchObject({ 'origami.board.view': 'instructions' });
  });

  // The regression this catches is the one a new rail row invites: routing the
  // new id at the wrong component (or leaving the previous view mounted under
  // it), which looks fine until you notice the body never changed.
  it('Bots: mounts CollabAgentsPane, unmounts Folds, marks itself active only', async () => {
    const { container } = render(BoardShell);
    await tick();
    const col = railButton(container, 'Bots');
    await fireEvent.click(col);
    await tick();
    expect(container.querySelector('.ca-pane')).not.toBeNull();
    expect(container.querySelector('.am-root')).toBeNull();
    expect(col.classList.contains('active')).toBe(true);
    expect(railButton(container, 'Folds').classList.contains('active')).toBe(false);
  });

  // The rename is DISPLAY only, exactly like Insights two rows down. The id is
  // the persisted state key, so renaming it would silently reset every user who
  // had this view open — this pins the two apart.
  it('the Bots view is captioned Bots but still persists under its old collabagents id', async () => {
    const { container } = render(BoardShell);
    await tick();
    expect(railButtons(container).map((b) => b.getAttribute('title'))
      .some((t) => (t ?? '').startsWith('Collab agents'))).toBe(false);
    await fireEvent.click(railButton(container, 'Bots'));
    await tick();
    expect(globalThis.__vscodeApiMock.setState.mock.calls.at(-1)?.[0])
      .toMatchObject({ 'origami.board.view': 'collabagents' });
  });

  // The view is only useful if it says the one thing a def file cannot: an
  // agent saved here does not exist for the engine until it restarts. That
  // sentence going missing is a silent correctness bug, not a copy tweak.
  it('the Bots view states the engine-restart caveat up front', async () => {
    const { container } = render(BoardShell);
    await tick();
    await fireEvent.click(railButton(container, 'Bots'));
    await tick();
    expect(container.querySelector('.ca-notice')!.textContent).toMatch(/restart/i);
  });

  it('Crons and Loops are described as DIFFERENT things — the distinction users get wrong', async () => {
    // A loop dies with the window; a cron is an OS task that fires with VS Code
    // closed. A rail that blurs the two sends people to the wrong view.
    const { container } = render(BoardShell);
    await tick();
    expect(railButton(container, 'Crons').getAttribute('title')).toContain('closed');
    expect(railButton(container, 'Loops').getAttribute('title')).not.toContain('closed');
  });
});

describe('BoardShell — the two map/context views mount their own panes', () => {
  it('Labyrinth: mounts LabyrinthPane and marks itself active only', async () => {
    const { container } = render(BoardShell);
    await tick();
    const lab = railButton(container, 'Labyrinth');
    await fireEvent.click(lab);
    await tick();
    expect(container.querySelector('.lab-pane')).not.toBeNull();
    expect(container.querySelector('.am-root')).toBeNull();
    expect(lab.classList.contains('active')).toBe(true);
    expect(railButton(container, 'Folds').classList.contains('active')).toBe(false);
  });

  it('Insights: mounts InstructionsPane and marks itself active only', async () => {
    const { container } = render(BoardShell);
    await tick();
    const ins = railButton(container, 'Insights');
    await fireEvent.click(ins);
    await tick();
    expect(container.querySelector('.ins-pane')).not.toBeNull();
    expect(container.querySelector('.am-root')).toBeNull();
    expect(ins.classList.contains('active')).toBe(true);
    expect(railButton(container, 'Folds').classList.contains('active')).toBe(false);
  });

  // Tools sits directly below Insights and asks the same question about the
  // OTHER half of the per-request bill. Same wiring regression to catch: the
  // new id routed at the wrong component, or the previous view left mounted.
  it('Tools: mounts ToolsPane, asks the engine for the catalog, marks itself active only', async () => {
    const { container } = render(BoardShell);
    await tick();
    const tools = railButton(container, 'Tools');
    await fireEvent.click(tools);
    await tick();
    expect(container.querySelector('.tl-pane')).not.toBeNull();
    expect(container.querySelector('.ins-pane')).toBeNull();
    expect(container.querySelector('.am-root')).toBeNull();
    expect(tools.classList.contains('active')).toBe(true);
    expect(globalThis.__vscodeApiMock.postMessage.mock.calls.map((c) => c[0]?.type)).toContain('toolsRequest');
  });

  // Plugins sits directly below Tools (t-kgtolm round 3) — same wiring
  // regression to catch: the new id routed at the wrong component, or Tools
  // left mounted underneath it.
  it('Plugins: mounts PluginsPane, asks the engine for the plugin list, marks itself active only', async () => {
    const { container } = render(BoardShell);
    await tick();
    const plugins = railButton(container, 'Plugins');
    await fireEvent.click(plugins);
    await tick();
    expect(container.querySelector('.pg-pane')).not.toBeNull();
    expect(container.querySelector('.tl-pane')).toBeNull();
    expect(container.querySelector('.am-root')).toBeNull();
    expect(plugins.classList.contains('active')).toBe(true);
    expect(globalThis.__vscodeApiMock.postMessage.mock.calls.map((c) => c[0]?.type)).toContain('pluginsRequest');
  });

  // MCP sits directly below Plugins, and the two are the pair most easily
  // mis-wired: a plugin can BRING an MCP server, so both views render MCP
  // status pills. Routing the new id at PluginsPane would look plausible on
  // screen and be wrong — hence the negative assertion on `.pg-pane`.
  it('MCP: mounts MCPPane (not PluginsPane), asks the engine for the server list, marks itself active only', async () => {
    const { container } = render(BoardShell);
    await tick();
    const mcp = railButton(container, 'MCP');
    await fireEvent.click(mcp);
    await tick();
    expect(container.querySelector('.mcp-pane')).not.toBeNull();
    expect(container.querySelector('.pg-pane')).toBeNull();
    expect(container.querySelector('.am-root')).toBeNull();
    expect(mcp.classList.contains('active')).toBe(true);
    expect(globalThis.__vscodeApiMock.postMessage.mock.calls.map((c) => c[0]?.type)).toContain('mcpRequest');
  });
});

describe('BoardShell — clicking a rail entry swaps the view and marks it active', () => {
  it('Skills: mounts SkillsPane, unmounts Folds, marks Skills active only', async () => {
    const { container } = render(BoardShell);
    await tick();
    const skills = railButton(container, 'Skills');
    await fireEvent.click(skills);
    await tick();
    expect(container.querySelector('.skills-pane')).not.toBeNull();
    expect(container.querySelector('.am-root')).toBeNull();
    expect(skills.classList.contains('active')).toBe(true);
    expect(railButton(container, 'Folds').classList.contains('active')).toBe(false);
  });

  it('Loops: mounts LoopsPane, marks Loops active only', async () => {
    const { container } = render(BoardShell);
    await tick();
    const loops = railButton(container, 'Loops');
    await fireEvent.click(loops);
    await tick();
    expect(container.querySelector('.loops-pane')).not.toBeNull();
    expect(container.querySelector('.am-root')).toBeNull();
    expect(loops.classList.contains('active')).toBe(true);
    expect(railButton(container, 'Folds').classList.contains('active')).toBe(false);
  });

  it('Crons: mounts CronsPane (not LoopsPane), marks Crons active only', async () => {
    const { container } = render(BoardShell);
    await tick();
    const crons = railButton(container, 'Crons');
    await fireEvent.click(crons);
    await tick();
    expect(container.querySelector('.crons-pane')).not.toBeNull();
    // The wiring regression that matters: routing Crons at the Loops pane.
    expect(container.querySelector('.loops-pane')).toBeNull();
    expect(container.querySelector('.am-root')).toBeNull();
    expect(crons.classList.contains('active')).toBe(true);
  });

  it('clicking back to Folds restores AgentManagerPane and its active state', async () => {
    const { container } = render(BoardShell);
    await tick();
    await fireEvent.click(railButton(container, 'Crons'));
    await tick();
    const folds = railButton(container, 'Folds');
    await fireEvent.click(folds);
    await tick();
    expect(container.querySelector('.am-root')).not.toBeNull();
    expect(container.querySelector('.crons-pane')).toBeNull();
    expect(folds.classList.contains('active')).toBe(true);
  });
});

describe('BoardShell — the picked view persists through the webview state API', () => {
  it('a click writes the view to vscode state, and a fresh mount reads it back', async () => {
    const { container, unmount } = render(BoardShell);
    await tick();
    await fireEvent.click(railButton(container, 'Skills'));
    await tick();
    const lastState = globalThis.__vscodeApiMock.setState.mock.calls.at(-1)?.[0];
    expect(lastState).toMatchObject({ 'origami.board.view': 'skills' });
    unmount();

    globalThis.__vscodeApiMock.getState.mockReturnValue(lastState);
    const { container: remount } = render(BoardShell);
    await tick();
    expect(remount.querySelector('.skills-pane')).not.toBeNull();
    expect(remount.querySelector('.am-root')).toBeNull();
  });
});

// A SECTION REQUEST arrives from ANOTHER webview — the collab room's "Manage
// bots" link. The two are different webviews, so the board cannot be switched
// directly; it announces itself on mount and the host replays what is pending.
// The ack is the half worth guarding: without it a request outlives the click
// and hijacks a board opened later for an unrelated reason.
describe('BoardShell — a section request from another webview', () => {
  const showSection = async (section: string) => {
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'boardShowSection', section } }));
    await tick();
  };

  it('announces itself on mount, so a request made before it attached is not lost', async () => {
    render(BoardShell);
    await tick();
    expect(globalThis.__vscodeApiMock.postMessage.mock.calls.map((c) => c[0]?.type)).toContain('boardReady');
  });

  it('switches to Bots on a `bots` request and persists the switch like any other', async () => {
    const { container } = render(BoardShell);
    await tick();
    await showSection('bots');
    expect(container.querySelector('.ca-pane')).not.toBeNull();
    expect(railButton(container, 'Bots').classList.contains('active')).toBe(true);
    expect(globalThis.__vscodeApiMock.setState.mock.calls.at(-1)?.[0])
      .toMatchObject({ 'origami.board.view': 'collabagents' });
  });

  it('acknowledges the request, which is what clears it host-side', async () => {
    render(BoardShell);
    await tick();
    await showSection('bots');
    expect(globalThis.__vscodeApiMock.postMessage.mock.calls.map((c) => c[0]?.type)).toContain('boardSectionShown');
  });

  // A section this build does not have must not leave the request pending — it
  // has been delivered either way, and a board that never acknowledges it would
  // jump somewhere unasked-for on its next mount.
  it('acknowledges an UNKNOWN section without navigating anywhere', async () => {
    const { container } = render(BoardShell);
    await tick();
    await showSection('somewhere-else');
    expect(container.querySelector('.am-root')).not.toBeNull();
    expect(globalThis.__vscodeApiMock.postMessage.mock.calls.map((c) => c[0]?.type)).toContain('boardSectionShown');
  });
});

describe('BoardShell — the host brand bar is told which view is on screen', () => {
  // The brand bar lives in ChatView, OUTSIDE this component, and used to be a
  // hard-coded "Origami — Folds". That reads as a lie the moment you click
  // Skills. The real bug this catches: navigating without re-reporting, so the
  // chrome names a view you are no longer looking at.
  it('reports the full view name on mount and again on every swap', async () => {
    const seen: string[] = [];
    const { container } = render(BoardShell, { props: { onViewName: (n: string) => seen.push(n) } });
    await tick();
    expect(seen.at(-1)).toBe('Folds');

    await fireEvent.click(railButton(container, 'Loops'));
    await tick();
    expect(seen.at(-1)).toBe('Loops');

    await fireEvent.click(railButton(container, 'Crons'));
    await tick();
    expect(seen.at(-1)).toBe('Crons');
  });

  // The Routings view was DELETED, but a user who had it open still carries
  // `origami.board.view: 'routings'` in webview state. A saved id with no VIEWS
  // entry must degrade to Folds, not to an empty body — the migration bug the
  // deletion invites, and the reason isViewId validates against VIEWS rather
  // than against a hardcoded list.
  it('a saved view id that no longer exists falls back to Folds, not a blank board', async () => {
    globalThis.__vscodeApiMock.getState.mockReturnValue({ 'origami.board.view': 'routings' });
    const seen: string[] = [];
    const { container } = render(BoardShell, { props: { onViewName: (n: string) => seen.push(n) } });
    await tick();
    expect(container.querySelector('.am-root')).not.toBeNull();
    expect(railButton(container, 'Folds').classList.contains('active')).toBe(true);
    expect(seen.at(-1)).toBe('Folds');
  });

  it('reports the restored view — not the default — when remounting onto saved state', async () => {
    globalThis.__vscodeApiMock.getState.mockReturnValue({ 'origami.board.view': 'skills' });
    const seen: string[] = [];
    render(BoardShell, { props: { onViewName: (n: string) => seen.push(n) } });
    await tick();
    expect(seen.at(-1)).toBe('Skills');
  });
});
