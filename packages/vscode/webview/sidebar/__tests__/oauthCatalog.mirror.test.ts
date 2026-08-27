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
const codexPath = path.resolve(here, '..', '..', '..', '..', 'engine', 'src', 'plugin', 'openai', 'codex.ts');

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

  it('the openai catalog is EXACTLY the engine allowlist — no more, no less', () => {
    // Fewer: a model the user can never reach through the picker.
    // More: a block whose very first message fails, which is what happened.
    expect(Object.keys(OAUTH_PROVIDERS['openai'].models).sort()).toEqual(allowedModels().sort());
  });

  it('gpt-5.3-codex-spark is gone from BOTH sides and stays gone', () => {
    expect(allowedModels()).not.toContain('gpt-5.3-codex-spark');
    expect(Object.keys(OAUTH_PROVIDERS['openai'].models)).not.toContain('gpt-5.3-codex-spark');
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
