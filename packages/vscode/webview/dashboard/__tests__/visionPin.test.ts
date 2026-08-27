// The Vision PIN — the third bit, and the two places it has to be obeyed.
//
// THE REQUIREMENT. `readModelVision` / `writeModelVision` carry ONE boolean, and
// the reconcile pass writes that same boolean from whatever the local server
// says. So without a second store there is no way to tell "LM Studio called this
// a vlm" from "the owner said so", and every manual choice is reverted the next
// time a panel opens. The pin is that second store, and the whole feature is
// worth nothing unless reconcile SKIPS a pinned model — that is the test below
// that must go red the moment the skip is removed.
//
// FRESH FIXTURES. Nothing here was captured from a running panel. The store is a
// Map behind the two Memento methods the module declares (`update(k, undefined)`
// DELETES, which is what clearing a pin relies on), and the host is a recorder.
// No `vscode`, no fs, no network — visionPin.ts imports none of them, which is
// the property that makes this file possible.
//
// The last block asserts the WIRING in DashboardPanel.ts by reading its source,
// the same way oauthLiveness.test.ts and engineStale.test.ts do: the panel class
// cannot be instantiated without an extension host, and the gap this feature
// closed was precisely a leaf that was written, imported, and never called.

import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyVisionPin,
  readVisionPin,
  splitModel,
  visionPinKey,
  visionStateFor,
  visionWrites,
  writeVisionPin,
  type PinStore,
  type VisionPinHost,
} from '../../../src/dashboard/visionPin';
import { VISION_MODES } from '../components/visionPinState';

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** A Memento over a Map. The one behaviour that matters is the delete. */
function storeOf(seed: Record<string, unknown> = {}): PinStore & { map: Map<string, unknown> } {
  const map = new Map<string, unknown>(Object.entries(seed));
  return {
    map,
    get: <T>(key: string) => map.get(key) as T | undefined,
    update: async (key: string, value: unknown) => {
      if (value === undefined) map.delete(key);
      else map.set(key, value);
    },
  };
}

describe('the key a pin is filed under', () => {
  it('is namespaced and carries the PROVIDER as well as the model', () => {
    expect(visionPinKey('lmstudio', 'qwen2.5-vl-7b')).toBe('origami.visionPin.lmstudio/qwen2.5-vl-7b');
  });

  it('keeps two servers offering the SAME model id apart', () => {
    // A local 4-bit quant and a remote FP8 of "qwen3-vl" are different machines
    // with different projectors; a pin on one must not speak for the other.
    expect(visionPinKey('lmstudio', 'qwen3-vl')).not.toBe(visionPinKey('spark', 'qwen3-vl'));
  });

  it('survives a model id containing slashes of its own', () => {
    expect(visionPinKey('lmstudio', 'qwen/qwen3-vl-8b')).toBe('origami.visionPin.lmstudio/qwen/qwen3-vl-8b');
  });
});

describe('round-tripping a pin through the store', () => {
  it('writes, reads back, and clears to AUTO by DELETING the key', async () => {
    const store = storeOf();
    await writeVisionPin(store, 'lmstudio', 'qwen3-vl', 'on');
    expect(readVisionPin(store, 'lmstudio', 'qwen3-vl')).toBe('on');

    await writeVisionPin(store, 'lmstudio', 'qwen3-vl', 'off');
    expect(readVisionPin(store, 'lmstudio', 'qwen3-vl')).toBe('off');

    await writeVisionPin(store, 'lmstudio', 'qwen3-vl', undefined);
    expect(readVisionPin(store, 'lmstudio', 'qwen3-vl')).toBeUndefined();
    // Not "stored as undefined" — GONE. globalState is synced and persisted, so a
    // tombstone per model the owner once touched would accumulate forever.
    expect(store.map.has(visionPinKey('lmstudio', 'qwen3-vl'))).toBe(false);
  });

  it('an unpinned model reads as AUTO rather than throwing', () => {
    expect(readVisionPin(storeOf(), 'lmstudio', 'never-touched')).toBeUndefined();
  });

  it('a value the store should not contain degrades to AUTO, never a third state', () => {
    // A newer build, a corrupted sync, a hand-edited state db. Detection taking
    // the model back is recoverable; a model stranded on a state the UI cannot
    // draw is not.
    const store = storeOf({
      [visionPinKey('lmstudio', 'a')]: 'yes',
      [visionPinKey('lmstudio', 'b')]: true,
      [visionPinKey('lmstudio', 'c')]: null,
    });
    expect(readVisionPin(store, 'lmstudio', 'a')).toBeUndefined();
    expect(readVisionPin(store, 'lmstudio', 'b')).toBeUndefined();
    expect(readVisionPin(store, 'lmstudio', 'c')).toBeUndefined();
  });

  it('an empty provider or model is never looked up at all', () => {
    const store = storeOf({ 'origami.visionPin./': 'on', 'origami.visionPin.lmstudio/': 'on' });
    expect(readVisionPin(store, '', 'qwen3-vl')).toBeUndefined();
    expect(readVisionPin(store, 'lmstudio', '')).toBeUndefined();
  });
});

describe('splitModel — provider/model, first slash only', () => {
  it.each([
    ['lmstudio/qwen3-vl', 'lmstudio', 'qwen3-vl'],
    // The engine serves ids that carry their own slashes; splitting on the last
    // one would file the pin under provider "lmstudio/qwen".
    ['lmstudio/qwen/qwen3-vl-8b', 'lmstudio', 'qwen/qwen3-vl-8b'],
    ['openrouter/anthropic/claude-sonnet-4.5', 'openrouter', 'anthropic/claude-sonnet-4.5'],
  ])('%s -> %s + %s', (current, providerId, modelId) => {
    expect(splitModel(current, 'lmstudio')).toEqual({ providerId, modelId });
  });

  it('a bare id belongs to the local provider — the only one that can serve it unqualified', () => {
    expect(splitModel('qwen3-vl', 'lmstudio')).toEqual({ providerId: 'lmstudio', modelId: 'qwen3-vl' });
  });

  it('no model at all yields no provider either, so nothing is pinned by accident', () => {
    expect(splitModel('', 'lmstudio')).toEqual({ providerId: '', modelId: '' });
    // No local provider configured yet: still no key, rather than one under ''.
    expect(splitModel('qwen3-vl', undefined)).toEqual({ providerId: '', modelId: 'qwen3-vl' });
  });

  it('a LEADING slash is not a provider', () => {
    expect(splitModel('/qwen3-vl', 'lmstudio')).toEqual({ providerId: 'lmstudio', modelId: '/qwen3-vl' });
  });
});

describe('what the control shows — pin beats config, and "detected" is a different word', () => {
  const model = { providerId: 'lmstudio', modelId: 'qwen3-vl' };

  it('no pin: the state is the config flag, marked AUTO', () => {
    expect(visionStateFor(storeOf(), model, () => true)).toBe('auto-on');
    expect(visionStateFor(storeOf(), model, () => false)).toBe('auto-off');
  });

  it('a pin wins over the config flag in BOTH directions', () => {
    // The config still says what it says — a pinned-off model whose config was
    // never rewritten must still READ as off, or the control lies about itself.
    const off = storeOf({ [visionPinKey('lmstudio', 'qwen3-vl')]: 'off' });
    expect(visionStateFor(off, model, () => true)).toBe('off');
    const on = storeOf({ [visionPinKey('lmstudio', 'qwen3-vl')]: 'on' });
    expect(visionStateFor(on, model, () => false)).toBe('on');
  });

  it('no model selected: auto-off, and the config is never consulted', () => {
    const readVision = vi.fn(() => true);
    expect(visionStateFor(storeOf(), { providerId: '', modelId: '' }, readVision)).toBe('auto-off');
    expect(readVision).not.toHaveBeenCalled();
  });
});

describe('the reconcile write plan — THE SKIP', () => {
  const seen = new Map([['pinned-model', true], ['auto-model', true]]);

  it('SKIPS a pinned model even when detection disagrees with the config', () => {
    // The point of the whole feature. Detection says both models see; the config
    // says neither does; the owner pinned one of them OFF. Writing that one would
    // undo the pin the moment a panel opened, so only the unpinned model is written.
    const writes = visionWrites({
      models: ['pinned-model', 'auto-model'],
      seen,
      pinned: (id) => id === 'pinned-model',
      current: () => false,
    });
    expect(writes).toEqual([{ modelId: 'auto-model', enabled: true }]);
  });

  it('SKIPS a model pinned to the value detection ALSO wants', () => {
    // Same skip, no visible difference in the config — but taking the write here
    // would mean the skip is "only when they disagree", which is a rule nobody
    // stated and which breaks the moment the server changes its mind.
    const writes = visionWrites({
      models: ['pinned-model'],
      seen: new Map([['pinned-model', true]]),
      pinned: () => true,
      current: () => false,
    });
    expect(writes).toEqual([]);
  });

  it('writes every unpinned model detection answered for', () => {
    const writes = visionWrites({
      models: ['a', 'b'],
      seen: new Map([['a', true], ['b', false]]),
      pinned: () => false,
      current: () => undefined as unknown as boolean,
    });
    expect(writes).toEqual([{ modelId: 'a', enabled: true }, { modelId: 'b', enabled: false }]);
  });

  it('a model the server did not answer for is left alone — absent is not false', () => {
    // The shipped SGLang bug: a hand-configured VLM on a server with no
    // capability surface must keep its flag.
    const writes = visionWrites({
      models: ['hand-configured-vlm'],
      seen: new Map(),
      pinned: () => false,
      current: () => true,
    });
    expect(writes).toEqual([]);
  });

  it('a model already carrying the detected value is not rewritten', () => {
    // No write means no origami.json rewrite and no .bak churn on every panel open.
    const writes = visionWrites({
      models: ['already-right'],
      seen: new Map([['already-right', true]]),
      pinned: () => false,
      current: () => true,
    });
    expect(writes).toEqual([]);
  });

  it('asks about the pin ONLY for models detection answered for', () => {
    // The pin store is a Memento read per call; asking it about models that could
    // never be written is work for an answer that cannot change the outcome.
    const asked: string[] = [];
    visionWrites({
      models: ['answered', 'unanswered'],
      seen: new Map([['answered', true]]),
      pinned: (id) => { asked.push(id); return false; },
      current: () => false,
    });
    expect(asked).toEqual(['answered']);
  });
});

/** The host as a recorder: what was written, in what order, and how often. */
function hostOf(over: Partial<VisionPinHost> = {}) {
  const store = storeOf();
  const order: string[] = [];
  const config: { providerId: string; modelId: string; enabled: boolean }[] = [];
  const warned: string[] = [];
  let reconciles = 0;
  let refreshes = 0;
  const host: VisionPinHost = {
    store: {
      get: store.get.bind(store),
      update: async (key: string, value: unknown) => { order.push('pin'); await store.update(key, value); },
    },
    current: 'lmstudio/qwen3-vl',
    localId: 'lmstudio',
    writeVision: (input) => { order.push('config'); config.push(input); return { path: 'origami.json' }; },
    reconcile: async () => { order.push('reconcile'); reconciles += 1; },
    refresh: () => { order.push('refresh'); refreshes += 1; },
    warn: (text) => { warned.push(text); },
    ...over,
  };
  return {
    host,
    order,
    config,
    warned,
    pins: store.map,
    reconciles: () => reconciles,
    refreshes: () => refreshes,
  };
}

describe('applying a click on Auto / On / Off', () => {
  it('On: writes the config ONCE with the pinned value, stores the pin, and does NOT reconcile', async () => {
    const h = hostOf();
    await applyVisionPin(h.host, 'on');
    expect(h.config).toEqual([{ providerId: 'lmstudio', modelId: 'qwen3-vl', enabled: true }]);
    expect(h.pins.get(visionPinKey('lmstudio', 'qwen3-vl'))).toBe('on');
    // Reconcile here would re-read the server and could immediately overwrite the
    // value just pinned — the pin already IS the answer.
    expect(h.reconciles()).toBe(0);
    expect(h.refreshes()).toBe(1);
  });

  it('Off: the same, mirrored — one config write carrying false', async () => {
    const h = hostOf();
    await applyVisionPin(h.host, 'off');
    expect(h.config).toEqual([{ providerId: 'lmstudio', modelId: 'qwen3-vl', enabled: false }]);
    expect(h.pins.get(visionPinKey('lmstudio', 'qwen3-vl'))).toBe('off');
    expect(h.reconciles()).toBe(0);
  });

  it('the CONFIG write lands before the pin is stored', async () => {
    // Order is the failure rule: a pin stored against a config write that threw
    // would forbid reconcile from ever correcting a value the config never took.
    const h = hostOf();
    await applyVisionPin(h.host, 'on');
    expect(h.order).toEqual(['config', 'pin', 'refresh']);
  });

  it('a FAILED config write leaves the model on Auto — no pin is stored', async () => {
    const h = hostOf({
      writeVision: () => { throw new Error('origami.json is not valid JSON'); },
    });
    await applyVisionPin(h.host, 'on');
    expect(h.pins.size).toBe(0);
    expect(h.warned[0]).toContain('lmstudio/qwen3-vl');
    expect(h.warned[0]).toContain('origami.json is not valid JSON');
    // The control must still repaint, or it keeps showing the state the click
    // asked for rather than the state the model is in.
    expect(h.refreshes()).toBe(1);
  });

  it('Auto: clears the pin, writes NO config, and asks for exactly ONE reconcile', async () => {
    const h = hostOf();
    await applyVisionPin(h.host, 'on');
    h.config.length = 0;
    h.order.length = 0;

    await applyVisionPin(h.host, '');
    expect(h.pins.has(visionPinKey('lmstudio', 'qwen3-vl'))).toBe(false);
    // Unpinning must not decide the flag itself — the whole point is to hand the
    // question back to detection, which the reconcile pass answers.
    expect(h.config).toEqual([]);
    expect(h.reconciles()).toBe(1);
    expect(h.order).toEqual(['pin', 'reconcile', 'refresh']);
  });

  it('anything that is not "on" or "off" is Auto, not a silent no-op', async () => {
    for (const mode of ['', 'auto', 'AUTO', 'nonsense']) {
      const h = hostOf();
      await applyVisionPin(h.host, mode);
      expect(h.config, `mode ${JSON.stringify(mode)} wrote a config`).toEqual([]);
      expect(h.reconciles(), `mode ${JSON.stringify(mode)} skipped the reconcile`).toBe(1);
    }
  });

  it('every mode the UI can send is one this understands', () => {
    // The drift guard between the button table and the handler: a fourth button,
    // or a renamed wire value, would land here as an unintended Auto.
    expect(VISION_MODES.map((m) => m.wire).sort()).toEqual(['', 'off', 'on']);
  });

  it('a chat with no model selected explains itself and writes nothing', async () => {
    const h = hostOf({ current: '' });
    await applyVisionPin(h.host, 'on');
    expect(h.config).toEqual([]);
    expect(h.pins.size).toBe(0);
    expect(h.reconciles()).toBe(0);
    expect(h.warned[0]).toContain('no model selected');
  });

  it('a failing RECONCILE still clears the pin and still repaints', async () => {
    // The unpin already landed in globalState before reconcile ran; swallowing the
    // error and repainting shows the detected state as it actually is (stale until
    // the next probe) rather than leaving the control frozen mid-transition.
    const h = hostOf({ reconcile: async () => { throw new Error('LM Studio is not running'); } });
    await applyVisionPin(h.host, 'on');
    await applyVisionPin(h.host, '');
    expect(h.pins.size).toBe(0);
    expect(h.warned.at(-1)).toContain('LM Studio is not running');
    expect(h.refreshes()).toBe(2);
  });
});

describe('the wiring in DashboardPanel.ts', () => {
  // Read, not rendered: the panel needs an extension host to exist. The gap this
  // feature closed was a leaf that was imported and never called, so "is it
  // called, from the right place" is exactly what has to be pinned down.
  const panel = readFileSync(path.join(pkgRoot, 'src/dashboard/DashboardPanel.ts'), 'utf8');
  const reconcileBody = panel.slice(
    panel.indexOf('private async reconcileVisionCapabilities('),
    panel.indexOf('private post(msg: object)'),
  );

  it('the reconcile pass runs through visionWrites, with the pin as its skip', () => {
    expect(reconcileBody).toContain('visionWrites({');
    expect(reconcileBody).toMatch(/pinned:\s*\(\w+\)\s*=>\s*readVisionPin\(this\.context\.globalState/);
  });

  it('the reconcile pass has no second, un-pinned path to writeModelVision', () => {
    // A raw `seen.get(id)` loop beside the plan is how the skip would come back
    // out: both loops would write, and the pinned one would lose.
    expect(reconcileBody).not.toContain('seen.get(');
    expect(reconcileBody.match(/writeModelVision\(/g)).toHaveLength(1);
  });

  it('the pin is read out of GLOBAL state, not the workspace one', () => {
    // A pin is a fact about the owner and their servers; filing it per workspace
    // would silently un-pin every model on the next folder they opened.
    expect(reconcileBody).not.toContain('workspaceState');
    expect(panel).toContain('store: this.context.globalState');
  });

  it('the composer\'s click reaches applyVisionPin', () => {
    const handler = panel.slice(panel.indexOf("case 'setVisionPin'"));
    expect(handler.slice(0, 800)).toContain('applyVisionPin({');
    // The message the row actually posts (VisionPinRow.svelte) — a rename on
    // either side leaves a control that silently does nothing.
    const row = readFileSync(path.join(pkgRoot, 'webview/dashboard/components/VisionPinRow.svelte'), 'utf8');
    expect(row).toContain("type: 'setVisionPin'");
  });

  it('going back to Auto re-arms the once-per-panel reconcile guard', () => {
    // Without the reset, `reconcileVisionCapabilities` returns at its first line
    // and the detected answer does not come back until the panel is reopened.
    const handler = panel.slice(panel.indexOf("case 'setVisionPin'"), panel.indexOf("case 'setVisionPin'") + 1200);
    expect(handler).toMatch(/reconcile:[^\n]*this\.visionReconciled = false/);
    expect(handler).toContain('this.reconcileVisionCapabilities(');
  });
});
