// The Add/Re-key picker's CATALOG: the fixed list of connection templates the
// sidebar offers, and the two types that describe one.
//
// A PURE DATA LEAF, extracted from ControlStrip.svelte, which sat EXACTLY on its
// 1241-line cap — so this was extract-or-stop, not a preference. Data rather
// than markup on purpose: ControlStrip's CSS is component-scoped and it declares
// no `:global` rules, so lifting any MARKUP out of it would have meant
// duplicating ~18 style rules across 9 shared classes with no test in this repo
// able to catch the resulting visual regression (jsdom has no layout). Moving
// constants instead frees the same room and cannot change a single pixel. Same
// pattern as this folder's other extractions — connectionSection.ts and
// providerGrid.ts are both .ts leaves lifted out of the same component.
//
// NOTHING HERE RENDERS. `label` is the picker's face; `name` is what gets
// written into origami.json as the provider's display name. They are NOT
// interchangeable — renaming a label must never rewrite a stored block's name.

export type ProviderKind = 'local' | 'compat' | 'cloud' | 'oauth';
// `keylessCatalog` marks a gateway whose GET <baseURL>/models answers with NO
// Authorization header, so the add form can offer its REAL model list before a
// key exists. MIRRORS src/dashboard/keyOnlyPresets.ts (the webview cannot
// import a runtime value out of src/ — tsconfig.webview.json pins rootDir to
// webview/); keyOnlyPresets.mirror.test.ts reads both files and fails on drift.
// `authProvider` is the ENGINE provider id an OAuth entry signs into. The
// catalog id has to differ from the API-key entry's (`openai` vs
// `openai-oauth`) because both live in the same keyed {#each} and a
// duplicate key is a Svelte runtime error — but every DECISION that should
// treat the two as the same provider (which accordion section, which pill)
// reads authProvider, not the catalog id.
export interface SetupProvider { id: string; label: string; name: string; kind: ProviderKind; npm?: string; baseURL?: string; model: string; keyOnly?: boolean; localAuto?: boolean; keylessCatalog?: boolean; authProvider?: string; }
export const SETUP_PROVIDERS: SetupProvider[] = [
  { id: 'lmstudio',   label: 'LM Studio (local)',  name: 'LM Studio', kind: 'local',  npm: '@ai-sdk/openai-compatible', baseURL: 'http://127.0.0.1:1234/v1', model: 'qwen/qwen3-coder-30b', localAuto: true },
  // vLLM — any self-hosted OpenAI-compatible vLLM endpoint. Same localAuto
  // flow as LM Studio: enter the base URL, the host probes /v1/models and
  // auto-picks. Most vLLM servers run with no API key, same as LM Studio/Ollama.
  { id: 'vllm',       label: 'vLLM (self-hosted)', name: 'vLLM',      kind: 'local',  npm: '@ai-sdk/openai-compatible', baseURL: 'http://localhost:8000/v1', model: '', localAuto: true },
  // Ollama — its OpenAI-compatible endpoint is /v1 (default port 11434); the host
  // probes /v1/models and auto-picks. Detected as flavor 'ollama' (answers
  // /api/tags), so it switches live with no phantom lms controls.
  { id: 'ollama',     label: 'Ollama (local)',     name: 'Ollama',    kind: 'local',  npm: '@ai-sdk/openai-compatible', baseURL: 'http://127.0.0.1:11434/v1', model: '', localAuto: true },
  // SGLang — its OpenAI-compatible endpoint is /v1 on default port 30000,
  // reached over loopback like LM Studio/Ollama (not a fixed remote box like
  // vLLM's Spark default). Same localAuto flow: enter/accept the base URL,
  // the host probes /v1/models and auto-picks — no fixed catalog model to
  // pin, since which model is loaded is entirely up to the server. Referenced
  // in comments/prose since 0.4.27 (a keyless-compat example) but never had a
  // template of its own, so it was invisible in the picker itself.
  { id: 'sglang',     label: 'SGLang (local)',     name: 'SGLang',    kind: 'local',  npm: '@ai-sdk/openai-compatible', baseURL: 'http://localhost:30000/v1', model: '', localAuto: true },
  { id: 'openrouter', label: 'OpenRouter',         name: 'OpenRouter', kind: 'compat', npm: '@ai-sdk/openai-compatible', baseURL: 'https://openrouter.ai/api/v1', model: '', keyOnly: true },
  // OpenCode Zen and Go (t-o92558) — the upstream project's own gateway, and
  // the two entries mirror OpenRouter exactly: keyOnly, so Add -> Providers ->
  // pick asks for the key and nothing else (round 5: reclassified out of Labs,
  // see connectionSection.ts). Endpoint VERIFIED LIVE by keyless probe
  // (GET /zen/v1/models answered 200 without a key; write paths answered a
  // structured 401), not read off documentation.
  //
  // GO IS NOT A SECOND ENDPOINT. It is the same gateway on a different billing
  // tier, so its baseURL is identical by design — the key decides the tier.
  // Two entries exist because the user picks the plan they bought, and one
  // entry named "Zen" would make Go look unsupported.
  //
  // ROUTING CAVEAT, per family: Zen serves chat-completions at /v1, but routes
  // GPT models to /responses and Claude models to /messages. This /v1 preset is
  // therefore honest only for the chat-completions family; a GPT or Claude
  // model bought through Zen needs per-family routing that this preset does not
  // do, and that is a follow-up on the ticket, not a thing to guess at here.
  //
  // The `model` is a real id, not '' (t-o92558 round 4). Shipping '' meant the
  // host's setup flow hit its "needs a model id" guard and wrote nothing, so a
  // pasted key produced no pill at all. `deepseek-v4-flash-free` is in Zen's
  // live catalog, is neither gpt-* nor claude-* (so the caveat above does not
  // bite it), and is free — the first message after connecting cannot spend on
  // a key whose tier we cannot read. keylessCatalog replaces it with the user's
  // own pick as soon as the catalog fetch lands. Full reasoning:
  // src/dashboard/keyOnlyPresets.ts.
  // id is `opencode` to match the engine catalog's provider id — see keyOnlyPresets.ts.
  { id: 'opencode',     label: 'OpenCode Zen',      name: 'OpenCode Zen', kind: 'compat', npm: '@ai-sdk/openai-compatible', baseURL: 'https://opencode.ai/zen/v1', model: 'deepseek-v4-flash-free', keyOnly: true, keylessCatalog: true },
  // Go is its OWN gateway (zen/go/v1) with its own open-coding-model catalog —
  // NOT the Zen base on a billing tier. models.dev + live 401/200 evidence
  // 2026-08-21; full reasoning in src/dashboard/keyOnlyPresets.ts.
  { id: 'opencode-go',  label: 'OpenCode Go',       name: 'OpenCode Go',  kind: 'compat', npm: '@ai-sdk/openai-compatible', baseURL: 'https://opencode.ai/zen/go/v1', model: 'deepseek-v4-flash', keyOnly: true, keylessCatalog: true },
  // SUBSCRIPTION SIGN-IN, not a second way to paste a key: these drive the
  // engine's OAuth plugins (ChatGPT Plus/Pro on :1455, SuperGrok on :56121)
  // through provider_auth_*, and write a block with NO apiKey — the plugin
  // injects the bearer. Each lab's API-key entry stays and comes FIRST, its
  // OAuth twin directly under it (owner order, 0.3.83); Anthropic last.
  { id: 'openai',     label: 'OpenAI (API)',       name: 'OpenAI',    kind: 'cloud',  model: 'gpt-5' },
  { id: 'openai-oauth', label: 'OpenAI (OAuth)',   name: 'OpenAI (ChatGPT)', kind: 'oauth', model: '', authProvider: 'openai' },
  { id: 'xai',        label: 'Grok (API)',         name: 'xAI',       kind: 'cloud',  model: 'grok-4' },
  { id: 'xai-oauth',    label: 'Grok (OAuth)',     name: 'xAI (SuperGrok)',  kind: 'oauth', model: '', authProvider: 'xai' },
  { id: 'anthropic',  label: 'Anthropic (API)',    name: 'Anthropic', kind: 'cloud',  model: 'claude-sonnet-4-5' },
  // Other — a generic OpenAI-compatible provider you fill in yourself (base
  // URL + key + model), so a new lab/endpoint never needs a code change. kind
  // 'compat' with no flags => the setup form shows all three fields.
  { id: 'other',      label: 'Other (OpenAI-compatible)', name: 'Custom', kind: 'compat', npm: '@ai-sdk/openai-compatible', baseURL: '', model: '' },
];
