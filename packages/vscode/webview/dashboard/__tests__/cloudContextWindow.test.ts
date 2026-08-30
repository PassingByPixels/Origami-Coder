// A CLOUD chat must never wear the LOCAL server's context window.
//
// THE DEFECT (owner, 0.4.59): a grok chat's gauge read "194k/36k tokens (100%)".
// 36864 is LM Studio's `loaded_context_length` — the number the LOCAL probe
// measured for whatever model LM Studio happened to have loaded — displayed as
// if it were grok's ceiling. The false 100% then drives the whole compaction
// affordance (and the threshold menu's denominator) off a number belonging to a
// different server entirely.
//
// THE CHAIN: resolveModelProbe read the base URL out of the session model's
// provider block, and when there was none it fell through to a return carrying
// `providerId: null` and the LM STUDIO engine URL. A cloud block never has one:
// every keyless OAuth connect writes providerId/name/npm/models and nothing else
// (providerAuthPane.ts's `finish`), and the key-only presets for xai/openai/
// anthropic carry no URL either (keyOnlyPresets.ts — only openrouter/opencode/
// opencode-go do). refreshModelInfoFor then read that null as "local" and
// assigned `session.modelWindow = this.modelInfo.contextLength`.
//
// The inconsistency at the centre: sessionModelStatus decided remoteness from
// the model id's PROVIDER PREFIX (grok = remote), while refreshModelInfoFor
// decided it from whether a base URL turned up (grok = local). The second one
// wrote the number. `isLocal` is now resolved once, by the prefix rule, and both
// read it.
//
// These drive the REAL panel methods against a temp XDG config, for
// connectContextLimit.test.ts's reason: detectLocalProvider / readGlobalProviders
// / readModelVision all resolve the config path themselves, so a temp XDG dir is
// found only if that path code is right. The panel is built on the prototype
// with the handful of fields these two methods touch — constructing a real one
// needs a live extension host, and a hand-rolled fake of the methods under test
// would prove only that the fake agrees with itself.

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DashboardPanel } from '../../../src/dashboard/DashboardPanel';

/** LM Studio's loaded window on the owner's machine when this was reported. */
const LOADED = 36864;
/** The local engine endpoint the fallthrough used to hand every session. */
const ENGINE_URL = 'http://127.0.0.1:1234/v1';

let tmp: string;
let cfgDir: string;
let cfgPath: string;
let savedXdg: string | undefined;

const seed = (cfg: unknown): void => {
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
};
const read = () => JSON.parse(fs.readFileSync(cfgPath, 'utf8'));

/** The owner's shape: a loopback LM Studio, a self-hosted vLLM with its own base
 *  URL, and a key-only/OAuth cloud provider with NO `options` at all. */
const baseConfig = () => ({
  model: 'xai/grok-4.6',
  provider: {
    lmstudio: {
      name: 'LM Studio',
      npm: '@ai-sdk/openai-compatible',
      options: { baseURL: ENGINE_URL },
      models: { 'qwen3-8b': { name: 'qwen3-8b' } },
    },
    vllm: {
      name: 'DGX Spark',
      npm: '@ai-sdk/openai-compatible',
      options: { baseURL: 'http://100.64.1.10:8000/v1' },
      models: { 'spec-test': { name: 'spec-test' } },
    },
    // Exactly what providerAuthPane's `finish` writes for a keyless OAuth
    // connect, and what the xai/openai/anthropic key-only prompt writes minus
    // the key: a name, an npm package, models. No `options`, so no baseURL.
    xai: { name: 'xAI', npm: '@ai-sdk/xai', models: { 'grok-4.6': { name: 'Grok 4.6' } } },
  },
});

beforeEach(() => {
  savedXdg = process.env.XDG_CONFIG_HOME;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'origami-cloud-ctx-'));
  process.env.XDG_CONFIG_HOME = tmp;
  cfgDir = path.join(tmp, 'origami');
  cfgPath = path.join(cfgDir, 'origami.json');
  seed(baseConfig());
});

afterEach(() => {
  if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = savedXdg;
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

type Panel = {
  resolveModelProbe(session: unknown): { apiBase: string | undefined; providerId: string | null; modelId: string | null; apiKey?: string; isLocal: boolean };
  refreshModelInfoFor(session: unknown): Promise<void>;
  sessionModelStatus(session: unknown, ctx: unknown): { contextWindow: number; providerIsLocal: boolean; isVlm: boolean; providerId: string };
  modelInfo: { ok: boolean; modelId: string; contextLength: number; state: string; type?: string; reason?: string };
  posted: object[];
};

/** The panel state resolveModelProbe / refreshModelInfoFor / sessionModelStatus
 *  actually read. `this.modelInfo` is the LM Studio probe result — a REAL one:
 *  a vlm loaded at 36864, which is what leaked. */
function makePanel(): Panel {
  const panel = Object.create(DashboardPanel.prototype) as Record<string, unknown> & Panel;
  panel.modelInfo = { ok: true, modelId: 'qwen3-8b', contextLength: LOADED, state: 'ready', type: 'vlm' };
  panel.posted = [];
  Object.assign(panel as Record<string, unknown>, {
    providerStatusCache: new Map(),
    activeSessionId: '',
    activeModelWindow: 0,
    context: { globalState: { get: () => undefined, update: async () => {} } },
    // Own properties shadow the prototype: resolveEngineUrl needs a live
    // vscode configuration, and broadcasting needs a webview.
    resolveEngineUrl: () => ENGINE_URL,
    broadcastModelStatus: () => {},
    post: (m: object) => { panel.posted.push(m); },
  });
  return panel;
}

/** A chat whose engine has reported its model — the only session field these
 *  paths read besides the id. */
const session = (current: string) => ({
  id: 's1',
  client: { getModelOption: () => ({ current }) },
} as unknown as { id: string; modelWindow?: number; modelWindowFor?: string; modelIsVlm?: boolean });

const statusCtx = () => ({ localId: 'lmstudio', providers: read().provider, staleRemote: new Set<string>() });

describe('a cloud session with no probeable endpoint', () => {
  it('does NOT inherit the LM Studio window (the reported 36k-on-grok gauge)', async () => {
    const panel = makePanel();
    const s = session('xai/grok-4.6');
    await panel.refreshModelInfoFor(s);
    // The bug: 36864, LM Studio's loaded_context_length, on a grok chat.
    expect(s.modelWindow).not.toBe(LOADED);
    // Unknown, not guessed — InputBar falls back to the ENGINE's own
    // provider-correct `usage_update.size` when contextWindow is 0, and says
    // "(catalog max)" rather than "loaded context window".
    expect(s.modelWindow).toBe(0);
    // Still tagged for the model it was resolved for, so sessionValidWindow and
    // the recovery probe keep working.
    expect(s.modelWindowFor).toBe('xai/grok-4.6');
  });

  it('does NOT inherit the LM Studio VLM flag either — same gate, same leak', async () => {
    const panel = makePanel(); // LM Studio has a *vlm* loaded
    const s = session('xai/grok-4.6');
    await panel.refreshModelInfoFor(s);
    // grok-4.6's own config block declares no image modality, so: false.
    expect(s.modelIsVlm).toBe(false);
  });

  it('resolves NO probe target rather than pointing at the local engine URL', () => {
    const panel = makePanel();
    const p = panel.resolveModelProbe(session('xai/grok-4.6'));
    // The fallthrough used to hand back the LM Studio endpoint here, with
    // providerId null — which is what made the session read as "local".
    expect(p.apiBase).toBeUndefined();
    expect(p.providerId).toBe('xai');
    expect(p.modelId).toBe('grok-4.6');
    expect(p.isLocal).toBe(false);
  });

  it('applies to the CONFIGURED DEFAULT model too, before the engine reports one', async () => {
    // Pre-start seed: no model option yet, so detectModel() stands in — and the
    // default here is xai/grok-4.6. The prefix rule must still hold.
    const panel = makePanel();
    const s = { id: 's1', client: { getModelOption: () => undefined } } as unknown as { modelWindow?: number };
    await panel.refreshModelInfoFor(s);
    expect(s.modelWindow).toBe(0);
  });

  it('writes NOTHING into the cloud provider block — no LM Studio number persisted', async () => {
    const before = fs.readFileSync(cfgPath, 'utf8');
    const panel = makePanel();
    await panel.refreshModelInfoFor(session('xai/grok-4.6'));
    // limit.context is what the ENGINE reads to decide auto-compaction
    // (session/overflow.ts). A 36864 baked in here would make grok compact at a
    // ceiling belonging to another server, on disk, permanently.
    expect(read().provider.xai.models['grok-4.6'].limit).toBeUndefined();
    expect(fs.readFileSync(cfgPath, 'utf8')).toBe(before);
  });

  it('its per-session STATUS reports an unknown window, not the local one', () => {
    // sessionModelStatus's own fallback: a non-remote session with no valid
    // cached window falls back to this.modelInfo.contextLength. It is the
    // provider PREFIX that keeps a cloud chat out of that branch, so pin it.
    const panel = makePanel();
    const st = panel.sessionModelStatus(session('xai/grok-4.6'), statusCtx());
    expect(st.contextWindow).toBe(0);
    expect(st.providerIsLocal).toBe(false);
    expect(st.providerId).toBe('xai');
  });
});

describe('what must NOT change', () => {
  it('a LOCAL session keeps the probed window and the VLM flag', async () => {
    const panel = makePanel();
    const s = session('lmstudio/qwen3-8b');
    await panel.refreshModelInfoFor(s);
    expect(s.modelWindow).toBe(LOADED);
    expect(s.modelIsVlm).toBe(true);
    expect(s.modelWindowFor).toBe('lmstudio/qwen3-8b');
  });

  it('a local session resolves the local probe target', () => {
    const panel = makePanel();
    const p = panel.resolveModelProbe(session('lmstudio/qwen3-8b'));
    expect(p.isLocal).toBe(true);
    expect(p.apiBase).toBe(ENGINE_URL);
  });

  it('a REMOTE provider that HAS a base URL is still probed at its own endpoint', () => {
    // The self-hosted path this whole mechanism exists for (a vLLM's
    // max_model_len) must be untouched by the cloud gate.
    const panel = makePanel();
    const p = panel.resolveModelProbe(session('vllm/spec-test'));
    expect(p.apiBase).toBe('http://100.64.1.10:8000/v1');
    expect(p.providerId).toBe('vllm');
    expect(p.isLocal).toBe(false);
  });

  it('a session with no model at all still reads as the local server', async () => {
    // No prefix to judge by and no configured default: the whole no-provider
    // branch of sessionModelStatus already presents as LM Studio (name, label,
    // providerIsLocal), so the window must stay consistent with it.
    const cfg = baseConfig();
    delete (cfg as { model?: string }).model;
    seed(cfg);
    const panel = makePanel();
    const s = session('');
    await panel.refreshModelInfoFor(s);
    expect(s.modelWindow).toBe(LOADED);
  });
});
