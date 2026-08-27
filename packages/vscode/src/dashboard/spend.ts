// Monthly spend ledger for cloud providers (OpenRouter). The engine reports each
// session's CUMULATIVE cost (usage_update.cost.amount); this accrues the positive
// deltas into a per-month total across all chats, persisted at ~/.origami/spend.json
// so it survives session close + window reload. Per-session cumulative marks are
// stored too so a reload (which re-reports a session's whole cost) doesn't
// double-count. The month rolls over automatically (resets on the 1st).

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

/** Read this month's ledger. A stored ledger from a previous month resets to a
 *  fresh zero total (a new month = a new budget window). */
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

/** Accrue a session's latest CUMULATIVE cost. Adds only the positive delta since
 *  this session was last seen (idempotent across reloads), returns the updated
 *  month ledger. A `<= seen` value is a no-op. */
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

// ─── Monthly budget cap ──────────────────────────────────────────────────────
// A single monthly USD ceiling across all chats (cloud/OpenRouter spend). null =
// no cap. Warn at 80%, hard-block at 100% (enforced in the send path).

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

// ─── OAuth cap exclusion (oauth-cost) ────────────────────────────────────────
// An OAuth/subscription-connected provider (openai Codex ChatGPT, xai Grok
// SuperGrok, ...) carries no real per-token spend — the engine either already
// zeroes its cost.amount (codex.ts) or is being fixed to (xai.ts). Either way
// the CAP must not depend on that: a provider the ext already knows is
// OAuth-connected (provider_auth_list's `connected` map, via
// providerAuthPane.ts's oauthConnectedIds) must never inflate the blended
// "OpenRouter" ledger and must never trip "Cloud turns are blocked" on its
// own. OpenRouter's own accounting is untouched — it is never a member of
// `oauthProviderIds`.

/** True when `providerId` (e.g. "xai", off `provider/model`) currently holds
 *  an OAuth credential. Pure — takes the caller's already-resolved set rather
 *  than reading the engine itself, so it needs no live connection to test. */
export function isOAuthExcluded(providerId: string, oauthProviderIds: ReadonlySet<string>): boolean {
  return !!providerId && oauthProviderIds.has(providerId);
}

/** Whether the monthly cap should block a turn on this provider. Mirrors the
 *  old bare `/^(openrouter|openai|xai|anthropic)\//` gate, minus an OAuth-
 *  excluded provider, which never reaches the cap regardless of blended
 *  spend elsewhere. `overBudget` is passed in (not read here) so this stays
 *  pure and testable without touching the real budget/spend files. */
export function budgetBlocks(providerId: string, oauthProviderIds: ReadonlySet<string>, overBudget: boolean): boolean {
  if (isOAuthExcluded(providerId, oauthProviderIds)) return false;
  return /^(openrouter|openai|xai|anthropic)$/.test(providerId) && overBudget;
}

/** accrueSessionSpend, but a turn on an OAuth-excluded provider is a no-op —
 *  it must never inflate the ledger the cap reads. Returns the ledger
 *  unchanged in that case, same shape as accrueSessionSpend's own <=0 no-op. */
export function accrueSessionSpendUnlessOAuth(
  sessionId: string,
  sessionCumulativeCost: number,
  providerId: string,
  oauthProviderIds: ReadonlySet<string>,
): SpendState {
  if (isOAuthExcluded(providerId, oauthProviderIds)) return readSpend();
  return accrueSessionSpend(sessionId, sessionCumulativeCost);
}
