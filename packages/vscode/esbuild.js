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
  sourcemap: true,
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
    sourcemap: true,
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

async function build() {
  if (watch) {
    const [extCtx, chatCtx] = await Promise.all([
      esbuild.context(extensionOptions),
      esbuild.context(chatOptions),
    ]);
    await Promise.all([extCtx.watch(), chatCtx.watch()]);
    console.log('[esbuild] watching extension + chat for changes...');
  } else {
    await Promise.all([
      esbuild.build(extensionOptions),
      esbuild.build(chatOptions),
    ]);
    console.log(
      '[esbuild] build complete -> out/extension.js + out/webview/chat.js',
    );
  }
}

build().catch((err) => {
  console.error('[esbuild] build failed:', err);
  process.exit(1);
});
