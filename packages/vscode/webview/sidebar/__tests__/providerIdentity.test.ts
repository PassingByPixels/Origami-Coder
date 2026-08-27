// The Add / Re-key form's decisions, as a pure leaf — no DOM, no component.
//
// This file exists because of the 0.4.28 OpenRouter incident. The rule "a blank
// key removes the stored key" was implemented HOST-side by inferring it from
// `apiKey` being absent, and absence is what the model pin, the lms swap, the
// OAuth completion and both background adopts all send. So every model switch
// silently deleted the user's OpenRouter key.
//
// The intent now travels as its own field, decided HERE — the only place that
// knows whether a submit is a Re-key of an existing provider or a fresh Add —
// and the writer removes a key on nothing else. Because it is a pure function,
// that rule is assertable without rendering anything.

import { describe, expect, it } from 'vitest';
import { clearsStoredKey, setupProviderPayload, uniqueProviderId, reKeyTemplate, slugify } from '../providerIdentity';
import { SETUP_PROVIDERS } from '../setupCatalog';

const template = (id: string) => SETUP_PROVIDERS.find(p => p.id === id)!;

/** The form state a submit reads, with the fields a test doesn't care about
 *  defaulted to what an untouched form holds. */
const form = (over: Partial<Parameters<typeof setupProviderPayload>[0]>) => setupProviderPayload({
  template: template('lmstudio'),
  name: 'LM Studio',
  reKeyProviderId: '',
  existingIds: [],
  baseURL: 'http://127.0.0.1:1234/v1',
  apiKey: '',
  modelId: '',
  ...over,
});

describe('clearsStoredKey — the ONLY thing that may remove a stored API key', () => {
  it('a RE-KEY submitted with a blank key clears it — the owner-commissioned behaviour', () => {
    expect(clearsStoredKey('lmstudio', '')).toBe(true);
  });

  it('whitespace is blank too — a spacebar in the field is not a key', () => {
    expect(clearsStoredKey('lmstudio', '   ')).toBe(true);
  });

  it('a RE-KEY with a real key REPLACES rather than clears', () => {
    expect(clearsStoredKey('lmstudio', 'sk-new')).toBe(false);
  });

  it('a fresh ADD with a blank key clears NOTHING — there is no stored key, and no provider was targeted', () => {
    expect(clearsStoredKey('', '')).toBe(false);
  });

  it('a fresh ADD with a key clears nothing either', () => {
    expect(clearsStoredKey('', 'sk-new')).toBe(false);
  });
});

describe('setupProviderPayload — the message the host writes from', () => {
  it('a Re-key blank submit says CLEAR out loud, and targets the provider it opened for', () => {
    const p = form({ reKeyProviderId: 'vllm-2', name: 'S2 - DGX Spark 2', apiKey: '' });
    expect(p.providerId).toBe('vllm-2');
    expect(p.apiKey).toBe('');
    expect(p.clearApiKey).toBe(true);
  });

  it('a Re-key with a typed key carries the key and NO clear', () => {
    const p = form({ reKeyProviderId: 'vllm-2', apiKey: '  spark2-secret  ' });
    expect(p.apiKey).toBe('spark2-secret');
    expect(p.clearApiKey).toBe(false);
  });

  it('a fresh ADD never asks for a clear, whatever the key field holds', () => {
    expect(form({ apiKey: '' }).clearApiKey).toBe(false);
    expect(form({ apiKey: 'sk-1' }).clearApiKey).toBe(false);
  });

  // --- the rules that moved here out of ControlStrip.svelte, unchanged --------

  it('an ADD mints a fresh id when the template id is taken; a Re-key never does', () => {
    expect(form({ name: 'S2 Spark', existingIds: ['lmstudio'] }).providerId).toBe('s2-spark');
    expect(form({ name: 'S2 Spark', existingIds: ['lmstudio'], reKeyProviderId: 'lmstudio' }).providerId).toBe('lmstudio');
  });

  it('keyOnly (OpenRouter) takes the FIXED base URL, not whatever the form holds', () => {
    const p = form({ template: template('openrouter'), baseURL: 'http://nonsense', apiKey: 'sk-or-1' });
    expect(p.baseURL).toBe('https://openrouter.ai/api/v1');
    expect(p.apiKey).toBe('sk-or-1');
  });

  it('a cloud provider sends NO base URL', () => {
    expect(form({ template: template('anthropic'), modelId: 'claude-sonnet-4-5' }).baseURL).toBeUndefined();
  });

  it('localAuto blanks the model — the host reads the loaded one off the server', () => {
    const p = form({ template: template('lmstudio'), modelId: 'typed-anyway' });
    expect(p.modelId).toBe('');
    expect(p.modelName).toBe('');
  });

  it('a non-localAuto preset sends the model it was given, trimmed', () => {
    const p = form({ template: template('opencode'), modelId: '  deepseek-v4-flash-free  ', apiKey: 'sk-zen' });
    expect(p.modelId).toBe('deepseek-v4-flash-free');
    expect(p.modelName).toBe('deepseek-v4-flash-free');
  });
});

// The two helpers the payload builder leans on, previously reachable only
// through a rendered component.
describe('the id helpers', () => {
  it('uniqueProviderId walks past collisions rather than clobbering an instance', () => {
    expect(uniqueProviderId(template('lmstudio'), 'Spark', ['lmstudio', 'spark'])).toBe('spark-2');
  });

  it('a keyOnly/cloud singleton always reuses its template id', () => {
    expect(uniqueProviderId(template('openrouter'), 'Anything', ['openrouter'])).toBe('openrouter');
  });

  it('reKeyTemplate falls back to the generic self-hosted shape for a minted id', () => {
    expect(reKeyTemplate('vllm-2').id).toBe('lmstudio');
    expect(reKeyTemplate('openrouter').id).toBe('openrouter');
  });

  it('slugify makes a URL-safe id out of a pill name', () => {
    expect(slugify('S2 - DGX Spark 2')).toBe('s2-dgx-spark-2');
  });
});
