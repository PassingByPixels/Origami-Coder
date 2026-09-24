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
  writeDefaultModel,
  persistModelPick,
  resolveModelPickProviderName,
  cleanupStaleClaudeSubscriptionBlock,
  ensureClaudeSubscriptionBlockCleanup,
  type CleanupOnceMarker,
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

// ---------------------------------------------------------------------------
// The picker's vision chip is a read of the CONFIG, not of the engine.
//
// `visionStatesFor` (visionPin.ts) fills every picker row by calling
// `readModelVision(providerId, modelId)`, because acp/directory.ts flattens
// capabilities away before the model list reaches the panel. So the chip says
// what origami.json says — and for the Labs OAuth connections origami.json is
// not the authority. Two ways a row gets there with nothing to read:
//
//   · a ChatGPT id typed in by hand (`"gpt-5.6-luna": { "name": ... }`), months
//     before any catalog names it — the owner's own block, 2026-09-03;
//   · a row the engine resolved that origami.json has never held at all, which
//     is every model GitHub adds to a Copilot plan after the three-id seed was
//     written.
//
// Both read `false` and both drew "no vision" on models that all take images.
// The rule the owner states, and the one the backends implement: every model
// reached through a Labs OAuth subscription — ChatGPT, xAI, Copilot — sees.
//
// A DECLARATION STILL WINS, and must: `writeModelVision(off)` stores "off" as
// the ABSENCE of modalities plus a pin, and `visionStateFor` reads the pin
// first, so this default can never overrule a pinned-off model.
// ---------------------------------------------------------------------------
describe('a Labs OAuth model with nothing declared still reads as sighted', () => {
  const labs = () => JSON.stringify({
    provider: {
      openai: {
        name: 'ChatGpt',
        npm: '@ai-sdk/openai',
        models: {
          'gpt-5.6-luna': { name: 'gpt-5.6-luna' },
          'gpt-5.6-sol': { name: 'gpt-5.6-sol', attachment: true, modalities: { input: ['text', 'image'] } },
          'gpt-5.4-blind': { name: 'declared text-only', modalities: { input: ['text'] } },
        },
      },
      xai: { name: 'xAI (SuperGrok)', models: { 'grok-4.5': { name: 'Grok 4.5' } } },
      'github-copilot': { name: 'GitHub Copilot', models: { 'gpt-4.1': { name: 'GPT-4.1' } } },
      vllm: { name: 'S1', options: { baseURL: 'http://x:8000/v1' }, models: { 'qwen3.6-35b': { name: 'qwen3.6-35b' } } },
    },
  }, null, 2) + '\n';

  it('a hand-added ChatGPT entry with only a name', () => {
    write(labs());
    expect(readModelVision('openai', 'gpt-5.6-luna')).toBe(true);
  });

  it('and one the config has never held at all — a live Copilot row', () => {
    write(labs());
    expect(readModelVision('github-copilot', 'claude-opus-5')).toBe(true);
    expect(readModelVision('xai', 'grok-4.6')).toBe(true);
  });

  it('every Labs provider, not just the one that was noticed', () => {
    write(labs());
    expect(readModelVision('xai', 'grok-4.5')).toBe(true);
    expect(readModelVision('github-copilot', 'gpt-4.1')).toBe(true);
  });

  it('a declaration still wins — text-only stays text-only', () => {
    write(labs());
    expect(readModelVision('openai', 'gpt-5.4-blind')).toBe(false);
  });

  it('and a self-hosted provider is untouched: silence there really is no vision', () => {
    // The local reconcile pass writes this same flag from an LM Studio probe
    // (visionDetect.ts), so a default there would make every text model claim
    // eyes and then fight detection for them.
    write(labs());
    expect(readModelVision('vllm', 'qwen3.6-35b')).toBe(false);
    expect(readModelVision('vllm', 'never-configured')).toBe(false);
  });

  it('an unreadable config still answers false, never a Labs default', () => {
    write('{ not json');
    expect(readModelVision('openai', 'gpt-5.6-luna')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// t-u0rcmb — a model pick persists only what the engine cannot know by itself.
// For a model the engine already serves, that is `cfg.model`. Before this, EVERY
// successful switch also called writeModelConfig, which pinned a provider block +
// a models row even for a provider with none — freezing a copy of a catalog the
// engine already keeps current, and (via the name fallback below) sometimes
// naming that block after a completely different provider.
// ---------------------------------------------------------------------------
describe('writeDefaultModel — persists ONLY cfg.model, no provider block', () => {
  it('sets cfg.model and touches nothing else, for a provider with no block at all', () => {
    write(populated());
    const res = writeDefaultModel('claude-subscription/haiku');
    expect(res.model).toBe('claude-subscription/haiku');
    const cfg = read();
    expect(cfg.model).toBe('claude-subscription/haiku');
    expect(cfg.provider).toEqual(populatedProvider());
    expect('claude-subscription' in cfg.provider).toBe(false);
  });

  it('honours XDG_CONFIG_HOME like every other writer', () => {
    const res = writeDefaultModel('vllm/qwen');
    expect(res.path).toBe(cfgPath);
    expect(read().model).toBe('vllm/qwen');
  });

  it('refuses a commented config rather than deleting the comments', () => {
    write('{\n  // kept\n  "model": "vllm/spec-test",\n  "provider": { "vllm": { "models": { "spec-test": {} } } }\n}\n');
    expect(() => writeDefaultModel('vllm/spec-test')).toThrow(/comments/);
  });
});

function populatedProvider() {
  return JSON.parse(populated()).provider;
}

describe('persistModelPick — the shared tail of every switch-model flow', () => {
  it('an engine-served model (isConfigured) writes NO provider block and no models row — only cfg.model changes', () => {
    write(populated()); // has an lmstudio block, no claude-subscription block
    const result = persistModelPick(
      { providerId: 'claude-subscription', providerName: 'claude-subscription', modelId: 'haiku', modelName: 'haiku' },
      /* isConfigured */ true,
    );
    expect(result.wroteBlock).toBe(false);
    const cfg = read();
    expect(cfg.model).toBe('claude-subscription/haiku');
    expect('claude-subscription' in cfg.provider).toBe(false);
    // the provider that DID have a block is untouched
    expect(cfg.provider.lmstudio).toEqual(populatedProvider().lmstudio);
  });

  it('a fresh LM Studio / self-hosted model (not isConfigured) still gets its block', () => {
    write(populated());
    const result = persistModelPick(
      { providerId: 'vllm', providerName: 'S1 - DGX Spark 1', modelId: 'new-model', modelName: 'new-model' },
      /* isConfigured */ false,
    );
    expect(result.wroteBlock).toBe(true);
    expect(read().provider.vllm.models['new-model']).toEqual({ name: 'new-model' });
  });

  it('an OpenRouter pick (not isConfigured) still writes cost', () => {
    write(populated());
    const result = persistModelPick(
      { providerId: 'openrouter', providerName: 'OpenRouter', modelId: 'kimi-k3', modelName: 'Kimi K3', cost: { input: 0.5, output: 2 } },
      /* isConfigured */ false,
    );
    expect(result.wroteBlock).toBe(true);
    expect(read().provider.openrouter.models['kimi-k3'].cost).toEqual({ input: 0.5, output: 2 });
  });

  it('a provider that already has a block (isConfigured) keeps its name and hand-set fields', () => {
    write(populated());
    // vllm already has a hand-set name — an isConfigured pick must not touch the block at all.
    persistModelPick(
      { providerId: 'vllm', providerName: 'a name this call must never write', modelId: 'spec-test', modelName: 'spec-test' },
      /* isConfigured */ true,
    );
    expect(read().provider.vllm).toEqual(populatedProvider().vllm);
    expect(read().model).toBe('vllm/spec-test');
  });
});

describe('resolveModelPickProviderName — never borrows another provider\'s identity', () => {
  const local = { id: 'lmstudio', name: 'LM Studio' };

  it('a configured block\'s own name always wins', () => {
    expect(resolveModelPickProviderName('openrouter', 'OpenRouter', local)).toBe('OpenRouter');
  });

  it('the local provider\'s name is used ONLY when providerId IS the local provider', () => {
    expect(resolveModelPickProviderName('lmstudio', undefined, local)).toBe('LM Studio');
  });

  it('a different, unconfigured provider NEVER borrows the local provider\'s name — the t-u0rcmb bug', () => {
    // Before the fix this returned "LM Studio", which is how the owner's live config
    // got a claude-subscription block literally named after LM Studio.
    expect(resolveModelPickProviderName('claude-subscription', undefined, local)).toBe('claude-subscription');
  });

  it('with no local provider at all, an unconfigured provider falls back to its own id', () => {
    expect(resolveModelPickProviderName('openrouter', undefined, null)).toBe('openrouter');
  });
});

// ---------------------------------------------------------------------------
// writeModelVision for a provider with NO block (e.g. `openai` with only an
// auth key): the ENGINE reads this config flag, not the extension's vision pin
// (visionPin.ts is display-only) — so a capability override still has to land
// here. The fix writes the SMALLEST possible block: never name/npm/options,
// only `models[id]`'s two capability fields, pruned back to nothing once empty.
// ---------------------------------------------------------------------------
describe('writeModelVision — a no-block provider gets a MINIMAL capability-only block', () => {
  it('vision ON with no prior block: the block is exactly { models: { id: { attachment, modalities } } }', () => {
    write(populated());
    writeModelVision({ providerId: 'claude-subscription', modelId: 'haiku', enabled: true });
    expect(read().provider['claude-subscription']).toEqual({
      models: { haiku: { attachment: true, modalities: { input: ['text', 'image'] } } },
    });
  });

  it('vision OFF afterwards prunes the model row and then the block itself — gone entirely', () => {
    write(populated());
    writeModelVision({ providerId: 'claude-subscription', modelId: 'haiku', enabled: true });
    writeModelVision({ providerId: 'claude-subscription', modelId: 'haiku', enabled: false });
    expect('claude-subscription' in read().provider).toBe(false);
  });

  it('never writes name, npm or options for the minimal block', () => {
    write(populated());
    writeModelVision({ providerId: 'openai', modelId: 'gpt-5.6-luna', enabled: true });
    const block = read().provider.openai;
    expect(Object.keys(block)).toEqual(['models']);
  });

  it('a provider that already has a real block keeps its name and fields — untouched by pruning', () => {
    write(populated());
    writeModelVision({ providerId: 'lmstudio', modelId: 'qwen3-8b', enabled: true });
    const lmstudio = read().provider.lmstudio;
    expect(lmstudio.name).toBe('LM Studio');
    expect(lmstudio.options).toEqual({ baseURL: 'http://127.0.0.1:1234/v1' });
    expect(lmstudio.models['qwen3-8b']).toEqual({ name: 'qwen3-8b', attachment: true, modalities: { input: ['text', 'image'] } });

    // turning it back off never prunes a block that carries real identity fields
    writeModelVision({ providerId: 'lmstudio', modelId: 'qwen3-8b', enabled: false });
    expect(read().provider.lmstudio.name).toBe('LM Studio');
    expect(read().provider.lmstudio.models['qwen3-8b']).toEqual({ name: 'qwen3-8b' });
  });
});

// ---------------------------------------------------------------------------
// One-time clean-up of an old `claude-subscription` block (t-u0rcmb). Removes it
// only when every field is one the old pick path could have written; a person's
// hand-edit (an apiKey, a baseURL, a model with `cost`/`limit`) is left alone.
// ---------------------------------------------------------------------------
describe('cleanupStaleClaudeSubscriptionBlock', () => {
  const withStaleBlock = () => JSON.stringify({
    model: 'claude-subscription/haiku',
    provider: {
      lmstudio: { name: 'LM Studio', npm: '@ai-sdk/openai-compatible', options: { baseURL: 'http://127.0.0.1:1234/v1' }, models: { 'qwen3-8b': { name: 'qwen3-8b' } } },
      'claude-subscription': { name: 'LM Studio', options: {}, models: { haiku: { name: 'haiku' } } },
    },
  }, null, 2) + '\n';

  it('removes an old-pick-path-shaped block, backs up, leaves cfg.model and every other block alone', () => {
    write(withStaleBlock());
    const res = cleanupStaleClaudeSubscriptionBlock();
    expect(res.removed).toBe(true);
    const cfg = read();
    expect('claude-subscription' in cfg.provider).toBe(false);
    expect(cfg.model).toBe('claude-subscription/haiku'); // left alone — the engine's own fallback handles it
    expect(cfg.provider.lmstudio).toEqual(JSON.parse(withStaleBlock()).provider.lmstudio);
    expect(fs.existsSync(`${cfgPath}.bak`)).toBe(true);
  });

  it('is idempotent — a second call finds nothing to remove', () => {
    write(withStaleBlock());
    cleanupStaleClaudeSubscriptionBlock();
    const afterFirst = fs.readFileSync(cfgPath, 'utf8');
    const res = cleanupStaleClaudeSubscriptionBlock();
    expect(res.removed).toBe(false);
    expect(fs.readFileSync(cfgPath, 'utf8')).toBe(afterFirst);
  });

  it('leaves a hand-edited block alone (an apiKey the old pick path never wrote)', () => {
    const handEdited = JSON.stringify({
      provider: { 'claude-subscription': { name: 'My Claude', options: { apiKey: 'sk-hand-typed' }, models: { haiku: { name: 'haiku' } } } },
    }, null, 2) + '\n';
    write(handEdited);
    const res = cleanupStaleClaudeSubscriptionBlock();
    expect(res.removed).toBe(false);
    expect(read().provider['claude-subscription'].options.apiKey).toBe('sk-hand-typed');
  });

  it('leaves a hand-edited block alone (a model with a cost the old pick path never wrote)', () => {
    const handEdited = JSON.stringify({
      provider: { 'claude-subscription': { name: 'X', options: {}, models: { haiku: { name: 'haiku', cost: { input: 1, output: 2 } } } } },
    }, null, 2) + '\n';
    write(handEdited);
    const res = cleanupStaleClaudeSubscriptionBlock();
    expect(res.removed).toBe(false);
    expect(read().provider['claude-subscription'].models.haiku.cost).toEqual({ input: 1, output: 2 });
  });

  it('a config with no claude-subscription block at all is a clean no-op', () => {
    write(populated());
    const before = fs.readFileSync(cfgPath, 'utf8');
    const res = cleanupStaleClaudeSubscriptionBlock();
    expect(res.removed).toBe(false);
    expect(fs.readFileSync(cfgPath, 'utf8')).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// The clean-up must run AT MOST ONCE per install. After the writeModelVision fix,
// a genuine vision override on claude-subscription is a `models`-only block — the
// SAME shape the clean-up removes — so running the pass on every activation would
// delete a real, current override. A globalState-backed marker (the same pattern
// as ensureGlobalSeeds/ensureSubagentToolDefaults) gates it to one pass.
// ---------------------------------------------------------------------------
describe('ensureClaudeSubscriptionBlockCleanup — runs at most once', () => {
  const withStaleBlock = () => JSON.stringify({
    provider: { 'claude-subscription': { name: 'LM Studio', options: {}, models: { haiku: { name: 'haiku' } } } },
  }, null, 2) + '\n';

  function fakeMarker(initial?: boolean): CleanupOnceMarker & { value: boolean | undefined } {
    return {
      value: initial,
      get() { return this.value; },
      set(v: boolean) { this.value = v; },
    };
  }

  it('marker unset: runs the clean-up and sets the marker true', () => {
    write(withStaleBlock());
    const marker = fakeMarker(undefined);
    const res = ensureClaudeSubscriptionBlockCleanup(marker);
    expect(res?.removed).toBe(true);
    expect('claude-subscription' in read().provider).toBe(false);
    expect(marker.value).toBe(true);
  });

  it('marker already true: skipped entirely — config never even read, block survives untouched', () => {
    write(withStaleBlock());
    const before = fs.readFileSync(cfgPath, 'utf8');
    const marker = fakeMarker(true);
    const res = ensureClaudeSubscriptionBlockCleanup(marker);
    expect(res).toBeNull();
    expect(fs.readFileSync(cfgPath, 'utf8')).toBe(before);
  });

  it('a throw (corrupt config) does NOT set the marker — retries next start', () => {
    write('{ "model": ');
    const marker = fakeMarker(undefined);
    expect(() => ensureClaudeSubscriptionBlockCleanup(marker)).toThrow();
    expect(marker.value).toBeUndefined();
  });

  it('protects a genuine vision-only override from being deleted on a LATER activation', () => {
    // First activation: marker unset, an old-shaped stale block is cleaned up.
    write(withStaleBlock());
    const marker = fakeMarker(undefined);
    ensureClaudeSubscriptionBlockCleanup(marker);
    // The owner then sets a real vision override the same shape the clean-up removes.
    writeModelVision({ providerId: 'claude-subscription', modelId: 'sonnet', enabled: true });
    expect(read().provider['claude-subscription']).toEqual({
      models: { sonnet: { attachment: true, modalities: { input: ['text', 'image'] } } },
    });
    // A LATER activation (marker now true) must not touch it.
    const res = ensureClaudeSubscriptionBlockCleanup(marker);
    expect(res).toBeNull();
    expect(read().provider['claude-subscription']).toEqual({
      models: { sonnet: { attachment: true, modalities: { input: ['text', 'image'] } } },
    });
  });
});
