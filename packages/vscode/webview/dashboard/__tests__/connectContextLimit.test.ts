// A freshly-connected SELF-HOSTED provider must reach the engine with its REAL
// context window, on the first connect, with no second visit to any UI.
//
// THE DEFECT (owner, brand-new macOS install): connecting an "S1 - Spark 1" vLLM
// endpoint wrote the model as `{"name": "deepseek-v4-flash-0731-ablit"}` and
// nothing else, while that same server's /v1/models reported
// `max_model_len: 1048576` and answered a curl from that very machine. The
// engine resolves `model.limit?.context ?? existingModel?.limit?.context ?? 0`,
// and session/overflow.ts's isOverflow() hard-returns false at 0 — so
// auto-compaction was OFF for that connection, and the gauge fell back to a
// "(catalog max)" number belonging to a different model.
//
// The safety net that was supposed to cover it — DashboardPanel's
// refreshModelInfoFor bridging a probed window into writeModelContextLimit —
// demonstrably never ran successfully there: the config stayed bare. So the
// window is now baked at CONNECT, by the one flow that already knows both which
// server and which model, and the net stays as a net.
//
// These drive the REAL writer (writeModelConfig) against a temp XDG dir, for
// configWriters.test.ts's reason: the writers honour XDG_CONFIG_HOME, so a temp
// dir is found only if the path code is right, whereas a mocked homedir would
// pass just as happily against a defect. Every assertion is about what lands IN
// THE FILE the engine reads — never about which dependency was called.

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { writeModelConfig } from '../../../src/dashboard/firstFold';
import { setupProvider, type SetupProviderDeps } from '../../../src/dashboard/setupProvider';

let tmp: string;
let cfgDir: string;
let cfgPath: string;
let savedXdg: string | undefined;

beforeEach(() => {
  savedXdg = process.env.XDG_CONFIG_HOME;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'origami-connect-ctx-'));
  process.env.XDG_CONFIG_HOME = tmp;
  cfgDir = path.join(tmp, 'origami');
  cfgPath = path.join(cfgDir, 'origami.json');
});

afterEach(() => {
  if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = savedXdg;
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const seed = (cfg: unknown): void => {
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
};
const read = () => JSON.parse(fs.readFileSync(cfgPath, 'utf8'));

/** The model id the owner's Spark actually served when this broke. */
const MODEL = 'deepseek-v4-flash-0731-ablit';
/** Its real `max_model_len`, read live off that server. */
const SERVED = 1048576;
const SPARK_URL = 'http://100.64.1.30:8000/v1';

/** The connect form's payload for the Spark preset: a tailnet base URL and NO
 *  model id — the `localAuto` shape (setupCatalog.ts), so the flow auto-picks. */
const sparkMsg = (over: Record<string, unknown> = {}) => ({
  providerId: 'vllm',
  providerName: 'S1 - Spark 1',
  npm: '@ai-sdk/openai-compatible',
  baseURL: SPARK_URL,
  modelId: '',
  ...over,
});

const okFetch = (async () => ({ ok: true, status: 200, json: async () => ({}) })) as unknown as typeof fetch;

/** The flow with its REAL config writer and every other dependency faked. */
function deps(over: Partial<SetupProviderDeps> & { msg: SetupProviderDeps['msg'] }): SetupProviderDeps {
  return {
    sessionId: 's1',
    fetchImpl: okFetch,
    fetchLocalModels: async () => [MODEL],
    fetchCatalog: async () => [],
    cacheCatalog: () => {},
    costFor: async () => undefined,
    write: writeModelConfig,
    post: () => {},
    refresh: () => {},
    ...over,
  };
}

describe('connecting a self-hosted server bakes ITS OWN window into config', () => {
  it('a fresh machine with NO config at all ends up with the real limit.context', async () => {
    // The reported defect, end to end: nothing on disk, one connect, and the
    // engine can now compact — instead of a bare {"name": …} and isOverflow()
    // stuck at false forever.
    expect(fs.existsSync(cfgPath)).toBe(false);
    await setupProvider(deps({ msg: sparkMsg(), fetchModelWindow: async () => SERVED }));

    const saved = read().provider.vllm.models[MODEL];
    expect(saved.name).toBe(MODEL);
    // `output` is not decoration: the engine's config schema makes it a REQUIRED
    // sibling of `context`, and a bare {context} invalidates the WHOLE file.
    expect(saved.limit).toEqual({ context: SERVED, output: 0 });
    expect(read().model).toBe(`vllm/${MODEL}`);
  });

  it('asks the server being connected, about the model being written', async () => {
    const asked: Array<[string, string, string | undefined]> = [];
    await setupProvider(deps({
      msg: sparkMsg({ apiKey: 'sk-spark' }),
      fetchLocalModels: async () => [MODEL, 'some-other-model'],
      fetchModelWindow: async (b, m, k) => { asked.push([b, m, k]); return SERVED; },
    }));
    // The key matters: a key-protected vLLM 401s an unauthenticated probe, which
    // would silently cost the window while the connection itself works fine.
    expect(asked).toEqual([[SPARK_URL, MODEL, 'sk-spark']]);
    expect(read().provider.vllm.models[MODEL].limit.context).toBe(SERVED);
  });

  it('a LOOPBACK server (LM Studio) is baked too — the gate is self-hosted, not one URL', async () => {
    await setupProvider(deps({
      msg: { providerId: 'lmstudio', providerName: 'LM Studio', baseURL: 'http://127.0.0.1:1234/v1', modelId: '' },
      fetchLocalModels: async () => ['qwen/qwen3-coder-30b'],
      fetchModelWindow: async () => 65536,
    }));
    expect(read().provider.lmstudio.models['qwen/qwen3-coder-30b'].limit).toEqual({ context: 65536, output: 0 });
  });
});

describe('what is NOT written — an honest unknown beats a fabricated window', () => {
  it('a server that publishes no window saves EXACTLY what it saved before', async () => {
    await setupProvider(deps({ msg: sparkMsg(), fetchModelWindow: async () => 0 }));
    // Byte-for-byte the old behaviour: a bare entry, no `limit` key invented.
    expect(read().provider.vllm.models[MODEL]).toEqual({ name: MODEL });
  });

  it('and so does a caller that wires no window probe at all', async () => {
    await setupProvider(deps({ msg: sparkMsg() }));
    expect(read().provider.vllm.models[MODEL]).toEqual({ name: MODEL });
  });

  it('a hand-set window is NEVER overruled — the server reports a static maximum', async () => {
    // A user may deliberately cap a model lower than the server's ceiling to
    // force earlier compaction; the live config on the owner's machine does
    // exactly that for three vLLM models. Filling a 0 is the fix. Overruling a
    // chosen number would be a regression wearing the fix's clothes.
    seed({
      model: `vllm/${MODEL}`,
      provider: {
        vllm: {
          name: 'S1 - Spark 1',
          options: { baseURL: SPARK_URL },
          models: { [MODEL]: { name: MODEL, limit: { context: 32768, output: 8192 } } },
        },
      },
    });
    await setupProvider(deps({ msg: sparkMsg(), fetchModelWindow: async () => SERVED }));
    expect(read().provider.vllm.models[MODEL].limit).toEqual({ context: 32768, output: 8192 });
  });

  it('a CLOUD gateway is never probed for a window and never gets one baked', async () => {
    // OpenRouter and the Zen family publish a catalogue figure that
    // refreshModelInfoFor deliberately keeps out of config (it is a policy
    // decision about the engine's compaction, taken separately). This connect
    // must not quietly make that decision on its behalf.
    const probe = vi.fn(async () => SERVED);
    await setupProvider(deps({
      msg: { providerId: 'opencode-go', providerName: 'OpenCode Go', apiKey: 'sk-go', modelId: 'deepseek-v4-flash' },
      fetchModelWindow: probe,
    }));
    expect(probe).not.toHaveBeenCalled();
    expect(read().provider['opencode-go'].models['deepseek-v4-flash']).toEqual({ name: 'deepseek-v4-flash' });
  });

  it('a window probe that THROWS still connects — it must never cost the user the block', async () => {
    const posted: object[] = [];
    await setupProvider(deps({
      msg: sparkMsg(),
      fetchModelWindow: async () => { throw new Error('ECONNRESET'); },
      post: (m) => { posted.push(m); },
    }));
    expect(read().provider.vllm.models[MODEL]).toEqual({ name: MODEL });
    expect(posted.filter((p) => (p as { type?: string }).type === 'error')).toEqual([]);
  });
});
