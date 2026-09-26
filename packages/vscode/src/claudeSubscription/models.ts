// models.ts — the "Claude (subscription, experimental)" picker rows
// (t-tijdof). Modelled on claudeCode/models.ts, with two differences: (1) it
// is gated on the `origami.experimentalClaudeSubscription` setting, not on
// detection alone — an opt-in feature must not appear before the user opts
// in; (2) a NOT-READY state still gets a tab, carrying one non-selectable
// marker row, so the user can see WHY it is not ready instead of the group
// silently not existing (the acceptance item: "see why it is not ready").
//
// The label never says "Claude Code" (the Agent SDK branding rule, study
// section "Agent SDK overview": "Not permitted: 'Claude Code' ... for partner
// products") — this route removes Claude Code's own agent (see the study),
// so naming it as if it were Claude Code would misdescribe what runs.
import { readinessFixLine, type ClaudeSubscriptionReadiness } from './readiness';

/** The synthetic provider id. Not a configured provider — see
 *  claudeCode/models.ts's CLAUDE_CODE_PROVIDER for the same reasoning. */
export const CLAUDE_SUBSCRIPTION_PROVIDER = 'claude-subscription';
/** The tab's own name — the string the picker's tab and its tooltip/empty
 *  message key off. Deliberately not "Claude Code" anything. t-xu5o64: short,
 *  and the same words the engine's rows carry ("Claude (Sub)/<model>",
 *  provider/claude-subscription.ts `infoOf`); the experimental notice is given
 *  once, at the connection step (+ Add connection, the card, the disclosure). */
export const CLAUDE_SUBSCRIPTION_GROUP = 'Claude (Sub)';

const PREFIX = `${CLAUDE_SUBSCRIPTION_PROVIDER}/`;
/** Value suffix for the not-ready marker row — never a real alias, so it can
 *  never be mistaken for one even if `selectable` were dropped somewhere. */
const STATUS_ALIAS = '__status__';

/** The aliases, in the order the picker shows them (most capable first) —
 *  same four Claude Code offers; the CLI itself resolves each against the
 *  signed-in plan. */
export const CLAUDE_SUBSCRIPTION_ALIASES: readonly string[] = ['fable', 'opus', 'sonnet', 'haiku'];
const LABEL: Record<string, string> = { fable: 'Fable', opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku' };

export interface ClaudeSubscriptionRow {
  value: string;
  name: string;
  configured: false;
  visionState: '';
  group: string;
  groupDetail: string;
  /** False hides this row from the picker's SELECTABLE list (modelList.ts's
   *  `visibleModels`) while still letting it create the tab (offeredProviders.ts
   *  keys a tab off any row naming a `group`). Absent/true = ordinary, pickable
   *  row. Used only for the not-ready marker row. */
  selectable?: boolean;
}

/** Is this a pick the claude-subscription route owns rather than the engine? */
export function isClaudeSubscriptionModel(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

/** The bare alias for the route's `--model`-equivalent ('' for anything else,
 *  including the not-ready marker itself — it is never a real pick). */
export function claudeSubscriptionAlias(value: string): string {
  if (!isClaudeSubscriptionModel(value)) return '';
  const alias = value.slice(PREFIX.length);
  return CLAUDE_SUBSCRIPTION_ALIASES.includes(alias) ? alias : '';
}

/**
 * The rows to append to `modelOptions`.
 *
 * `enabled=false` (the setting is off): no rows at all — the group must not
 * appear where picking from it could not possibly work, same rule
 * claudeCodeModelRows follows for "no CLI".
 *
 * `enabled=true` and NOT ready: one marker row, so the tab exists and its
 * tooltip / empty-list message carries the fix line — nothing on it is
 * selectable.
 *
 * `enabled=true` and ready: the four real aliases, selectable.
 */
export function claudeSubscriptionModelRows(
  enabled: boolean,
  readiness: ClaudeSubscriptionReadiness,
): ClaudeSubscriptionRow[] {
  if (!enabled) return [];
  if (readiness.state !== 'ready') {
    return [{
      value: `${PREFIX}${STATUS_ALIAS}`,
      name: 'Not ready',
      configured: false,
      visionState: '',
      group: CLAUDE_SUBSCRIPTION_GROUP,
      groupDetail: readinessFixLine(readiness),
      selectable: false,
    }];
  }
  return CLAUDE_SUBSCRIPTION_ALIASES.map((alias) => ({
    value: `${PREFIX}${alias}`,
    // The engine's own rows read "<provider name>/<model name>" (acp/config-option.ts).
    name: `${CLAUDE_SUBSCRIPTION_GROUP}/${LABEL[alias] ?? alias}`,
    configured: false as const,
    visionState: '' as const,
    group: CLAUDE_SUBSCRIPTION_GROUP,
    groupDetail: CLAUDE_SUBSCRIPTION_GROUP,
  }));
}

/**
 * The engine's rows joined with the rows above (t-ty02bb).
 *
 * The engine lists the family's models even while its Gate B says no, so that
 * a request is refused with the reason instead of "model not found". On
 * 0.4.170 those rows were pickable in a not-ready tab: the owner picked Haiku
 * and learned why only when the first prompt failed. While not ready they are
 * dropped here, and the marker row carries the reason.
 *
 * While ready the engine's rows are the account's real catalog (t-xu5o64), so
 * they are the ONLY rows: each gets the group, which is what gives the family
 * its tab (offeredProviders.ts), and the host's four aliases are not added. On
 * 0.4.178 the aliases the catalog did not list by that exact value (`fable`,
 * `opus`: the CLI lists `claude-fable-5-1[1m]` and `opus[1m]`) were appended
 * as bare, unbadged rows. The aliases stand in only when the engine lists no
 * row of the family at all (no chat to ask yet).
 */
export function mergeClaudeSubscriptionRows<T extends { value: string; name?: string }>(
  engineRows: T[],
  subscriptionRows: ClaudeSubscriptionRow[],
  readiness: ClaudeSubscriptionReadiness,
  persisted: ReadonlySet<string> = new Set(),
): Array<T | ClaudeSubscriptionRow> {
  if (subscriptionRows.length === 0) return engineRows;
  if (readiness.state !== 'ready') {
    return [...engineRows.filter((row) => !isClaudeSubscriptionModel(row.value)), ...subscriptionRows];
  }
  if (!engineRows.some((row) => isClaudeSubscriptionModel(row.value))) return [...engineRows, ...subscriptionRows];
  const tab = { group: CLAUDE_SUBSCRIPTION_GROUP, groupDetail: CLAUDE_SUBSCRIPTION_GROUP };
  const covers = aliasCovers(engineRows, persisted);
  return engineRows.flatMap((row) => {
    if (!isClaudeSubscriptionModel(row.value)) return [row];
    if (covers.dropped.has(row.value)) return [];
    const id = row.value.slice(PREFIX.length);
    const label = (row.name ?? '').startsWith(`${CLAUDE_SUBSCRIPTION_GROUP}/`) ? row.name!.slice(CLAUDE_SUBSCRIPTION_GROUP.length + 1) : row.name;
    const stands = covers.by.get(row.value);
    return [{ ...row, ...tab, name: `${CLAUDE_SUBSCRIPTION_GROUP}/${readableName(id, label)}`, ...(stands ? { covers: stands } : {}) }];
  });
}

/** The family of a bare id: an alias (`opus`, `opus[1m]`) or a full id (`claude-fable-5-1[1m]`). */
function familyOf(id: string): string {
  const base = id.replace(/\[1m\]$/, '');
  return CLAUDE_SUBSCRIPTION_ALIASES.find((family) => base === family || base.startsWith(`claude-${family}-`)) ?? '';
}

/** t-y5ecbj: a row's picker name, never the raw id. MIRROR of the engine's
 *  `readableName` (provider/claude-subscription.ts), for rows an older engine or
 *  origami.json named by their id. */
function readableName(id: string, label?: string): string {
  const family = familyOf(id);
  const base = (label && label !== id ? label : '') || (family ? LABEL[family] ?? id : id);
  return id.endsWith('[1m]') && !/\b1M\b/i.test(base) ? `${base} (1M context)` : base;
}

/**
 * t-y5ecbj: which bare alias rows (`fable`, `opus`, ...) duplicate a row of
 * their family listed under another value (`claude-fable-5-1[1m]`, `opus[1m]`).
 * An engine lists its live catalog OR the pinned aliases, never both, so a
 * second row of one family comes from the origami.json block (`persisted`: a
 * pick persisted by writeModelConfig, or a vision override). A pair where
 * neither side is persisted is two real catalog rows and both stay. The kept row
 * `covers` the dropped value, so a chat saved on the alias is ticked on it.
 */
function aliasCovers(rows: Array<{ value: string }>, persisted: ReadonlySet<string>) {
  const ids = rows.filter((row) => isClaudeSubscriptionModel(row.value)).map((row) => row.value.slice(PREFIX.length));
  const dropped = new Set<string>();
  const by = new Map<string, string[]>();
  for (const alias of ids.filter((id) => CLAUDE_SUBSCRIPTION_ALIASES.includes(id))) {
    const live = ids.find((id) => !CLAUDE_SUBSCRIPTION_ALIASES.includes(id) && familyOf(id) === alias && (persisted.has(id) || persisted.has(alias)));
    if (!live) continue;
    dropped.add(`${PREFIX}${alias}`);
    by.set(`${PREFIX}${live}`, [...(by.get(`${PREFIX}${live}`) ?? []), `${PREFIX}${alias}`]);
  }
  return { dropped, by };
}

/** Why a pick of this model is refused now: '' for any other model, or when
 *  ready. Said in the chat BEFORE any prompt is sent (t-ty02bb). */
export function claudeSubscriptionPickRefusal(value: string, readiness: ClaudeSubscriptionReadiness): string {
  if (!isClaudeSubscriptionModel(value) || readiness.state === 'ready') return '';
  return `Claude (subscription) is not ready, so the model was not changed. ${readinessFixLine(readiness)}`;
}
