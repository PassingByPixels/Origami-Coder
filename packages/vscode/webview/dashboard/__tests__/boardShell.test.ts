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
  railButtons(c).find((b) => (b.getAttribute('aria-label') ?? '').startsWith(titlePrefix))!;

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
    expect(container.querySelector('.sch-pane')).toBeNull();
    expect(container.querySelector('.lab-pane')).toBeNull();
    expect(container.querySelector('.ins-pane')).toBeNull();
    expect(railButton(container, 'Folds').classList.contains('active')).toBe(true);
  });

  // The rail order is the OWNER's, so it is asserted exactly rather than as a
  // set: a view drifting back to build order is the regression, and a
  // set-comparison would pass straight through it. Remote is on the rail
  // whatever the setting says — the row is visible, the SETTING is what gates
  // the socket. Pinned both ways: with the prop on here, off below.
  it('exposes the thirteen top views in the owner order, then the spacer, then Settings and Docs at the foot, with Remote on', async () => {
    const { container } = render(BoardShell, { props: { remoteEnabled: true } });
    await tick();
    const titles = railButtons(container).map((b) => (b.getAttribute('aria-label') ?? '').split(' — ')[0]);
    expect(titles).toEqual([
      // t-ru1qsp: Loops and Crons folded into one Schedules row.
      'Folds', 'Bots', 'Schedules', 'Skills', 'Labyrinth', 'Insights', 'Tools', 'Plugins', 'MCP',
      // Remote and Flock are LAST and adjacent (owner ruling: "a new Icon below
      // MCP that was Rem and Flo"). Everything above them is about this editor.
      // t-rz4555: Artifacts joins that off-machine group — an artifact is one
      // object in the device group, beside the phone and the friend's Origami.
      // t-s9jr6u: Nests directly after Remote (both reach other devices).
      'Artifacts', 'Remote', 'Nests', 'Flock',
      // t-s9jr6u: Settings at the FOOT, directly above Docs.
      'Settings', 'Docs',
    ]);
    // Docs is a LINK, not a view (owner ruling), at the very foot; Settings is
    // the one VIEW below the flex spacer, directly above it.
    const docs = railButtons(container).at(-1)!;
    const settings = railButtons(container).at(-2)!;
    expect(docs.previousElementSibling).toBe(settings);
    expect(settings.previousElementSibling?.classList.contains('nav-spacer')).toBe(true);
  });

  // THE HIDE IS REVERSED (remote-device-key lane). The iOS app makes Remote a
  // shipping feature and a row nobody can see is a feature nobody turns on, so
  // the rail draws it with the setting OFF (no `remoteEnabled` prop) exactly as
  // it does with it on. What the setting still gates is every line that costs
  // something — no socket, no timer, no secret read.
  it('keeps Remote on the rail when origamicoder.remote.enabled is off (the default)', async () => {
    const { container } = render(BoardShell);
    await tick();
    const titles = railButtons(container).map((b) => (b.getAttribute('aria-label') ?? '').split(' — ')[0]);
    expect(titles).toEqual([
      'Folds', 'Bots', 'Schedules', 'Skills', 'Labyrinth', 'Insights', 'Tools', 'Plugins', 'MCP',
      // t-rz4555: Artifacts joins that off-machine group — an artifact is one
      // object in the device group, beside the phone and the friend's Origami.
      'Artifacts', 'Remote', 'Nests', 'Flock',
      'Settings', 'Docs',
    ]);
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
    expect(railButtons(container).map((b) => b.getAttribute('aria-label')).some((t) => (t ?? '').startsWith('Collabs'))).toBe(false);
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
    expect(railButtons(container).map((b) => b.getAttribute('aria-label'))
      .some((t) => (t ?? '').startsWith('Instructions'))).toBe(false);
    await fireEvent.click(railButton(container, 'Insights'));
    await tick();
    expect(container.querySelector('.ins-pane')).not.toBeNull();
    expect(globalThis.__vscodeApiMock.setState.mock.calls.at(-1)?.[0])
      .toMatchObject({ 'origami.board.view': 'instructions' });
  });

  // The two views added below MCP (owner: "Origami Remote and Flock i dont see in
  // the Agent Managers Side bar"). Same routing assertion the Bots row gets, per
  // pane, because the regression a new rail row invites is mounting the WRONG
  // component under the new id — which looks fine until you notice the body
  // never changed.
  it('Remote: mounts the Remote pane, unmounts Folds, marks itself active only', async () => {
    const { container } = render(BoardShell, { props: { remoteEnabled: true } });
    await tick();
    const btn = railButton(container, 'Remote');
    await fireEvent.click(btn);
    await tick();
    expect(container.querySelector('.remote-pane')).not.toBeNull();
    expect(container.querySelector('.am-root')).toBeNull();
    expect(btn.classList.contains('active')).toBe(true);
    expect(globalThis.__vscodeApiMock.setState.mock.calls.at(-1)?.[0])
      .toMatchObject({ 'origami.board.view': 'remote' });
  });

  // The hide is reversed: a saved `remote` view id is restored whether or not
  // the setting is on, because the ROW is drawn either way now. What the
  // setting gates is the socket, and the pane says so itself when it is off.
  it('a saved `remote` view id is restored when Remote is off (the default) too', async () => {
    globalThis.__vscodeApiMock.getState.mockReturnValue({ 'origami.board.view': 'remote' });
    const { container } = render(BoardShell);
    await tick();
    expect(container.querySelector('.remote-pane')).not.toBeNull();
    expect(railButton(container, 'Remote').classList.contains('active')).toBe(true);
  });

  it('a saved `remote` view id is restored when Remote is on', async () => {
    globalThis.__vscodeApiMock.getState.mockReturnValue({ 'origami.board.view': 'remote' });
    const { container } = render(BoardShell, { props: { remoteEnabled: true } });
    await tick();
    expect(container.querySelector('.remote-pane')).not.toBeNull();
    expect(railButton(container, 'Remote').classList.contains('active')).toBe(true);
  });

  // The persisted id is `friends`, NOT `flock`: that word is already the Folds
  // view's id, and taking it would silently move every user who had Folds open.
  it('Flock: mounts the Flock pane and persists under `friends`, leaving Folds on `flock`', async () => {
    const { container } = render(BoardShell);
    await tick();
    const btn = railButton(container, 'Flock');
    await fireEvent.click(btn);
    await tick();
    expect(container.querySelector('.flock-pane')).not.toBeNull();
    expect(container.querySelector('.am-root')).toBeNull();
    expect(globalThis.__vscodeApiMock.setState.mock.calls.at(-1)?.[0])
      .toMatchObject({ 'origami.board.view': 'friends' });

    await fireEvent.click(railButton(container, 'Folds'));
    await tick();
    expect(container.querySelector('.am-root')).not.toBeNull();
    expect(globalThis.__vscodeApiMock.setState.mock.calls.at(-1)?.[0])
      .toMatchObject({ 'origami.board.view': 'flock' });
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
    expect(railButtons(container).map((b) => b.getAttribute('aria-label'))
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

  // t-ru1qsp: Crons and Loops are now ONE rail item, but the rail's own hover
  // title still names both halves of what it opens — the distinction itself
  // moved to the tab titles inside SchedulesPane (schedulesPane.test.ts).
  it('the Schedules rail entry names both crons (fires closed) and loops (repeats while open) in its title', async () => {
    const { container } = render(BoardShell);
    await tick();
    const title = railButton(container, 'Schedules').getAttribute('aria-label') ?? '';
    expect(title).toContain('closed');
    expect(title.toLowerCase()).toContain('loop');
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

  // t-ru1qsp: one Schedules row now routes to SchedulesPane, which opens on
  // Crons by default (schedulesPane.test.ts covers its own tab switching and
  // the Crons-vs-Loops distinction in depth). This only pins the rail's own
  // wiring: the right pane mounts, the right button goes active.
  it('Schedules: mounts SchedulesPane (defaulting to its Crons tab), marks Schedules active only', async () => {
    const { container } = render(BoardShell);
    await tick();
    const sch = railButton(container, 'Schedules');
    await fireEvent.click(sch);
    await tick();
    expect(container.querySelector('.sch-pane')).not.toBeNull();
    expect(container.querySelector('.crons-pane')).not.toBeNull();
    expect(container.querySelector('.am-root')).toBeNull();
    expect(sch.classList.contains('active')).toBe(true);
  });

  it('clicking back to Folds restores AgentManagerPane and its active state', async () => {
    const { container } = render(BoardShell);
    await tick();
    await fireEvent.click(railButton(container, 'Schedules'));
    await tick();
    const folds = railButton(container, 'Folds');
    await fireEvent.click(folds);
    await tick();
    expect(container.querySelector('.am-root')).not.toBeNull();
    expect(container.querySelector('.sch-pane')).toBeNull();
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

  // t-ru1qsp acceptance: "opening view id crons or loops selects the matching
  // tab". These are legacy section words from before the Schedules fold —
  // viewForSection (boardViews.ts) still maps both onto the one rail item,
  // and remembers WHICH one so SchedulesPane opens on that tab, not always Crons.
  it('a `loops` request opens Schedules on its Loops tab', async () => {
    const { container } = render(BoardShell);
    await tick();
    await showSection('loops');
    expect(container.querySelector('.sch-pane')).not.toBeNull();
    expect(container.querySelector('.loops-pane')).not.toBeNull();
    expect(container.querySelector('.crons-pane')).toBeNull();
    expect(railButton(container, 'Schedules').classList.contains('active')).toBe(true);
  });

  it('a `crons` request opens Schedules on its Crons tab', async () => {
    const { container } = render(BoardShell);
    await tick();
    await showSection('crons');
    expect(container.querySelector('.sch-pane')).not.toBeNull();
    expect(container.querySelector('.crons-pane')).not.toBeNull();
    expect(container.querySelector('.loops-pane')).toBeNull();
    expect(railButton(container, 'Schedules').classList.contains('active')).toBe(true);
  });
});

// t-qn09vr: the rail expands on pointer/focus to full names, collapses to
// icons otherwise. Ported as JS-driven state (a `.rail-expanded` class, not a
// bare `:hover` CSS rule) precisely so it is provable here — jsdom has no
// layout engine, so a width transition cannot be read back through
// getComputedStyle, but a class toggle can.
describe('BoardShell — the rail expands on hover/focus to full names', () => {
  it('is collapsed at rest and gains .rail-expanded on pointerenter, loses it on pointerleave', async () => {
    const { container } = render(BoardShell);
    await tick();
    const nav = container.querySelector('.board-nav')!;
    expect(nav.classList.contains('rail-expanded')).toBe(false);
    await fireEvent.pointerEnter(nav);
    expect(nav.classList.contains('rail-expanded')).toBe(true);
    await fireEvent.pointerLeave(nav);
    expect(nav.classList.contains('rail-expanded')).toBe(false);
  });

  it('also expands on focus (keyboard use), not only pointer hover', async () => {
    const { container } = render(BoardShell);
    await tick();
    const nav = container.querySelector('.board-nav')!;
    await fireEvent.focusIn(nav);
    expect(nav.classList.contains('rail-expanded')).toBe(true);
    await fireEvent.focusOut(nav);
    expect(nav.classList.contains('rail-expanded')).toBe(false);
  });

  // CHANGES.md change 33: "the names are restored from each button's own
  // `title`" — here, the ViewDef's own `name` field, not the 3-letter `label`
  // caption every entry always shows collapsed.
  it('swaps the 3-letter caption for the full name while expanded, and back on collapse', async () => {
    const { container } = render(BoardShell);
    await tick();
    const nav = container.querySelector('.board-nav')!;
    const folds = railButton(container, 'Folds');
    expect(folds.querySelector('.nav-label')!.textContent).toBe('Git');
    await fireEvent.pointerEnter(nav);
    expect(folds.querySelector('.nav-label')!.textContent).toBe('Folds');
    await fireEvent.pointerLeave(nav);
    expect(folds.querySelector('.nav-label')!.textContent).toBe('Git');
  });

  // The porting trap named in the ticket: the rail used to carry no view id in
  // the DOM at all (round-3 change 49 matched on the `title` prefix instead).
  // t-ru1qsp folded Crons and Loops into one row: this now pins the SINGLE
  // `schedules` id, and that no separate `crons`/`loops` rail button exists —
  // the acceptance item's "same single word" check, expanded and collapsed both.
  it('stamps the Schedules button with data-view-id="schedules", with no separate Crons/Loops button', async () => {
    const { container } = render(BoardShell);
    await tick();
    expect(railButton(container, 'Folds').getAttribute('data-view-id')).toBe('flock');
    expect(railButton(container, 'Schedules').getAttribute('data-view-id')).toBe('schedules');
    const labels = railButtons(container).map((b) => (b.getAttribute('aria-label') ?? '').split(' — ')[0]);
    expect(labels.filter((l) => l === 'Schedules')).toHaveLength(1);
    expect(labels).not.toContain('Crons');
    expect(labels).not.toContain('Loops');

    const nav = container.querySelector('.board-nav')!;
    await fireEvent.pointerEnter(nav);
    expect(railButton(container, 'Schedules').querySelector('.nav-label')!.textContent).toBe('Schedules');
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

    await fireEvent.click(railButton(container, 'Schedules'));
    await tick();
    expect(seen.at(-1)).toBe('Schedules');
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
