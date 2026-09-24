// The Add/Re-key picker's catalog: fixed connection templates the
// sidebar offers, and the two types that describe one.
//
// A pure data leaf, extracted from ControlStrip.svelte to free room
// under its architecture cap without touching markup.
//
// Nothing here renders. `label` is the picker's face; `name` is what
// gets written into origami.json — renaming a label must never rewrite a stored block's name.

// 'claude-subscription' (t-tsw90t) is neither a key nor an OAuth sign-in: no
// fields at all. ControlStrip's applyProviderDefaults intercepts a pick of
// this kind before any field state is set, so it never reaches the
// setup-form rendering the other three kinds share.
export type ProviderKind = 'local' | 'compat' | 'cloud' | 'oauth' | 'claude-subscription';
// `keylessCatalog` marks a gateway whose model list needs no auth header,
// so the add form can offer real models before a key exists (mirrors
// src/dashboard/keyOnlyPresets.ts; a test catches drift).
// `authProvider` is the engine id an OAuth entry signs into — it may
// differ from the catalog id, but sameness checks must read authProvider.
export interface SetupProvider { id: string; label: string; name: string; kind: ProviderKind; npm?: string; baseURL?: string; model: string; keyOnly?: boolean; localAuto?: boolean; keylessCatalog?: boolean; authProvider?: string; }
export const SETUP_PROVIDERS: SetupProvider[] = [
  { id: 'lmstudio',   label: 'LM Studio (local)',  name: 'LM Studio', kind: 'local',  npm: '@ai-sdk/openai-compatible', baseURL: 'http://127.0.0.1:1234/v1', model: 'qwen/qwen3-coder-30b', localAuto: true },
  // Any self-hosted OpenAI-compatible vLLM endpoint, no API key usually.
  { id: 'vllm',       label: 'vLLM (self-hosted)', name: 'vLLM',      kind: 'local',  npm: '@ai-sdk/openai-compatible', baseURL: 'http://localhost:8000/v1', model: '', localAuto: true },
  // Detected as flavor 'ollama' (/api/tags), so it switches live, no phantom lms controls.
  { id: 'ollama',     label: 'Ollama (local)',     name: 'Ollama',    kind: 'local',  npm: '@ai-sdk/openai-compatible', baseURL: 'http://127.0.0.1:11434/v1', model: '', localAuto: true },
  // Loopback like LM Studio/Ollama; no fixed model — whichever is loaded is up to the server.
  { id: 'sglang',     label: 'SGLang (local)',     name: 'SGLang',    kind: 'local',  npm: '@ai-sdk/openai-compatible', baseURL: 'http://localhost:30000/v1', model: '', localAuto: true },
  { id: 'openrouter', label: 'OpenRouter',         name: 'OpenRouter', kind: 'compat', npm: '@ai-sdk/openai-compatible', baseURL: 'https://openrouter.ai/api/v1', model: '', keyOnly: true },
  // OpenCode Zen/Go mirror OpenRouter (keyOnly): Go is the same gateway
  // on a different billing tier, not a second endpoint — two entries let
  // the user pick the plan they bought. `model` is a real id so a pasted
  // key produces a pill immediately; keylessCatalog replaces it once the catalog fetch lands.
  { id: 'opencode',     label: 'OpenCode Zen',      name: 'OpenCode Zen', kind: 'compat', npm: '@ai-sdk/openai-compatible', baseURL: 'https://opencode.ai/zen/v1', model: 'deepseek-v4-flash-free', keyOnly: true, keylessCatalog: true },
  { id: 'opencode-go',  label: 'OpenCode Go',       name: 'OpenCode Go',  kind: 'compat', npm: '@ai-sdk/openai-compatible', baseURL: 'https://opencode.ai/zen/go/v1', model: 'deepseek-v4-flash', keyOnly: true, keylessCatalog: true },
  // A subscription behind which sit several labs' models, so it sits
  // with the aggregators rather than under Labs. No API-key twin:
  // device-code sign-in is the only door.
  { id: 'github-copilot-oauth', label: 'GitHub Copilot (OAuth)', name: 'GitHub Copilot', kind: 'oauth', model: '', authProvider: 'github-copilot' },
  // Subscription sign-in, not a second way to paste a key: these drive
  // the engine's OAuth plugins and write a block with no apiKey. Each
  // lab's API-key entry stays first, its OAuth twin directly under it.
  { id: 'openai',     label: 'OpenAI (API)',       name: 'OpenAI',    kind: 'cloud',  model: 'gpt-5' },
  { id: 'openai-oauth', label: 'OpenAI (OAuth)',   name: 'OpenAI (ChatGPT)', kind: 'oauth', model: '', authProvider: 'openai' },
  { id: 'xai',        label: 'Grok (API)',         name: 'xAI',       kind: 'cloud',  model: 'grok-4' },
  { id: 'xai-oauth',    label: 'Grok (OAuth)',     name: 'xAI (SuperGrok)',  kind: 'oauth', model: '', authProvider: 'xai' },
  // "Claude" is the user's word; "Anthropic" is the company and the
  // engine's provider id, so `id` stays `anthropic` — renaming would
  // orphan every existing connection.
  { id: 'anthropic',  label: 'Claude (Anthropic API)', name: 'Claude', kind: 'cloud',  model: 'claude-sonnet-5' },
  // Subscription sign-in via the local Claude Code CLI's own credentials
  // (t-tijdof, t-tsw90t) — no key, no browser OAuth dance: picking this
  // entry shows the one-time disclosure (claudeSubscriptionConsent.ts) and
  // Confirm flips origami.experimentalClaudeSubscription on. Directly under
  // its API-key sibling, same pairing rule the OAuth entries follow above.
  { id: 'claude-subscription', label: 'Claude (subscription, experimental)', name: 'Claude (subscription)', kind: 'claude-subscription', model: '' },
  // A generic OpenAI-compatible provider filled in by hand, so a new
  // lab/endpoint never needs a code change.
  { id: 'other',      label: 'Other (OpenAI-compatible)', name: 'Custom', kind: 'compat', npm: '@ai-sdk/openai-compatible', baseURL: '', model: '' },
];
