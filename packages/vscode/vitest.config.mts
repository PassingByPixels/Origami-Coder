// Pillar J (iter-25.15, snappy-dragon plan) — vitest + jsdom +
// @sveltejs/vite-plugin-svelte. Lets webview component tests render
// real Svelte components into a jsdom DOM and query/assert against
// them without booting a full VS Code extension host.
//
// The dashboard's production build (esbuild → IIFE bundles in
// out/webview/) is unchanged; vitest imports .svelte files directly
// via the vite plugin, bypassing esbuild entirely for the test path.

import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';
import { transformWithEsbuild } from 'vite';
import { fileURLToPath } from 'node:url';

// Explicit esbuild TS-stripping for <script lang="ts">. With vite-plugin-svelte
// v4 + Svelte 5.56, neither the compiler's native stripping nor vitePreprocess()
// removed the type annotations for the vite-node SSR path, so `?:` survived into
// the compiled module and vite's ssrTransform (rollup parseAst) died with
// "Expected ',', got '?'", silently collecting 0 tests from every suite that
// renders a component. esbuild strips deterministically, regardless of version.
const tsScript = {
  name: 'vitest-esbuild-ts-script',
  script: async ({ content, attributes, filename }: {
    content: string;
    attributes: Record<string, string | boolean>;
    filename?: string;
  }) => {
    if (attributes.lang !== 'ts') return;
    const { code, map } = await transformWithEsbuild(
      content,
      filename ?? 'component.svelte.ts',
      {
        loader: 'ts',
        target: 'esnext',
        // verbatimModuleSyntax keeps every value import verbatim. Without it,
        // esbuild drops imports that look unused in the isolated <script> —
        // but component imports (ConfirmModal, SidebarLauncher, …) are only
        // referenced in the Svelte *template*, which esbuild can't see, so
        // they'd vanish and render as "X is not defined". Type-only imports
        // must use `import type` (the codebase already does).
        tsconfigRaw: { compilerOptions: { verbatimModuleSyntax: true } },
      },
    );
    return { code, map };
  },
};

export default defineConfig({
  plugins: [svelte({ hot: false, preprocess: [tsScript] })],
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['webview/**/*.test.{ts,svelte.test.ts}'],
    // realConfigGuard FIRST: it captures the real os.homedir() and patches the
    // fs write calls before any test module loads, which is the only point at
    // which both are still the genuine ones. See its header for the 2026-08-15
    // incident it exists to make impossible.
    setupFiles: [
      './webview/dashboard/__tests__/realConfigGuard.ts',
      './webview/dashboard/__tests__/setup.ts',
    ],
  },
  resolve: {
    // Vitest needs the browser condition to resolve svelte's
    // client-side entry points instead of the SSR ones.
    conditions: ['browser'],
    alias: {
      // The `vscode` module only exists inside a real extension host.
      // Alias it to a resolvable stub so vite's import-analysis can load
      // extension-host (src/) modules under test; behaviour is supplied
      // per-test via vi.mock('vscode', ...). No production code path uses
      // this alias (esbuild marks vscode external).
      vscode: fileURLToPath(
        new URL('./webview/dashboard/__tests__/vscode-stub.ts', import.meta.url),
      ),
    },
  },
});
