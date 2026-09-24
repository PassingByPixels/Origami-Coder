// passthroughGates.test.ts — the five affordances a Claude Code passthrough
// cell must HIDE, asserted where they are actually drawn.
//
// A table test would only prove passthroughCaps.ts agrees with itself. These
// mount the real components twice — once as an engine chat, once as a
// passthrough — and assert the control is THERE and then GONE. That pairing is
// the point: a gate that hides a control for everybody passes a
// "not.toBeTruthy" on its own, and would silently take the affordance away from
// every ordinary chat.

import { render, fireEvent } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import ChatTranscript from './ChatTranscript.svelte';
import ComposerUtilityRow from './ComposerUtilityRow.svelte';
import ModelPicker from './ModelPicker.svelte';
import type { Message } from '../panes/chatMessage';
import { PASSTHROUGH_KIND, PASSTHROUGH_OFF, capabilityOn, isPassthrough } from '../panes/passthroughCaps';

const AGENT_TURN: Message[] = [
  { id: 1, kind: 'user', label: 'You', text: 'do the thing' },
  // engineMsgId is the rewind anchor: an engine turn HAS one.
  { id: 2, kind: 'agent', label: 'Tsuru', text: 'done', engineMsgId: 'eng-2' },
];

describe('the capability table', () => {
  it('keeps every affordance for an engine chat (no kind) and drops five for a passthrough', () => {
    for (const cap of PASSTHROUGH_OFF) {
      expect(capabilityOn(undefined, cap), `engine chat lost ${cap}`).toBe(true);
      expect(capabilityOn('chat', cap), `named chat lost ${cap}`).toBe(true);
      expect(capabilityOn(PASSTHROUGH_KIND, cap), `passthrough kept ${cap}`).toBe(false);
    }
    expect(PASSTHROUGH_OFF).toEqual(['rewind', 'compaction', 'insights', 'subagentModel', 'secondOpinion']);
    expect(isPassthrough('claude')).toBe(true);
    expect(isPassthrough('agent')).toBe(false);
  });
});

describe('rewind', () => {
  it('offers "Rewind here" on an engine turn', () => {
    const { container } = render(ChatTranscript, { messages: AGENT_TURN, sessionId: 's1', inFlight: false });
    expect(container.querySelector('.rewind-btn')).toBeTruthy();
  });

  it('does not offer it on a passthrough turn', () => {
    const { container } = render(ChatTranscript, { messages: AGENT_TURN, sessionId: 's1', inFlight: false, passthrough: true });
    expect(container.querySelector('.rewind-btn')).toBeNull();
    // The rest of the transcript still renders — hidden, not broken.
    expect(container.querySelector('.agent-row')).toBeTruthy();
  });
});

describe('second opinion', () => {
  it('draws the scales for an engine chat', () => {
    const { container } = render(ComposerUtilityRow, { secondOpinionFor: 's1' });
    expect(container.querySelector('.second-opinion')).toBeTruthy();
  });

  it('draws nothing for a passthrough chat — the null the prop already documents', () => {
    // InputBar passes `bare || passthrough ? null : sessionId`; this is that null.
    const { container } = render(ComposerUtilityRow, { secondOpinionFor: null });
    expect(container.querySelector('.second-opinion')).toBeNull();
  });
});

describe('sub-agent model target', () => {
  it('offers the Sub-agents target in an engine chat\'s picker', async () => {
    const { container, getByText } = render(ModelPicker, { sessionId: 's1', fallbackName: 'haiku' });
    await fireEvent.click(container.querySelector('.mp-trigger')!);
    expect(getByText('Sub-agents')).toBeTruthy();
    expect(container.querySelectorAll('.mp-target-btn')).toHaveLength(2);
  });

  it('hides it in a passthrough chat\'s picker, leaving the model list usable', async () => {
    const { container, queryByText } = render(ModelPicker, { sessionId: 's1', fallbackName: 'haiku', passthrough: true });
    await fireEvent.click(container.querySelector('.mp-trigger')!);
    expect(queryByText('Sub-agents')).toBeNull();
    expect(container.querySelectorAll('.mp-target-btn')).toHaveLength(0);
    // The menu itself still opened.
    expect(container.querySelector('.mp-menu')).toBeTruthy();
  });
});

describe('compaction', () => {
  // InputBar's gauge is the compaction control. Rendering it needs a live
  // contextUpdate broadcast, so this asserts on the SOURCE instead — the three
  // handlers and the threshold menu must every one be gated on `passthrough`.
  // A source assertion is honest here in a way a DOM one would not be: jsdom
  // loads no <style>, so "the button looks inert" is unobservable.
  const src = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), 'InputBar.svelte'), 'utf8',
  );

  it('gates every compaction affordance on the passthrough flag', () => {
    expect(src).toContain('onclick={(e) => { if (passthrough) return;');
    expect(src).toContain('onkeydown={(e) => { if (passthrough) return;');
    expect(src).toContain('oncontextmenu={passthrough ? undefined : openCompactionMenu}');
    expect(src).toContain('open={compactionMenuOpen && !passthrough}');
    // The button AFFORDANCE (role, tab stop, hover style) goes with it.
    expect(src).toContain('class:ctx-gauge-btn={!passthrough}');
    expect(src).toContain("role={passthrough ? undefined : 'button'}");
  });

  it('still shows the reading — a passthrough chat has a real context window', () => {
    expect(src).toContain('Claude Code manages its own compaction');
  });
});

describe('the kind string is mirrored, so it needs a drift guard', () => {
  // The guard reads the DECLARING file, never a re-export: pointed at one it
  // would match nothing and pass a rename it should have caught, which is the
  // failure mode a drift guard exists to avoid. The declaration has moved twice
  // — to claudeCodeCell.ts in round 2, and on to claudeCodeCells.ts (the cell
  // REGISTRY) in the adversarial round — and this guard caught the second move
  // itself, which is the behaviour to keep.
  it('agrees with the host-side declaration in claudeCodeCells.ts', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const host = readFileSync(path.join(here, '..', '..', '..', 'src', 'dashboard', 'claudeCodeCells.ts'), 'utf8');
    const hostKind = /export const PASSTHROUGH_KIND = '([^']+)'/.exec(host)?.[1];
    expect(hostKind, 'claudeCodeCells.ts no longer declares PASSTHROUGH_KIND').toBe(PASSTHROUGH_KIND);
  });
});
