// liveModelMerge.ts — the model picker's LIVE-MIRROR projection: reconcile the
// engine's config-built model catalog against what each self-hosted server
// ACTUALLY serves right now, so a tab shows the server's truth and not an
// accumulated history of everything origami.json ever held.
//
// EXTRACTED from DashboardPanel.broadcastModelOptions, which was carrying this
// inline at its line cap — and which had a defect the extraction fixes:
// the polls ran under a bare `Promise.all` inside one `try/catch {}`, so a
// SINGLE rejecting poll discarded EVERY provider's live list. node:http's
// `http.get` throws synchronously on a non-`http:` URL (ERR_INVALID_PROTOCOL),
// so one https provider block in origami.json (e.g. opencode.ai) silently
// disabled the live mirror for lmstudio, vllm and every other local server at
// once. Two independent guards now stop that class of failure:
//   1. pollableProviders() offers `http:` URLs (node:http territory) plus the
//      https keyless-catalog gateway presets (Zen/Go — fetched by the caller's
//      protocol-dispatching fetcher, never by node:http). Every other https
//      cloud provider is never polled at all (it keeps its own configured
//      catalog). This also subsumes the old openrouter.ai name check.
//   2. every poll is caught PER PROVIDER, so one bad server can only ever cost
//      its own tab, never its neighbours'.
//
// Display-prune only. Nothing here writes origami.json: a per-model block that
// is temporarily unserved (server stopped, model deleted upstream) keeps its
// options — `variants`, `limit.context`, vision `modalities` — so they are all
// still there when the server comes back. Only the ROWS disappear.

import type { ConfiguredProvider } from './firstFold';
import { KEY_ONLY_PRESETS } from './keyOnlyPresets';

/** One row of the picker's `modelOptions` broadcast. */
export interface ModelOptionRow {
  /** `<providerId>/<modelId>` — the value `setModel` is posted with. */
  value: string;
  name: string;
  /** True when origami.json already holds this model (picking it needs no write). */
  configured: boolean;
}

/**
 * The providers whose `/v1/models` we can actually poll.
 *
 * Two shapes qualify, and the CALLER's fetcher must dispatch on protocol:
 *
 *   · `http:` — a self-hosted server the node:http poller can dial. An https
 *     cloud provider (OpenRouter, any OAuth connection) is never offered by
 *     this branch: node:http throws on https, and a cloud catalog is its own
 *     source of truth. No provider is matched by NAME.
 *   · `https:` ONLY when the provider id is a keyless-catalog gateway preset
 *     (KEY_ONLY_PRESETS[pid].keylessCatalog — the OpenCode Zen/Go family).
 *     Those gateways answer GET /models with no key, so ONE connection can
 *     offer the whole catalog in the picker instead of a connection per
 *     model. Gated by PRESET ID — the same load-bearing id rule every Zen
 *     feature gate uses — never by URL or name; OpenRouter stays out because
 *     its preset says `keylessCatalog: false` (its ~343-model priced catalog
 *     has its own dedicated flow).
 *
 * Each entry carries the block's `apiKey` when it has one, because a self-hosted
 * server MAY enforce auth: without it the poll 401s, the live list comes back
 * empty and the picker silently stops tracking what the server is really
 * serving. Almost always undefined — the keyless path is unchanged.
 */
export function pollableProviders(
  providers: Record<string, ConfiguredProvider>,
): Array<{ pid: string; baseURL: string; apiKey?: string }> {
  const out: Array<{ pid: string; baseURL: string; apiKey?: string }> = [];
  for (const [pid, block] of Object.entries(providers ?? {})) {
    const baseURL = block?.options?.baseURL ?? '';
    const apiKey = block?.options?.apiKey;
    const selfHosted = /^http:\/\//i.test(baseURL);
    const catalogGateway = /^https:\/\//i.test(baseURL) && KEY_ONLY_PRESETS[pid]?.keylessCatalog === true;
    if (selfHosted || catalogGateway) out.push(apiKey ? { pid, baseURL, apiKey } : { pid, baseURL });
  }
  return out;
}

/**
 * Merge each pollable provider's LIVE model list into the configured catalog.
 *
 * Per provider, when the server answers with at least one id:
 *   · rows for that provider whose id is no longer served are REMOVED (a vLLM
 *     that loads exactly one model therefore shows exactly one row, however
 *     many that provider has accumulated in origami.json);
 *   · served ids missing from the catalog are ADDED, and a served id that
 *     matches a config key is reconciled onto that config entry — its display
 *     name and `configured: true` — so the engine's per-model options apply to
 *     the row the user picks.
 *
 * When the server does NOT answer (empty list, refused, timed out, threw) that
 * provider is left exactly as configured. A running chat must never face an
 * empty picker because a server was restarting.
 */
export async function mergeLiveModels(
  options: ReadonlyArray<ModelOptionRow>,
  providers: Record<string, ConfiguredProvider>,
  fetchModels: (baseURL: string, apiKey?: string) => Promise<string[]>,
): Promise<ModelOptionRow[]> {
  const polls = await Promise.all(
    pollableProviders(providers).map(async ({ pid, baseURL, apiKey }) => {
      // Caught HERE, not around the whole batch: a provider that throws costs
      // only its own live list. This is the defect the extraction fixed.
      try {
        return { pid, ids: await fetchModels(baseURL, apiKey) };
      } catch {
        return { pid, ids: [] as string[] };
      }
    }),
  );
  let rows = options.slice();
  for (const { pid, ids } of polls) {
    if (ids.length === 0) continue;
    const configured = providers[pid]?.models ?? {};
    const live = new Set(ids.map((id) => `${pid}/${id}`));
    rows = rows.filter((row) => !row.value.startsWith(pid + '/') || live.has(row.value));
    const have = new Set(rows.map((row) => row.value));
    for (const id of ids) {
      const value = `${pid}/${id}`;
      if (have.has(value)) continue;
      const cfg = configured[id];
      rows.push({ value, name: cfg?.name ?? id, configured: !!cfg });
      have.add(value);
    }
  }
  return rows;
}
