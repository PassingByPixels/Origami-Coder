// GitHub Copilot's OAuth connection spec — its own file because a multi-model family carries more
// data than oauthConnections.ts has room for.
//
// GitHub.com only: the plugin's Enterprise prompt is never answered by ACP's
// provider_auth_authorize, so Enterprise cannot be reached from the extension.
//
// The seed list is NOT the plugin's own — Copilot ships no allowlist, so ids are drawn from the
// models.dev snapshot the engine bakes in, pinned by oauthCatalog.mirror.test.ts. The seed is
// PERMANENT: the live picker rebuilds on top of it after connecting, but a seed id stays in the
// picker for the life of the connection even if the account loses access to it, so the seed favours
// a few ids GitHub has always fronted Copilot with rather than a full catalog tour.
//
// With no models.dev snapshot at all (an engine built from source) the seed IS the whole catalog,
// which is why every entry carries its own `provider.api`.

import type { OauthProviderSpec } from './oauthConnections';

/** GitHub Copilot's API base, written PER MODEL (not as options.baseURL, which loses to
 *  model.api.url for every model) so a snapshot-less engine still dials GitHub. */
const COPILOT_API = { api: 'https://api.githubcopilot.com' };

const TEXT_IN_IMAGE_PDF = { input: ['text', 'image', 'pdf'], output: ['text'] };

export const COPILOT_OAUTH: OauthProviderSpec = {
  id: 'github-copilot',
  name: 'GitHub Copilot',
  npm: '@ai-sdk/github-copilot',
  // The plugin's own UTILITY_MODELS name gpt-4.1 as an always-served id, and it
  // is GitHub's base model on every plan including Free. cfg.model has to be an
  // id the account can certainly reach, not the best one on offer — the
  // stronger models are one click away in the chat pane.
  defaultModel: 'gpt-4.1',
  hint: 'Signs in with your GitHub Copilot subscription using a device code — GitHub shows a page and you type the code into it. Only github.com is offered here; GitHub Enterprise needs the CLI. Three GPT models are written now, and the rest of what your plan carries is added to the picker once you are signed in.',
  models: {
    'gpt-4.1': {
      name: 'GPT-4.1',
      limit: { context: 128_000, output: 16_384 },
      reasoning: false, tool_call: true, attachment: true, temperature: true,
      modalities: TEXT_IN_IMAGE_PDF, release_date: '2025-04-14',
      provider: COPILOT_API,
    },
    'gpt-5.4': {
      name: 'GPT-5.4',
      limit: { context: 1_050_000, output: 128_000 },
      reasoning: true, tool_call: true, attachment: true, temperature: false,
      modalities: TEXT_IN_IMAGE_PDF, release_date: '2026-03-05',
      provider: COPILOT_API,
    },
    'gpt-5.4-mini': {
      name: 'GPT-5.4 mini',
      limit: { context: 400_000, output: 128_000 },
      reasoning: true, tool_call: true, attachment: true, temperature: false,
      modalities: { input: ['text', 'image'], output: ['text'] }, release_date: '2026-03-17',
      provider: COPILOT_API,
    },
  },
};
