// The Claude family a fresh "Claude (Anthropic API)" connection declares in the
// GLOBAL origami.json — the multi-model half of the catalog entry whose picker
// face lives in webview/sidebar/setupCatalog.ts.
//
// WHY A BAKED LIST AT ALL. The sidebar's model picker is built from the CONFIG
// blocks (firstFold.readGlobalProviders -> liveModelMerge -> modelOptions), not
// from the engine's own provider database. The cloud setup form submits exactly
// one model id (ControlStrip's `cloud` shape: API key + model id), so without
// this table "connect Claude" wrote a block declaring a single model and the
// picker offered that one row forever — while the engine could resolve the whole
// family. The block is what the picker can see; this is what makes the family
// visible in it.
//
// WHERE THE NUMBERS COME FROM. Read out of the models.dev snapshot the ENGINE
// ITSELF is built against: `packages/engine/script/generate.ts` fetches
// models.dev/api.json at build time and `script/build.ts` inlines it into the
// binary as the `ORIGAMI_MODELS_DEV` define. These six entries were extracted
// verbatim from the shipped `~/.origami/bin/origami.exe` (2026-08-26 build) at
// the `anthropic:{id:"anthropic"` offset, cross-checked field for field against
// Anthropic's own current-model table. Same trade oauthConnections.ts makes: a
// mirror of data that lives elsewhere, so it will age — but it is small,
// visible, and a wrong id fails loudly on the first message rather than
// silently.
//
// NOT THE WHOLE ZOO. That snapshot's anthropic provider carries 13 entries,
// including dated snapshots (`claude-sonnet-4-5-20250929`), `(latest)` aliases
// and superseded generations. This is the CURRENT line-up only — one entry per
// tier that is still the thing a new connection should be offered. A user who
// wants a retired id types it into the form; it is written alongside these.
//
// The values are deliberately full (limit / capabilities / modalities / cost)
// rather than name-only: an engine spawned from source (`origami.devEngineSource`)
// has NO baked snapshot, so its provider database is empty and every field the
// block omits falls back to a zero — a `limit.context` of 0 disables auto-
// compaction outright, and a cost of 0 makes every spend readout wrong.

/** One model's block, in `origami.json`'s own shape. A type alias, not an
 *  interface, so it carries the implicit index signature `ModelChoice.catalog`
 *  (Record<string, Record<string, unknown>>) needs. */
export type ClaudeModelConfig = {
  name: string;
  limit: { context: number; output: number };
  reasoning: boolean;
  tool_call: boolean;
  attachment: boolean;
  temperature: boolean;
  modalities: { input: string[]; output: string[] };
  release_date: string;
  /** USD per MILLION tokens — the engine reads `model.cost` straight from config. */
  cost: { input: number; output: number; cache_read: number; cache_write: number };
};

/** Text in, image and PDF in, text out — every current Claude model. */
const TEXT_IN_IMAGE_PDF = { input: ['text', 'image', 'pdf'], output: ['text'] };

/** The model a fresh connection starts on: the newest Sonnet-class id, which is
 *  the everyday coding tier. MIRRORED by setupCatalog.ts's `model` field (the
 *  webview cannot import a runtime value out of src/ — tsconfig.webview.json
 *  pins rootDir to webview/); anthropicCatalog.mirror.test.ts fails on drift. */
export const CLAUDE_DEFAULT_MODEL = 'claude-sonnet-5';

export const CLAUDE_MODELS: Record<string, ClaudeModelConfig> = {
  'claude-sonnet-5': {
    name: 'Claude Sonnet 5',
    limit: { context: 1_000_000, output: 128_000 },
    reasoning: true, tool_call: true, attachment: true, temperature: false,
    modalities: TEXT_IN_IMAGE_PDF, release_date: '2026-06-29',
    cost: { input: 2, output: 10, cache_read: 0.2, cache_write: 2.5 },
  },
  'claude-opus-5': {
    name: 'Claude Opus 5',
    limit: { context: 1_000_000, output: 128_000 },
    reasoning: true, tool_call: true, attachment: true, temperature: false,
    modalities: TEXT_IN_IMAGE_PDF, release_date: '2026-07-24',
    cost: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
  },
  'claude-fable-5': {
    name: 'Claude Fable 5',
    limit: { context: 1_000_000, output: 128_000 },
    reasoning: true, tool_call: true, attachment: true, temperature: false,
    modalities: TEXT_IN_IMAGE_PDF, release_date: '2026-06-07',
    cost: { input: 10, output: 50, cache_read: 1, cache_write: 12.5 },
  },
  'claude-opus-4-8': {
    name: 'Claude Opus 4.8',
    limit: { context: 1_000_000, output: 128_000 },
    reasoning: true, tool_call: true, attachment: true, temperature: false,
    modalities: TEXT_IN_IMAGE_PDF, release_date: '2026-05-28',
    cost: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
  },
  // The two entries that still accept `temperature` — the 4.6/4.5 generation.
  // Kept because they are the cheaper lanes, not because they are newest.
  'claude-sonnet-4-6': {
    name: 'Claude Sonnet 4.6',
    limit: { context: 1_000_000, output: 128_000 },
    reasoning: true, tool_call: true, attachment: true, temperature: true,
    modalities: TEXT_IN_IMAGE_PDF, release_date: '2026-02-17',
    cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
  },
  'claude-haiku-4-5': {
    name: 'Claude Haiku 4.5',
    limit: { context: 200_000, output: 64_000 },
    reasoning: true, tool_call: true, attachment: true, temperature: true,
    modalities: TEXT_IN_IMAGE_PDF, release_date: '2025-10-15',
    cost: { input: 1, output: 5, cache_read: 0.1, cache_write: 1.25 },
  },
};

/**
 * The multi-model catalog to declare alongside the model a setup form submitted,
 * or undefined for a provider that has no baked family here.
 *
 * Keyed on the ENGINE provider id, never on the picker's label: the entry is
 * called "Claude" in the UI and `anthropic` everywhere the engine, auth.json and
 * the config block are concerned, and only the latter may decide this.
 */
export function claudeCatalogFor(providerId: string): Record<string, ClaudeModelConfig> | undefined {
  return providerId === 'anthropic' ? CLAUDE_MODELS : undefined;
}
