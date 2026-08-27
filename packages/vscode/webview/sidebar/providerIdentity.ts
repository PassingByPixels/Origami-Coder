// Pure id/name helpers for the Add/re-key picker, extracted out of
// ControlStrip.svelte (which sat over its architecture cap — see
// architecture.test.ts). No DOM, no vscode import: mirrors the
// providerGrid.ts / connectionSection.ts pattern of a leaf the component
// only calls into.

import { SETUP_PROVIDERS, type SetupProvider } from './setupCatalog';

/** URL-safe slug of a pill name, used as a fallback provider id. */
export function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** A pill NAME (the instance label) is separate from the provider TYPE (the
 *  template). Mint a fresh, unique id for a NEW connection so a 2nd vLLM /
 *  LM Studio coexists instead of clobbering the first. Singletons (OpenRouter
 *  / cloud, keyed by the host on a fixed id) always reuse the template id;
 *  the first local reuses it too (back-compat).
 *
 *  ADD-time only — a Re-key must never call this (it writes back to the
 *  provider's own existing id instead; see ControlStrip's reKeyProviderId). */
export function uniqueProviderId(template: SetupProvider, name: string, existingIds: Iterable<string>): string {
  if (template.keyOnly || template.kind === 'cloud') return template.id;
  const existing = new Set(existingIds);
  if (!existing.has(template.id)) return template.id;
  const base = slugify(name) || template.id;
  if (!existing.has(base)) return base;
  let n = 2;
  while (existing.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

/** The catalog id of the OAuth entry that signs into a configured provider —
 *  looked up rather than spelled out, so adding a third OAuth connection needs
 *  no change here. Falls back to the provider's own id (which opens its
 *  API-key form) if no OAuth entry claims it. */
export function oauthEntryFor(providerId: string): string {
  return SETUP_PROVIDERS.find(p => p.kind === 'oauth' && p.authProvider === providerId)?.id ?? providerId;
}

/** Does THIS submit intend to CLEAR the provider's stored API key?
 *
 *  Only one thing does: a RE-KEY (the form opened on an existing provider, so
 *  `reKeyProviderId` is set) submitted with the key field blank. A fresh Add
 *  with a blank key has nothing to clear, and every other writer of a provider
 *  block — the model pin, the lms swap, OAuth completion, the background
 *  adopts — sends no key because it has no business knowing one.
 *
 *  It is a SEPARATE signal for exactly that reason. 0.4.28 inferred the clear
 *  from the key being absent, which silently deleted the OpenRouter key on
 *  every model pin (firstFold.ts writeModelConfig carries the full account).
 *  Absence means "I am not touching the key"; this flag means "remove it". */
export function clearsStoredKey(reKeyProviderId: string, apiKeyField: string): boolean {
  return !!reKeyProviderId && !apiKeyField.trim();
}

/** Re-key's catalog lookup: the template whose FORM SHAPE to render for an
 *  existing configured provider's id. Falls back to the first catalog entry
 *  (LM Studio's local/localAuto shape) for an id that isn't itself a catalog
 *  id — a second/renamed local instance (e.g. a slugified 'vllm-2') — which
 *  is the right generic shape (base URL + optional key, no model field) for
 *  any self-hosted server. Re-key's caller pins the WRITE to the real id
 *  separately; this only decides which fields the form shows. */
export function reKeyTemplate(id: string): SetupProvider {
  return SETUP_PROVIDERS.find(p => p.id === id) ?? SETUP_PROVIDERS[0];
}

/** The raw form state a submit reads from. */
export interface SetupFormState {
  template: SetupProvider;
  /** The instance label, already defaulted to the template name. */
  name: string;
  /** The EXACT existing provider id a Re-key opened for; '' for a plain Add. */
  reKeyProviderId: string;
  /** Every configured provider id, so an Add can mint a non-colliding one. */
  existingIds: string[];
  baseURL: string;
  apiKey: string;
  modelId: string;
}

/** The `setupProvider` message body, minus its `type`. */
export interface SetupProviderPayload {
  providerId: string;
  providerName: string;
  npm?: string;
  baseURL?: string;
  apiKey: string;
  clearApiKey: boolean;
  modelId: string;
  modelName: string;
}

/**
 * Everything the Add / Re-key form decides, as a pure function — so the id,
 * key and model rules can be asserted without a DOM, and so ControlStrip.svelte
 * (at its architecture cap) carries the wiring only.
 */
export function setupProviderPayload(f: SetupFormState): SetupProviderPayload {
  const p = f.template;
  return {
    // A Re-key writes back to the EXACT provider it opened for; uniqueProviderId
    // (ADD-time only — mints a fresh id for a 2nd instance) must never run here.
    providerId: f.reKeyProviderId || uniqueProviderId(p, f.name, f.existingIds),
    providerName: f.name,
    npm: p.npm,
    // keyOnly (OpenRouter) → the fixed base URL; cloud omits it; else the entered one.
    baseURL: p.keyOnly ? p.baseURL : (p.kind === 'cloud' ? undefined : f.baseURL.trim()),
    // A self-hosted key is OPTIONAL: send whatever the field holds ('' when
    // untouched, which the host reads as "no key" and omits from the block).
    // This used to hard-code `undefined` for kind:'local', which is why a key
    // could never be set on LM Studio however the form looked.
    apiKey: f.apiKey.trim(),
    // …and a blank one REMOVES a stored key only when this is a Re-key, said
    // out loud rather than inferred host-side (clearsStoredKey above).
    clearApiKey: clearsStoredKey(f.reKeyProviderId, f.apiKey),
    // localAuto → blank, because the host reads the loaded model off the server.
    // Everything else sends whatever the form holds — which for a keyOnly preset
    // is its own default (or the user's pick from the live catalog).
    //
    // This used to blank keyOnly too, on the assumption that "the host auto-picks
    // it". The host only does that for OpenRouter, whose catalog it can price;
    // for any other keyOnly preset a blank arrived at the "needs a model id"
    // guard and the connection was silently dropped (t-o92558 round 4). Blanking
    // OpenRouter still happens — its preset model is '' — so its free-tier
    // auto-pick is untouched.
    modelId: p.localAuto ? '' : f.modelId.trim(),
    modelName: p.localAuto ? '' : f.modelId.trim(),
  };
}
