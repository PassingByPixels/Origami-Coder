// MIRROR DRIFT GUARD — the house rule from docs/WORKING_ON_ORIGAMI_CODER.md
// Part 5: "every mirror needs a test that reads BOTH files and asserts they
// still agree."
//
// A Claude connection's DEFAULT MODEL ID is declared in three places:
//
//   webview/sidebar/setupCatalog.ts        the Add-picker entry's `model`
//   src/dashboard/anthropicCatalog.ts      CLAUDE_DEFAULT_MODEL + the family
//   src/dashboard/DashboardPanel.ts        /firstfold's QuickPick default
//
// The first two are forced apart by tsconfig.webview.json pinning rootDir to
// webview/ — the webview cannot import a runtime value out of src/. The third is
// a different entry point (the command palette flow) into the same connection.
//
// What drifts, and what it costs:
//   - the picker default is not in the baked family -> the connect writes the
//     chosen model as a bare `{name: <id>}` block sitting next to six fully
//     described siblings, so the model the user actually starts on is the one
//     with no window, no price and no capabilities. Silent: it only shows up as
//     compaction never firing and a spend readout of zero.
//   - /firstfold and the sidebar disagree -> two doors into one provider hand
//     the user different starting models, and only one of them was ever checked
//     against the engine's model catalog.
//
// The two modules are IMPORTED (real values, so a renamed field is a type error
// here). DashboardPanel.ts is regex-scraped, because it is a 6k-line vscode
// host file that cannot be imported into jsdom — and the scrape is guarded by an
// assertion that it matched at all, which is the failure mode a regex mirror has.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { SETUP_PROVIDERS } from '../setupCatalog';
import { CLAUDE_DEFAULT_MODEL, CLAUDE_MODELS } from '../../../src/dashboard/anthropicCatalog';

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const pickerModel = (): string | undefined => SETUP_PROVIDERS.find((p) => p.id === 'anthropic')?.model;

/** The `anthropic:` row of connectModelInteractive's `defaults` table. */
function firstFoldDefault(): string | null {
  const src = readFileSync(path.join(pkgRoot, 'src/dashboard/DashboardPanel.ts'), 'utf8');
  return src.match(/anthropic:\s*\{\s*name:\s*'[^']*',\s*model:\s*'([^']+)'\s*\}/)?.[1] ?? null;
}

describe('the Claude default model id agrees across all three declarations', () => {
  it('the scrape found /firstfold\'s table (guards a silently-passing mirror)', () => {
    expect(firstFoldDefault(), 'the DashboardPanel defaults regex matched nothing').toBeTruthy();
  });

  it('the Add-picker entry starts on the host table\'s default', () => {
    expect(pickerModel()).toBe(CLAUDE_DEFAULT_MODEL);
  });

  it('/firstfold\'s QuickPick starts on the same one', () => {
    expect(firstFoldDefault()).toBe(CLAUDE_DEFAULT_MODEL);
  });

  it('...and that default is a model the baked family actually describes', () => {
    // The load-bearing one: a default outside CLAUDE_MODELS is written with none
    // of the fields the other six carry.
    expect(Object.keys(CLAUDE_MODELS)).toContain(CLAUDE_DEFAULT_MODEL);
  });

  it('every baked id is a claude-* id — the table is the ANTHROPIC provider\'s', () => {
    // Cheap shape check against the class of typo (an OpenRouter-style
    // `anthropic/claude-…` slug) that would 404 on the first message: the
    // anthropic provider addresses its models by bare id.
    for (const id of Object.keys(CLAUDE_MODELS)) expect(id).toMatch(/^claude-[a-z0-9-]+$/);
  });
});
