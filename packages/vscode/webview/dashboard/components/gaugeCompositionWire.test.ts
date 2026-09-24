// t-s8ikm2 — the context gauge's breakdown card, from the wire to the hover.
//
// The live bug: on a 0.4.160 opencode-go session the gauge showed its long
// plain tooltip, because the engine's usage_update carried no composition.
// The engine side is fixed and tested in packages/engine/test/acp/
// usage-composition-wire.test.ts. These tests hold the client half: a frame
// shaped as the engine's `buildUsageUpdate` emits it must reach InputBar as a
// composition and draw the card, and a frame with none must keep the plain tip.

import { render, fireEvent, cleanup } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AcpClient, type AcpEventHandlers } from '../../../src/acpClient';
import InputBar from './InputBar.svelte';

afterEach(cleanup);

const COMPOSITION = { systemPrompt: 3_000, tools: 6, conversation: 327_994, estimated: true, method: 'chars/4 ...' };

/** A usage_update as engine acp/usage.ts `buildUsageUpdate` builds it. */
function usageFrame(meta?: Record<string, unknown>) {
  return {
    sessionId: 'ses_go',
    update: {
      sessionUpdate: 'usage_update',
      used: 331_000,
      size: 1_000_000,
      cost: { amount: 0.01, currency: 'USD' },
      ...(meta ? { _meta: meta } : {}),
    },
  };
}

async function decode(frame: ReturnType<typeof usageFrame>) {
  const onUsageUpdate = vi.fn();
  const client = new AcpClient({ onUsageUpdate } as unknown as AcpEventHandlers);
  const impl = (client as unknown as { buildClientImpl: () => { sessionUpdate(p: unknown): Promise<void> } }).buildClientImpl();
  await impl.sessionUpdate(frame);
  return onUsageUpdate.mock.calls[0]?.[0] as { used: number; composition?: unknown } | undefined;
}

describe('acpClient decodes the composition off usage_update._meta', () => {
  it('passes the engine frame\'s composition to the host, next to the cache block', async () => {
    const args = await decode(usageFrame({ composition: COMPOSITION, cache: { read: 330_000, write: 0 } }));
    expect(args?.used).toBe(331_000);
    expect(args?.composition).toMatchObject({ systemPrompt: 3_000, tools: 6, conversation: 327_994 });
  });

  it('reports no composition when the engine sent none', async () => {
    const args = await decode(usageFrame({ cache: { read: 330_000, write: 0 } }));
    expect(args?.used).toBe(331_000);
    expect(args?.composition).toBeUndefined();
  });
});

const SID = 'ses_go';
const post = (data: Record<string, unknown>) => window.dispatchEvent(new MessageEvent('message', { data }));

async function gaugeAfter(usage: Record<string, unknown>): Promise<HTMLElement> {
  const { container } = render(InputBar, {
    props: {
      inFlight: false, agentName: 'Tsuru', modelName: 'deepseek-v4.1-flash', modelOnline: true,
      sessionId: SID, onCompact: () => {}, onSend: () => {}, onCancel: () => {},
    },
  });
  // The host's post for a usage_update (DashboardPanel onUsageUpdate).
  post({ type: 'usageUpdate', sessionId: SID, used: 331_000, size: 1_000_000, cost: { amount: 0.01 }, ...usage });
  await new Promise((r) => setTimeout(r, 0));
  return container as HTMLElement;
}

describe('the gauge on hover, after a usageUpdate', () => {
  it('draws the breakdown card, and no plain tooltip, when the frame carries a composition', async () => {
    const c = await gaugeAfter({ composition: COMPOSITION });
    await fireEvent.mouseEnter(c.querySelector('.ctx-gauge-wrap')!);
    expect(c.querySelector('.ctx-card')).not.toBeNull();
    expect((c.querySelector('.ctx-gauge') as HTMLElement).dataset.tip).toBe('');
  });

  it('keeps the plain tooltip, and draws no card, when the frame has none', async () => {
    const c = await gaugeAfter({});
    await fireEvent.mouseEnter(c.querySelector('.ctx-gauge-wrap')!);
    expect(c.querySelector('.ctx-card')).toBeNull();
    expect((c.querySelector('.ctx-gauge') as HTMLElement).dataset.tip).toMatch(/^331k context \(last step\) of 1000k tokens/);
  });
});
