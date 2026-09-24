// Board data for the Labyrinth and Instructions views: the no-session guard,
// the failure-into-`error`-field shape, and a defensive read of the ACP reply.
import type { InstructionSet, RunStep, RunStepsResult } from '../acpExtTypes';

interface RunStepsSource {
  getRunSteps(sessionId: string, cwd?: string): Promise<RunStepsResult>;
}
interface InstructionsSource {
  listInstructions(cwd?: string): Promise<InstructionSet>;
}

export interface RunStepsPayload {
  sessionId: string;
  steps: RunStep[];
  truncated: boolean;
  total: number;
  error?: string;
}

export interface InstructionsPayload {
  entries: InstructionSet['entries'];
  totalChars: number;
  totalBytes: number;
  totalTokensApprox: number;
  tokensApproxMethod: InstructionSet['tokensApproxMethod'];
  error?: string;
}

const NO_SESSION = 'Open a chat first — this needs a live engine connection.';
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * A past run's steps. `truncated`/`total` are read defensively and NEVER
 * synthesised optimistically: an absent `total` falls back to the number of
 * steps actually received, so the pane can only under-claim, never over-claim.
 */
export async function runStepsPayload(
  client: RunStepsSource | null | undefined,
  sessionId: string,
  /** The run's own directory. A listed run may not belong to the active
   *  workspace, so blank lets the engine decide rather than risk an empty run. */
  cwd = '',
): Promise<RunStepsPayload> {
  const empty = { sessionId, steps: [], truncated: false, total: 0 };
  if (!sessionId) return { ...empty, error: 'No run was selected.' };
  if (!client) return { ...empty, error: NO_SESSION };
  try {
    const res = await client.getRunSteps(sessionId, cwd || undefined);
    const steps = Array.isArray(res?.steps) ? res.steps : [];
    return {
      sessionId,
      steps,
      truncated: res?.truncated === true,
      total: typeof res?.total === 'number' ? res.total : steps.length,
    };
  } catch (e) {
    return { ...empty, error: message(e) };
  }
}

/** The system-prompt inventory. Totals come from the engine, which computes
 *  them over the same entries it returns — they are not recomputed here. */
export async function instructionsPayload(
  client: InstructionsSource | null | undefined,
): Promise<InstructionsPayload> {
  const empty: InstructionsPayload = {
    entries: [],
    totalChars: 0,
    totalBytes: 0,
    totalTokensApprox: 0,
    tokensApproxMethod: 'chars/4',
  };
  if (!client) return { ...empty, error: NO_SESSION };
  try {
    const set = await client.listInstructions();
    return {
      entries: Array.isArray(set?.entries) ? set.entries : [],
      totalChars: set?.totalChars ?? 0,
      totalBytes: set?.totalBytes ?? 0,
      totalTokensApprox: set?.totalTokensApprox ?? 0,
      tokensApproxMethod: set?.tokensApproxMethod ?? 'chars/4',
    };
  } catch (e) {
    return { ...empty, error: message(e) };
  }
}
