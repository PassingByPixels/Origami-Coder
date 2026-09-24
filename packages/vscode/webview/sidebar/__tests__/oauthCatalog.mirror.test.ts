// DRIFT GUARD: the OAuth catalog the extension WRITES vs the list the engine's
// codex plugin actually SERVES.
//
// oauthConnections.ts is a hand mirror — its own header says so: "This is a
// MIRROR of data that lives elsewhere, so it will age." It aged. The catalog
// carried `gpt-5.3-codex-spark` because codex.ts's ALLOWED_MODELS carried it,
// and the ChatGPT backend refuses that model by name: "The
// 'gpt-5.3-codex-spark' model is not supported when using Codex with a ChatGPT
// account" — the owner's first message on a fresh sign-in, 2026-08-15. Both
// lists were trimmed; this test is what stops them parting again.
//
// The engine list is read as TEXT, not imported: packages/vscode has no
// dependency on packages/engine's source, and the mirror is precisely the thing
// that must not be papered over with an import that could silently resolve to a
// stale build.

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OAUTH_PROVIDERS } from '../../../src/dashboard/oauthConnections';

const here = path.dirname(fileURLToPath(import.meta.url));
const enginePath = (...rel: string[]) => path.resolve(here, '..', '..', '..', '..', 'engine', ...rel);
const codexPath = enginePath('src', 'plugin', 'openai', 'codex.ts');

// GITHUB COPILOT PINS SOMETHING ELSE, AND HERE IS WHY.
//
// codex.ts declares ALLOWED_MODELS, so "the catalog is EXACTLY the allowlist"
// is a statement that can be true or false. github-copilot's plugin declares no
// such list: `CopilotModels.get` (plugin/github-copilot/models.ts) fetches
// `<base>/models` with the user's own token and serves whatever GitHub says
// THAT ACCOUNT may use — different on Free, Pro and Business. There is no list
// in the plugin to be equal to, so equality is the wrong assertion.
//
// What CAN drift, and what these tests pin instead:
//   - a seed id GitHub does not serve at all -> a config block whose row is
//     dead on arrival. Pinned against the models.dev snapshot the engine binary
//     itself bakes in (engine/script/generate.ts inlines api.json as
//     ORIGAMI_MODELS_DEV; this fixture is a captured copy of that same file).
//   - a seed's LIMITS drifting from that snapshot -> a wrong context window,
//     which silently mis-drives auto-compaction rather than failing loudly.
//   - the default model drifting off the ids the PLUGIN itself names as
//     always-served (its UTILITY_MODELS) -> a fresh sign-in writes cfg.model =
//     something the account may not be entitled to, and the first chat 400s.
const modelsDevPath = enginePath('test', 'tool', 'fixtures', 'models-api.json');
const copilotPluginPath = enginePath('src', 'plugin', 'github-copilot', 'copilot.ts');

/** The `github-copilot` provider entry of the models.dev snapshot. */
function copilotSnapshot(): { models: Record<string, Record<string, unknown>> } {
  return JSON.parse(readFileSync(modelsDevPath, 'utf8'))['github-copilot'];
}

/** The plugin's UTILITY_MODELS, parsed out of its source. */
function utilityModels(): string[] {
  const src = readFileSync(copilotPluginPath, 'utf8');
  const line = /const UTILITY_MODELS = \[([^\]]*)\]/.exec(src);
  expect(line, `UTILITY_MODELS not found in ${copilotPluginPath} — the parser needs updating`).toBeTruthy();
  return [...line![1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

/** The engine's ALLOWED_MODELS, parsed out of the plugin source. */
function allowedModels(): string[] {
  const src = readFileSync(codexPath, 'utf8');
  const line = /const ALLOWED_MODELS = new Set\(\[([^\]]*)\]\)/.exec(src);
  expect(line, `ALLOWED_MODELS not found in ${codexPath} — the parser needs updating`).toBeTruthy();
  return [...line![1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

describe('the OAuth model catalog matches what the ChatGPT backend serves', () => {
  it('the engine plugin is where this test thinks it is', () => {
    // A moved file would make every assertion below vacuously pass.
    expect(existsSync(codexPath), `${codexPath} is missing`).toBe(true);
    expect(allowedModels().length).toBeGreaterThan(0);
  });

  it('every seeded openai model is one the engine will serve', () => {
    // WAS an equality check. Relaxed to seed ⊆ served, deliberately, because
    // equality now asserts something false: the engine discovers the account's
    // real list at runtime (engine `plugin/openai/codexCatalog.ts`), so
    // ALLOWED_MODELS is an offline FLOOR that may legitimately be longer than
    // the seed - `gpt-6-astra` reaches the picker without appearing in either
    // list. The half that still matters is unchanged and is the half that broke
    // before: a seeded id the engine strips is a config block whose very first
    // message fails, and no amount of discovery rescues it.
    const served = new Set(allowedModels());
    const unreachable = Object.keys(OAUTH_PROVIDERS['openai'].models).filter((id) => !served.has(id));
    expect(unreachable, 'seeded but not in the engine allowlist').toEqual([]);
  });

  it('gpt-5.3-codex-spark is gone from BOTH sides and stays gone', () => {
    expect(allowedModels()).not.toContain('gpt-5.3-codex-spark');
    expect(Object.keys(OAUTH_PROVIDERS['openai'].models)).not.toContain('gpt-5.3-codex-spark');
  });

  it('the openai catalog is checked against the allowlist, not against Copilot’s seed', () => {
    // Guards the assertion above from the change that added a THIRD provider:
    // if it ever grew to loop every spec, github-copilot's seed would have to
    // equal codex.ts's list, which is nonsense — and the loop would have been
    // "fixed" by loosening the openai check.
    expect(Object.keys(OAUTH_PROVIDERS).sort()).toEqual(['github-copilot', 'openai', 'xai']);
  });

  it('the default model the connection writes is one the backend will serve', () => {
    // The regression this catches: trimming the catalog out from under
    // `defaultModel`, so a successful sign-in writes cfg.model = a model that
    // no longer exists and the first chat has nothing to send.
    for (const spec of Object.values(OAUTH_PROVIDERS)) {
      expect(Object.keys(spec.models), `${spec.id} defaultModel`).toContain(spec.defaultModel);
    }
  });
});

describe('the GitHub Copilot seed catalog matches the models.dev snapshot', () => {
  const spec = OAUTH_PROVIDERS['github-copilot'];

  it('the snapshot is where this test thinks it is, and carries github-copilot', () => {
    // A moved/renamed fixture would make every assertion below vacuously pass.
    expect(existsSync(modelsDevPath), `${modelsDevPath} is missing`).toBe(true);
    expect(Object.keys(copilotSnapshot().models).length).toBeGreaterThan(10);
    expect(utilityModels().length).toBeGreaterThan(0);
  });

  it('every seed id is one GitHub actually serves', () => {
    const served = Object.keys(copilotSnapshot().models);
    for (const id of Object.keys(spec.models)) {
      expect(served, `${id} is not in models.dev's github-copilot list`).toContain(id);
    }
  });

  it('every seed’s name, limits, modalities and date are the snapshot’s, verbatim', () => {
    // Hand-copied numbers age. A wrong limit.context does not fail loudly — it
    // mis-drives auto-compaction — so it is pinned field by field.
    const served = copilotSnapshot().models;
    for (const [id, seed] of Object.entries(spec.models)) {
      const real = served[id] as {
        name: string; limit: { context: number; output: number };
        reasoning: boolean; tool_call: boolean; attachment: boolean; temperature: boolean;
        modalities: { input: string[]; output: string[] }; release_date: string;
      };
      expect({ id, ...seed, provider: undefined }).toEqual({
        id,
        name: real.name,
        limit: { context: real.limit.context, output: real.limit.output },
        reasoning: real.reasoning,
        tool_call: real.tool_call,
        attachment: real.attachment,
        temperature: real.temperature,
        modalities: real.modalities,
        release_date: real.release_date,
        provider: undefined,
      });
    }
  });

  it('every seed declares the Copilot API base — the only url a snapshot-less engine has', () => {
    const api = copilotSnapshot() as unknown as { api: string };
    expect(api.api).toBe('https://api.githubcopilot.com');
    for (const [id, seed] of Object.entries(spec.models)) {
      expect(seed.provider?.api, `${id}`).toBe(api.api);
    }
  });

  it('the default model is one the PLUGIN itself names as always-served', () => {
    // copilot.ts's UTILITY_MODELS are the ids GitHub serves for title
    // generation on every plan — the only always-available ids the plugin
    // source names. cfg.model has to be one of them.
    expect(utilityModels()).toContain(spec.defaultModel);
  });
});

// EVERY LABS MODEL SEES. Not a style rule — a claim about the three backends
// this catalog writes blocks for. The ChatGPT subscription backend, xAI's
// OAuth-gated Grok models and GitHub Copilot all take image input on every chat
// model they serve, and `provider.ts` builds `capabilities.input.image` from
// this array alone. A seed written without `modalities` therefore resolves a
// SIGHTED model as blind, and `ProviderTransform.unsupportedParts` replaces the
// picture with "ERROR: Cannot read image" before it reaches a backend that
// would have taken it.
//
// The extension reads the same field for the picker's vision chip
// (firstFold.ts's readModelVision), so a missing `modalities` here is also a
// row that SAYS "no vision" about a model that sees.
//
// "text" is asserted alongside: provider.ts reads text support from this same
// array, so ["image"] alone would resolve a model that cannot take a prompt.
describe('every baked Labs model declares image input', () => {
  for (const [providerId, spec] of Object.entries(OAUTH_PROVIDERS)) {
    for (const [modelId, model] of Object.entries(spec.models)) {
      it(`${providerId}/${modelId}`, () => {
        expect(model.modalities?.input, `${providerId}/${modelId} declares no modalities.input`).toBeDefined();
        expect(model.modalities!.input).toContain('image');
        expect(model.modalities!.input).toContain('text');
        // A model that takes a picture must also be allowed to be sent one.
        expect(model.attachment, `${providerId}/${modelId} is sighted but refuses attachments`).toBe(true);
      });
    }
  }
});
