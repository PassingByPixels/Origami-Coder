// MIRROR DRIFT GUARD for the MCP wire — the house rule from
// docs/WORKING_ON_ORIGAMI_CODER.md Part 5: "every mirror needs a test that
// reads BOTH files and asserts they still agree."
//
// One server row is declared THREE times:
//
//   packages/engine/src/acp/mcp.ts            ServerEntry      (the producer)
//   packages/vscode/src/acpExtTypes.ts        McpServerEntry   (host side)
//   packages/vscode/webview/.../MCPPane.svelte  interface Server (webview side)
//
// The duplication is forced. `effect` and `@origami/core` are unresolvable
// from packages/vscode (this monorepo installs per package), and
// tsconfig.webview.json pins rootDir to `webview/`, so the webview cannot even
// `import type` from `src/`. Every copy is therefore hand-written, and TypeScript
// checks none of them against the engine.
//
// What the failure looks like without this guard: the engine renames
// `shadowed`, the pane keeps reading the old key, `undefined` is falsy, and
// EVERY server silently stops showing the override warning — the one thing the
// view exists to say. Nothing throws; nothing fails; the warning is just gone.
//
// The files are read as TEXT, which needs no module resolution and trips the
// moment a declaration moves.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const repoRoot = path.resolve(pkgRoot, '..', '..');

const engineMcp = readFileSync(path.join(repoRoot, 'packages/engine/src/acp/mcp.ts'), 'utf8');
const engineAgent = readFileSync(path.join(repoRoot, 'packages/engine/src/acp/agent.ts'), 'utf8');
const extTypes = readFileSync(path.join(pkgRoot, 'src/acpExtTypes.ts'), 'utf8');
const hostPane = readFileSync(path.join(pkgRoot, 'src/dashboard/mcpPane.ts'), 'utf8');
const webviewPane = readFileSync(path.join(pkgRoot, 'webview/dashboard/panes/MCPPane.svelte'), 'utf8');

/** The body of a `{ … }` declaration, bounded at the first closing brace that
 *  sits at the DECLARATION's own indent, so a later block cannot leak in. */
function body(src: string, header: string, indent: string): string {
  const start = src.indexOf(header);
  expect(start, `"${header}" not found — the declaration was renamed or restructured`).toBeGreaterThan(-1);
  const rest = src.slice(start + header.length);
  const end = rest.indexOf(`\n${indent}}`);
  expect(end, `no end found for "${header}"`).toBeGreaterThan(-1);
  return rest.slice(0, end);
}

/** Field names at one nesting level, comments and doc-blocks skipped. */
const fields = (block: string, indent: string): string[] =>
  [...block.matchAll(new RegExp(`^${indent}(?:readonly )?([A-Za-z_][\\w$]*)\\??:`, 'gm'))].map((m) => m[1]!).sort();

const engineFields = () => fields(body(engineMcp, 'export type ServerEntry = {', ''), '  ');
const extFields = () => fields(body(extTypes, 'export interface McpServerEntry {', ''), '  ');
const paneFields = () => fields(body(webviewPane, '  interface Server {', '  '), '    ');

describe('MCP wire shape — the three copies of one server row agree', () => {
  it('the extension host type declares exactly the fields the engine produces', () => {
    const engine = engineFields();
    // A parse that silently collected nothing would make every comparison
    // below vacuously true.
    expect(engine.length, 'no fields parsed — the extraction broke, not the mirror').toBeGreaterThan(5);
    expect(extFields()).toEqual(engine);
  });

  it('the webview pane declares exactly the same fields', () => {
    expect(paneFields()).toEqual(engineFields());
  });

  it('the fields this view is FOR are present in all three, by name', () => {
    // Agreement is worthless if all three drifted together, so pin the
    // contract too: `source` and `shadowed` are the merge rule made visible,
    // and `supportsOAuth`/`auth` gate the two OAuth buttons.
    for (const key of ['name', 'source', 'shadowed', 'type', 'enabled', 'status', 'supportsOAuth', 'auth']) {
      expect(engineFields(), `engine lost "${key}"`).toContain(key);
      expect(extFields(), `acpExtTypes lost "${key}"`).toContain(key);
      expect(paneFields(), `MCPPane lost "${key}"`).toContain(key);
    }
  });

  it('the status union the pane branches on is the one the engine can send', () => {
    // `statusClass`/`statusLabel` map these five to a pill. A sixth state
    // added engine-side would silently render as "not connected".
    const declared = [...engineMcp.matchAll(/status: MCP\.Status/g)];
    expect(declared.length, 'ServerEntry no longer carries MCP.Status').toBeGreaterThan(0);
    const union = readFileSync(path.join(repoRoot, 'packages/engine/src/mcp/index.ts'), 'utf8');
    const block = /export const Status = Schema\.Union\(\[([\s\S]*?)\]\)/.exec(union);
    expect(block, 'MCP.Status union not found in the engine').toBeTruthy();
    const members = [...block![1]!.matchAll(/Status([A-Za-z]+),/g)].map((m) => m[1]!);
    expect(members.length).toBe(5);
    for (const state of ['connected', 'disabled', 'failed', 'needs_auth', 'needs_client_registration']) {
      expect(webviewPane + extTypes, `nothing handles the "${state}" status`).toContain(state);
    }
  });
});

describe('MCP wire shape — the ext methods the host calls still exist engine-side', () => {
  it('every `mcp_*` method mcpPane.ts sends is a case in the engine ACP switch', () => {
    // The names are string LITERALS in mcpPane.ts — one at the `mcp_list`
    // read, the rest at each `write(host, 'mcp_…', …)` call, which all funnel
    // through one shared `extMethod(method, params)`.
    const called = [...new Set([...hostPane.matchAll(/'(mcp_[a-z_]+)'/g)].map((m) => m[1]!))];
    expect(called.length, 'no ext-method calls parsed — the extraction broke').toBeGreaterThan(5);
    for (const method of called) {
      // A renamed engine case would answer "method not found" at runtime and
      // nowhere else — no type connects these two files.
      expect(engineAgent, `the engine has no case for "${method}"`).toContain(`case "${method}":`);
    }
  });

  it('the notification the auth flow depends on is spelled the same on both sides', () => {
    // The engine PUSHES this; the client switches on it. A typo on either side
    // is a sign-in link that silently never appears.
    const acpClient = readFileSync(path.join(pkgRoot, 'src/acpClient.ts'), 'utf8');
    const service = readFileSync(path.join(repoRoot, 'packages/engine/src/acp/service.ts'), 'utf8');
    expect(service).toContain('"origami/mcpAuthUrl"');
    expect(acpClient).toContain("'origami/mcpAuthUrl'");
  });
});
