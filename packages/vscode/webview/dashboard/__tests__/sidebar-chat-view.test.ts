// Split-surface GUI-identity gate — guard tests for the Codex/Claude-shaped
// two-container layout: a CONFIG view in the LEFT activity bar (setup) and
// a CHAT view in the SECONDARY side bar (top-right, the brand hero).
//
// These are NOT echo tests. Each breaks on a specific regression the split
// exists to prevent:
//   1. A `views` contribution whose id no provider registers → VS Code
//      raises an activation error ("no data provider registered").
//   2. A view declared as a `tree` instead of a real `webview` surface.
//   3. The secondary side bar container missing (the chat regressing back
//      into the left activity bar), or the engines floor not lifted to the
//      version that ships the stable `secondarySidebar` location.
//   4. A provider stubbed to a placeholder: scripts disabled, no resource
//      root, or never handing the webview to the real chat machinery
//      (DashboardPanel.resolveSharedView) → a dead view.
//   5. The shared-host fan-out (the single host driving BOTH views)
//      silently regressing to a 1:1 wire.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// vi.mock is hoisted above imports, so the shared captures live in a
// vi.hoisted block (also hoisted) the factories can safely close over.
const { joinPathCalls, resolveSharedView } = vi.hoisted(() => ({
  joinPathCalls: [] as unknown[][],
  resolveSharedView: vi.fn(
    async (host: unknown, _context?: unknown, _bundle?: unknown) => ({ __dashboard: true, host }),
  ),
}));

// --- vscode module mock (minimal surface the providers touch) ---
vi.mock('vscode', () => ({
  Uri: {
    joinPath: (...parts: unknown[]) => {
      joinPathCalls.push(parts);
      return { __uri: parts.join('/') };
    },
  },
  window: {
    showErrorMessage: vi.fn(),
  },
}));

// --- DashboardPanel mock: capture the host each provider builds, without
//     loading AcpClient (which would spawn origami-acp). ---
vi.mock('../../../src/dashboard/DashboardPanel', () => ({
  DashboardPanel: { resolveSharedView },
}));

import { ChatViewProvider } from '../../../src/sidebar/ChatViewProvider';

function makeFakeView() {
  const webview = {
    options: undefined as unknown,
    html: '',
    postMessage: vi.fn(),
    onDidReceiveMessage: vi.fn(() => ({ dispose() {} })),
    asWebviewUri: (u: unknown) => u,
    cspSource: 'vscode-resource:',
  };
  return {
    webview,
    onDidDispose: vi.fn(() => ({ dispose() {} })),
  };
}

const fakeContext = { extensionUri: { __uri: 'EXT' } } as never;

function readPkg(): {
  engines: { vscode: string };
  contributes: {
    viewsContainers: Record<string, Array<{ id: string; icon?: string }>>;
    views: Record<string, Array<{ id: string; type?: string }>>;
    commands: Array<{ command: string; icon?: string | { light: string; dark: string } }>;
    menus: Record<string, Array<{ command: string; when?: string; group?: string }>>;
    keybindings: Array<{ command: string; key?: string; mac?: string }>;
    themes: Array<{ label: string; uiTheme: string; path: string }>;
  };
} {
  return JSON.parse(
    readFileSync(join(__dirname, '..', '..', '..', 'package.json'), 'utf-8'),
  );
}

describe('package.json — split surfaces (config + chat)', () => {
  it('engines floor lifted to ^1.106.0 (required for the stable secondarySidebar location)', () => {
    expect(readPkg().engines.vscode).toBe('^1.106.0');
  });

  it('has NO left activity-bar Setup view (removed — settings live in the right sidebar)', () => {
    const pkg = readPkg();
    const activitybar = pkg.contributes.viewsContainers.activitybar ?? [];
    expect(activitybar.find((c) => c.id === 'origami-config')).toBeUndefined();
    expect(pkg.contributes.views['origami-config']).toBeUndefined();
  });

  it('CHAT container lives in the secondary side bar with the crane icon + the chatView', () => {
    const pkg = readPkg();
    const chatContainer = pkg.contributes.viewsContainers.secondarySidebar?.find(
      (c) => c.id === 'origami-chat',
    );
    // The crane is the chat brand hero, top-right.
    expect(chatContainer).toBeDefined();
    expect(chatContainer?.icon).toBe('media/origami-icon.svg');
    const views = pkg.contributes.views['origami-chat'];
    const chat = views.find((v) => v.id === ChatViewProvider.viewId);
    expect(chat).toBeDefined();
    expect(chat?.type).toBe('webview');
  });

  it('Open Chat is reachable from the command palette + a non-colliding keybinding', () => {
    const pkg = readPkg();
    // The command exists (it focuses origami.chatView in extension.ts).
    expect(pkg.contributes.commands.some((c) => c.command === 'origami.openChat')).toBe(true);

    // It is surfaced in the command palette so "Origami: Open Chat" is typeable.
    const palItem = pkg.contributes.menus.commandPalette?.find(
      (m) => m.command === 'origami.openChat',
    );
    expect(palItem).toBeDefined();

    // It has a keybinding...
    const kb = pkg.contributes.keybindings.find((k) => k.command === 'origami.openChat');
    expect(kb).toBeDefined();
    expect(kb?.key).toBeTruthy();
    expect(kb?.mac).toBeTruthy();

    // ...and that chord must NOT collide with any other origami keybinding
    // (toggleSidebar ctrl+shift+l / newSession ctrl+shift+n / switchModel
    // ctrl+shift+m). A duplicate key would make one command unreachable.
    const sameKey = pkg.contributes.keybindings.filter((k) => k.key === kb?.key);
    expect(sameKey).toHaveLength(1);
    expect(sameKey[0].command).toBe('origami.openChat');
  });

  it('a New Chat (+) command is gated to the chat view title bar', () => {
    const pkg = readPkg();
    // The command must exist...
    expect(pkg.contributes.commands.some((c) => c.command === 'origami.newChat')).toBe(true);
    // ...and be surfaced in the chat view's title bar navigation group only.
    const item = pkg.contributes.menus['view/title']?.find(
      (m) => m.command === 'origami.newChat',
    );
    expect(item).toBeDefined();
    expect(item?.when).toBe('view == origami.chatView');
    expect(item?.group).toBe('navigation');
  });

  // #1 — the editor-title crane LAUNCHER must use a {light,dark} icon pair
  // (editor-title icons render in the AUTHOR's colours, not masked), so the
  // crane is visible on both backgrounds rather than the near-black
  // currentColor silhouette it regressed to.
  it('Open Chat launcher uses a {light,dark} crane icon pair (not currentColor)', () => {
    const pkg = readPkg();
    const cmd = pkg.contributes.commands.find((c) => c.command === 'origami.openChat');
    expect(cmd).toBeDefined();
    const icon = cmd?.icon;
    // Must be the object form, not a single masked SVG path.
    expect(typeof icon).toBe('object');
    const pair = icon as { light: string; dark: string };
    expect(pair.light).toBe('media/origami-icon-light.svg');
    expect(pair.dark).toBe('media/origami-icon-dark.svg');
    // The two variants must be distinct files (distinct fills).
    expect(pair.light).not.toBe(pair.dark);
    // Both files exist and carry an EXPLICIT hex fill (NOT currentColor),
    // sharing the same crane polygon geometry.
    const mediaDir = join(__dirname, '..', '..', '..', 'media');
    const lightSvg = readFileSync(join(mediaDir, 'origami-icon-light.svg'), 'utf-8');
    const darkSvg = readFileSync(join(mediaDir, 'origami-icon-dark.svg'), 'utf-8');
    expect(lightSvg).not.toMatch(/fill="currentColor"/);
    expect(darkSvg).not.toMatch(/fill="currentColor"/);
    expect(lightSvg).toMatch(/fill="#[0-9a-fA-F]{6}"/);
    expect(darkSvg).toMatch(/fill="#[0-9a-fA-F]{6}"/);
    // Same crane geometry as the masked container icon (one of the wing
    // polygons is load-bearing proof they are the same mark).
    expect(lightSvg).toContain('points="44,40 62,29 47,48"');
    expect(darkSvg).toContain('points="44,40 62,29 47,48"');
  });

  // The fixed Origami palettes must ship as contributed VS Code workbench
  // colour themes so Midnight takes over the full workbench like Dark + Quiet.
  // ('custom' is webview-only — no workbench contribution.)
  it('contributes the fixed workbench themes (Meadow/Harbour/Ember/Midnight, valid JSON)', () => {
    const pkg = readPkg();
    const labels = pkg.contributes.themes.map((t) => t.label);
    expect(labels).toContain('Origami Meadow');
    expect(labels).toContain('Origami Harbour');
    expect(labels).toContain('Origami Ember');
    expect(labels).toContain('Origami Midnight');
    expect(labels).not.toContain('Origami Lilac');
    expect(labels).not.toContain('Origami Quiet');

    // Each contributed theme path resolves to a file that parses as valid
    // JSON with the expected name (no BOM, complete theme).
    const root = join(__dirname, '..', '..', '..');
    for (const t of pkg.contributes.themes) {
      const raw = readFileSync(join(root, t.path), 'utf-8');
      // No BOM byte at the head.
      expect(raw.charCodeAt(0)).not.toBe(0xfeff);
      const parsed = JSON.parse(raw) as { name: string; colors: Record<string, string> };
      expect(parsed.name).toBe(t.label);
      // A complete theme carries the editor background key.
      expect(parsed.colors['editor.background']).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
  });

  // The Midnight theme JSON must mirror the in-panel --og-* palette
  // (theme.css) so panel + workbench agree, not arbitrary colours.
  it('Midnight theme JSON matches the theme.css panel palette', () => {
    const root = join(__dirname, '..', '..', '..');
    const midnight = JSON.parse(
      readFileSync(join(root, 'media', 'themes', 'origami-midnight.json'), 'utf-8'),
    ) as { colors: Record<string, string> };
    // Midnight bg = --og-bg #07091a; fg = --og-text #c8c8e0 (theme.css).
    expect(midnight.colors['editor.background']).toBe('#07091a');
    expect(midnight.colors['editor.foreground']).toBe('#c8c8e0');
  });
});

describe('ChatViewProvider — chat view wiring (shared host)', () => {
  beforeEach(() => {
    joinPathCalls.length = 0;
    resolveSharedView.mockClear();
  });

  it('enables scripts + roots the webview at out/webview', async () => {
    const provider = new ChatViewProvider(fakeContext);
    const view = makeFakeView();
    await provider.resolveWebviewView(view as never, {} as never, {} as never);
    const opts = view.webview.options as { enableScripts?: boolean; localResourceRoots?: unknown[] };
    expect(opts.enableScripts).toBe(true);
    expect(Array.isArray(opts.localResourceRoots)).toBe(true);
    expect(joinPathCalls.some((c) => c.includes('out') && c.includes('webview'))).toBe(true);
  });

  it('hands the REAL webview to resolveSharedView with the CHAT bundle', async () => {
    const provider = new ChatViewProvider(fakeContext);
    const view = makeFakeView();
    await provider.resolveWebviewView(view as never, {} as never, {} as never);
    expect(resolveSharedView).toHaveBeenCalledTimes(1);
    const host = resolveSharedView.mock.calls[0][0] as { webview: unknown; reveal: () => void; dispose: () => void };
    expect(host.webview).toBe(view.webview);
    expect(typeof host.reveal).toBe('function');
    expect(typeof host.dispose).toBe('function');
    // The bundle discriminant must be 'chat' so the chat shell (ChatView)
    // is rendered, not config.
    expect(resolveSharedView.mock.calls[0][2]).toBe('chat');
  });
});


// Source-level mutation guards on DashboardPanel: the bundle-name
// selection must branch to config.js / chat.js, the per-bundle CSS sidecar
// must be linked (the NOTE A theme fix), and the shared-host fan-out must
// post to more than the single primary wire.
describe('DashboardPanel — bundle selection, theme sidecar, shared-host fan-out', () => {
  const src = readFileSync(
    join(__dirname, '..', '..', '..', 'src', 'dashboard', 'DashboardPanel.ts'),
    'utf-8',
  );

  it('selects the config + chat bundles by discriminant', () => {
    expect(src).toMatch(/bundle === 'config'\s*\?\s*'config'/);
    expect(src).toMatch(/bundle === 'chat'\s*\?\s*'chat'/);
    expect(src).toMatch(/`\$\{bundleName\}\.js`/);
  });

  it('links the per-bundle CSS sidecar (NOTE A: the four data-theme palettes load independent of the workbench)', () => {
    // Without this <link> the --og-* vars are undefined and Midnight/Lilac
    // never repaint. The sidecar is named `${bundleName}.css`.
    expect(src).toMatch(/`\$\{bundleName\}\.css`/);
  });

  it('fans out post() to the primary host AND attached extra views (no 1:1 regression)', () => {
    // The broadcast must target a list that includes the extra views, not
    // just this.panel.webview, so config + chat agree on status.
    expect(src).toMatch(/this\.panel\.webview\s*,\s*\.\.\.this\.extraViews/);
  });

  // The host workbenchThemes map must cover the fixed brand themes (meadow/
  // harbour/ember/midnight) so the workbench sync follows them. 'custom' maps
  // too (the ThemeEditor rewrites it); lilac/quiet are gone.
  it('workbenchThemes map covers the fixed themes (meadow/harbour/ember/midnight), not lilac/quiet', () => {
    // Isolate the map literal so we assert against the sync table, not a
    // stray mention elsewhere.
    const map = src.match(/const workbenchThemes:[^;]*?\{([\s\S]*?)\}/);
    expect(map).not.toBeNull();
    const body = map![1];
    expect(body).toMatch(/meadow:\s*'Origami Meadow'/);
    expect(body).toMatch(/harbour:\s*'Origami Harbour'/);
    expect(body).toMatch(/ember:\s*'Origami Ember'/);
    expect(body).toMatch(/midnight:\s*'Origami Midnight'/);
    expect(body).not.toMatch(/lilac/);
    expect(body).not.toMatch(/quiet:/);
  });

  // #4 — attachView must REPLAY existing sessions to a freshly-attached
  // view (not just broadcastModelStatus), so a chat view that attaches
  // AFTER the host bootstrapped the session sees the ChatPane + empty-state
  // instead of the bare "No session" stub.
  it('attachView replays existing sessions to the newly-attached view', () => {
    // attachView calls a per-view replay helper...
    expect(src).toMatch(/attachView[\s\S]*?this\.replaySessionsTo\(host\.webview\)/);
    // ...and that helper re-posts sessionCreated for each existing session.
    expect(src).toMatch(/replaySessionsTo[\s\S]*?type:\s*'sessionCreated'/);
    // ...scoped to ONE webview (postTo), not the broadcast fan-out.
    expect(src).toMatch(/private postTo\(webview: vscode\.Webview/);
  });

  // #3 — addSession must create an ADDITIONAL concurrent session on the
  // live host (not silently no-op), so repeated new-chat spawns instances.
  it('addSession creates an additional session on the live host', () => {
    expect(src).toMatch(/static async addSession[\s\S]*?DashboardPanel\.current\.createSession\(\)/);
  });

  // t-q41knp — the mount-time `sessionList` reply (requestSessions) is the
  // ONE recovery path for a `requestPermission` posted before the sidebar's
  // listener was ready (the same "missed the bootstrap fan-out" race the
  // handshake already exists to patch, for a session's existence). Without
  // `pendingAskIds` that ask is lost forever — the ring can never learn a
  // session is waiting on the user. Both emission sites (the handshake reply
  // and the reorder echo) must carry it, or a launcher that (re)mounts after
  // either one still misses an open ask.
  it('requestSessions carries each session\'s pending ask ids, not just its identity', () => {
    expect(src).toMatch(/case 'requestSessions':[\s\S]*?pendingAskIds:\s*Array\.from\(s\.pendingPermissions\.keys\(\)\)[\s\S]*?type:\s*'sessionList'/);
  });

  it('the reorderSessions echo also carries pending ask ids, not just the settled order', () => {
    expect(src).toMatch(/case 'reorderSessions':[\s\S]*?type:\s*'sessionList'[\s\S]*?pendingAskIds:\s*Array\.from\(s\.pendingPermissions\.keys\(\)\)/);
  });
});
