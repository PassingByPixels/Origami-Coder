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
 *  message key off. Deliberately not "Claude Code" anything. */
export const CLAUDE_SUBSCRIPTION_GROUP = 'Claude (subscription, experimental)';

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
    name: LABEL[alias] ?? alias,
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
 * dropped here, and the marker row carries the reason. While ready the
 * engine's rows are the account's real catalog; an alias it already lists is
 * not added a second time (a duplicate value is a duplicate list key).
 */
export function mergeClaudeSubscriptionRows<T extends { value: string }>(
  engineRows: T[],
  subscriptionRows: ClaudeSubscriptionRow[],
  readiness: ClaudeSubscriptionReadiness,
): Array<T | ClaudeSubscriptionRow> {
  if (subscriptionRows.length === 0) return engineRows;
  if (readiness.state !== 'ready') {
    return [...engineRows.filter((row) => !isClaudeSubscriptionModel(row.value)), ...subscriptionRows];
  }
  const listed = new Set(engineRows.map((row) => row.value));
  return [...engineRows, ...subscriptionRows.filter((row) => !listed.has(row.value))];
}

/** Why a pick of this model is refused now: '' for any other model, or when
 *  ready. Said in the chat BEFORE any prompt is sent (t-ty02bb). */
export function claudeSubscriptionPickRefusal(value: string, readiness: ClaudeSubscriptionReadiness): string {
  if (!isClaudeSubscriptionModel(value) || readiness.state === 'ready') return '';
  return `Claude (subscription) is not ready, so the model was not changed. ${readinessFixLine(readiness)}`;
}
