// Key-only provider presets — for every provider whose setup is "paste your key and nothing else":
// where its API lives, how to prove a key is real, and what model to write when the user picked
// none.
//
// Per-preset facts live here once, read by id, rather than special-cased setup code hard-coding a
// single provider name and check.
//
// MIRRORED in webview/sidebar/ControlStrip.svelte's SETUP_PROVIDERS, since the webview cannot
// import a runtime value from src/; keyOnlyPresets.mirror.test.ts reads both files and fails on
// drift.
//
// Nothing here imports vscode or node — fetch is injected — so the whole file is unit-testable with
// a fake.

/** How a preset proves a pasted key is real. */
export type KeyProbe =
  /** GET <base>/key — OpenRouter's key-metadata endpoint (label + free tier). */
  | 'openrouter-key'
  /** POST <base>/chat/completions capped at one token — the only auth-sensitive route OpenCode Zen
   *  exposes; every GET besides /models answers 404, and /models answers 200 with no key at all, so
   *  it cannot judge one. */
  | 'chat-completion';

export interface KeyOnlyPreset {
  /** The provider's own name — the ONLY string a failure message may use. */
  name: string;
  baseURL: string;
  probe: KeyProbe;
  /** GET <baseURL>/models answers without a key, so the add form can offer the
   *  real catalog before the user has pasted anything. */
  keylessCatalog: boolean;
  /** Written when the user picks no model. '' means "the caller auto-picks from
   *  a keyed catalog" (OpenRouter's free-tier logic). */
  defaultModel: string;
}

// The Zen fallback model: live in the keyless catalog, neither gpt-* nor claude-* (Zen routes those
// to different endpoints its /v1 preset can't call), and the -free suffix means the first message
// after connecting can't spend money on a key whose tier can't be read (Zen publishes no /key
// endpoint). A fallback, not a recommendation — the add form lets the user choose from the fetched
// catalog.
export const ZEN_DEFAULT_MODEL = 'deepseek-v4-flash-free';

const ZEN_BASE_URL = 'https://opencode.ai/zen/v1';

// Go's own base + default (evidence in the preset comment below). The default
// is in Go's LIVE catalog (2026-08-21, 29 ids), outside the gpt-*/claude-*
// routing caveat, and subscription-covered — no free/paid split to respect.
const GO_BASE_URL = 'https://opencode.ai/zen/go/v1';
export const GO_DEFAULT_MODEL = 'deepseek-v4-flash';

export const KEY_ONLY_PRESETS: Record<string, KeyOnlyPreset> = {
  openrouter: {
    name: 'OpenRouter',
    baseURL: 'https://openrouter.ai/api/v1',
    probe: 'openrouter-key',
    // OpenRouter's /models needs no key either, but its catalog is ~343 entries
    // WITH pricing, and the flow already fetches it keyed to auto-pick a free
    // model on a free-tier key. Leave that path alone.
    keylessCatalog: false,
    defaultModel: '',
  },
  // OpenCode Zen and Go are NOT one gateway with a tier bit: a paid Go key answered 401 on non-free
  // zen/v1 models while zen/go/v1 answered 200 across its whole catalog. Same console mints the
  // key; the BASE decides the product — pointing Go at the Zen base makes a good subscription key
  // look dead.
  // The ids `opencode`/`opencode-go` match the engine's baked models.dev provider ids and are
  // load-bearing: every Zen feature gate keys off `ProviderV2.ID.opencode`, and the id is written
  // straight into `provider.<id>` in origami.json.
  opencode: {
    name: 'OpenCode Zen',
    baseURL: ZEN_BASE_URL,
    probe: 'chat-completion',
    keylessCatalog: true,
    defaultModel: ZEN_DEFAULT_MODEL,
  },
  'opencode-go': {
    name: 'OpenCode Go',
    baseURL: GO_BASE_URL,
    probe: 'chat-completion',
    keylessCatalog: true,
    defaultModel: GO_DEFAULT_MODEL,
  },
};

export function keyOnlyPreset(id: string): KeyOnlyPreset | undefined {
  return KEY_ONLY_PRESETS[id];
}

/** Model ids out of an OpenAI-shaped `/models` reply ({object:'list',data:[{id}]}).
 *  Tolerates a bare array, because not every gateway wraps it. */
export function parseModelIds(json: unknown): string[] {
  const data = Array.isArray(json)
    ? json
    : Array.isArray((json as { data?: unknown })?.data)
      ? (json as { data: unknown[] }).data
      : [];
  const ids: string[] = [];
  for (const m of data) {
    const id = typeof m === 'string' ? m : String((m as { id?: unknown })?.id ?? '').trim();
    if (id) ids.push(id);
  }
  return ids;
}

/** The id the add form should start on: the preset's default when the live
 *  catalog really carries it, else the first thing the catalog offers, else the
 *  default unverified. Never returns an id the catalog contradicts. */
export function pickDefaultModel(ids: string[], preferred: string): string {
  if (ids.includes(preferred)) return preferred;
  return ids[0] ?? preferred;
}

/** Fetch a gateway's catalog ids. Best-effort: [] on any failure, so a dead
 *  network degrades the picker to the preset default instead of blocking setup. */
export async function fetchCatalogIds(
  baseURL: string,
  fetchImpl: typeof fetch,
  apiKey?: string,
): Promise<string[]> {
  const base = baseURL.replace(/\/+$/, '');
  try {
    const res = await fetchImpl(`${base}/models`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return [];
    return parseModelIds(await res.json().catch(() => ({})));
  } catch {
    return [];
  }
}

export interface KeyCheckResult {
  ok: boolean;
  /** True only when the provider ANSWERED and refused the key (401/403). A
   *  network failure is `ok:false, rejected:false` — the caller must not tell a
   *  user their key is bad because their wifi dropped. */
  rejected?: boolean;
  reason?: string;
  /** OpenRouter's key label, when the probe returns one. */
  label?: string;
  freeTier?: boolean;
}

export interface KeyCheckDeps {
  presetId: string;
  apiKey: string;
  fetchImpl: typeof fetch;
  /** Model for the 'chat-completion' probe; falls back to the preset default. */
  model?: string;
  /** Overrides the preset's baseURL (a re-key of a hand-edited block). */
  baseURL?: string;
}

/**
 * Prove a key against ITS OWN provider — the preset decides both host and probe shape, so nothing
 *  here can validate one gateway's key against another's endpoint.
 */
export async function checkProviderKey(d: KeyCheckDeps): Promise<KeyCheckResult> {
  const preset = KEY_ONLY_PRESETS[d.presetId];
  if (!preset) return { ok: true };
  if (!d.apiKey) return { ok: false, rejected: true, reason: 'no API key' };
  const base = (d.baseURL || preset.baseURL).replace(/\/+$/, '');

  if (preset.probe === 'openrouter-key') {
    try {
      const res = await d.fetchImpl(`${base}/key`, {
        headers: { Authorization: `Bearer ${d.apiKey}` },
        signal: AbortSignal.timeout(8000),
      });
      if (res.ok) {
        const j = (await res.json().catch(() => ({}))) as { data?: { label?: string; is_free_tier?: boolean } };
        return { ok: true, label: j?.data?.label, freeTier: j?.data?.is_free_tier === true };
      }
      if (res.status === 401) return { ok: false, rejected: true, reason: 'invalid API key (401)' };
      return { ok: false, reason: `HTTP ${res.status}` };
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
  }

  // chat-completion probe: one token, so a valid key costs a rounding error and an invalid one
  // costs nothing. The verdict reads AUTH ONLY — 401/403 means refused; any other answer (200, or
  // even a 400/502) means the request got past the gate, which is the whole question. Judging on
  // res.ok instead would call a good key invalid the day the default model id retires.
  try {
    const res = await d.fetchImpl(`${base}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${d.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: d.model || preset.defaultModel,
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 1,
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (res.status === 401) return { ok: false, rejected: true, reason: 'invalid API key (401)' };
    if (res.status === 403) return { ok: false, rejected: true, reason: 'key not authorised (403)' };
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

/** The sentence a user reads when a key does not land. Names the PRESET's own
 *  provider, and distinguishes "they said no" from "we could not ask". */
export function keyRejectedMessage(presetName: string, r: KeyCheckResult): string {
  return r.rejected
    ? `${presetName} key rejected (${r.reason}). Nothing was saved.`
    : `${presetName} could not be reached (${r.reason}). Nothing was saved.`;
}
