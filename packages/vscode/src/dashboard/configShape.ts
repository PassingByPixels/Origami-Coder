// A MIRROR of the parts of the engine's config schema that this extension's
// writers can actually violate — so a writer refuses before it persists a
// document the engine will throw the whole file away for.
//
// WHY A MIRROR AND NOT AN IMPORT. The real schema is Effect-based and lives in
// packages/core/src/v1/config/{config,provider}.ts, decoded by
// packages/engine/src/config/parse.ts. This monorepo installs per package:
// `effect`, `@origami/core` and `jsonc-parser` are all UNRESOLVABLE from
// packages/vscode, at runtime and under vitest alike (verified with
// require.resolve from this package). So the house mirror pattern applies, the
// same one modelBanner.ts / permissionOptions.ts / repoMapPillars.ts use — and
// with it the house obligation: a mirror needs a test that reads BOTH files and
// asserts they still agree. That test is configShape.test.ts; it parses the
// real schema source and fails when this file stops matching it.
//
// WHY IT MATTERS THAT THIS IS NARROW. The engine rejects a config file as a
// WHOLE (parse.ts throws InvalidError for one bad nested field, and
// config.ts's cachedGlobal swallows it into `{}` with a single log line no UI
// reads). So a writer that persists one NaN cost does not lose that field — it
// silently reverts the user to no configuration at all, with the panel still
// showing every pill green. This file's job is to catch the shapes a writer in
// THIS package can produce, not to re-implement the schema.
//
// Pure data in, string list out. No I/O, no `vscode` import.

/** The literal set `Model.modalities.{input,output}` accepts.
 *  MIRRORS packages/core/src/v1/config/provider.ts. */
export const MODALITIES = ['text', 'audio', 'image', 'video', 'pdf'] as const;

/** Top-level keys the engine's `ConfigV1.Info` declares. An undeclared one is
 *  not ignored: parse.ts's topLevelExtraKeys check rejects the file outright.
 *  MIRRORS the `Info` struct in packages/core/src/v1/config/config.ts. */
export const TOP_LEVEL_KEYS = [
  '$schema', 'shell', 'logLevel', 'server', 'command', 'skills', 'references', 'reference',
  'watcher', 'snapshot', 'plugin', 'agentPlugins', 'share', 'autoshare', 'autoupdate',
  'disabled_providers', 'enabled_providers', 'model', 'small_model', 'default_agent',
  'subagent_depth', 'username', 'mode', 'agent', 'provider', 'mcp', 'formatter', 'lsp',
  'instructions', 'layout', 'permission', 'tools', 'attachment', 'enterprise', 'tool_output',
  'compaction', 'flock', 'experimental',
] as const;

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** A number the engine's `Schema.Finite` accepts. NaN and Infinity are the two
 *  that get here: `JSON.stringify(NaN)` emits `null`, which fails Finite, so a
 *  single unparseable upstream price can zero the user's whole config. */
function finiteProblem(where: string, v: unknown): string | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return `${where} must be a finite number (got ${JSON.stringify(v) ?? String(v)})`;
  return null;
}

/** Check `provider.<id>.models.<id>` against the fields this extension writes:
 *  `cost` (writeModelConfig, from the OpenRouter catalog), `limit`
 *  (writeModelContextLimit) and `modalities` (writeModelVision). */
function modelProblems(where: string, model: unknown): string[] {
  const out: string[] = [];
  if (!isObj(model)) return [`${where} must be an object`];

  if (model.limit !== undefined) {
    const limit = model.limit;
    if (!isObj(limit)) out.push(`${where}.limit must be an object`);
    else {
      // `context` AND `output` are both REQUIRED siblings in the schema — a bare
      // { context } does not partially apply, it invalidates the whole file.
      for (const key of ['context', 'output']) {
        const p = finiteProblem(`${where}.limit.${key}`, limit[key]);
        if (p) out.push(p);
      }
      if (limit.input !== undefined) {
        const p = finiteProblem(`${where}.limit.input`, limit.input);
        if (p) out.push(p);
      }
    }
  }

  if (model.cost !== undefined) {
    const cost = model.cost;
    if (!isObj(cost)) out.push(`${where}.cost must be an object`);
    else {
      for (const key of ['input', 'output']) {
        const p = finiteProblem(`${where}.cost.${key}`, cost[key]);
        if (p) out.push(p);
      }
      for (const key of ['cache_read', 'cache_write']) {
        if (cost[key] === undefined) continue;
        const p = finiteProblem(`${where}.cost.${key}`, cost[key]);
        if (p) out.push(p);
      }
    }
  }

  if (model.modalities !== undefined) {
    const modalities = model.modalities;
    if (!isObj(modalities)) out.push(`${where}.modalities must be an object`);
    else {
      for (const key of ['input', 'output']) {
        const list = modalities[key];
        if (list === undefined) continue;
        if (!Array.isArray(list)) { out.push(`${where}.modalities.${key} must be an array`); continue; }
        const bad = list.filter((m) => !(MODALITIES as readonly unknown[]).includes(m));
        if (bad.length) out.push(`${where}.modalities.${key} has unknown ${bad.map((b) => JSON.stringify(b)).join(', ')} (allowed: ${MODALITIES.join(', ')})`);
      }
    }
  }

  if (model.attachment !== undefined && typeof model.attachment !== 'boolean') {
    out.push(`${where}.attachment must be true or false`);
  }
  return out;
}

/**
 * Everything wrong with `cfg` that would make the ENGINE discard the whole
 * file. Empty array = the engine will accept it.
 *
 * Deliberately not exhaustive — see the header. It covers the top-level key
 * set, the `model` pointer, and every numeric/enum field the seven writers in
 * this package put into a provider block.
 */
export function configShapeErrors(cfg: unknown): string[] {
  const out: string[] = [];
  if (!isObj(cfg)) return ['config must be a JSON object'];

  const known = new Set<string>(TOP_LEVEL_KEYS);
  const extra = Object.keys(cfg).filter((k) => !known.has(k));
  if (extra.length) out.push(`unrecognized top-level key${extra.length === 1 ? '' : 's'}: ${extra.join(', ')}`);

  if (cfg.model !== undefined && typeof cfg.model !== 'string') out.push('model must be a string');

  if (cfg.provider !== undefined) {
    if (!isObj(cfg.provider)) out.push('provider must be an object');
    else {
      for (const [pid, block] of Object.entries(cfg.provider)) {
        if (!isObj(block)) { out.push(`provider.${pid} must be an object`); continue; }
        if (block.name !== undefined && typeof block.name !== 'string') out.push(`provider.${pid}.name must be a string`);
        if (block.npm !== undefined && typeof block.npm !== 'string') out.push(`provider.${pid}.npm must be a string`);
        if (block.models === undefined) continue;
        if (!isObj(block.models)) { out.push(`provider.${pid}.models must be an object`); continue; }
        for (const [mid, model] of Object.entries(block.models)) {
          out.push(...modelProblems(`provider.${pid}.models.${mid}`, model));
        }
      }
    }
  }
  return out;
}
