// The "Add / re-key a provider" flow, extracted whole out of DashboardPanel.ts's
// message switch (t-o92558 round 4). Dependency-injected exactly like
// connectOllama.ts: no vscode import, no direct network, no disk — the panel
// wires the real validator / catalog fetchers / writer / broadcaster in, and a
// test wires fakes. That is what makes "a Zen key with only a key pasted ends up
// written" an assertable fact instead of something only a human can see.
//
// It was extracted rather than patched in place because DashboardPanel.ts sat
// EXACTLY on its 6334-line cap, and the house rule is extract-before-raise. The
// flow is also the single thing this ticket is about, so it earns its own file.
//
// SHAPE OF THE FLOW, and where it used to go wrong:
//
//   key-only preset (OpenRouter / OpenCode Zen / Go)
//     -> validate the key against THAT preset's own host (keyOnlyPresets.ts)
//     -> fill the model: OpenRouter auto-picks from its keyed catalog, the Zen
//        family takes whatever the add form chose, else the preset default
//   local endpoint (no key, a base URL, no model)
//     -> auto-pick the first loaded model, refusing to write a dead server
//   everything else keeps the model id the form supplied
//
// The old code did step one ONLY for `providerId === 'openrouter'`, so every
// other key-only preset skipped validation entirely and then died on the
// "needs a model id" guard with nothing written.

import { claudeCatalogFor } from './anthropicCatalog';
import { KEY_ONLY_PRESETS, checkProviderKey, keyRejectedMessage } from './keyOnlyPresets';
import { isSelfHostedBaseUrl } from './selfHosted';
import type { ModelChoice } from './firstFold';

/** The pricing-bearing catalog entry the OpenRouter path works in. */
export interface CatalogModel {
  id: string;
  name: string;
  free: boolean;
  cost?: { input: number; output: number };
}

/** The `setupProvider` message as the ControlStrip posts it. The index signature
 *  is what lets the panel hand its raw switch value straight in — every field is
 *  `unknown` and coerced below, so an extra key from a future form is harmless. */
export interface SetupProviderMessage {
  [k: string]: unknown;
  providerId?: unknown;
  providerName?: unknown;
  npm?: unknown;
  baseURL?: unknown;
  apiKey?: unknown;
  clearApiKey?: unknown; // Re-key's blank submit only — providerIdentity.clearsStoredKey
  modelId?: unknown;
  modelName?: unknown;
}

export interface SetupProviderDeps {
  /** The chat session the system/error lines target. */
  sessionId: string;
  msg: SetupProviderMessage;
  /** Injected so this file carries no network import. */
  fetchImpl: typeof fetch;
  /** List a local OpenAI-compatible server's model ids (fetchLmStudioModels).
   *  `apiKey` is optional and usually absent — a self-hosted server that DOES
   *  enforce auth needs it, or the probe 401s and the connection is refused for
   *  "no model loaded" while the server is perfectly healthy. */
  fetchLocalModels: (baseURL: string, apiKey?: string) => Promise<string[]>;
  /** The window this server reports for one model (fetchModelInfo) — see ModelChoice.servedContext. */
  fetchModelWindow?: (baseURL: string, modelId: string, apiKey?: string) => Promise<number>;
  /** OpenRouter's catalog WITH pricing (fetchOpenRouterModels). */
  fetchCatalog: (apiKey: string, baseURL: string) => Promise<CatalogModel[]>;
  /** Hand the freshly-fetched OpenRouter catalog back for the panel's cache. */
  cacheCatalog: (models: CatalogModel[]) => void;
  /** Per-million pricing for an already-known OpenRouter model id. */
  costFor: (modelId: string) => Promise<{ input: number; output: number } | undefined>;
  /** The shared config writer (writeModelConfig). */
  write: (choice: ModelChoice) => { path: string; model: string };
  /** Post a webview message (system / error lines). */
  post: (m: object) => void;
  /** Bust this provider's status cache + re-broadcast, so its pill appears now. */
  refresh: (providerId: string) => void;
  /** Optional host toast offering a window reload (skipped in tests). */
  notifyReload?: (providerName: string, model: string) => void;
  /** Optional host ERROR toast. `post` targets a chat session, and from the
   *  CONFIG view none may be visible — a refused key then read as "nothing
   *  happened" (owner-hit 2026-08-21). Every failure exit calls this too. */
  notifyError?: (message: string) => void;
}

export async function setupProvider(d: SetupProviderDeps): Promise<void> {
  const { msg: m, post, sessionId: sid } = d;
  // A failure is told twice on purpose: transcript line + always-visible toast.
  const fail = (message: string): void => {
    post({ type: 'error', message, sessionId: sid });
    d.notifyError?.(message);
  };
  try {
    const providerId = String(m.providerId ?? '').trim();
    let modelId = String(m.modelId ?? '').trim();
    let modelName = String(m.modelName ?? modelId);
    let baseURL = m.baseURL ? String(m.baseURL) : undefined;
    const apiKey = m.apiKey ? String(m.apiKey) : undefined;
    // Pricing (per-million USD) for the chosen model, persisted so the engine
    // computes real spend. Populated for OpenRouter below; undefined otherwise.
    let choiceCost: { input: number; output: number } | undefined;
    if (!providerId) {
      fail('Provider setup needs a provider.');
      return;
    }

    // KEY-ONLY PRESETS ("the rest is handled"). The key is validated live
    // against the preset's OWN base URL before anything is written — a rejected
    // key never lands in origami.json — and a refusal is worded with the
    // preset's own name.
    const preset = KEY_ONLY_PRESETS[providerId];
    if (preset) {
      baseURL = baseURL || preset.baseURL;
      if (!apiKey) {
        fail(`${preset.name} needs an API key.`);
        return;
      }
      post({ type: 'system', text: `Validating ${preset.name} key…`, sessionId: sid });
      const v = await checkProviderKey({
        presetId: providerId,
        apiKey,
        baseURL,
        // Validate against the model that is actually about to be written, so a
        // model the key cannot reach is caught here rather than on turn one.
        model: modelId || preset.defaultModel,
        fetchImpl: d.fetchImpl,
      });
      if (!v.ok) {
        fail(keyRejectedMessage(preset.name, v));
        return;
      }
      if (!modelId) {
        if (preset.defaultModel) {
          // The preset ships a real default (the Zen family), so the form always
          // had something to submit; this is the belt-and-braces path for a
          // caller that posted no model at all.
          modelId = preset.defaultModel;
          modelName = modelId;
        } else {
          // OpenRouter: no default, because the right first model depends on the
          // key's tier. Auto-pick a free one on a free-tier key so the first
          // message works, and cache the priced catalog for the picker.
          const models = await d.fetchCatalog(apiKey, baseURL);
          d.cacheCatalog(models);
          const free = models.find(x => x.free);
          const pick = (v.freeTier && free) ? free : (models.find(x => x.id === 'x-ai/grok-4') ?? free ?? models[0]);
          modelId = pick?.id ?? 'x-ai/grok-4';
          modelName = pick?.name ?? modelId;
          choiceCost = pick?.cost;
        }
      } else if (providerId === 'openrouter') {
        choiceCost = await d.costFor(modelId);
      }
      post({
        type: 'system',
        text: `${preset.name} key valid${v.freeTier ? ' (free tier)' : ''}${v.label ? ` — ${v.label}` : ''}.`,
        sessionId: sid,
      });
    }

    // LM Studio / a self-hosted endpoint: the setup is ENDPOINT-ONLY (the active
    // model is chosen in the chat pane). Auto-pick the first loaded model as the
    // provider's default so a config block can be written.
    //
    // THE GATE IS "IS THIS SELF-HOSTED?", NOT "IS THIS KEYLESS?". It used to be
    // `!apiKey && baseURL && !modelId`, which quietly made a key and auto-pick
    // mutually exclusive: a key arriving with a blank model skipped this probe and
    // fell into the "needs a model id" guard below, writing nothing — precisely
    // the shape a keyed LM Studio submits, so optional keys could not work at all.
    // isSelfHostedBaseUrl is the same predicate the picker groups on
    // (selfHosted.ts), so section and flow can never disagree. A REMOTE compat
    // endpoint is still refused without a model id: the probe is node:http-only
    // and cannot reach an https gateway, so guessing would only confuse the error.
    if (baseURL && !modelId && isSelfHostedBaseUrl(baseURL)) {
      const ids = await d.fetchLocalModels(baseURL, apiKey);
      if (ids.length === 0) {
        fail(`No model loaded at ${baseURL} — load one in LM Studio, then Connect. Nothing was saved.`);
        return;
      }
      modelId = ids[0];
      modelName = ids[0];
    }

    if (!modelId) {
      fail('Provider setup needs a model id.');
      return;
    }

    const choice: ModelChoice = {
      providerId,
      providerName: String(m.providerName ?? providerId),
      npm: m.npm ? String(m.npm) : undefined,
      baseURL,
      apiKey,
      clearApiKey: m.clearApiKey === true, // carried, never inferred — see writeModelConfig
      modelId,
      modelName,
      cost: choiceCost,
      // SELF-HOSTED ONLY: a gateway's window is refreshModelInfoFor's policy call
      // (unpersisted). A failed probe degrades to 0 — it must never fail the connect.
      servedContext: baseURL && isSelfHostedBaseUrl(baseURL) ? await d.fetchModelWindow?.(baseURL, modelId, apiKey).catch(() => 0) : 0,
      catalog: claudeCatalogFor(providerId), // the rest of the family — see anthropicCatalog.ts
    };
    const written = d.write(choice);
    // Light the pill up immediately — bust the cache for the just-connected
    // provider so it re-probes and shows now, not after the TTL.
    d.refresh(providerId);
    post({ type: 'system', text: `${choice.providerName} connected — model ${written.model} (saved to your global origami.json).`, sessionId: sid });
    d.notifyReload?.(choice.providerName, written.model);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    fail(`Provider setup failed: ${message}`);
  }
}
