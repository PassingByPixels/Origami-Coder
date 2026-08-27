// All SEVEN global-origami.json writers, driven end to end against a real
// temp config directory. One file, because the connections adversarial review
// (2026-08-15) found the same four defects in all seven of them, and a fix that
// lands in six is not a fix — the seventh is the one the user hits.
//
// The seven (firstFold.ts unless noted):
//   writeModelConfig · writeModelContextLimit · removeProviderConfig
//   renameProviderConfig · writeAgentFrequencyPenalty · writeModelVision
//   writeToolState (toolDeferConfig.ts)
//
// XDG_CONFIG_HOME points at a temp dir rather than node:os being mocked. That
// is deliberate: finding 5 IS that the writers ignored XDG_CONFIG_HOME, so a
// suite that mocked homedir would pass just as happily against the defect it
// is supposed to catch. Here the temp dir is only found if the fix works.

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  detectModel,
  detectLocalProvider,
  readGlobalProviders,
  readAgentFrequencyPenalty,
  readModelVision,
  listConfiguredModels,
  removeProviderConfig,
  renameProviderConfig,
  writeAgentFrequencyPenalty,
  writeModelConfig,
  writeModelContextLimit,
  writeModelVision,
} from '../../../src/dashboard/firstFold';
import { writeToolState } from '../../../src/dashboard/toolDeferConfig';
import { resetContextLimitWarnings } from '../../../src/dashboard/contextLimitWarning';

let tmp: string;
let cfgDir: string;
let cfgPath: string;
let savedXdg: string | undefined;

const populated = () => JSON.stringify({
  model: 'lmstudio/qwen3-8b',
  provider: {
    lmstudio: {
      name: 'LM Studio',
      npm: '@ai-sdk/openai-compatible',
      options: { baseURL: 'http://127.0.0.1:1234/v1' },
      models: { 'qwen3-8b': { name: 'qwen3-8b' } },
    },
    vllm: {
      name: 'S1 - DGX Spark 1',
      options: { baseURL: 'http://100.64.1.30:8000/v1' },
      models: { 'spec-test': { name: 'spec-test' } },
    },
  },
}, null, 2) + '\n';

const write = (text: string) => {
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(cfgPath, text, 'utf8');
};
const read = () => JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
const files = () => fs.readdirSync(cfgDir).sort();

beforeEach(() => {
  savedXdg = process.env.XDG_CONFIG_HOME;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'origami-writers-'));
  process.env.XDG_CONFIG_HOME = tmp;
  cfgDir = path.join(tmp, 'origami');
  cfgPath = path.join(cfgDir, 'origami.json');
  resetContextLimitWarnings();
});

afterEach(() => {
  if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = savedXdg;
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Finding 5 — the writers hardcoded ~/.config, so a user with XDG_CONFIG_HOME
// set wrote a file the engine never read. Both halves succeeded; the setting
// simply never happened.
// ---------------------------------------------------------------------------
describe('every writer honours XDG_CONFIG_HOME, like the engine does', () => {
  it('writeModelConfig creates the config under XDG_CONFIG_HOME, not under ~/.config', () => {
    const res = writeModelConfig({ providerId: 'vllm', providerName: 'Spark', modelId: 'qwen', modelName: 'qwen' });
    expect(res.path).toBe(cfgPath);
    expect(fs.existsSync(cfgPath)).toBe(true);
    expect(read().model).toBe('vllm/qwen');
  });

  it('and so does the seventh writer, in the other file', () => {
    write(populated());
    expect(writeToolState('read', 'deferred')).toBe(cfgPath);
    expect(read().experimental.tool_search.defer).toEqual(['read']);
  });

  it('...including when it writes the OFF half, which lands on a different key', () => {
    // writeToolState is the only writer here that touches two keys. The XDG
    // question has to be asked of BOTH, or the half that got it wrong is the
    // half nobody tested.
    write(populated());
    expect(writeToolState('read', 'off')).toBe(cfgPath);
    expect(read().tools).toEqual({ read: false });
    expect(read().experimental.tool_search.defer).toEqual([]);
    expect(read().experimental.tool_search.always).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Finding 6, read half — the engine parses origami.json as JSONC. One `//`
// comment made readGlobalProviders return {}, which emptied the provider grid:
// all 8 pills vanished from a panel whose engine was working perfectly.
// ---------------------------------------------------------------------------
describe('a commented config still reads', () => {
  const commented = () => `{
  // the model I actually use
  "model": "lmstudio/qwen3-8b",
  "provider": {
    /* two boxes on the tailnet */
    "lmstudio": {
      "name": "LM Studio",
      "npm": "@ai-sdk/openai-compatible",
      "options": { "baseURL": "http://127.0.0.1:1234/v1" },
      "models": { "qwen3-8b": { "name": "qwen3-8b", "modalities": { "input": ["text", "image"] } } },
    },
  },
  "agent": { "build": { "frequency_penalty": 0.4 } },
}`;

  it('the provider grid is populated, not blank', () => {
    write(commented());
    expect(Object.keys(readGlobalProviders())).toEqual(['lmstudio']);
  });

  it('and every other reader keeps working too', () => {
    write(commented());
    expect(detectModel()).toBe('lmstudio/qwen3-8b');
    expect(detectLocalProvider()).toEqual({ id: 'lmstudio', name: 'LM Studio' });
    expect(readAgentFrequencyPenalty()).toBe(0.4);
    expect(listConfiguredModels('lmstudio')).toEqual(['qwen3-8b']);
    expect(readModelVision('lmstudio', 'qwen3-8b')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Finding 6, write half — every one of the seven is a whole-object rewrite, so
// none of them CAN keep the comments. The old code wrote anyway on the read
// path it could parse, and on the one it could not it blamed the file:
// "not valid JSON — fix or remove it first", about a file the engine reads.
// ---------------------------------------------------------------------------
describe('a commented config is refused honestly, and left alone', () => {
  const commented = '{\n  // Spark 2 is the second DGX box\n  "model": "vllm/spec-test",\n  "provider": { "vllm": { "name": "S2", "models": { "spec-test": {} } } }\n}\n';

  const throwers: Array<[string, () => unknown]> = [
    ['writeModelConfig', () => writeModelConfig({ providerId: 'x', providerName: 'X', modelId: 'm', modelName: 'm' })],
    ['removeProviderConfig', () => removeProviderConfig('vllm')],
    ['renameProviderConfig', () => renameProviderConfig('vllm', 'Renamed')],
    ['writeAgentFrequencyPenalty', () => writeAgentFrequencyPenalty(0.5)],
    ['writeModelVision', () => writeModelVision({ providerId: 'vllm', modelId: 'spec-test', enabled: true })],
    ['writeToolState', () => writeToolState('read', 'deferred')],
    ['writeToolState (off)', () => writeToolState('read', 'off')],
  ];

  for (const [name, run] of throwers) {
    it(`${name} says the comments would be deleted, and does not delete them`, () => {
      write(commented);
      let message = '';
      try { run(); } catch (e) { message = e instanceof Error ? e.message : String(e); }
      expect(message, `${name} wrote instead of refusing`).toContain('comments');
      expect(message).not.toContain('not valid JSON');
      expect(fs.readFileSync(cfgPath, 'utf8')).toBe(commented);
    });
  }

  // The seventh is a background probe, so it must never THROW into a probe —
  // it reports the same fact through its return value and its warning instead.
  it('writeModelContextLimit reports it without throwing, and writes nothing', () => {
    write(commented);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const seen: string[] = [];
    expect(writeModelContextLimit('vllm', 'spec-test', 65536, { onError: (m) => seen.push(m) })).toBe(false);
    expect(fs.readFileSync(cfgPath, 'utf8')).toBe(commented);
    expect(warn.mock.calls[0]?.[0]).toContain('comments');
    expect(seen[0]).toContain('comments');
  });
});

// ---------------------------------------------------------------------------
// Finding 7 — a plain truncating write on the one file whose corruption takes
// the whole product down. Atomicity itself is pinned in globalConfig.test.ts
// against the real filesystem; here it is only checked that the writers go
// through it rather than around it.
// ---------------------------------------------------------------------------
describe('no writer leaves a temp file behind', () => {
  it('after a full round of user-initiated writes the directory holds only the config and its backups', () => {
    write(populated());
    renameProviderConfig('vllm', 'Spark One');
    writeAgentFrequencyPenalty(0.3);
    writeModelVision({ providerId: 'vllm', modelId: 'spec-test', enabled: true });
    writeToolState('read', 'deferred');
    writeToolState('read', 'off');
    expect(files().filter((f) => f.includes('.tmp-'))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Finding 8 — one .bak slot, and BACKGROUND writers turning it over. A
// hand-edit gone wrong could be overwritten within seconds by a model probe
// nobody asked for, so the file named like a rollback point never was one.
// ---------------------------------------------------------------------------
describe('backups belong to the user, not to the probes', () => {
  it('successive user writes stack up instead of overwriting one slot', () => {
    write(populated());
    renameProviderConfig('vllm', 'first');
    renameProviderConfig('vllm', 'second');
    renameProviderConfig('vllm', 'third');
    expect(JSON.parse(fs.readFileSync(`${cfgPath}.bak`, 'utf8')).provider.vllm.name).toBe('second');
    expect(JSON.parse(fs.readFileSync(`${cfgPath}.bak.1`, 'utf8')).provider.vllm.name).toBe('first');
    expect(JSON.parse(fs.readFileSync(`${cfgPath}.bak.2`, 'utf8')).provider.vllm.name).toBe('S1 - DGX Spark 1');
  });

  // The two probe paths (reprobeModel, refreshModelInfoFor) run on a timer.
  // Before this, each one consumed the single slot.
  it('a background context probe takes NO backup slot', () => {
    write(populated());
    renameProviderConfig('vllm', 'the edit I want back');
    expect(writeModelContextLimit('vllm', 'spec-test', 262144)).toBe(true);
    expect(read().provider.vllm.models['spec-test'].limit.context).toBe(262144);
    expect(files().filter((f) => f.includes('.bak'))).toEqual(['origami.json.bak']);
    expect(JSON.parse(fs.readFileSync(`${cfgPath}.bak`, 'utf8')).provider.vllm.name).toBe('S1 - DGX Spark 1');
  });

  // maybeAdoptRemoteServedModel writes from a background poll of the server's
  // model list — a config write with no user behind it.
  it('an automatic writeModelConfig takes no backup slot either, while a user one does', () => {
    write(populated());
    writeModelConfig({ providerId: 'vllm', providerName: 'S1', modelId: 'new-served', modelName: 'new-served' }, { automatic: true });
    expect(files().filter((f) => f.includes('.bak'))).toEqual([]);
    writeModelConfig({ providerId: 'vllm', providerName: 'S1', modelId: 'user-picked', modelName: 'user-picked' });
    expect(files().filter((f) => f.includes('.bak'))).toEqual(['origami.json.bak']);
  });
});

// ---------------------------------------------------------------------------
// Finding 2, validate-before-write half — the engine throws away a config file
// as a WHOLE for one bad nested field, so a writer that persists one does not
// lose a field: it silently reverts the user to no configuration at all.
// ---------------------------------------------------------------------------
describe('no writer persists a document the engine would throw away', () => {
  it('an unparseable OpenRouter price is refused rather than written as null', () => {
    write(populated());
    const before = fs.readFileSync(cfgPath, 'utf8');
    expect(() => writeModelConfig({
      providerId: 'openrouter', providerName: 'OpenRouter', modelId: 'kimi-k3', modelName: 'Kimi K3',
      cost: { input: Number.NaN, output: 2 },
    })).toThrow(/finite number/);
    expect(fs.readFileSync(cfgPath, 'utf8')).toBe(before);
  });

  // A refused write must not spend a rotation slot either. Five clicks on a
  // Connect that keeps failing would otherwise flush the real history out of
  // the chain with five copies of the same unchanged file.
  it('a refused write consumes no backup slot', () => {
    write(populated());
    renameProviderConfig('vllm', 'the edit I want back');
    for (let i = 0; i < 6; i++) {
      expect(() => writeModelConfig({
        providerId: 'openrouter', providerName: 'OpenRouter', modelId: 'kimi-k3', modelName: 'Kimi K3',
        cost: { input: Number.NaN, output: 2 },
      })).toThrow();
    }
    expect(files().filter((f) => f.includes('.bak'))).toEqual(['origami.json.bak']);
    expect(JSON.parse(fs.readFileSync(`${cfgPath}.bak`, 'utf8')).provider.vllm.name).toBe('S1 - DGX Spark 1');
  });

  it('a valid cost still goes through', () => {
    write(populated());
    writeModelConfig({
      providerId: 'openrouter', providerName: 'OpenRouter', modelId: 'kimi-k3', modelName: 'Kimi K3',
      cost: { input: 0.5, output: 2 },
    });
    expect(read().provider.openrouter.models['kimi-k3'].cost).toEqual({ input: 0.5, output: 2 });
  });
});

// ---------------------------------------------------------------------------
// Re-key quirk 1 (0.4.27 follow-up) — `if (choice.apiKey) options.apiKey =`
// WROTE a key but never DELETED one. Re-keying an existing provider with the
// key field left blank therefore left the old key sitting in origami.json,
// silently contradicting the form's own "leave blank to clear" contract.
//
// The clear is driven by an EXPLICIT `clearApiKey` on the choice, set ONLY by
// the Re-key form's blank submit. It is NOT inferred from `apiKey` being
// absent — see the 0.4.28 regression block below for what that cost.
// ---------------------------------------------------------------------------
describe('writeModelConfig — an EXPLICIT clear removes the key; a blank key alone never does', () => {
  it('a provider with NO stored key, written with no key, gets no apiKey field at all', () => {
    write(populated());
    writeModelConfig({ providerId: 'lmstudio', providerName: 'LM Studio', modelId: 'qwen3-8b', modelName: 'qwen3-8b' });
    const options = read().provider.lmstudio.options;
    expect('apiKey' in options).toBe(false);
    // Byte-identical to the untouched fixture — nothing else in options moved either.
    expect(options).toEqual({ baseURL: 'http://127.0.0.1:1234/v1' });
  });

  it('a provider WITH a stored key, re-keyed with a blank key, has the key REMOVED (absent, not empty)', () => {
    write(populated());
    writeModelConfig({ providerId: 'lmstudio', providerName: 'LM Studio', modelId: 'qwen3-8b', modelName: 'qwen3-8b', apiKey: 'lms-secret-1' });
    expect(read().provider.lmstudio.options.apiKey).toBe('lms-secret-1');

    // Re-key: same provider, blank key — the form says so with clearApiKey.
    writeModelConfig({ providerId: 'lmstudio', providerName: 'LM Studio', modelId: 'qwen3-8b', modelName: 'qwen3-8b', clearApiKey: true });
    const options = read().provider.lmstudio.options;
    expect('apiKey' in options).toBe(false);
    expect(options.apiKey).toBeUndefined();
    // The endpoint survives the clear untouched.
    expect(options.baseURL).toBe('http://127.0.0.1:1234/v1');
  });

  it('a fresh ADD with a blank key is still byte-identical — clearApiKey false, nothing to delete', () => {
    write(populated());
    writeModelConfig({ providerId: 'lmstudio', providerName: 'LM Studio', modelId: 'qwen3-8b', modelName: 'qwen3-8b', clearApiKey: false });
    expect(read().provider.lmstudio.options).toEqual({ baseURL: 'http://127.0.0.1:1234/v1' });
  });

  it('a real key WINS over a stray clear flag — a nonsense pairing never loses the key the user just typed', () => {
    write(populated());
    writeModelConfig({ providerId: 'lmstudio', providerName: 'LM Studio', modelId: 'qwen3-8b', modelName: 'qwen3-8b', apiKey: 'typed-now', clearApiKey: true });
    expect(read().provider.lmstudio.options.apiKey).toBe('typed-now');
  });

  it('a non-blank re-key OVERWRITES the stored key', () => {
    write(populated());
    writeModelConfig({ providerId: 'lmstudio', providerName: 'LM Studio', modelId: 'qwen3-8b', modelName: 'qwen3-8b', apiKey: 'first-key' });
    writeModelConfig({ providerId: 'lmstudio', providerName: 'LM Studio', modelId: 'qwen3-8b', modelName: 'qwen3-8b', apiKey: 'second-key' });
    expect(read().provider.lmstudio.options.apiKey).toBe('second-key');
  });
});

// ---------------------------------------------------------------------------
// 0.4.28 REGRESSION — "the OpenRouter key vanishes between one message and the
// next". The blank-clears change above shipped as `else delete options.apiKey`,
// which INFERRED intent-to-clear from `apiKey` being absent. Absence is what
// every caller with nothing to do with keys naturally passes:
//
//   DashboardPanel.ts setModel   -> the chat-pane model pin ("Model set to …")
//   DashboardPanel.ts loadModel  -> the lms swap
//   adoptLoadedModel             -> boot alignment to the loaded local model
//   maybeAdoptRemoteServedModel  -> the background poll (automatic: true)
//   providerAuthPane.ts finish   -> OAuth success, keyless block BY DESIGN
//   firstFold's LM Studio branch -> endpoint + model, no key
//
// So pinning a model on OpenRouter deleted its API key. The observed sequence:
// "Model set to openrouter/stealth/ox-alpha" -> the next prompt goes out with
// NO Authorization header and OpenRouter itself answers "No cookie auth
// credentials found" -> the following pin makes the engine's own preflight say
// "provider authentication required".
//
// These tests use the LITERAL payload shapes those call sites build, so a
// future caller shape change has to come past them.
// ---------------------------------------------------------------------------
describe('0.4.28 regression — a keyless write never deletes a stored key', () => {
  const keyed = () => JSON.stringify({
    model: 'openrouter/stealth/ox-alpha',
    provider: {
      openrouter: {
        name: 'OpenRouter',
        options: { baseURL: 'https://openrouter.ai/api/v1', apiKey: 'sk-or-v1-edac80' },
        models: { 'stealth/ox-alpha': { name: 'stealth/ox-alpha' } },
      },
    },
  }, null, 2) + '\n';

  it('the chat-pane MODEL PIN keeps the key (DashboardPanel setModel: provider + model + cost, no key)', () => {
    write(keyed());
    writeModelConfig({
      providerId: 'openrouter',
      providerName: 'OpenRouter',
      modelId: 'nvidia/nemotron-3.5-lightning:free',
      modelName: 'nvidia/nemotron-3.5-lightning:free',
      cost: { input: 0, output: 0 },
    });
    expect(read().provider.openrouter.options.apiKey).toBe('sk-or-v1-edac80');
    // and the pin still did its job
    expect(read().model).toBe('openrouter/nvidia/nemotron-3.5-lightning:free');
  });

  it('a pin REPEATED (the second, third… switch) still keeps it — the incident was a sequence, not one write', () => {
    write(keyed());
    for (const id of ['a/one', 'b/two', 'stealth/ox-alpha']) {
      writeModelConfig({ providerId: 'openrouter', providerName: 'OpenRouter', modelId: id, modelName: id });
    }
    expect(read().provider.openrouter.options.apiKey).toBe('sk-or-v1-edac80');
  });

  it('the BACKGROUND adopt (automatic: true, no .bak slot) keeps it too', () => {
    write(keyed());
    writeModelConfig(
      { providerId: 'openrouter', providerName: 'OpenRouter', modelId: 'b/two', modelName: 'b/two' },
      { automatic: true },
    );
    expect(read().provider.openrouter.options.apiKey).toBe('sk-or-v1-edac80');
  });

  it('the OAUTH completion — which writes a deliberately keyless block — keeps a coexisting API key', () => {
    // providerAuthPane.ts finish(): npm + catalog, never an apiKey (the plugin
    // injects the bearer). A provider can hold an `api` credential at the same
    // time as an oauth one, so signing in must not delete the key.
    write(keyed());
    writeModelConfig({
      providerId: 'openrouter',
      providerName: 'OpenRouter',
      npm: '@ai-sdk/openai-compatible',
      modelId: 'stealth/ox-alpha',
      modelName: 'stealth/ox-alpha',
      catalog: { 'stealth/ox-alpha': { name: 'stealth/ox-alpha' } },
    });
    expect(read().provider.openrouter.options.apiKey).toBe('sk-or-v1-edac80');
  });

  it('a keyless write leaves a keyless provider exactly as it was — the fresh-add path is untouched', () => {
    write(populated());
    writeModelConfig({ providerId: 'vllm', providerName: 'S1 - DGX Spark 1', modelId: 'spec-test', modelName: 'spec-test' });
    expect(read().provider.vllm.options).toEqual({ baseURL: 'http://100.64.1.30:8000/v1' });
  });
});

// ---------------------------------------------------------------------------
// Finding 9 — writeModelContextLimit swallowed read/parse/write failure alike
// into `return false`, and both call sites discard the boolean. The engine then
// keeps limit.context = 0, and session/overflow.ts hard-returns false from
// isOverflow() at 0 — so auto-compaction is OFF and nothing ever said so.
// ---------------------------------------------------------------------------
describe('a context window that cannot be persisted is no longer silent', () => {
  it('warns with the path and the reason, and hands the reason to the caller', () => {
    write('{ "model": ');   // genuinely malformed
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const seen: string[] = [];
    expect(writeModelContextLimit('vllm', 'spec-test', 262144, { onError: (m) => seen.push(m) })).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain(cfgPath);
    expect(warn.mock.calls[0][0]).toContain('vllm/spec-test');
    expect(seen).toHaveLength(1);
  });

  // The legitimate no-ops must stay quiet, or the warning becomes noise and
  // stops meaning anything.
  it('stays silent for the legitimate no-ops', () => {
    write(populated());
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(writeModelContextLimit('', 'spec-test', 1)).toBe(false);          // no provider
    expect(writeModelContextLimit('vllm', 'spec-test', 0)).toBe(false);      // not a window
    expect(writeModelContextLimit('nope', 'spec-test', 65536)).toBe(false);  // provider not configured
    writeModelContextLimit('vllm', 'spec-test', 65536);
    expect(writeModelContextLimit('vllm', 'spec-test', 65536)).toBe(false);  // already right
    expect(warn).not.toHaveBeenCalled();
  });
});
