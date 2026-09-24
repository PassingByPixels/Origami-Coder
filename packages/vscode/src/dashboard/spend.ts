// Monthly spend ledger for cloud providers (OpenRouter). The engine reports each session's
// CUMULATIVE cost; this accrues positive deltas into a per-month total, persisted at
// ~/.origami/spend.json, with per-session marks so a reload's re-reported total doesn't
// double-count. Rolls over on the 1st.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const SPEND_PATH = path.join(os.homedir(), '.origami', 'spend.json');
const BUDGET_PATH = path.join(os.homedir(), '.origami', 'budget.json');

export interface SpendState {
  /** Current month, "YYYY-MM". */
  month: string;
  /** Total USD accrued this month across all chats. */
  total: number;
  /** Per-session cumulative cost already counted, keyed by sessionId. */
  sessions: Record<string, number>;
}

function currentMonth(): string {
  return new Date().toISOString().slice(0, 7); // YYYY-MM
}

/** Read this month's ledger; a stored ledger from a previous month resets to a fresh zero total. */
export function readSpend(): SpendState {
  const month = currentMonth();
  try {
    const raw = JSON.parse(fs.readFileSync(SPEND_PATH, 'utf-8')) as Partial<SpendState>;
    if (raw && raw.month === month && typeof raw.total === 'number') {
      return {
        month,
        total: raw.total,
        sessions: (raw.sessions && typeof raw.sessions === 'object') ? raw.sessions : {},
      };
    }
  } catch {
    /* absent or unreadable — treat as empty */
  }
  return { month, total: 0, sessions: {} };
}

function writeSpend(state: SpendState): void {
  try {
    fs.mkdirSync(path.dirname(SPEND_PATH), { recursive: true });
    fs.writeFileSync(SPEND_PATH, JSON.stringify(state), 'utf-8');
  } catch {
    /* best-effort — spend tracking never blocks a turn */
  }
}

/** Accrue a session's latest cumulative cost — adds only the positive delta since it was last seen
 *  (idempotent across reloads). */
export function accrueSessionSpend(sessionId: string, sessionCumulativeCost: number): SpendState {
  if (!Number.isFinite(sessionCumulativeCost) || sessionCumulativeCost <= 0) return readSpend();
  const cur = readSpend();
  const seen = cur.sessions[sessionId] ?? 0;
  if (sessionCumulativeCost <= seen) return cur;
  const next: SpendState = {
    month: cur.month,
    total: cur.total + (sessionCumulativeCost - seen),
    sessions: { ...cur.sessions, [sessionId]: sessionCumulativeCost },
  };
  writeSpend(next);
  return next;
}

// A single monthly USD ceiling across all chats (cloud/OpenRouter spend). null = no cap; warn at
// 80%, hard-block at 100%.

export interface BudgetState {
  /** Monthly USD ceiling, or null for no cap. */
  monthly: number | null;
}

export function readBudget(): BudgetState {
  try {
    const raw = JSON.parse(fs.readFileSync(BUDGET_PATH, 'utf-8')) as Partial<BudgetState>;
    if (raw && typeof raw.monthly === 'number' && Number.isFinite(raw.monthly) && raw.monthly > 0) {
      return { monthly: raw.monthly };
    }
  } catch {
    /* absent — no cap */
  }
  return { monthly: null };
}

export function writeBudget(monthly: number | null): BudgetState {
  const next: BudgetState = {
    monthly: typeof monthly === 'number' && Number.isFinite(monthly) && monthly > 0 ? monthly : null,
  };
  try {
    fs.mkdirSync(path.dirname(BUDGET_PATH), { recursive: true });
    fs.writeFileSync(BUDGET_PATH, JSON.stringify(next), 'utf-8');
  } catch {
    /* best-effort */
  }
  return next;
}

/** True once this month's spend has reached the cap (100%). No cap ⇒ never. */
export function isOverBudget(): boolean {
  const { monthly } = readBudget();
  if (monthly === null) return false;
  return readSpend().total >= monthly;
}

// OAuth cap exclusion: an OAuth/subscription provider (Codex, Grok SuperGrok, ...) carries no real
// per-token spend, so the cap must not depend on it — a provider already known OAuth-connected must
// never inflate the blended OpenRouter ledger or trip the block on its own. OpenRouter's own
// accounting is untouched.

/** True when `providerId` currently holds an OAuth credential — pure, takes the caller's resolved
 *  set rather than reading the engine. */
export function isOAuthExcluded(providerId: string, oauthProviderIds: ReadonlySet<string>): boolean {
  return !!providerId && oauthProviderIds.has(providerId);
}

/** Whether the monthly cap should block a turn on this provider — mirrors the old bare provider
 *  regex, minus an OAuth-excluded provider. Pure and testable: `overBudget` is passed in, not read
 *  here. */
export function budgetBlocks(providerId: string, oauthProviderIds: ReadonlySet<string>, overBudget: boolean): boolean {
  if (isOAuthExcluded(providerId, oauthProviderIds)) return false;
  return /^(openrouter|openai|xai|anthropic)$/.test(providerId) && overBudget;
}

/** accrueSessionSpend, but a no-op for an OAuth-excluded provider's turn, so it never inflates the
 *  ledger the cap reads. */
export function accrueSessionSpendUnlessOAuth(
  sessionId: string,
  sessionCumulativeCost: number,
  providerId: string,
  oauthProviderIds: ReadonlySet<string>,
): SpendState {
  if (isOAuthExcluded(providerId, oauthProviderIds)) return readSpend();
  return accrueSessionSpend(sessionId, sessionCumulativeCost);
}
