// The provider blocks an OAuth sign-in writes into the GLOBAL origami.json.
//
// WHY A BAKED CATALOG AT ALL. This fork ships no models.dev data — the network
// fetch is hard-disabled (`core/src/models-dev.ts`, "FORK STRIP") — so on a
// real install the engine's provider database is EMPTY: `openai` and `xai` do
// not exist until a config block declares them, and `mergeProvider` drops the
// plugin auth loader's contribution for any provider the database has never
// heard of. A stored OAuth credential on its own therefore buys nothing at
// all. The block below is what makes the provider real; the credential is what
// makes it usable. Proven, both directions, by the engine's
// `test/provider/oauth-catalog-attach.test.ts`.
//
// NO apiKey IS WRITTEN. That is the point: the plugin's `loader` supplies a
// dummy key plus a fetch wrapper that injects the real bearer, so a key in the
// config would only override the thing that works.
//
// WHERE THE NUMBERS COME FROM. Each model's id, name and limits are the
// models.dev entries for that provider, and each list is the subset the
// PLUGIN itself serves over the subscription backend:
//   - openai: `plugin/openai/codex.ts`'s ALLOWED_MODELS — the ChatGPT backend
//     (chatgpt.com/backend-api/codex), not the platform API. Costs stay 0
//     because a Plus/Pro subscription is not metered per token.
//   - xai: the reasoning/chat Grok models. xAI's image and video models are
//     not chat models and are deliberately absent.
// This is a MIRROR of data that lives elsewhere, so it will age. It is small,
// visible, and a wrong id fails loudly on the first message rather than
// silently — which is the trade a baked list makes here.

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
    hint: 'Signs in with your ChatGPT Plus/Pro account. The models come from the ChatGPT subscription backend (the gpt-5.x Codex family), not the platform API — an OpenAI platform key buys a different, metered catalog and lives under the "OpenAI" entry instead.',
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
      // gpt-5.3-codex-spark WAS here. The backend refuses it by name — "The
      // 'gpt-5.3-codex-spark' model is not supported when using Codex with a
      // ChatGPT account" (owner session, 2026-08-15) — so writing it into the
      // config only bought a connection whose first message always failed. It is
      // gone from codex.ts's ALLOWED_MODELS too; oauthCatalog.mirror.test.ts
      // fails if the two lists ever disagree again.
    },
  },
  xai: {
    id: 'xai',
    name: 'xAI (SuperGrok)',
    npm: '@ai-sdk/xai',
    defaultModel: 'grok-4.5',
    hint: 'Signs in with your SuperGrok subscription. xAI gates OAuth by subscription tier — if sign-in or the first message comes back 403, the plan does not carry OAuth access and the "Grok (API)" API-key entry is the way in.',
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
};

/**
 * Which login methods the pane offers for a provider.
 *
 * Every plugin's method list ends with a "Manually enter API Key" entry that
 * is NOT an OAuth flow — `ProviderAuth.authorize` answers `undefined` for it.
 * The API-key connection already has its own catalog entry with a validated
 * key field, so showing it here would be a second, worse door to the same
 * room. Filtered by TYPE, not by label, so a plugin renaming its entry cannot
 * quietly put it back.
 */
export function oauthMethods(
  methods: ReadonlyArray<{ type: string; label: string }> | undefined,
): Array<{ index: number; label: string }> {
  return (methods ?? [])
    .map((m, index) => ({ index, label: m.label, type: m.type }))
    .filter((m) => m.type === 'oauth')
    .map(({ index, label }) => ({ index, label }));
}
