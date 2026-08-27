// Dead-export detection (pattern from Kilo Code's CI). The svelte "compiler"
// is the knip-documented lightweight approach: extract import statements so
// exports consumed only from .svelte files are not false-flagged (that
// exactly bit scoreInboxMatch on the first configuration attempt).
import type { KnipConfig } from 'knip';

const config: KnipConfig = {
  entry: ['webview/*/main.ts', '**/*.test.ts', 'webview/**/__tests__/**'],
  project: ['src/**/*.ts', 'webview/**/*.{ts,svelte}'],
  // Ambient type declarations have no importers by design.
  ignore: ['webview/global.d.ts'],
  ignoreExportsUsedInFile: true,
  ignoreDependencies: ['@types/vscode'],
  compilers: {
    svelte: (text: string) => [...text.matchAll(/import[^;]+;/g)].map((m) => m[0]).join('\n'),
  },
};

export default config;
