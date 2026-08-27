// MIRROR DRIFT GUARD — the key-only provider facts are declared twice.
//
// tsconfig.webview.json pins rootDir to webview/, so ControlStrip.svelte cannot
// import a runtime value out of src/. The house pattern is to mirror the
// constant and guard it with a test that reads BOTH sides, which is what this is
// (same shape as repoMapPillars.test.ts).
//
// What drifts, and what it costs if nobody notices:
//   - a baseURL changed on one side  -> the form prefills one host and the key is
//     validated against another; the user is told their good key is bad.
//   - a default model changed on one side -> the form submits an id the host has
//     never heard of, or the host silently overwrites the user's visible choice.
//   - keylessCatalog set on one side only -> the form asks for a catalog the host
//     refuses to fetch, and the picker is permanently a single stale option.
//
// The src/ side is IMPORTED (it is a plain module with no vscode import); the
// webview side is parsed out of the .svelte source, because that is the only way
// to read a Svelte <script> constant without booting a component.

import { describe, expect, it } from 'vitest';
import { KEY_ONLY_PRESETS } from '../../../src/dashboard/keyOnlyPresets';
import { SETUP_PROVIDERS } from '../setupCatalog';

interface StripEntry {
  id: string;
  baseURL?: string;
  model: string;
  keyOnly: boolean;
  keylessCatalog: boolean;
}

/** The webview catalog, normalised to the shape this mirror compares.
 *
 *  IMPORTED now that the catalog is its own module (it used to be regex-scraped
 *  out of ControlStrip.svelte). The drift this file guards is unchanged — two
 *  hand-maintained tables, one under webview/ and one under src/, which the
 *  tsconfig rootDir split forbids sharing — but the webview side is now real
 *  values instead of a regex that could silently stop matching. */
function stripEntries(): StripEntry[] {
  return SETUP_PROVIDERS.map((p) => ({
    id: p.id,
    ...(p.baseURL !== undefined ? { baseURL: p.baseURL } : {}),
    model: p.model,
    keyOnly: p.keyOnly === true,
    keylessCatalog: p.keylessCatalog === true,
  }));
}

describe('key-only presets — the webview table and the host table agree', () => {
  const entries = stripEntries();

  it('the parser actually found the catalog (guards a silently-passing test)', () => {
    expect(entries.length).toBeGreaterThan(5);
    expect(entries.map((e) => e.id)).toContain('opencode');
  });

  it('every keyOnly entry in the form has a host-side preset', () => {
    const keyOnlyIds = entries.filter((e) => e.keyOnly).map((e) => e.id).sort();
    expect(keyOnlyIds).toEqual(Object.keys(KEY_ONLY_PRESETS).sort());
  });

  it('base URLs match, so the key is validated where the form said it would connect', () => {
    for (const e of entries.filter((x) => x.keyOnly)) {
      expect(e.baseURL, `${e.id} baseURL`).toBe(KEY_ONLY_PRESETS[e.id].baseURL);
    }
  });

  it('default model ids match, so the form submits what the host would have chosen', () => {
    for (const e of entries.filter((x) => x.keyOnly)) {
      expect(e.model, `${e.id} default model`).toBe(KEY_ONLY_PRESETS[e.id].defaultModel);
    }
  });

  it('keylessCatalog matches, so the picker is never asking for a list the host refuses', () => {
    for (const e of entries.filter((x) => x.keyOnly)) {
      expect(e.keylessCatalog, `${e.id} keylessCatalog`).toBe(KEY_ONLY_PRESETS[e.id].keylessCatalog);
    }
  });

  it('a keylessCatalog preset ships a non-empty default — a blank is the round-4 bug', () => {
    for (const e of entries.filter((x) => x.keylessCatalog)) {
      expect(e.model, `${e.id} must carry a fallback model id`).not.toBe('');
    }
  });
});
