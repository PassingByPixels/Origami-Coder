// The composer's session-mode control, after it grew a third state.
//
// A two-state toggle widened in place is how a third state ends up half-wired:
// the button lights, the popover offers it, and the one place that still asks
// `mode === 'plan'` quietly treats it as ordinary build. So what is asserted
// here is not "three buttons render" but the four things a half-wiring breaks —
// what the trigger says, what the popover offers, what a click posts, and which
// modes count as planning for everything downstream.
import { render, fireEvent, cleanup } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import ModeControl from './ModeControl.svelte';
import { MODE_IDS, MODE_OPTIONS, MODE_RAIL_OPTIONS, isPlanningMode, modeButtonLabel, modeState } from './modeControl';

afterEach(cleanup);

function mount(current: string) {
  const picked: string[] = [];
  const { container } = render(ModeControl, { props: { current, onSelect: (id: string) => picked.push(id) } });
  return { container, picked };
}

const trigger = (c: HTMLElement) => c.querySelector('.mode-btn') as HTMLButtonElement;
// The panel is now the ACCESS popover's dot rail (ApproveRail.svelte), so the
// choices are `.approve-notch` dots under an `.approve-label` each — NOT the
// `.mode-opt` text buttons this control used to draw. The label row is what
// the user reads, so it is what the option list is taken from.
const options = (c: HTMLElement) =>
  Array.from(c.querySelectorAll('.mode-pop .approve-label')).map((b) => (b.textContent ?? '').trim());
const notches = (c: HTMLElement) =>
  Array.from(c.querySelectorAll('.mode-pop .approve-notch')) as HTMLButtonElement[];
const activeNotchIndex = (c: HTMLElement) => notches(c).findIndex((n) => n.classList.contains('active'));

describe('modeControl — the decisions, with no DOM around them', () => {
  it('offers exactly the three modes the engine has agents for', () => {
    expect(MODE_IDS).toEqual(['build', 'plan', 'deep-plan']);
    // Every option must carry a hint: the popover's names alone ("Deep Plan")
    // do not tell a first-time reader that the mode never starts building,
    // which is the single most surprising thing about it.
    for (const option of MODE_OPTIONS) expect(option.hint.length).toBeGreaterThan(20);
  });

  it('treats BOTH planning modes as planning, and nothing else', () => {
    // This predicate gates the approve rail. Miss deep-plan and a chat could
    // sit on `bypass`, whose session ruleset overrides the agent's edit denies
    // — which is exactly the boundary that stops a deep plan scaffolding the
    // project it was asked to think about.
    expect(isPlanningMode('plan')).toBe(true);
    expect(isPlanningMode('deep-plan')).toBe(true);
    for (const other of ['build', 'default', 'auto', 'bypass', 'some-bot', '']) {
      expect(isPlanningMode(other), other).toBe(false);
    }
  });

  it('reads anything it does not know as Build rather than lighting up', () => {
    // The panel starts on the literal 'default' before the engine's first
    // modeOptions lands, and a chat can be on a user-defined bot agent. Neither
    // is a planning mode, and a control that lit for them would claim a
    // guarantee the session does not have.
    expect(modeState('default')).toBe('build');
    expect(modeState('some-collab-bot')).toBe('build');
    expect(modeButtonLabel('default')).toBe('Plan');
    expect(modeButtonLabel('some-collab-bot')).toBe('Plan');
  });

  it('names the mode it is actually in', () => {
    expect(modeButtonLabel('build')).toBe('Plan');
    expect(modeButtonLabel('plan')).toBe('Plan: on');
    expect(modeButtonLabel('deep-plan')).toBe('Deep Plan: on');
  });
});

describe('ModeControl — the control itself', () => {
  it('is ONE button until it is opened', () => {
    // The composer's action row is asserted button-for-button elsewhere
    // (InputBar.test.ts). A control that rendered its three choices inline
    // would silently add two buttons to that row.
    const { container } = mount('build');
    expect(container.querySelectorAll('button')).toHaveLength(1);
    expect(trigger(container).textContent?.trim()).toBe('Plan');
    expect(options(container)).toEqual([]);
  });

  it('opens onto all three states', async () => {
    const { container } = mount('build');
    await fireEvent.click(trigger(container));
    expect(options(container)).toEqual(['Build', 'Plan', 'Deep Plan']);
  });

  it('reports the picked mode and closes', async () => {
    const { container, picked } = mount('build');
    await fireEvent.click(trigger(container));
    const deep = notches(container)[options(container).indexOf('Deep Plan')]!;
    await fireEvent.click(deep);
    expect(picked).toEqual(['deep-plan']);
    // ...and it does NOT move itself. The engine is the authority; the caller
    // echoes the confirmed mode back through `current`. A control that flipped
    // its own state would keep showing a mode the engine refused.
    expect(trigger(container).textContent?.trim()).toBe('Plan');
    expect(options(container)).toEqual([]);
  });

  // Owner UAT: the composer had TWO ways of picking one-of-N a few pixels
  // apart — the Access popover's dot slider and this control's list of text
  // buttons. These pin the idiom itself, because "it still works" is exactly
  // what a silently-reverted restyle also looks like.
  it('draws the ACCESS dot rail, not a list of option buttons', async () => {
    const { container } = mount('build');
    await fireEvent.click(trigger(container));

    expect(container.querySelectorAll('.mode-pop .approve-notch')).toHaveLength(3);
    expect(container.querySelectorAll('.mode-pop .approve-dot')).toHaveLength(3);
    // Two connectors for three dots — the "slider" half of dot-slider.
    expect(container.querySelectorAll('.mode-pop .approve-rail')).toHaveLength(2);
    // ...and the old idiom is really gone, not merely hidden behind it.
    expect(container.querySelectorAll('.mode-opt')).toHaveLength(0);
    // Titled like an Access row: a short caption LEFT of its own rail.
    expect(container.querySelector('.mode-pop-title')?.textContent?.trim()).toBe('Mode:');
  });

  it('lights the dot for the mode the chat is ACTUALLY in, one at a time', async () => {
    for (const [current, index] of [['build', 0], ['plan', 1], ['deep-plan', 2]] as const) {
      const { container } = mount(current);
      await fireEvent.click(trigger(container));
      expect(activeNotchIndex(container), current).toBe(index);
      expect(notches(container).filter((n) => n.classList.contains('active')), current).toHaveLength(1);
      cleanup();
    }
  });

  it('keeps each mode’s HINT on its dot — a bare name never warned anyone', async () => {
    // The rail's own default tooltip is the option NAME. "Deep Plan" alone
    // does not tell a first-time reader the mode never starts building, which
    // is the single most surprising thing about it, so the hint has to ride
    // through MODE_RAIL_OPTIONS into the notch title.
    const { container } = mount('build');
    await fireEvent.click(trigger(container));
    const deep = notches(container)[2]!;

    expect(deep.getAttribute('title')).toContain('never starts building');
    // ...while the ACCESSIBLE name stays the short one, so the control is not
    // read out as a paragraph.
    expect(deep.getAttribute('aria-label')).toBe('Deep Plan');
  });

  it('derives the rail options from MODE_OPTIONS rather than re-typing them', () => {
    // A fourth mode added to MODE_OPTIONS must appear on the rail without
    // anyone remembering a second list — the exact half-wiring this control's
    // whole test file exists to catch.
    expect(MODE_RAIL_OPTIONS.map((o) => o.value)).toEqual(MODE_IDS);
    expect(MODE_RAIL_OPTIONS.map((o) => o.name)).toEqual(MODE_OPTIONS.map((o) => o.name));
    expect(MODE_RAIL_OPTIONS.map((o) => o.hint)).toEqual(MODE_OPTIONS.map((o) => o.hint));
  });

  it('wears a different state for each planning mode', () => {
    // Told apart by class, because they are told apart by COLOUR in the UI —
    // one shared "active" look would make Plan and Deep Plan indistinguishable
    // at a glance, and they are very different promises.
    const build = mount('build').container;
    expect(trigger(build).className).not.toContain('active');

    const plan = mount('plan').container;
    expect(trigger(plan).className).toContain('active');
    expect(trigger(plan).className).toContain('plan-mode');
    expect(trigger(plan).className).not.toContain('deep-plan-mode');

    const deep = mount('deep-plan').container;
    expect(trigger(deep).className).toContain('active');
    expect(trigger(deep).className).toContain('deep-plan-mode');
  });

  it('says which mode it is in, and what that mode does, in the tooltip', () => {
    const { container } = mount('deep-plan');
    const title = trigger(container).getAttribute('title') ?? '';
    expect(title).toContain('Deep Plan');
    expect(title).toContain('never starts building');
  });
});

// The theme-discipline proof this file owes, on the ChatsList precedent: the
// component is NOT in THEMED_FILES because its popover keeps the same
// `rgba(0, 0, 0, 0.28)` drop shadow the four other composer popovers use, and
// no --og-* shadow var exists. Every value that IS a colour still has to be a
// token, since the three mode states are told apart by fill.
describe('ModeControl — theme discipline', () => {
  it('uses --og-* tokens for every colour, the shadow alone excepted', () => {
    const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'ModeControl.svelte');
    const src = readFileSync(file, 'utf8');
    const literals = [
      ...src.matchAll(/#[0-9a-fA-F]{3,8}\b/g),
      ...src.matchAll(/\brgba?\([^)]*\)/g),
      ...src.matchAll(/\bhsla?\(/g),
      // The old inline button used a bare `color: white` for its active state.
      // A named colour is a literal too, and it is the one most likely to be
      // copied back in from InputBar's remaining `.mode-btn.active` rule.
      ...src.matchAll(/:\s*(white|black)\s*;/g),
    ].map((m) => m[0]);
    expect(literals, `unexpected literal colour(s): ${literals.join(', ')}`).toEqual(['rgba(0, 0, 0, 0.28)']);
    // ...and the states that carry meaning really are drawn from tokens.
    for (const token of ['--og-chat', '--og-accent-2', '--og-surface', '--og-border']) {
      expect(src, token).toContain(`var(${token})`);
    }
  });
});

// --- the host's half of the same decision -------------------------------
// A mode the picker offers is also a mode a user will type as `/<name>`, and
// the host routes those through DashboardPanel.MODE_COMMANDS. A command missing
// from that set is not an error - it falls through and is sent to the MODEL as
// a prompt, so `/deep-plan` would read as a chat message and the mode would
// silently not change.
//
// Read out of the source rather than imported: DashboardPanel.ts imports
// `vscode`, and MODE_COMMANDS is private. Same mirror technique botTools.test.ts
// uses against the engine's tool files.
describe('the host routes every offered mode as a slash command', () => {
  it('MODE_COMMANDS covers all three, deep-plan included', () => {
    const panel = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '..', '..', '..', 'src', 'dashboard', 'DashboardPanel.ts',
    );
    const src = readFileSync(panel, 'utf8');
    const line = /MODE_COMMANDS\s*=\s*new Set\(\[([^\]]*)\]\)/.exec(src);
    expect(line, 'MODE_COMMANDS is no longer a literal Set - update this mirror').not.toBeNull();
    const commands = [...line![1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    for (const id of MODE_IDS) {
      // 'build' is the one exception: it is the baseline, reached by leaving a
      // mode rather than by naming one, and it has never had a slash command.
      if (id === 'build') continue;
      expect(commands, `/${id} would be sent to the model instead of switching mode`).toContain(id);
    }
    // The auto-approve presets share the same routing and must not be lost.
    for (const preset of ['default', 'auto', 'bypass']) expect(commands).toContain(preset);
  });
});
