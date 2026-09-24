// The model picker's live-mirror projection: reconcile the engine's config-built catalog against
// what each self-hosted server actually serves now, so a tab shows the server's truth, not an
// accumulated history of everything origami.json ever held.
//
// Two guards stop one bad provider taking every other one down: pollableProviders() only offers
// http: URLs plus the https keyless-catalog gateway presets (any other https cloud provider keeps
// its own configured catalog), and every poll is caught PER PROVIDER.
//
// Display-prune only — nothing here writes origami.json; an unserved model keeps its config
// options, only its row disappears.

import type { ConfiguredProvider } from './firstFold';
import { KEY_ONLY_PRESETS } from './keyOnlyPresets';

/** One row of the picker's `modelOptions` broadcast. */
export interface ModelOptionRow {
  /** `<providerId>/<modelId>` — the value `setModel` is posted with. */
  value: string;
  name: string;
  /** True when origami.json already holds this model (picking it needs no write). */
  configured: boolean;
  /** Whether this model reads images and who said so (visionPin.ts's
   *  `VisionState`). Optional because the merge cannot invent one for a served id
   *  origami.json has never held: the PANEL fills every row in afterwards, and
   *  the merge's only duty is not to LOSE one it was given. */
  visionState?: string;
}

/**
 * The providers whose `/v1/models` can actually be polled. Two shapes qualify: `http:` self-hosted
 *  servers the node:http poller can dial (an https cloud provider is never matched by name), or
 *  `https:` when the provider id is a keyless-catalog gateway preset (OpenCode Zen/Go), gated by
 *  preset id, never by URL or name.
 * Each entry carries the block's apiKey when set, since a self-hosted server may enforce auth —
 *  without it the poll 401s and the live list silently stops tracking what the server serves.
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
 * Merge each pollable provider's LIVE model list into the configured catalog. When a server answers
 *  with at least one id: rows no longer served are removed, served ids missing from the catalog are
 *  added, and a served id matching a config key is reconciled onto it (display name + `configured:
 *  true`).
 * When the server does not answer at all, that provider is left exactly as configured — a running
 *  chat must never face an empty picker because a server was restarting.
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
