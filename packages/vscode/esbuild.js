// Origami VS Code extension — esbuild config.
//
// Two builds, run in parallel (watch mode rebuilds on any change):
//   1. Extension host (TypeScript -> CJS, node platform)
//   2. Chat view      (Svelte -> IIFE, browser platform)
//
// The CHAT view (secondary side bar, top-right) carries the real ChatPane
// plus the embedded Settings (ControlStrip + theme). It imports
// shared/theme.css, so esbuild emits a sidecar out/webview/chat.css that the
// host links — that sidecar holds the :root[data-theme] palettes, which makes
// the themes repaint independent of the VS Code workbench theme. The old
// CONFIG (left activity-bar) view and the full-panel "dashboard" webview
// (App.svelte) were removed.

const esbuild = require('esbuild');
const sveltePlugin = require('esbuild-svelte');
const fs = require('node:fs');
const path = require('node:path');

const watch = process.argv.includes('--watch');

/** Extension host — TypeScript → out/extension.js (CJS; no "type":"module"
 *  in package.json, so a .js extension loads as CommonJS. vsce 2.x rejects
 *  a `.cjs` main, so the bundle is named .js per VS Code convention). */
const extensionOptions = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'out/extension.js',
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: watch ? true : 'external', // release: map written for local triage, no sourceMappingURL comment in the shipped file
  external: ['vscode'],
  minify: false,
  logLevel: 'info',
};

/** Shared Svelte webview build options (config + chat). `css: 'injected'`
 *  keeps component-scoped styles in the JS; the GLOBAL `import
 *  '../shared/theme.css'` in each main.ts is handled by esbuild's CSS
 *  loader and extracted to a sidecar `<outfile>.css` the host links. */
function svelteViewOptions(entry, outfile) {
  return {
    entryPoints: [entry],
    bundle: true,
    outfile,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    sourcemap: watch ? true : 'external',
    minify: false,
    logLevel: 'info',
    plugins: [
      sveltePlugin({
        compilerOptions: {
          css: 'injected',
        },
      }),
    ],
  };
}

/** CHAT view — Svelte → out/webview/chat.js (+ chat.css). */
const chatOptions = svelteViewOptions('webview/chat/main.ts', 'out/webview/chat.js');

/** PHONE SHELL — the Origami Remote static bundle, out/remote/*.
 *
 *  It is NOT a third view: it is a HOST for the chat view. remote.js installs
 *  an acquireVsCodeApi() shim that seals every postMessage into a wire frame,
 *  then loads the SAME out/webview/chat.js the VS Code panel loads. So the
 *  chat bundle is copied next to it rather than rebuilt — one bundle, two
 *  hosts, and no chance of the phone drifting from the desktop.
 *
 *  Plain TS/CSS, no Svelte plugin: the shell owns only a status strip and a
 *  PIN sheet, both hand-written in index.html.  makes
 *  esbuild emit the sidecar out/remote/remote.css, the same mechanism the
 *  chat view uses for its theme sidecar. */
const remoteOptions = {
  entryPoints: ['webview/remote/main.ts'],
  bundle: true,
  outfile: 'out/remote/remote.js',
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  // The relay serves this bundle to the open internet, so a release build
  // carries no source map and is minified. The map shipped every original
  // .ts file, comments included; the unminified bundle read as source.
  // Watch mode keeps both, so local debugging is unchanged.
  sourcemap: watch,
  minify: !watch,
  logLevel: 'info',
};

/** Static files the shell needs beside its bundle. The chat pair is copied
 *  from out/webview, so this must run AFTER the chat build. */
function copyRemoteStatics() {
  const out = path.join(__dirname, 'out', 'remote');
  fs.mkdirSync(out, { recursive: true });
  const copies = [
    ['webview/remote/index.html', 'index.html'],
    ['webview/remote/manifest.webmanifest', 'manifest.webmanifest'],
    ['out/webview/chat.js', 'chat.js'],
    ['out/webview/chat.css', 'chat.css'],
    ['media/icon.png', 'icon.png'],
  ];
  for (const [from, to] of copies) {
    const src = path.join(__dirname, from);
    if (!fs.existsSync(src)) throw new Error('[esbuild] remote shell is missing ' + from);
    fs.copyFileSync(src, path.join(out, to));
  }

  // chat.js is copied, not rebuilt, so it still carries the sourceMappingURL
  // of the map that stays behind in out/webview. Drop the line: the relay
  // serves this folder publicly and the map must never be fetchable.
  const chat = path.join(out, 'chat.js');
  const text = fs.readFileSync(chat, 'utf8');
  const marker = text.lastIndexOf('//# sourceMappingURL=');
  if (marker !== -1) fs.writeFileSync(chat, text.slice(0, marker).trimEnd());

  // This folder is BOTH the build output and the folder operators are told to
  // copy to the relay, which serves it to the open internet. A map here leaks
  // the original TypeScript, comments included — remote.js.map shipped that
  // way once (2026-09-12).
  //
  // Watch mode writes maps on purpose, so the check is release-only. That is
  // also what makes it useful: a map left behind by an earlier watch run is
  // not cleaned by anything, and would otherwise ride a later release build
  // out to the relay unnoticed. Here it stops the build instead.
  if (!watch) {
    const leaked = fs.readdirSync(out).filter((f) => f.endsWith('.map'));
    if (leaked.length) {
      throw new Error(
        '[esbuild] out/remote must not contain source maps: ' + leaked.join(', ') +
          ' — delete them (a watch build wrote them) and rebuild.',
      );
    }
  }
}

async function build() {
  if (watch) {
    const [extCtx, chatCtx, remoteCtx] = await Promise.all([
      esbuild.context(extensionOptions),
      esbuild.context(chatOptions),
      esbuild.context(remoteOptions),
    ]);
    await Promise.all([extCtx.watch(), chatCtx.watch(), remoteCtx.watch()]);
    // One-shot: the statics are copies, not builds, so a watch rebuild of
    // chat.js does NOT refresh out/remote/chat.js. Re-run a full build before
    // testing the phone shell against a chat change.
    copyRemoteStatics();
    console.log('[esbuild] watching extension + chat + remote for changes...');
  } else {
    await Promise.all([
      esbuild.build(extensionOptions),
      esbuild.build(chatOptions),
      esbuild.build(remoteOptions),
    ]);
    copyRemoteStatics();
    console.log(
      '[esbuild] build complete -> out/extension.js + out/webview/chat.js + out/remote/',
    );
  }
}

build().catch((err) => {
  console.error('[esbuild] build failed:', err);
  process.exit(1);
});
