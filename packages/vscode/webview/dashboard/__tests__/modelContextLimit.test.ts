// The BRIDGE between the extension's context probe and the engine.
//
// The extension always measured the real window accurately (LM Studio's
// `loaded_context_length`, vLLM's `max_model_len`) — and then kept it to itself.
// Nothing ever wrote a `limit` into origami.json, so `provider.ts` resolved
// `model.limit?.context ?? existingModel?.limit?.context ?? 0` to ZERO for every
// local model, which (a) disables auto-compaction outright — `session/overflow.ts`
// `isOverflow()` hard-returns false at context 0 — and (b) suppresses the usage
// event that feeds the gauge. These tests pin the write-back and, just as
// importantly, the SHAPE.
//
// SHAPE IS LOAD-BEARING: the engine config schema
// (packages/core/src/v1/config/provider.ts, `Model.limit`) makes `output` a
// REQUIRED sibling of `context`, and config/parse.ts decodes strictly. A bare
// `{ context }` is not "partially applied" — it invalidates the WHOLE config.
// Verified by running the engine's own decoder over both candidates:
//   { context: 65536 }            -> REJECTED, issue path
//                                    provider.lmstudio.models.qwen3-8b.limit.output
//                                    "Missing key"
//   { context: 65536, output: 0 } -> ACCEPTED
// Hence every assertion below that insists on `output` being present.

import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

// A throwaway HOME so the real ~/.config/origami/origami.json is never touched.
// Hoisted (vi.mock factories run before the module graph) and free of node:os,
// which is exactly the module we are about to replace.
const { HOME } = vi.hoisted(() => {
  const base = process.env.RUNNER_TEMP || process.env.TEMP || process.env.TMPDIR || '/tmp';
  return { HOME: `${base}/origami-ctxlimit-${process.pid}-${Date.now()}` };
});

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, default: { ...actual, homedir: () => HOME }, homedir: () => HOME };
});

import { writeModelContextLimit, shouldReloadLocalModel } from '../../../src/dashboard/firstFold';

const CFG = path.join(HOME, '.config', 'origami', 'origami.json');
const read = () => JSON.parse(fs.readFileSync(CFG, 'utf8'));
const write = (cfg: unknown) => {
  fs.mkdirSync(path.dirname(CFG), { recursive: true });
  fs.writeFileSync(CFG, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
};

/** A realistic config: a local provider with a model carrying the sibling fields
 *  the vision reconciler and the OpenRouter cost path write. */
const baseConfig = () => ({
  model: 'vllm/spec-test',
  provider: {
    lmstudio: {
      name: 'LM Studio',
      npm: '@ai-sdk/openai-compatible',
      options: { baseURL: 'http://127.0.0.1:1234/v1' },
      models: {
        'qwen3-8b': { name: 'qwen3-8b', attachment: true, modalities: { input: ['text', 'image'] } },
      },
    },
    vllm: { name: 'DGX Spark', options: { baseURL: 'http://100.64.1.10:8000/v1' }, models: { 'spec-test': { name: 'spec-test' } } },
  },
});

let savedXdg: string | undefined;

beforeEach(() => {
  // The config path honours XDG_CONFIG_HOME now (connections review finding 5),
  // so the mocked homedir above only pins it while that variable is unset.
  savedXdg = process.env.XDG_CONFIG_HOME;
  delete process.env.XDG_CONFIG_HOME;
  fs.rmSync(HOME, { recursive: true, force: true });
  write(baseConfig());
});

afterEach(() => {
  if (savedXdg !== undefined) process.env.XDG_CONFIG_HOME = savedXdg;
  vi.restoreAllMocks();
});

describe('writeModelContextLimit — handing the probed window to the engine', () => {
  it('persists the probed window in the shape the engine READS (context AND the required output)', () => {
    expect(writeModelContextLimit('lmstudio', 'qwen3-8b', 65536)).toBe(true);
    const limit = read().provider.lmstudio.models['qwen3-8b'].limit;
    // The number the engine reads at provider.ts `model.limit?.context`.
    expect(limit.context).toBe(65536);
    // Required by the schema — omit it and the ENTIRE config fails to decode,
    // so "we wrote a context" would silently become "the user has no config".
    expect(typeof limit.output).toBe('number');
    expect(Number.isFinite(limit.output)).toBe(true);
  });

  it('a REMOTE provider gets the same treatment (a vLLM max_model_len is just as real)', () => {
    expect(writeModelContextLimit('vllm', 'spec-test', 262144)).toBe(true);
    expect(read().provider.vllm.models['spec-test'].limit.context).toBe(262144);
  });

  // A remote server reports a STATIC maximum, and a user may deliberately cap a
  // model lower in config to force earlier compaction — the live config on this
  // machine does exactly that for three vLLM models. Filling a 0 is the fix;
  // overruling a chosen number would be a regression dressed up as one.
  it('onlyWhenUnset FILLS a missing/zero window…', () => {
    expect(writeModelContextLimit('vllm', 'spec-test', 262144, { onlyWhenUnset: true })).toBe(true);
    expect(read().provider.vllm.models['spec-test'].limit.context).toBe(262144);

    const cfg = baseConfig();
    (cfg.provider.vllm.models['spec-test'] as Record<string, unknown>).limit = { context: 0, output: 8192 };
    write(cfg);
    expect(writeModelContextLimit('vllm', 'spec-test', 262144, { onlyWhenUnset: true })).toBe(true);
    expect(read().provider.vllm.models['spec-test'].limit).toEqual({ context: 262144, output: 8192 });
  });

  it('…but NEVER overrules a hand-set one', () => {
    const cfg = baseConfig();
    (cfg.provider.vllm.models['spec-test'] as Record<string, unknown>).limit = { context: 32768, output: 8192 };
    write(cfg);
    expect(writeModelContextLimit('vllm', 'spec-test', 262144, { onlyWhenUnset: true })).toBe(false);
    expect(read().provider.vllm.models['spec-test'].limit.context).toBe(32768);
  });

  it('the LOCAL path still overwrites — a reload at a new -c genuinely changes the window', () => {
    const cfg = baseConfig();
    (cfg.provider.lmstudio.models['qwen3-8b'] as Record<string, unknown>).limit = { context: 32768, output: 0 };
    write(cfg);
    expect(writeModelContextLimit('lmstudio', 'qwen3-8b', 65536)).toBe(true);
    expect(read().provider.lmstudio.models['qwen3-8b'].limit.context).toBe(65536);
  });

  it('merges into the existing model block — name/attachment/modalities survive', () => {
    writeModelContextLimit('lmstudio', 'qwen3-8b', 32768);
    const m = read().provider.lmstudio.models['qwen3-8b'];
    expect(m.name).toBe('qwen3-8b');
    expect(m.attachment).toBe(true);
    expect(m.modalities).toEqual({ input: ['text', 'image'] });
  });

  it('keeps a REAL existing output limit instead of flattening it to 0', () => {
    const cfg = baseConfig();
    (cfg.provider.lmstudio.models['qwen3-8b'] as Record<string, unknown>).limit = { context: 8192, output: 4096 };
    write(cfg);
    writeModelContextLimit('lmstudio', 'qwen3-8b', 65536);
    expect(read().provider.lmstudio.models['qwen3-8b'].limit).toEqual({ context: 65536, output: 4096 });
  });

  it('never re-points the DEFAULT model — a background probe must not hijack the user\'s pick', () => {
    // writeModelConfig sets cfg.model; this writer must not. The active model
    // here is the Spark, while the probe reports LM Studio's loaded model.
    writeModelContextLimit('lmstudio', 'qwen3-8b', 65536);
    expect(read().model).toBe('vllm/spec-test');
  });

  it('refuses to persist a non-window: 0, negative and NaN leave the file byte-identical', () => {
    const before = fs.readFileSync(CFG, 'utf8');
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(writeModelContextLimit('lmstudio', 'qwen3-8b', bad)).toBe(false);
    }
    expect(fs.readFileSync(CFG, 'utf8')).toBe(before);
  });

  it('never invents a provider block for a provider that was never configured', () => {
    expect(writeModelContextLimit('ollama', 'llama3.1', 8192)).toBe(false);
    expect(read().provider.ollama).toBeUndefined();
  });

  it('is idempotent: re-writing the same window does not rewrite the file', () => {
    expect(writeModelContextLimit('lmstudio', 'qwen3-8b', 65536)).toBe(true);
    const after = fs.readFileSync(CFG, 'utf8');
    expect(writeModelContextLimit('lmstudio', 'qwen3-8b', 65536)).toBe(false);
    expect(fs.readFileSync(CFG, 'utf8')).toBe(after);
  });

  it('does not create a config out of nothing when none exists', () => {
    fs.rmSync(CFG, { force: true });
    expect(writeModelContextLimit('lmstudio', 'qwen3-8b', 65536)).toBe(false);
    expect(fs.existsSync(CFG)).toBe(false);
  });

  it('re-reads at write time, so a CONCURRENT chat\'s config change is not clobbered', () => {
    // Every chat runs its own engine process against this one file. Another
    // writer adds a provider between our probe and our write; it must survive.
    const cfg = baseConfig();
    (cfg.provider as Record<string, unknown>).openrouter = { name: 'OR Free', models: { 'kimi-k3': { name: 'kimi-k3' } } };
    write(cfg);
    writeModelContextLimit('lmstudio', 'qwen3-8b', 65536);
    const after = read();
    expect(after.provider.openrouter?.models['kimi-k3'].name).toBe('kimi-k3'); // not lost
    expect(after.provider.lmstudio.models['qwen3-8b'].limit.context).toBe(65536); // and ours applied
  });

  it('survives a corrupt config without throwing (a probe must never break the panel)', () => {
    fs.writeFileSync(CFG, '{ not json', 'utf8');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(writeModelContextLimit('lmstudio', 'qwen3-8b', 65536)).toBe(false);
    // …but it no longer survives it SILENTLY. The probe measured a real window
    // and could not persist it, which leaves the engine at limit.context = 0 —
    // and session/overflow.ts hard-returns false from isOverflow() at 0, so
    // auto-compaction is off for this model until someone fixes the file.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain(CFG);
  });

  // The .bak chain is the user's rollback point for what the USER did. Both
  // call sites of this writer are automatic probes (reprobeModel and
  // refreshModelInfoFor), and each one used to consume the single slot.
  it('takes no backup at all — a background probe must not spend the user\'s rollback point', () => {
    expect(writeModelContextLimit('lmstudio', 'qwen3-8b', 65536)).toBe(true);
    expect(fs.readdirSync(path.dirname(CFG)).filter((f) => f.includes('.bak'))).toEqual([]);
  });
});

// The LM Studio reload decision. Re-picking the model already loaded used to
// `lms unload --all` + `load` regardless — tens of seconds of dead GPU — and
// because LM Studio serves one model at a time the switch then CARRIES every
// other chat on that provider onto it, cascading the pointless reload.
describe('shouldReloadLocalModel — only reload when something actually changes', () => {
  const loaded = { ok: true, modelId: 'qwen3-8b', contextLength: 65536 };

  it('same model at the same window: NO reload', () => {
    expect(shouldReloadLocalModel({ requestedModelId: 'qwen3-8b', requestedContext: 65536, loaded })).toBe(false);
  });

  it('a DIFFERENT model: reload', () => {
    expect(shouldReloadLocalModel({ requestedModelId: 'qwen3-30b', requestedContext: 65536, loaded })).toBe(true);
  });

  it('the same model at a DIFFERENT window: reload (the window is the point of the prompt)', () => {
    expect(shouldReloadLocalModel({ requestedModelId: 'qwen3-8b', requestedContext: 32768, loaded })).toBe(true);
    expect(shouldReloadLocalModel({ requestedModelId: 'qwen3-8b', requestedContext: 131072, loaded })).toBe(true);
  });

  it('nothing loaded: reload', () => {
    expect(shouldReloadLocalModel({
      requestedModelId: 'qwen3-8b', requestedContext: 65536,
      loaded: { ok: false, modelId: '', contextLength: 0 },
    })).toBe(true);
  });

  it('an UNKNOWN window on either side is never treated as a match', () => {
    // Server reports no window…
    expect(shouldReloadLocalModel({
      requestedModelId: 'qwen3-8b', requestedContext: 65536,
      loaded: { ok: true, modelId: 'qwen3-8b', contextLength: 0 },
    })).toBe(true);
    // …or we don't know what we're asking for.
    expect(shouldReloadLocalModel({ requestedModelId: 'qwen3-8b', requestedContext: 0, loaded })).toBe(true);
  });

  it('a stale ok flag with no model id does not authorise a skip', () => {
    expect(shouldReloadLocalModel({
      requestedModelId: 'qwen3-8b', requestedContext: 65536,
      loaded: { ok: true, modelId: '', contextLength: 65536 },
    })).toBe(true);
  });
});
