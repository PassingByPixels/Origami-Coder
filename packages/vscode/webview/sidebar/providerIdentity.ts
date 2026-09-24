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

/** A pill name (the instance label) is separate from the provider type (the
 *  template). Mint a fresh, unique id for a new connection so a 2nd vLLM /
 *  LM Studio coexists instead of clobbering the first. Singletons always
 *  reuse the template id. Add-time only — a Re-key writes back to the
 *  provider's own existing id instead. */
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

/** Does this submit intend to clear the provider's stored API key? Only one
 *  thing does: a re-key submitted with the key field blank. A fresh Add with
 *  a blank key has nothing to clear, and every other writer of a provider
 *  block sends no key because it has no business knowing one. A separate
 *  signal, not inferred: absence means "not touching the key", this flag
 *  means "remove it". */
export function clearsStoredKey(reKeyProviderId: string, apiKeyField: string): boolean {
  return !!reKeyProviderId && !apiKeyField.trim();
}

/** Re-key's catalog lookup: the template whose form shape to render for an
 *  existing configured provider's id. Falls back to the first catalog entry
 *  for an id that isn't itself a catalog id (a renamed local instance),
 *  which is the right generic shape for any self-hosted server. */
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

/** Everything the Add / Re-key form decides, as a pure function, so the id,
 *  key and model rules can be asserted without a DOM. */
export function setupProviderPayload(f: SetupFormState): SetupProviderPayload {
  const p = f.template;
  return {
    // A Re-key writes back to the exact provider it opened for; uniqueProviderId is Add-time only.
    providerId: f.reKeyProviderId || uniqueProviderId(p, f.name, f.existingIds),
    providerName: f.name,
    npm: p.npm,
    // keyOnly (OpenRouter) -> the fixed base URL; cloud omits it; else the entered one.
    baseURL: p.keyOnly ? p.baseURL : (p.kind === 'cloud' ? undefined : f.baseURL.trim()),
    // A self-hosted key is optional: send whatever the field holds ('' when
    // untouched, read by the host as "no key").
    apiKey: f.apiKey.trim(),
    // A blank one removes a stored key only when this is a Re-key, said out
    // loud rather than inferred host-side.
    clearApiKey: clearsStoredKey(f.reKeyProviderId, f.apiKey),
    // localAuto -> blank, since the host reads the loaded model off the
    // server. Everything else sends whatever the form holds. OpenRouter's
    // preset model is also '' so its free-tier auto-pick is untouched; any
    // other keyOnly preset needs a real model id or the connection is dropped.
    modelId: p.localAuto ? '' : f.modelId.trim(),
    modelName: p.localAuto ? '' : f.modelId.trim(),
  };
}
