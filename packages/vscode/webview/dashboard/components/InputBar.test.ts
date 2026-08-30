// The compact affordance used to VANISH exactly when it was most needed.
//
// The clickable gauge rendered only under `contextUsed > 0 && contextKnown`;
// with an unknown window the bar fell through to a NON-interactive
// `<span class="ctx-unknown">⚠</span>` with no handler — the compact button was
// not in the DOM at all. And an unknown window is precisely the local-model case
// (a probe-less server), i.e. the user most likely to be drowning in context.
// The MECHANISM was never blocked (`/compact` typed into the box still worked),
// so this was a pure discoverability failure.
//
// The fix must not overcorrect: an unknown window must still refuse to show a
// percentage or a denominator, because a made-up window is what gets fed to a
// real `lms load -c` and OOMs a GPU.

import { render, fireEvent, cleanup, waitFor } from '@testing-library/svelte';
import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import InputBar from './InputBar.svelte';
import { PROVIDER_PROBING } from './modelBanner';
import { approveButtonState } from './approveButtonState';

const SID = 'sess-ctx-1';
const post = (data: Record<string, unknown>) => window.dispatchEvent(new MessageEvent('message', { data }));

afterEach(cleanup);

function mount(onCompact: () => void) {
  return render(InputBar, {
    props: {
      inFlight: false, agentName: 'Tsuru', modelName: 'qwen3-8b', modelOnline: true,
      sessionId: SID, onCompact, onSend: () => {}, onCancel: () => {},
    },
  });
}

// 0.3.24 UAT: "Tsuru 3 is missing all the action buttons below the chat pane".
// The row was never conditionally rendered — a sibling banner was stealing its
// height out of a 100vh app inside an overflow:hidden body, so it was pushed
// off-screen (fixed in the shell's own CSS, which no unit test can observe).
// What CAN be pinned here is the other half of that diagnosis: no per-chat mode
// removes the row or its controls. If a future "hide the controls in plan mode"
// ever lands, this is what says so out loud rather than a user losing them.
describe('InputBar — the action row belongs to THIS chat and never disappears', () => {
  const actionRow = (c: HTMLElement) => c.querySelector('.mode-row');
  const labels = (c: HTMLElement) =>
    Array.from(c.querySelectorAll('.mode-row button')).map((b) => b.textContent?.trim());

  // M4.2 UAT dropped TWO entries from this row: the Agents button (the board
  // keeps four other routes — the sidebar ⚑, the status bar item, the
  // `origami.openAgentManager` palette command and the nav rail) and the Flock
  // indicator (Flock routing is deprecated). Both are named here rather than
  // just deleted from the array, so a re-add is a deliberate act and not a
  // silent drift back.
  const GONE = ['Agents', 'Flock'];

  it('renders the full row in the normal mode', () => {
    const { container } = mount(() => {});
    expect(actionRow(container)).not.toBeNull();
    expect(labels(container)).toEqual(expect.arrayContaining(['/', 'Plan', 'Approve']));
    for (const gone of GONE) expect(labels(container).join(' ')).not.toContain(gone);
  });

  it('...and STILL renders it once THIS chat is in plan mode', async () => {
    const { container } = mount(() => {});
    post({ type: 'modeUpdate', sessionId: SID, mode: 'plan' });
    await new Promise((r) => setTimeout(r, 0));
    // The toggle reflects it — and everything else is still reachable. The row
    // is FOUR buttons now: `/`, Plan, Approve and Vision (Effort is hidden
    // without variants, Export without an onExport). Temp was removed (the
    // sampling control was rarely used and added clutter). Asserted exactly,
    // because ">= N" would have gone on passing through both removals.
    // t-kgtr6c added the Vision button (round 2 called it "Eye" and stood a
    // separate read-out chip beside it; round 3 folded the two into this one),
    // and it stays in PLAN mode on purpose: a plan-mode chat still reads
    // screenshots, and the profile is not a permission. t-kgsupy round 3 added
    // a separate Browser button that ALSO stayed in plan mode (it is not a
    // per-session permission, it is VS Code's own global chat-tool
    // auto-approve); round 4 folded it INTO Approve, so there is no longer a
    // fifth button — the merged trigger itself stays enabled in plan mode for
    // the same reason (Browser must stay reachable), and it wears whichever
    // label (approveButtonState.ts) is correct for both settings at once.
    expect(labels(container)).toEqual(['/', 'Plan: on', 'Approve', 'Vision']);
    expect(actionRow(container)!.querySelectorAll('button').length).toBe(4);
  });

  it('another chat’s plan mode changes nothing here — the events are session-scoped', async () => {
    const { container } = mount(() => {});
    post({ type: 'modeUpdate', sessionId: 'some-other-chat', mode: 'plan' });
    await new Promise((r) => setTimeout(r, 0));
    expect(labels(container)).toContain('Plan'); // not "Plan: on"
    expect(container.querySelector('.mode-badge.mode-plan')).toBeNull();
    expect(actionRow(container)).not.toBeNull();
  });
});

describe('InputBar — the compact affordance', () => {
  it('UNKNOWN window: still offers a clickable compact control, and clicking it compacts', async () => {
    const onCompact = vi.fn();
    const { container } = mount(onCompact);
    // Real tokens, no window (contextWindow 0 = the server reported none).
    post({ type: 'contextUpdate', sessionId: SID, turns: 3, contextWindow: 0, contextUsed: 24000, contextTotal: 0 });
    await new Promise((r) => setTimeout(r, 0));
    const gauge = container.querySelector('.ctx-gauge-btn') as HTMLElement | null;
    expect(gauge).not.toBeNull();
    expect(gauge!.getAttribute('role')).toBe('button');
    await fireEvent.click(gauge!);
    expect(onCompact).toHaveBeenCalledTimes(1);
  });

  it('UNKNOWN window: keeps the honest ⚠ face and invents NO percentage or denominator', async () => {
    const { container } = mount(vi.fn());
    post({ type: 'contextUpdate', sessionId: SID, turns: 3, contextWindow: 0, contextUsed: 24000, contextTotal: 0 });
    await new Promise((r) => setTimeout(r, 0));
    const gauge = container.querySelector('.ctx-gauge-btn') as HTMLElement;
    expect(gauge.textContent).toMatch(/24k used/);
    expect(gauge.textContent).toContain('⚠');
    expect(gauge.textContent).not.toMatch(/%/);           // no fabricated percentage
    expect(gauge.querySelector('.gauge-svg')).toBeNull(); // no arc implying a ratio
    expect(gauge.className).toMatch(/ctx-unknown/);       // still styled as the unknown state
  });

  it('UNKNOWN window: the keyboard path compacts too (it is a real control, not a div)', async () => {
    const onCompact = vi.fn();
    const { container } = mount(onCompact);
    post({ type: 'contextUpdate', sessionId: SID, turns: 1, contextWindow: 0, contextUsed: 900, contextTotal: 0 });
    await new Promise((r) => setTimeout(r, 0));
    const gauge = container.querySelector('.ctx-gauge-btn') as HTMLElement;
    expect(gauge.getAttribute('tabindex')).toBe('0');
    await fireEvent.keyDown(gauge, { key: 'Enter' });
    expect(onCompact).toHaveBeenCalledTimes(1);
  });

  it('KNOWN window: unchanged — real percentage, real denominator, still clickable', async () => {
    const onCompact = vi.fn();
    const { container } = mount(onCompact);
    post({ type: 'contextUpdate', sessionId: SID, turns: 2, contextWindow: 64000, contextUsed: 32000, contextTotal: 0 });
    await new Promise((r) => setTimeout(r, 0));
    const gauge = container.querySelector('.ctx-gauge-btn') as HTMLElement;
    expect(gauge.textContent).toMatch(/50%/);
    expect(gauge.querySelector('.gauge-svg')).not.toBeNull();
    expect(gauge.className).not.toMatch(/ctx-unknown/);
    await fireEvent.click(gauge);
    expect(onCompact).toHaveBeenCalledTimes(1);
  });

  it('NO tokens used yet: no compact control at all (nothing to compact)', async () => {
    const { container } = mount(vi.fn());
    post({ type: 'contextUpdate', sessionId: SID, turns: 0, contextWindow: 64000, contextUsed: 0, contextTotal: 0 });
    await new Promise((r) => setTimeout(r, 0));
    expect(container.querySelector('.ctx-gauge-btn')).toBeNull();
    expect(container.querySelector('.ctx-window')?.textContent).toMatch(/64k ctx/);
  });
});

// The tooltip must not claim a number was LOADED when it was never probed. A
// cloud model with no live probe (contextWindow 0) falls back to contextTotal
// (the engine's usage_update `size` — the build-frozen models.dev snapshot for
// a provider fetchModelInfo can't reach, e.g. https OpenRouter before this fix),
// and previously said "loaded context window" regardless of source. Only the
// WORDING changes here — the % math, the click-to-compact affordance and the
// right-click threshold hint are identical in both cases.
describe('InputBar — the gauge tooltip names its OWN source honestly', () => {
  it('a live-probed window (contextWindow > 0) keeps saying "loaded context window"', async () => {
    const { container } = mount(vi.fn());
    post({ type: 'contextUpdate', sessionId: SID, turns: 1, contextWindow: 64000, contextUsed: 32000, contextTotal: 0 });
    await new Promise((r) => setTimeout(r, 0));
    const gauge = container.querySelector('.ctx-gauge-btn') as HTMLElement;
    expect(gauge.title).toContain("this chat's loaded context window");
    expect(gauge.title).not.toContain('catalog max');
  });

  it('a catalog-fallback window (contextWindow 0, contextTotal from usageUpdate) says "(catalog max)" instead', async () => {
    const { container } = mount(vi.fn());
    // No probe landed (contextWindow stays 0); usageUpdate's `size` is what
    // fed contextTotal — the engine's build-frozen catalog number.
    post({ type: 'usageUpdate', sessionId: SID, used: 32000, size: 64000 });
    await new Promise((r) => setTimeout(r, 0));
    const gauge = container.querySelector('.ctx-gauge-btn') as HTMLElement;
    expect(gauge.title).toContain("this chat's context window (catalog max)");
    expect(gauge.title).not.toContain('loaded context window');
    // The affordance itself is untouched by the wording change.
    expect(gauge.title).toContain('click to compact');
    expect(gauge.title).toContain('right-click to set a custom auto-compact threshold');
  });
});

// t-kgsdsw — right-click (or the browser's own contextmenu key/chord) opens a
// menu to pick a custom auto-compaction threshold, without disturbing the
// existing left-click-to-compact behaviour it shares the gauge with.
describe('InputBar — compaction threshold menu', () => {
  async function openGauge(onCompact = vi.fn()) {
    const { container } = mount(onCompact);
    post({ type: 'contextUpdate', sessionId: SID, turns: 2, contextWindow: 64000, contextUsed: 32000, contextTotal: 0 });
    await new Promise((r) => setTimeout(r, 0));
    return { container, gauge: container.querySelector('.ctx-gauge-btn') as HTMLElement, onCompact };
  }

  it('right-click opens the menu and does NOT also compact', async () => {
    const { container, gauge, onCompact } = await openGauge();
    await fireEvent.contextMenu(gauge);
    expect(container.querySelector('.ctm-menu')).not.toBeNull();
    expect(onCompact).not.toHaveBeenCalled();
  });

  it('picking a percentage posts setCompactionThreshold and closes the menu', async () => {
    const { container, gauge } = await openGauge();
    globalThis.__vscodeApiMock.postMessage.mockClear();
    await fireEvent.contextMenu(gauge);
    await fireEvent.click(container.querySelector('.ctm-option:nth-of-type(3)') as HTMLElement); // Auto, 50%, 60% -> 3rd is 60%
    expect(globalThis.__vscodeApiMock.postMessage).toHaveBeenCalledWith({ type: 'setCompactionThreshold', value: '60%', sessionId: SID });
    expect(container.querySelector('.ctm-menu')).toBeNull();
  });

  it('a custom token count posts the plain number, not a percentage', async () => {
    const { container, gauge } = await openGauge();
    globalThis.__vscodeApiMock.postMessage.mockClear();
    await fireEvent.contextMenu(gauge);
    const input = container.querySelector('.ctm-custom-input') as HTMLInputElement;
    await fireEvent.input(input, { target: { value: '150000' } });
    await fireEvent.keyDown(input, { key: 'Enter' });
    expect(globalThis.__vscodeApiMock.postMessage).toHaveBeenCalledWith({ type: 'setCompactionThreshold', value: '150000', sessionId: SID });
  });

  it('"Auto (default)" clears the override with an empty value', async () => {
    const { container, gauge } = await openGauge();
    globalThis.__vscodeApiMock.postMessage.mockClear();
    await fireEvent.contextMenu(gauge);
    await fireEvent.click(container.querySelector('.ctm-option') as HTMLElement); // first option is Auto
    expect(globalThis.__vscodeApiMock.postMessage).toHaveBeenCalledWith({ type: 'setCompactionThreshold', value: '', sessionId: SID });
  });

  it('clicking the backdrop closes the menu without posting anything or compacting', async () => {
    const { container, gauge, onCompact } = await openGauge();
    await fireEvent.contextMenu(gauge);
    globalThis.__vscodeApiMock.postMessage.mockClear();
    await fireEvent.click(container.querySelector('.ctm-backdrop') as HTMLElement);
    expect(container.querySelector('.ctm-menu')).toBeNull();
    expect(globalThis.__vscodeApiMock.postMessage).not.toHaveBeenCalled();
    expect(onCompact).not.toHaveBeenCalled();
  });

  it('a confirming compactionThresholdUpdate for THIS session updates the tooltip', async () => {
    const { gauge } = await openGauge();
    expect(gauge.title).not.toContain('currently');
    post({ type: 'compactionThresholdUpdate', sessionId: SID, value: '70%' });
    await new Promise((r) => setTimeout(r, 0));
    expect(gauge.title).toContain('currently 70%');
  });

  it('a compactionThresholdUpdate for a DIFFERENT session changes nothing here', async () => {
    const { gauge } = await openGauge();
    post({ type: 'compactionThresholdUpdate', sessionId: 'some-other-chat', value: '70%' });
    await new Promise((r) => setTimeout(r, 0));
    expect(gauge.title).not.toContain('currently');
  });
});

// The other side of the collab work: the CHAT path must be untouched by it.
// Both rules below are what the passthrough surface deliberately inverts, so
// they are the two that would break silently if a gate were written backwards.
describe('InputBar — the chat keeps its own slash rules', () => {
  it('routes a slash command to the host rather than sending it as a prompt', async () => {
    const sent: string[] = [];
    const { container } = mount(() => {});
    globalThis.__vscodeApiMock.postMessage.mockClear();
    const box = container.querySelector('textarea.input') as HTMLTextAreaElement;
    // A trailing space: the palette has no hit, so Enter falls through to send.
    await fireEvent.input(box, { target: { value: '/clear now' } });
    await fireEvent.keyDown(box, { key: 'Enter' });
    for (const call of globalThis.__vscodeApiMock.postMessage.mock.calls) {
      const msg = call[0] as { type: string; command?: string };
      if (msg.type === 'slashCommand') sent.push(String(msg.command));
    }
    expect(sent).toEqual(['clear']);
  });

  it('...and Enter still COMPLETES a highlighted command instead of sending it', async () => {
    const { container } = mount(() => {});
    const box = container.querySelector('textarea.input') as HTMLTextAreaElement;
    await fireEvent.input(box, { target: { value: '/cle' } });
    await fireEvent.keyDown(box, { key: 'Enter' });
    expect(box.value).toBe('/clear ');
  });
});

// The SAME composer serves the collab pane, stripped: everything the chat row
// carries is about an engine session, and a collab has none. What must survive
// the stripping is the box, Send, the `/` palette and Export — a composer that
// silently lost its command toggle here would be a whole vocabulary gone.
describe('InputBar — bare mode (the collab composer)', () => {
  const COLLAB = [{ name: '/archive', description: 'Close this collab', category: 'Collab' }];

  function bare(props: Record<string, unknown> = {}) {
    return render(InputBar, {
      props: {
        bare: true, passthroughSlash: true, commands: COLLAB, inFlight: false,
        agentName: '', modelName: '', onSend: () => true, onCancel: () => {},
        ...props,
      },
    });
  }

  it('keeps the box, Send, `/` and Export — and nothing that speaks to a session', () => {
    const { container } = bare({ onExport: () => {}, canExport: true });
    expect(container.querySelector('textarea.input')).not.toBeNull();
    expect(container.querySelector('.btn.send')).not.toBeNull();

    const labels = Array.from(container.querySelectorAll('.mode-row button')).map((b) => b.textContent?.trim() ?? '');
    expect(labels).toHaveLength(2);
    expect(labels[0]).toBe('/');
    expect(labels[1]).toMatch(/Export/);

    // No model bar, no Cancel, no Vision button: all of them describe a
    // session this composer does not have. The Vision assertion names the
    // button's OWN class — `.vision-indicator` was the round-2 read-out chip,
    // and once that was deleted the old assertion could never fail again.
    expect(container.querySelector('.model-bar')).toBeNull();
    expect(container.querySelector('.btn.cancel')).toBeNull();
    expect(container.querySelector('.vision-btn')).toBeNull();
    expect(container.querySelector('.model-warning')).toBeNull();
  });

  it('asks the host for nothing on mount — there is no spend to seed', () => {
    globalThis.__vscodeApiMock.postMessage.mockClear();
    bare();
    expect(globalThis.__vscodeApiMock.postMessage).not.toHaveBeenCalled();
  });

  it('offers the commands it was GIVEN, not the chat\'s', async () => {
    const { container } = bare();
    const box = container.querySelector('textarea.input') as HTMLTextAreaElement;
    await fireEvent.input(box, { target: { value: '/' } });
    const names = Array.from(container.querySelectorAll('.slash-name')).map((n) => n.textContent);
    expect(names).toEqual(['/archive']);
  });

  it('an archived surface disables the box and Send, and says why in the placeholder', () => {
    const { container } = bare({ disabled: true, placeholder: 'This collab is archived' });
    const box = container.querySelector('textarea.input') as HTMLTextAreaElement;
    expect(box.disabled).toBe(true);
    expect(box.placeholder).toBe('This collab is archived');
    expect((container.querySelector('.btn.send') as HTMLButtonElement).disabled).toBe(true);
  });
});

// The keep-the-draft contract. The composer clears the box BEFORE the parent
// has seen the line, which is right when the parent always accepts it — and
// wrong for a surface that parses the line itself and can refuse it. `false`
// is the refusal, and it must leave what was typed exactly where it was.
describe('InputBar — passthrough send', () => {
  const COLLAB = [{ name: '/archive', description: 'Close this collab', category: 'Collab' }];

  function passthrough(onSend: (text: string) => boolean | void, commands?: typeof COLLAB) {
    return render(InputBar, {
      props: {
        bare: true, passthroughSlash: true, commands, inFlight: false,
        agentName: '', modelName: '', onSend, onCancel: () => {},
      },
    });
  }

  const type = async (c: HTMLElement, value: string) => {
    const box = c.querySelector('textarea.input') as HTMLTextAreaElement;
    await fireEvent.input(box, { target: { value } });
    return box;
  };

  it('hands the raw trimmed line over — a slash command is NOT intercepted', async () => {
    const seen: string[] = [];
    globalThis.__vscodeApiMock.postMessage.mockClear();
    const { container } = passthrough((t) => { seen.push(t); return true; });
    const box = await type(container, '  /archive  ');
    await fireEvent.keyDown(box, { key: 'Enter' });
    expect(seen).toEqual(['/archive']);
    // ...and nothing was sent to the host behind the parent's back.
    expect(globalThis.__vscodeApiMock.postMessage.mock.calls.map((c: unknown[]) => (c[0] as { type: string }).type))
      .not.toContain('slashCommand');
  });

  it('a REFUSED line (false) keeps the draft', async () => {
    const { container } = passthrough(() => false);
    const box = await type(container, '/rename');
    await fireEvent.keyDown(box, { key: 'Enter' });
    expect(box.value).toBe('/rename');
  });

  it('an accepted line clears it — true and a plain void alike', async () => {
    const accepted = passthrough(() => true);
    const boxA = await type(accepted.container, 'ship it');
    await fireEvent.keyDown(boxA, { key: 'Enter' });
    expect(boxA.value).toBe('');

    const voided = passthrough(() => {});
    const boxB = await type(voided.container, 'ship it');
    await fireEvent.keyDown(boxB, { key: 'Enter' });
    expect(boxB.value).toBe('');
  });

  // With the palette open, Enter in the CHAT completes the highlighted command.
  // Here a command IS the whole line, so an Enter eaten by the dropdown would
  // make `/archive` need two presses and would swallow a missing-argument error.
  it('Enter SUBMITS even with the palette open — it never completes instead', async () => {
    const seen: string[] = [];
    const { container } = passthrough((t) => { seen.push(t); return true; }, COLLAB);
    const box = await type(container, '/archive');
    // The palette is open AND `/archive` is a live hit in it — the exact state
    // the chat's Enter-completes rule fires in.
    expect(container.querySelectorAll('.slash-name')).toHaveLength(1);
    await fireEvent.keyDown(box, { key: 'Enter' });
    expect(seen).toEqual(['/archive']);
  });
});

// M4.2 — `allowImages`, and the keep-the-draft contract growing to cover
// attachments.
//
// The trap was found by reading the code: the passthrough branch RETURNS before
// the chat's image branch, so a bare composer that started accepting pastes
// would have attached them, cleared them, and sent nothing but the text.
// Nothing in the chat's own image path could catch it, because the chat never
// reaches the passthrough branch.
//
// The other half is the default. `allowImages` is absent on every chat mount
// and on the collab composer's own sibling surfaces, so the gate has to fail
// CLOSED — a bare composer that was not asked for images must not grow them.
describe('InputBar — allowImages and the widened draft', () => {
  class SmallImage {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    width = 8;
    height = 8;
    set src(_v: string) { setTimeout(() => this.onload?.(), 0); }
  }
  const BYTES = 'x';
  const DATA_URL = `data:image/png;base64,${Buffer.from(BYTES).toString('base64')}`;

  beforeEach(() => { (globalThis as unknown as { Image: unknown }).Image = SmallImage; });

  function composer(props: Record<string, unknown>) {
    return render(InputBar, {
      props: { bare: true, passthroughSlash: true, inFlight: false, agentName: '', modelName: '', onCancel: () => {}, ...props },
    });
  }
  const thumbs = (c: HTMLElement) => Array.from(c.querySelectorAll('.image-thumb img'));
  async function firePaste(c: HTMLElement) {
    const box = c.querySelector('textarea.input') as HTMLTextAreaElement;
    const file = new File([BYTES], 'shot.png', { type: 'image/png' });
    await fireEvent.paste(box, { clipboardData: { items: [{ type: 'image/png', getAsFile: () => file }] } });
  }
  // The intake is async twice over (FileReader, then the optional down-scale),
  // so wait on the CONDITION rather than on a guessed number of ticks.
  async function attach(c: HTMLElement) {
    const before = thumbs(c).length;
    await firePaste(c);
    await waitFor(() => expect(thumbs(c).length).toBe(before + 1));
  }

  it('a bare composer with allowImages takes a paste and shows the strip', async () => {
    const { container } = composer({ allowImages: true, onSend: () => true });
    await attach(container);
    expect(thumbs(container)).toHaveLength(1);
  });

  it('...and WITHOUT it takes none — the gate fails closed', async () => {
    const { container } = composer({ onSend: () => true });
    await firePaste(container);
    await new Promise((r) => setTimeout(r, 50));
    expect(thumbs(container)).toHaveLength(0);
  });

  // THE TRAP. Without the hand-off the picture vanishes between the strip and
  // the parent, and every visible symptom looks like a working composer.
  it('the PASSTHROUGH branch hands the attachments to the parent, with the text', async () => {
    const seen: Array<[string, unknown, unknown]> = [];
    const { container } = composer({
      allowImages: true,
      onSend: (t: string, m: unknown, i: unknown) => { seen.push([t, m, i]); return true; },
    });
    await attach(container);
    const box = container.querySelector('textarea.input') as HTMLTextAreaElement;
    await fireEvent.input(box, { target: { value: 'look' } });
    await fireEvent.keyDown(box, { key: 'Enter' });

    expect(seen).toEqual([['look', undefined, [{ dataUrl: DATA_URL, name: 'shot.png' }]]]);
  });

  // Slot two is the chat's own mode and predates attachments by a long way; a
  // parent reading images out of it would get `'loop'`.
  it('sends NO images field when nothing is attached — the middle slot stays the mode', async () => {
    const seen: unknown[][] = [];
    const { container } = composer({ allowImages: true, onSend: (...a: unknown[]) => { seen.push(a); return true; } });
    const box = container.querySelector('textarea.input') as HTMLTextAreaElement;
    await fireEvent.input(box, { target: { value: 'just words' } });
    await fireEvent.keyDown(box, { key: 'Enter' });
    expect(seen).toEqual([['just words', undefined, undefined]]);
  });

  it('an accepted send clears BOTH halves of the draft', async () => {
    const { container } = composer({ allowImages: true, onSend: () => true });
    await attach(container);
    const box = container.querySelector('textarea.input') as HTMLTextAreaElement;
    await fireEvent.input(box, { target: { value: 'ship it' } });
    await fireEvent.keyDown(box, { key: 'Enter' });
    expect(box.value).toBe('');
    expect(thumbs(container)).toHaveLength(0);
  });

  // The whole point of the contract: a refusal costs the user nothing. Losing
  // four screenshots to a mistyped command is the punishment it exists to stop.
  it('a REFUSED send keeps the text AND the attachments', async () => {
    const { container } = composer({ allowImages: true, onSend: () => false });
    await attach(container);
    const box = container.querySelector('textarea.input') as HTMLTextAreaElement;
    await fireEvent.input(box, { target: { value: '/cap 20' } });
    await fireEvent.keyDown(box, { key: 'Enter' });
    expect(box.value).toBe('/cap 20');
    expect(thumbs(container)).toHaveLength(1);
  });

  it('an image with no words still sends — a picture IS a message', async () => {
    const seen: unknown[][] = [];
    const { container } = composer({ allowImages: true, onSend: (...a: unknown[]) => { seen.push(a); return true; } });
    await attach(container);
    await fireEvent.keyDown(container.querySelector('textarea.input') as HTMLTextAreaElement, { key: 'Enter' });
    expect(seen).toEqual([['', undefined, [{ dataUrl: DATA_URL, name: 'shot.png' }]]]);
  });

  it('an attachment can be taken back off before sending', async () => {
    const { container } = composer({ allowImages: true, onSend: () => true });
    await attach(container);
    await fireEvent.click(container.querySelector('.image-remove') as HTMLButtonElement);
    expect(thumbs(container)).toHaveLength(0);
  });
});

// Flock M4 wave X2 — the `@` participant picker.
//
// It rides the SAME dropdown the `/` palette draws through (SlashDropdown.svelte,
// extracted for exactly that reason), so the two things worth pinning here are
// the ones a shared component cannot enforce on its own:
//
//   1. A CHAT MOUNT IS UNCHANGED. `participants` is absent on every chat
//      InputBar, and `@` has always been an ordinary character there — an `@`
//      that started opening a picker in chat would be a regression the collab
//      feature dragged in behind it.
//   2. THE TWO VOCABULARIES NEVER OVERLAP. A `/` line is a command; the picker
//      must stay shut for it, or a line could offer both at once.
//
// The insertion itself (`@slug ` over the half-typed handle, caret after it)
// is collabMentions.applyMention's contract and is unit-tested there; what is
// asserted here is that a PICK actually runs it against the live draft.
describe('InputBar — the @ participant picker', () => {
  const ROSTER = [
    { slug: 'collab-crane', name: 'Crane' },
    { slug: 'collab-heron', name: 'Heron' },
  ];

  function composer(props: Record<string, unknown> = {}) {
    return render(InputBar, {
      props: {
        bare: true, passthroughSlash: true, inFlight: false,
        commands: [{ name: '/archive', description: 'Close this collab', category: 'Collab' }],
        agentName: '', modelName: '', onSend: () => true, onCancel: () => {},
        ...props,
      },
    });
  }

  const type = async (c: HTMLElement, value: string) => {
    const box = c.querySelector('textarea.input') as HTMLTextAreaElement;
    await fireEvent.input(box, { target: { value } });
    return box;
  };
  const rows = (c: HTMLElement) => Array.from(c.querySelectorAll('.slash-name')).map((n) => n.textContent);

  it('a bare @ opens the picker on the WHOLE roster — "who is in this room?" is a real question', async () => {
    const { container } = composer({ participants: ROSTER });
    await type(container, 'ping @');
    expect(container.querySelector('.slash-dropdown')).not.toBeNull();
    expect(rows(container)).toEqual(['@collab-crane', '@collab-heron']);
  });

  it('typing filters it — on the slug or on the display name, case-insensitively', async () => {
    const { container } = composer({ participants: ROSTER });
    await type(container, 'ping @her');
    expect(rows(container)).toEqual(['@collab-heron']);
    await type(container, 'ping @CRAN');
    expect(rows(container)).toEqual(['@collab-crane']);
  });

  it('a query that matches nobody SAYS so rather than showing an empty box', async () => {
    const { container } = composer({ participants: ROSTER });
    await type(container, 'ping @zzz');
    expect(rows(container)).toEqual([]);
    expect(container.querySelector('.slash-empty')!.textContent).toContain('No matching participants');
  });

  it('Enter inserts the highlighted slug over the half-typed handle, with a trailing space', async () => {
    const { container } = composer({ participants: ROSTER });
    const box = await type(container, 'ping @her');
    await fireEvent.keyDown(box, { key: 'Enter' });
    expect(box.value).toBe('ping @collab-heron ');
    // ...and the picker closes rather than re-offering itself on the inserted handle.
    expect(container.querySelector('.slash-dropdown')).toBeNull();
  });

  it('ArrowDown moves the cursor, so Enter can take the SECOND hit', async () => {
    const { container } = composer({ participants: ROSTER });
    const box = await type(container, 'ping @');
    await fireEvent.keyDown(box, { key: 'ArrowDown' });
    await fireEvent.keyDown(box, { key: 'Enter' });
    expect(box.value).toBe('ping @collab-heron ');
  });

  it('clicking a row inserts it too — the picker is not keyboard-only', async () => {
    const { container } = composer({ participants: ROSTER });
    const box = await type(container, 'ping @');
    await fireEvent.click(container.querySelectorAll('.slash-item')[1]);
    expect(box.value).toBe('ping @collab-heron ');
  });

  it('Escape closes it and KEEPS the draft — the same rule the / palette follows', async () => {
    const { container } = composer({ participants: ROSTER });
    const box = await type(container, 'ping @her');
    await fireEvent.keyDown(box, { key: 'Escape' });
    expect(container.querySelector('.slash-dropdown')).toBeNull();
    expect(box.value).toBe('ping @her');
  });

  it('a / line shows the COMMAND palette and never the picker — one vocabulary at a time', async () => {
    const { container } = composer({ participants: ROSTER });
    await type(container, '/arch');
    expect(rows(container)).toEqual(['/archive']);
  });

  // The regression that would be silent: every chat composer mounts WITHOUT
  // participants, and `@` has always been an ordinary character there.
  it('a CHAT mount (no participants) treats @ as an ordinary character — no dropdown at all', async () => {
    const { container } = composer();
    const box = await type(container, 'ping @her');
    expect(container.querySelector('.slash-dropdown')).toBeNull();
    // ...and Enter sends the line verbatim rather than completing anything.
    await fireEvent.keyDown(box, { key: 'Enter' });
    expect(box.value).toBe('');
  });

  it('an EMPTY roster is the same as none — a room with nobody in it offers nobody', async () => {
    const { container } = composer({ participants: [] });
    await type(container, 'ping @');
    expect(container.querySelector('.slash-dropdown')).toBeNull();
  });
});

// --- M4.4 truthful banner. `ok: false` covers two opposite situations and the
// composer used to draw the SAME alarm for both. A remote provider that has not
// been probed yet reports the `Checking provider…` sentinel — and the very same
// broadcast kicks the probe that settles it within seconds. Telling that user to
// go check the server is a lie they act on.
describe('InputBar — the connectivity banner does not cry wolf while probing', () => {
  const banner = (c: HTMLElement) => c.querySelector('.model-warning');
  const mountOffline = (props: Record<string, unknown>) =>
    render(InputBar, {
      props: {
        inFlight: false, agentName: 'Tsuru', modelName: '', modelOnline: false,
        sessionId: SID, onSend: () => {}, onCancel: () => {}, ...props,
      },
    });

  it('an UNPROBED remote provider gets a neutral "Checking …" line, not an alarm', () => {
    const { container } = mountOffline({
      modelReason: PROVIDER_PROBING, providerIsLocal: false, providerLabel: 'Spark',
    });
    const el = banner(container)!;
    expect(el.textContent).toContain('Checking Spark…');
    expect(el.textContent).not.toMatch(/unreachable/i);
    expect(el.textContent).not.toMatch(/check the server/i);
    // The alarm styling is what makes it read as a problem, so it is asserted
    // separately from the copy — one without the other is still half a lie.
    expect(el.classList.contains('probing')).toBe(true);
  });

  it('...and a CONFIRMED failed probe still says unreachable, with the alarm on', () => {
    const { container } = mountOffline({
      modelReason: 'ECONNREFUSED 100.64.1.20:8000', providerIsLocal: false, providerLabel: 'Spark',
    });
    const el = banner(container)!;
    expect(el.textContent).toContain('Spark unreachable');
    expect(el.textContent).toContain('check the server');
    expect(el.classList.contains('probing')).toBe(false);
  });

  it('the local no-model case is untouched', () => {
    const { container } = mountOffline({ modelReason: 'no model loaded', providerIsLocal: true });
    const el = banner(container)!;
    expect(el.textContent).toContain('start LM Studio');
    expect(el.classList.contains('probing')).toBe(false);
  });

  it('an ONLINE model has no banner in any of those states', () => {
    const { container } = render(InputBar, {
      props: {
        inFlight: false, agentName: 'Tsuru', modelName: 'qwen3-8b', modelOnline: true,
        modelReason: PROVIDER_PROBING, providerIsLocal: false, providerLabel: 'Spark',
        sessionId: SID, onSend: () => {}, onCancel: () => {},
      },
    });
    expect(banner(container)).toBeNull();
  });
});

// --- M4.4 live cost. Two claims, and only the second is new wiring:
//   1. The badge moves on EVERY usage_update, not at turn end. The engine now
//      throttles them to ~2s mid-turn, so a cost that waited for the turn to
//      finish would report money already spent.
//   2. `subagents` is an OPTIONAL ADDITIVE field. Absent, the badge is exactly
//      what it always was; present, the badge shows the total and the tooltip
//      names the split.
describe('InputBar — the cost badge is live and rolls sub-agents up', () => {
  const costEl = (c: HTMLElement) => c.querySelector('.cost');
  const mountOnline = () =>
    render(InputBar, {
      props: {
        inFlight: true, agentName: 'Tsuru', modelName: 'sonnet', modelOnline: true,
        sessionId: SID, onSend: () => {}, onCancel: () => {},
      },
    });

  it('updates MID-TURN — no turn-end gate', async () => {
    const { container } = mountOnline();
    expect(costEl(container)).toBeNull();          // nothing spent, no badge

    post({ type: 'usageUpdate', sessionId: SID, used: 900, size: 100000, cost: { amount: 0.12 } });
    await waitFor(() => expect(costEl(container)!.textContent).toBe('$0.1200'));

    // A SECOND frame in the same still-in-flight turn moves it again.
    post({ type: 'usageUpdate', sessionId: SID, used: 1800, size: 100000, cost: { amount: 0.34 } });
    await waitFor(() => expect(costEl(container)!.textContent).toBe('$0.3400'));
  });

  it('an engine that sends no `subagents` renders exactly the old badge', async () => {
    const { container } = mountOnline();
    post({ type: 'usageUpdate', sessionId: SID, used: 10, size: 1000, cost: { amount: 2.5 } });
    await waitFor(() => expect(costEl(container)!.textContent).toBe('$2.50'));
    expect(costEl(container)!.getAttribute('title')).not.toContain('subagents');
  });

  it('shows parent + sub-agents as ONE total, broken down in the tooltip', async () => {
    const { container } = mountOnline();
    post({
      type: 'usageUpdate', sessionId: SID, used: 10, size: 1000,
      cost: { amount: 1.25 }, subagents: { cost: 0.75, tokensInput: 900, tokensOutput: 120 },
    });
    await waitFor(() => expect(costEl(container)!.textContent).toBe('$2.00'));
    // Both halves go through the bar's OWN fmtUsd, which gives a sub-dollar
    // figure 4dp — a $0.75 rendered as "$0.75" here and "$0.7500" in the badge
    // would be two money formats on one line.
    expect(costEl(container)!.getAttribute('title')).toContain('$2.00 (+$0.7500 subagents)');
  });

  it('a later frame that omits `subagents` HOLDS the rollup instead of refunding it', async () => {
    // A flickering total would read as the sub-agents having given money back.
    const { container } = mountOnline();
    post({ type: 'usageUpdate', sessionId: SID, used: 10, size: 1000, cost: { amount: 1 }, subagents: { cost: 0.5 } });
    await waitFor(() => expect(costEl(container)!.textContent).toBe('$1.50'));
    post({ type: 'usageUpdate', sessionId: SID, used: 20, size: 1000, cost: { amount: 2 } });
    await waitFor(() => expect(costEl(container)!.textContent).toBe('$2.50'));
  });

  it('sub-agent spend alone is still a badge — the parent being free is not "no cost"', async () => {
    // A local parent orchestrating paid children costs real money, and the old
    // `sessionCost > 0` gate would have shown nothing at all.
    const { container } = mountOnline();
    post({ type: 'usageUpdate', sessionId: SID, used: 10, size: 1000, subagents: { cost: 0.4 } });
    await waitFor(() => expect(costEl(container)!.textContent).toBe('$0.4000'));
  });

  it('ignores another chat\'s usage frame', async () => {
    const { container } = mountOnline();
    post({ type: 'usageUpdate', sessionId: 'someone-else', cost: { amount: 9 }, subagents: { cost: 9 } });
    await new Promise((r) => setTimeout(r, 0));
    expect(costEl(container)).toBeNull();
  });
});

// --- M4.4 YOLO round trip, this end of it. ChatPane posts
// `{type:'setApproveMode', mode:'bypass'}`; DashboardPanel writes the ACP
// config option and echoes `approveUpdate`. This asserts the LAST leg: the
// toggle must show the new mode, because a composer still reading "Approve"
// after a yolo click says the chat will keep prompting when it will not.
describe('InputBar — the Approve toggle follows an externally-set mode', () => {
  const approveBtn = (c: HTMLElement) =>
    Array.from(c.querySelectorAll('.mode-row button'))
      .find((b) => /^(Approve|Auto-approve|Bypass)$/.test(b.textContent?.trim() ?? '')) as HTMLButtonElement;

  const mount = () => render(InputBar, {
    props: {
      inFlight: false, agentName: 'Tsuru', modelName: 'qwen3-8b', modelOnline: true,
      sessionId: SID, onSend: () => {}, onCancel: () => {},
    },
  });

  it('starts on Approve and switches to Bypass when the host echoes it', async () => {
    const { container } = mount();
    expect(approveBtn(container).textContent?.trim()).toBe('Approve');

    post({ type: 'approveUpdate', sessionId: SID, mode: 'bypass' });
    await waitFor(() => expect(approveBtn(container).textContent?.trim()).toBe('Bypass'));
    // The badge above the composer mirrors it too — one of the two lagging
    // would be a composer disagreeing with itself about what happens next.
    expect(container.querySelector('.mode-badge.mode-bypass')?.textContent).toBe('BYPASS');
  });

  it('ignores an approveUpdate addressed to a DIFFERENT chat', async () => {
    // The mode is per-chat. In a grid every cell mounts its own composer, and
    // one chat going yolo must not silently disarm the prompts in another.
    const { container } = mount();
    post({ type: 'approveUpdate', sessionId: 'some-other-chat', mode: 'bypass' });
    await new Promise((r) => setTimeout(r, 0));
    expect(approveBtn(container).textContent?.trim()).toBe('Approve');
  });
});

// t-kgsupy round 4 — the Approve gauge and the Browser control MERGED into
// ONE trigger + ONE popover with TWO labeled rows (round 3 shipped these as
// two separate buttons/popovers; see git history for that shape). The button
// itself can now wear any of five labels depending on WHICH setting is
// riskier (approveButtonState.ts), so the finder matches all of them. Row
// selectors key on ApprovePopover's `.approve-row-{actions,browser}` class —
// scoped, not a global `.approve-notch` index, because opening the ONE
// popover now renders BOTH rows' notches into the same DOM at once.
// Owner UAT: the merged control is named ACCESS, not Browser. It holds BOTH
// access settings — this chat's own Actions preset and VS Code's global
// browser/tool auto-approve — so a label saying "Browser" named the smaller
// half of what the button controls, and read as "this only affects the
// browser". The rename is the USER-VISIBLE strings only; `setApproveMode`,
// `setBrowserAutoApprove` and the popover's own "Browser:" ROW (which really
// is just VS Code's global setting) all keep their names.
describe('approveButtonState — the button names itself Access, never Browser', () => {
  it('calls the browser-only bypass "Access: Bypass"', () => {
    expect(approveButtonState('default', 'bypass').label).toBe('Access: Bypass');
  });

  it('never puts "Browser" on the button in ANY combination of the two settings', () => {
    for (const actions of ['default', 'auto', 'bypass', 'something-else']) {
      for (const browser of ['ask', 'bypass']) {
        const { label } = approveButtonState(actions, browser);
        expect(label, `${actions}/${browser}`).not.toContain('Browser');
        expect(label.length, `${actions}/${browser} has no label`).toBeGreaterThan(0);
      }
    }
  });
});

describe('InputBar — the merged Access popover', () => {
  const approveBtn = (c: HTMLElement) =>
    Array.from(c.querySelectorAll('.mode-row button'))
      .find((b) => /^(Approve|Auto-approve|Bypass|Access: Bypass|Bypass: All)$/.test(b.textContent?.trim() ?? '')) as HTMLButtonElement;
  const actionsNotches = (c: HTMLElement) => c.querySelectorAll('.approve-row-actions .approve-notch');
  const actionsLabels = (c: HTMLElement) =>
    Array.from(c.querySelectorAll('.approve-row-actions .approve-label')).map((l) => l.textContent?.trim());
  const browserNotches = (c: HTMLElement) => c.querySelectorAll('.approve-row-browser .approve-notch');
  const browserLabels = (c: HTMLElement) =>
    Array.from(c.querySelectorAll('.approve-row-browser .approve-label')).map((l) => l.textContent?.trim());

  const mount = () => render(InputBar, {
    props: {
      inFlight: false, agentName: 'Tsuru', modelName: 'qwen3-8b', modelOnline: true,
      sessionId: SID, onSend: () => {}, onCancel: () => {},
    },
  });
  const settle = () => new Promise((r) => setTimeout(r, 0));

  // __vscodeApiMock.postMessage is a module-level spy shared by the whole
  // file — cleared here so "never posts setBrowserAutoApprove/setApproveMode"
  // checks below see only THIS test's own clicks, not a prior test's.
  beforeEach(() => { globalThis.__vscodeApiMock.postMessage.mockClear(); });

  it('starts closed with no popover visible', () => {
    const { container } = mount();
    expect(container.querySelector('.approve-pop')).toBeNull();
  });

  // The tooltip is the only place the control explains itself, so it carries
  // the ACCESS name too — and still has to name BOTH rows, since the whole
  // point of the rename is that the button is not the browser one.
  it('the trigger tooltip calls the control Access and still names both rows', () => {
    const { container } = mount();
    const title = approveBtn(container).getAttribute('title') ?? '';
    expect(title).toContain('Access settings');
    expect(title).toContain('Actions');
    expect(title).toContain('Browser');
  });

  it('asks the host for the live Browser setting on mount, before anything is clicked', async () => {
    mount();
    await settle();
    expect(globalThis.__vscodeApiMock.postMessage).toHaveBeenCalledWith({ type: 'requestBrowserAutoApprove' });
  });

  // Round 5 (t-kgsupy): the header no longer spells out the option names —
  // they already show under the dots (actionsLabels/browserLabels below) — so
  // the row title shrinks to just "Actions:" / "Browser:".
  it('opens ONE popover with both rows, titled just "Actions:" and "Browser:"', async () => {
    const { container } = mount();
    await fireEvent.click(approveBtn(container));
    await settle();
    expect(container.querySelector('.approve-pop')).not.toBeNull();
    expect(container.querySelectorAll('.approve-row').length).toBe(2);
    expect(container.querySelector('.approve-row-actions .approve-row-title')?.textContent?.trim()).toBe('Actions:');
    expect(container.querySelector('.approve-row-browser .approve-row-title')?.textContent?.trim()).toBe('Browser:');
    expect(actionsLabels(container)).toEqual(['Ask', 'Auto', 'Bypass']);
    expect(browserLabels(container)).toEqual(['Ask', 'Bypass']);
  });

  it('re-requests the live Browser value EVERY time the popover opens — never trusts a stale local echo', async () => {
    const { container } = mount();
    await settle();
    globalThis.__vscodeApiMock.postMessage.mockClear();
    await fireEvent.click(approveBtn(container)); // open
    expect(globalThis.__vscodeApiMock.postMessage).toHaveBeenCalledWith({ type: 'requestBrowserAutoApprove' });
    globalThis.__vscodeApiMock.postMessage.mockClear();
    await fireEvent.click(approveBtn(container)); // close — no re-request
    expect(globalThis.__vscodeApiMock.postMessage).not.toHaveBeenCalledWith({ type: 'requestBrowserAutoApprove' });
    globalThis.__vscodeApiMock.postMessage.mockClear();
    await fireEvent.click(approveBtn(container)); // open again
    expect(globalThis.__vscodeApiMock.postMessage).toHaveBeenCalledWith({ type: 'requestBrowserAutoApprove' });
  });

  it('the Actions row drives setApproveMode only, stays open, and never touches Browser', async () => {
    const { container } = mount();
    await fireEvent.click(approveBtn(container));
    await settle();
    await fireEvent.click(actionsNotches(container)[1]); // Auto
    await settle();
    expect(globalThis.__vscodeApiMock.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'setApproveMode', mode: 'auto', sessionId: SID })
    );
    expect(globalThis.__vscodeApiMock.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'setBrowserAutoApprove' })
    );
    // Popover STAYS open after selection — user dismisses it by clicking off
    expect(container.querySelector('.approve-pop')).not.toBeNull();
  });

  it('the Browser row drives setBrowserAutoApprove only (true/false), stays open, and never touches Actions', async () => {
    const { container } = mount();
    await fireEvent.click(approveBtn(container));
    await settle();
    await fireEvent.click(browserNotches(container)[1]); // Bypass
    expect(globalThis.__vscodeApiMock.postMessage).toHaveBeenCalledWith({ type: 'setBrowserAutoApprove', value: true });
    await fireEvent.click(browserNotches(container)[0]); // Ask
    expect(globalThis.__vscodeApiMock.postMessage).toHaveBeenCalledWith({ type: 'setBrowserAutoApprove', value: false });
    expect(globalThis.__vscodeApiMock.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'setApproveMode' })
    );
    expect(container.querySelector('.approve-pop')).not.toBeNull();
  });

  it('the active dot in each row reflects its OWN setting, independently of the other row', async () => {
    const { container } = mount();
    post({ type: 'approveUpdate', sessionId: SID, mode: 'bypass' }); // Actions -> Bypass
    post({ type: 'browserAutoApproveUpdate', value: false }); // Browser stays Ask
    await settle();
    await fireEvent.click(approveBtn(container));
    await settle();
    expect(actionsNotches(container)[2].classList.contains('active')).toBe(true); // Actions: Bypass
    expect(actionsNotches(container)[0].classList.contains('active')).toBe(false);
    expect(browserNotches(container)[0].classList.contains('active')).toBe(true); // Browser: Ask
    expect(browserNotches(container)[1].classList.contains('active')).toBe(false);
  });

  // Round 4's own requirement: the Actions row is a per-session permission
  // (nothing to auto-approve in plan mode), but Browser is VS Code's global
  // setting and must stay reachable — so plan mode dims the ROW, not the
  // trigger, unlike round 3 where the whole (then Actions-only) button
  // disabled itself.
  it('plan mode disables the Actions row notches but leaves the trigger and the Browser row clickable', async () => {
    const { container } = mount();
    post({ type: 'modeUpdate', sessionId: SID, mode: 'plan' });
    await settle();
    expect(approveBtn(container).disabled).toBeFalsy();
    await fireEvent.click(approveBtn(container));
    await settle();
    for (const n of Array.from(actionsNotches(container))) expect((n as HTMLButtonElement).disabled).toBe(true);
    for (const n of Array.from(browserNotches(container))) expect((n as HTMLButtonElement).disabled).toBeFalsy();
  });

  it('an external browserAutoApproveUpdate(true) lights the MERGED button — the setting can change outside Origami', async () => {
    const { container } = mount();
    post({ type: 'browserAutoApproveUpdate', value: true });
    await settle();
    expect(approveBtn(container).textContent?.trim()).toBe('Access: Bypass');
    expect(approveBtn(container).classList.contains('bypass')).toBe(true);
  });

  // The ticket's own wording for the merged button: label/colour must
  // "reflect BOTH states sensibly". Actions bypass ALONE and Browser bypass
  // ALONE both already read 'Bypass'/'Access: Bypass' above — this pins the
  // WIDER case where both are armed together, which approveButtonState.ts
  // gives its own label rather than silently collapsing into either single
  // axis (a user glancing at 'Bypass' alone would not know Browser is ALSO
  // globally bypassed, every workspace).
  it('both axes bypassed at once gets its own label, not just "Bypass" or "Access: Bypass"', async () => {
    const { container } = mount();
    post({ type: 'approveUpdate', sessionId: SID, mode: 'bypass' }); // Actions -> Bypass
    post({ type: 'browserAutoApproveUpdate', value: true }); // Browser -> Bypass
    await settle();
    expect(approveBtn(container).textContent?.trim()).toBe('Bypass: All');
    expect(approveBtn(container).classList.contains('bypass')).toBe(true);
  });

  // Fix round (verifier-confirmed, carried into round 4): the Browser row's
  // notch flips OPTIMISTICALLY on click, before the host's config write
  // resolves. This drives the failure all the way through the MERGED button
  // and checks what it is left displaying. The dangerous direction: Bypass
  // was on, the user clicks Ask to turn it off, the write throws — the
  // button must NOT settle on the optimistic "safe-looking" label; it must
  // revert once the host's corrective browserAutoApproveUpdate arrives.
  it('a failed Browser write reverts the optimistic click on the merged button once the host corrects it', async () => {
    const { container } = mount();
    post({ type: 'browserAutoApproveUpdate', value: true }); // starts on Bypass
    await settle();
    expect(approveBtn(container).textContent?.trim()).toBe('Access: Bypass');

    await fireEvent.click(approveBtn(container)); // open popover
    await settle();
    await fireEvent.click(browserNotches(container)[0]); // click Ask
    // optimistic: the merged button already shows the guess, before any host reply
    expect(approveBtn(container).textContent?.trim()).toBe('Approve');
    expect(approveBtn(container).classList.contains('bypass')).toBe(false);

    // host's write failed; it corrects with the real (unchanged) live value
    post({ type: 'browserAutoApproveUpdate', value: true });
    await settle();
    expect(approveBtn(container).textContent?.trim()).toBe('Access: Bypass');
    expect(approveBtn(container).classList.contains('bypass')).toBe(true);
  });
});

// t-kgtr6c — the VISION button, and this panel's WIRE to it.
//
// It is the ONE control the whole feature hangs on: with no profile chosen the
// engine registers no tool and injects no prompt, so a user who cannot find or
// cannot trust this button has a feature that never fires. Four things are
// therefore correctness, not looks:
//
//  1. It must post the SLUG the user picked, on the posting panel's session.
//     A wrong sessionId in grid mode arms the chat you are not looking at.
//  2. "Off" must post an EMPTY string, because that is the engine's clear-word
//     (acp/service.ts). Posting "off" or omitting the field would leave the
//     profile armed while the button said otherwise.
//  3. The roster is NOT session-scoped. Profiles are files in one directory,
//     shared by every chat; filtering them by session would leave a second
//     panel's menu permanently empty.
//  4. `isVlm` must reach the button as `native` (round 3). It is the webview's
//     copy of the field the engine gates on, and the button is now the only
//     place a user is told whether the model can see — the separate read-out
//     chip that used to say so has been deleted.
//
// The button's own state table (native / blind / armed) lives in
// VisionProfileMenu.test.ts; what is tested here is the panel around it.
describe('InputBar — the vision profile button', () => {
  const eyeBtn = (c: HTMLElement) =>
    Array.from(c.querySelectorAll('.mode-row button')).find((b) => b.textContent?.trim().startsWith('Vision')) as HTMLButtonElement;
  const roster = (defs: string[]) =>
    post({ type: 'collabAgentDefs', visionDefs: defs.map((slug) => ({ slug })) });
  const settle = () => new Promise((r) => setTimeout(r, 0));

  function mount(props: Record<string, unknown> = {}) {
    return render(InputBar, {
      props: {
        inFlight: false, agentName: 'Tsuru', modelName: 'qwen3-8b', modelOnline: true,
        sessionId: SID, onCompact: () => {}, onSend: () => {}, onCancel: () => {},
        ...props,
      },
    });
  }

  beforeEach(() => { globalThis.__vscodeApiMock.postMessage.mockClear(); });
  const posts = () =>
    globalThis.__vscodeApiMock.postMessage.mock.calls.map((c: unknown[]) => c[0]) as Array<Record<string, unknown>>;

  it('reads OFF by default — the route costs a tool and a prompt block, so it is opted into', async () => {
    const { container } = mount();
    await settle();
    expect(eyeBtn(container).textContent?.trim()).toBe('Vision');
    expect(eyeBtn(container).classList.contains('active')).toBe(false);
  });

  // Round 3's consolidation, from the panel's side. Before it, `isVlm` lit a
  // separate chip that this button knew nothing about — so the row could show
  // "this model sees" beside a control offering to route around a model that
  // does not. There is now ONE control and it has to be handed that fact.
  it('hands isVlm down as `native`, and shows one Vision control rather than two', async () => {
    const { container } = mount({ isVlm: true });
    await settle();
    expect(container.querySelectorAll('.vision-btn')).toHaveLength(1);
    expect(eyeBtn(container).classList.contains('native')).toBe(true);
    // The deleted read-out chip. Named so a re-add is a deliberate act.
    expect(container.querySelector('.vision-indicator')).toBeNull();
  });

  it('a model with no vision of its own leaves the button neutral', async () => {
    const { container } = mount({ isVlm: false });
    await settle();
    expect(eyeBtn(container).classList.contains('native')).toBe(false);
  });

  it('asks the host for the profile roster on mount, so the button can name one straight away', async () => {
    mount();
    await settle();
    expect(posts().some((p) => p.type === 'listCollabAgentDefs')).toBe(true);
  });

  it('picking a profile posts its slug for THIS panel’s session', async () => {
    const { container } = mount();
    roster(['vision-eye']);
    await settle();
    await fireEvent.click(eyeBtn(container));
    await settle();

    const item = Array.from(container.querySelectorAll('.vision-item')).find((b) => b.textContent?.includes('vision-eye'))!;
    await fireEvent.click(item);
    await settle();

    expect(posts().find((p) => p.type === 'setVisionProfile')).toEqual({
      type: 'setVisionProfile', profile: 'vision-eye', sessionId: SID,
    });
    // Optimistic: the button names it before the engine echoes back.
    expect(eyeBtn(container).textContent?.trim()).toBe('Vision: vision-eye');
  });

  it('Off posts an EMPTY string — the engine’s clear-word, not the word "off"', async () => {
    const { container } = mount();
    roster(['vision-eye']);
    post({ type: 'visionUpdate', sessionId: SID, profile: 'vision-eye' });
    await settle();
    expect(eyeBtn(container).classList.contains('active')).toBe(true);

    await fireEvent.click(eyeBtn(container));
    await settle();
    const off = Array.from(container.querySelectorAll('.vision-item')).find((b) => b.textContent?.trim() === 'Off')!;
    await fireEvent.click(off);
    await settle();

    expect(posts().find((p) => p.type === 'setVisionProfile')).toMatchObject({ profile: '' });
    expect(eyeBtn(container).classList.contains('active')).toBe(false);
  });

  it('a failed write clears the button, so it never stays lit for a profile the engine refused', async () => {
    const { container } = mount();
    roster(['vision-eye']);
    post({ type: 'visionUpdate', sessionId: SID, profile: 'vision-eye' });
    await settle();
    // What DashboardPanel/visionProfile.ts sends on a refusal.
    post({ type: 'visionUpdate', sessionId: SID, profile: '' });
    await settle();
    expect(eyeBtn(container).textContent?.trim()).toBe('Vision');
  });

  it('sends you to the Agents board when there are no profiles at all', async () => {
    const { container } = mount();
    roster([]);
    await settle();
    await fireEvent.click(eyeBtn(container));
    await settle();
    expect(container.querySelector('.vision-empty')!.textContent).toContain('Vision Agents');
    // ...and offers nothing to pick, rather than an "Off" that is already true.
    expect(container.querySelectorAll('.vision-item').length).toBe(0);
  });

  it('another chat’s visionUpdate never touches this panel', async () => {
    const { container } = mount();
    roster(['vision-eye']);
    post({ type: 'visionUpdate', sessionId: 'someone-else', profile: 'vision-eye' });
    await settle();
    expect(eyeBtn(container).textContent?.trim()).toBe('Vision');
  });
});

// DEEP PLAN in the composer. The control itself is tested next door
// (ModeControl.test.ts); what is asserted HERE is the wiring only this file can
// see - that the composer posts the third mode to the engine, and that
// everything which used to ask "is this chat in plan mode?" now answers
// correctly for deep-plan too. That second half is the half a widened toggle
// silently gets wrong: the button lights, and the auto-approve preset the mode
// exists to suppress stays armed.
describe('InputBar - the third session mode', () => {
  const MSID = 'sess-mode-1';
  const mountMode = () =>
    render(InputBar, {
      props: {
        inFlight: false, agentName: 'Tsuru', modelName: 'qwen3-8b', modelOnline: true,
        sessionId: MSID, onCompact: () => {}, onSend: () => {}, onCancel: () => {},
      },
    });
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const sent = (type: string) =>
    globalThis.__vscodeApiMock.postMessage.mock.calls
      .map((call) => call[0] as Record<string, unknown>)
      .filter((msg) => msg.type === type);
  const modeTrigger = (c: HTMLElement) => c.querySelector('.mode-wrap .mode-btn') as HTMLButtonElement;
  // The mode panel is the ACCESS dot rail now, so a mode is picked by clicking
  // the NOTCH under its label, not a text button. Located by the label the user
  // actually reads, so this still fails if the names change.
  const openTo = async (c: HTMLElement, name: string) => {
    await fireEvent.click(modeTrigger(c));
    const labels = Array.from(c.querySelectorAll('.mode-pop .approve-label')).map((l) => l.textContent?.trim());
    const index = labels.indexOf(name);
    expect(index, `no "${name}" dot on the mode rail (saw ${labels.join(', ')})`).toBeGreaterThan(-1);
    await fireEvent.click(c.querySelectorAll('.mode-pop .approve-notch')[index] as HTMLButtonElement);
    await tick();
  };

  it('posts setMode deep-plan for THIS panel', async () => {
    const { container } = mountMode();
    globalThis.__vscodeApiMock.postMessage.mockClear();
    await openTo(container, 'Deep Plan');
    expect(sent('setMode')).toEqual([{ type: 'setMode', modeId: 'deep-plan', sessionId: MSID }]);
    // Optimistic, so the row says so before the engine echoes back.
    expect(modeTrigger(container).textContent?.trim()).toBe('Deep Plan: on');
  });

  it('still posts plan and build through the same control', async () => {
    const { container } = mountMode();
    globalThis.__vscodeApiMock.postMessage.mockClear();
    await openTo(container, 'Plan');
    await openTo(container, 'Build');
    expect(sent('setMode').map((msg) => msg.modeId)).toEqual(['plan', 'build']);
  });

  it('drops an armed auto-approve preset on the way into deep-plan', async () => {
    const { container } = mountMode();
    post({ type: 'approveUpdate', sessionId: MSID, mode: 'bypass' });
    await tick();
    globalThis.__vscodeApiMock.postMessage.mockClear();
    await openTo(container, 'Deep Plan');
    // A session-scoped bypass ruleset overrides the deep-plan agent's OWN edit
    // denies - the boundary that stops it writing outside its plan folder. Plan
    // mode has always cleared it; deep-plan needs it at least as much.
    expect(sent('setApproveMode')).toEqual([{ type: 'setApproveMode', mode: 'default', sessionId: MSID }]);
  });

  it('leaves the preset alone on the way into build', async () => {
    const { container } = mountMode();
    post({ type: 'approveUpdate', sessionId: MSID, mode: 'bypass' });
    await tick();
    globalThis.__vscodeApiMock.postMessage.mockClear();
    await openTo(container, 'Build');
    expect(sent('setApproveMode')).toEqual([]);
  });

  it('dims the Actions rail in deep-plan, and keeps Browser reachable', async () => {
    const { container } = mountMode();
    post({ type: 'modeUpdate', sessionId: MSID, mode: 'deep-plan' });
    await tick();
    const approve = Array.from(container.querySelectorAll('.mode-row button')).find(
      (b) => b.textContent?.trim() === 'Approve',
    ) as HTMLButtonElement;
    // The TRIGGER stays live - Browser is VS Code's own global setting, not a
    // per-session permission, so it must stay reachable in every mode.
    expect(approve.disabled).toBe(false);
    await fireEvent.click(approve);
    await tick();
    const rows = container.querySelectorAll('.approve-row');
    const notches = (row: Element) => Array.from(row.querySelectorAll('.approve-notch')) as HTMLButtonElement[];
    expect(notches(rows[0]).every((b) => b.disabled)).toBe(true);
    expect(notches(rows[1]).some((b) => b.disabled)).toBe(false);
  });

  it('wears a DEEP-PLAN badge, not a bare mode name', async () => {
    const { container } = mountMode();
    post({ type: 'modeUpdate', sessionId: MSID, mode: 'deep-plan' });
    await tick();
    const badge = container.querySelector('.mode-badge.mode-deep-plan');
    expect(badge?.textContent?.trim()).toBe('DEEP-PLAN');
  });

  it('never lights for another chat\u2019s mode change', async () => {
    const { container } = mountMode();
    post({ type: 'modeUpdate', sessionId: 'someone-else', mode: 'deep-plan' });
    await tick();
    expect(modeTrigger(container).textContent?.trim()).toBe('Plan');
  });

  // `/plan` has TWO paths and they are not the same code. Picking it in the
  // palette calls the composer's own mode switch; typing it and pressing Enter
  // posts a `slashCommand` the HOST routes through MODE_COMMANDS. Both are
  // asserted, because the toggle rewrite could only have broken the first and
  // the new mode is only reachable through the second.
  it('keeps the /plan palette entry a straight toggle', async () => {
    const { container } = render(InputBar, {
      props: {
        inFlight: false, agentName: 'Tsuru', modelName: 'qwen3-8b', modelOnline: true,
        sessionId: MSID, onCompact: () => {}, onSend: () => {}, onCancel: () => {},
        commands: [{ name: '/plan', description: 'Plan mode', category: 'Mode' }],
      },
    });
    globalThis.__vscodeApiMock.postMessage.mockClear();
    const box = container.querySelector('textarea.input') as HTMLTextAreaElement;
    await fireEvent.input(box, { target: { value: '/pla' } });
    await fireEvent.keyDown(box, { key: 'Enter' });
    await tick();
    expect(sent('setMode').map((msg) => msg.modeId)).toEqual(['plan']);
    // ...and toggles back off, rather than re-posting 'plan' forever.
    await fireEvent.input(box, { target: { value: '/pla' } });
    await fireEvent.keyDown(box, { key: 'Enter' });
    await tick();
    expect(sent('setMode').map((msg) => msg.modeId)).toEqual(['plan', 'build']);
  });

  it('hands a typed /deep-plan to the host, where MODE_COMMANDS routes it', async () => {
    const { container } = mountMode();
    globalThis.__vscodeApiMock.postMessage.mockClear();
    const box = container.querySelector('textarea.input') as HTMLTextAreaElement;
    await fireEvent.input(box, { target: { value: '/deep-plan ' } });
    await fireEvent.keyDown(box, { key: 'Enter' });
    await tick();
    // The hyphen is the trap: the composer splits on whitespace, so the command
    // must arrive whole. A split on '-' would post 'deep', which MODE_COMMANDS
    // does not know and the host would send to the model as a prompt.
    expect(sent('slashCommand')).toEqual([{ type: 'slashCommand', command: 'deep-plan', args: '' }]);
    expect(sent('setMode')).toEqual([]);
  });
});

// 0.4.61 UAT, second round: "the eye sits at the far right, above the Send
// button, and the whole row floats with a band of empty space under it".
//
// The utility row was a SIBLING of `.input-row`, so it spanned the full footer
// and `margin-left: auto` pushed the eye past the textarea and over Send. The
// fix puts the row and the textarea in one column, `.input-col`, with the
// button column beside it — so the row can only ever be as wide as the box it
// belongs to.
//
// WHAT THIS SUITE CANNOT DO: prove the alignment. jsdom has no layout engine
// and vitest.config.mts loads no stylesheet, so widths, the gap and the eye's
// right edge are all invisible here — `getComputedStyle` would return '' and
// an assertion on it would look rigorous and check nothing. The PARENTAGE is
// what makes the alignment possible, and parentage is checkable. The pixels
// need a human eye.
describe('InputBar — the utility row belongs to the textarea, not to the footer', () => {
  const mountFooter = (props: Record<string, unknown> = {}) =>
    render(InputBar, {
      props: {
        inFlight: false, agentName: 'Tsuru', modelName: 'qwen3-8b', modelOnline: true,
        sessionId: SID, onSend: () => {}, onCancel: () => {}, onToggleFocus: () => {}, ...props,
      },
    }).container;

  it('puts the changes row and the textarea in ONE column, with Send outside it', () => {
    const c = mountFooter();
    const col = c.querySelector('.input-row > .input-col');
    expect(col, 'the textarea needs a column of its own to align the row to').not.toBeNull();
    // Both children of the same column — this is the whole fix.
    expect(col!.querySelector(':scope > .changes-row')).not.toBeNull();
    expect(col!.querySelector(':scope > textarea.input')).not.toBeNull();
    // ...and the buttons are NOT in it, or the row would span them again.
    expect(col!.querySelector('.btn-col'), 'Send must stay outside the column').toBeNull();
    expect(c.querySelector('.input-row > .btn-col'), 'Send is the column\'s sibling').not.toBeNull();
  });

  it('draws the row ABOVE the box, not below it', () => {
    // Order is the difference between a row that sits on the textarea and one
    // that sits under it; both would satisfy "same parent".
    const kids = [...mountFooter().querySelector('.input-col')!.children].map((el) => el.className);
    expect(kids[0]).toContain('changes-row');
    expect(kids[1]).toContain('input');
  });

  it('a BARE composer puts the textarea in the same column and NOTHING above it', () => {
    // The collab composer passes no onToggleFocus and has no changes, so the
    // row must not render — the wrapper must not cost it a line of height.
    const c = mountFooter({ bare: true, onToggleFocus: undefined, sessionId: null });
    const col = c.querySelector('.input-row > .input-col');
    expect(col).not.toBeNull();
    expect(col!.querySelector('.changes-row'), 'no transcript, no row').toBeNull();
    expect(col!.querySelector('textarea.input')).not.toBeNull();
    expect(col!.children.length, 'the box alone').toBe(1);
  });
});
