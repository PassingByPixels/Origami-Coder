// The provider blocks an OAuth sign-in writes into the GLOBAL origami.json.
//
// This fork ships no models.dev data, so the engine's provider database is empty until a config
// block declares a provider — the block below makes it real, the credential makes it usable.
//
// NO apiKey is written: the plugin's loader supplies a dummy key plus a fetch wrapper that injects
// the real bearer, so a key in config would override the thing that works.
//
// Each model's id/name/limits come from the models.dev entries for the subset the PLUGIN actually
// serves. Since live discovery, this is a SEED, not the answer — the engine adds whatever the
// credential is actually served — but it still must be right, since a wrong id fails that
// connection's first message.

import { COPILOT_OAUTH } from './copilotCatalog';

/** A per-model config block, in `origami.json`'s own shape. */
export interface OauthModelConfig {
  name: string;
  limit: { context: number; output: number };
  reasoning?: boolean;
  tool_call?: boolean;
  attachment?: boolean;
  temperature?: boolean;
  modalities?: { input: string[]; output: string[] };
  release_date?: string;
  /** Per-model endpoint override, in origami.json's own shape. The ONLY fallback an engine spawned
   *  from source (no baked models.dev snapshot) has — written for github-copilot, whose SDK loader
   *  otherwise falls back to its own default. */
  provider?: { api?: string; npm?: string };
}

export interface OauthProviderSpec {
  /** The ENGINE provider id — what `provider_auth_*` and `auth.json` key on. */
  id: string;
  /** The pill label written into the config block. */
  name: string;
  npm: string;
  /** The model written to `cfg.model` — the connection's starting default. */
  defaultModel: string;
  models: Record<string, OauthModelConfig>;
  /** One honest sentence the setup form shows under the method buttons. */
  hint: string;
}

const TEXT_IN_IMAGE_PDF = { input: ['text', 'image', 'pdf'], output: ['text'] };

export const OAUTH_PROVIDERS: Record<string, OauthProviderSpec> = {
  openai: {
    id: 'openai',
    name: 'OpenAI (ChatGPT)',
    npm: '@ai-sdk/openai',
    defaultModel: 'gpt-5.5',
    hint: 'Signs in with your ChatGPT Plus/Pro account. The model list is DISCOVERED from the account once you are signed in — the entries below are only a starting seed, so a model OpenAI adds to your plan appears without an update. They come from the ChatGPT subscription backend, not the platform API — an OpenAI platform key buys a different, metered catalog and lives under the "OpenAI" entry instead.',
    models: {
      'gpt-5.5': {
        name: 'GPT-5.5',
        limit: { context: 1_050_000, output: 128_000 },
        reasoning: true, tool_call: true, attachment: true, temperature: false,
        modalities: TEXT_IN_IMAGE_PDF, release_date: '2026-04-23',
      },
      'gpt-5.4': {
        name: 'GPT-5.4',
        limit: { context: 1_050_000, output: 128_000 },
        reasoning: true, tool_call: true, attachment: true, temperature: false,
        modalities: TEXT_IN_IMAGE_PDF, release_date: '2026-03-05',
      },
      'gpt-5.4-mini': {
        name: 'GPT-5.4 mini',
        limit: { context: 400_000, output: 128_000 },
        reasoning: true, tool_call: true, attachment: true, temperature: false,
        modalities: { input: ['text', 'image'], output: ['text'] }, release_date: '2026-03-17',
      },
      // A model once offered here was refused by the backend by name, so it is gone from codex.ts's
      // ALLOWED_MODELS too; oauthCatalog.mirror.test.ts fails if the two lists ever disagree again.
    },
  },
  xai: {
    id: 'xai',
    name: 'xAI (SuperGrok)',
    npm: '@ai-sdk/xai',
    defaultModel: 'grok-4.5',
    hint: 'Signs in with your SuperGrok subscription. The model list is DISCOVERED from the account once you are signed in — the entries below are only a starting seed. xAI gates OAuth by subscription tier — if sign-in or the first message comes back 403, the plan does not carry OAuth access and the "Grok (API)" API-key entry is the way in.',
    models: {
      'grok-4.5': {
        name: 'Grok 4.5',
        limit: { context: 500_000, output: 500_000 },
        reasoning: true, tool_call: true, attachment: true, temperature: true,
        modalities: TEXT_IN_IMAGE_PDF, release_date: '2026-07-08',
      },
      'grok-4.3': {
        name: 'Grok 4.3',
        limit: { context: 1_000_000, output: 30_000 },
        reasoning: true, tool_call: true, attachment: true, temperature: true,
        modalities: TEXT_IN_IMAGE_PDF, release_date: '2026-04-17',
      },
      'grok-build-0.1': {
        name: 'Grok Build 0.1',
        limit: { context: 256_000, output: 256_000 },
        reasoning: true, tool_call: true, attachment: true, temperature: true,
        modalities: TEXT_IN_IMAGE_PDF, release_date: '2026-04-16',
      },
    },
  },
  // The third connection's spec is a file of its own (copilotCatalog.ts) — it
  // carries a longer why than the two above, and this file is capped.
  'github-copilot': COPILOT_OAUTH,
};

/**
 * Which login methods the pane offers for a provider. Every plugin's method list ends with a
 *  "Manually enter API Key" entry that is NOT an OAuth flow (authorize answers undefined for it) —
 *  filtered by TYPE, not label, so the API-key catalog entry stays the one door to that flow.
 */
export function oauthMethods(
  methods: ReadonlyArray<{ type: string; label: string }> | undefined,
): Array<{ index: number; label: string }> {
  return (methods ?? [])
    .map((m, index) => ({ index, label: m.label, type: m.type }))
    .filter((m) => m.type === 'oauth')
    .map(({ index, label }) => ({ index, label }));
}
