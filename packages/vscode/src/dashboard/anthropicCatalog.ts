// The Claude model family a fresh "Claude (Anthropic API)" connection
// declares in the global origami.json.
//
// The sidebar's model picker is built from this config block, not from the
// engine's provider database, so without it a cloud connection only offered
// one model. Values are mirrored from the engine's models.dev snapshot and
// will age — kept small and visible so a wrong id fails loudly rather than
// silently. This is the CURRENT line-up only, not the full provider list.

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
  // The two entries that still accept `temperature` (4.5/4.6 generation).
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
 * The multi-model catalog to declare alongside a setup form's model, or
 * undefined if none is baked for this provider. Keyed on the engine
 * provider id, never the picker's label.
 */
export function claudeCatalogFor(providerId: string): Record<string, ClaudeModelConfig> | undefined {
  return providerId === 'anthropic' ? CLAUDE_MODELS : undefined;
}
