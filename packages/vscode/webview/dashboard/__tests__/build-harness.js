// build-harness.js — bundles screenshotHarness.ts (Svelte -> IIFE) the same
// way esbuild.js bundles the real chat view, so the harness renders the
// SAME compiled component code the extension ships, not a reimplementation.
// Output goes to out/harness/, which packages/vscode/.gitignore already
// excludes (out/) — this is throwaway build output, not a deliverable.
//
// Run from packages/vscode/: node webview/dashboard/__tests__/build-harness.js

const esbuild = require('esbuild');
const sveltePlugin = require('esbuild-svelte');
const fs = require('node:fs');
const path = require('node:path');

const outDir = path.join(__dirname, '..', '..', '..', 'out', 'harness');
fs.mkdirSync(outDir, { recursive: true });

esbuild
  .build({
    entryPoints: [path.join(__dirname, 'screenshotHarness.ts')],
    bundle: true,
    outfile: path.join(outDir, 'harness.js'),
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    sourcemap: false,
    minify: false,
    logLevel: 'info',
    plugins: [sveltePlugin({ compilerOptions: { css: 'injected' } })],
  })
  .then(() => {
    fs.copyFileSync(path.join(__dirname, 'screenshotHarness.html'), path.join(outDir, 'index.html'));
    console.log('[build-harness] out/harness/index.html + harness.js');
  })
  .catch((err) => {
    console.error('[build-harness] failed:', err);
    process.exit(1);
  });
