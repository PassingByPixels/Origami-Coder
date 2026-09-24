// subagentStop.ts — t-q910fo: the host half of the drawer row's Stop.
//
// `sessionId` here is the CHILD's engine session id (`taskSessionId` on the tool
// card), NOT the chat's. It arrives from the engine on the task rider, so unlike
// `interject`/`shell_stop` there is nothing to resolve through engineSessionId.ts —
// translating it would be the bug, not the fix.
//
// Its own leaf, like backgroundShellStop.ts beside it: the one place that knows
// the method name, so the ext-method string exists once.

export interface SubagentStopClient {
  extMethod(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export function stopSubagent(client: SubagentStopClient, sessionId: string) {
  return client.extMethod('subagent_stop', { sessionId });
}

/** t-v5qi8q. How the row ends, from the engine's reply (engine acp/subagent-stop.ts):
 *  `cancelled` = it was running and the stop ended it; `completed`/`error` = its run
 *  had ALREADY ended; `not_found` = no job at all (a restarted engine), so nothing
 *  runs. Anything else (`running`) leaves the row to the engine's own marker. */
export function stopOutcome(status: unknown): 'completed' | 'error' | undefined {
  if (status === 'completed' || status === 'not_found') return 'completed';
  if (status === 'error' || status === 'cancelled') return 'error';
  return undefined;
}

/** Post-and-forget, with the failure reported on the chat that asked. NO CONFIRM
 *  anywhere on this path: a sub-agent is cheap to launch again, and a modal over
 *  a 240px drawer costs more than the mistake does. The message names the child
 *  so the sentence is about the row that was pressed. `settled` gets the row's end
 *  state: a stop on a child that had already ended must still settle its row. */
export function handleSubagentStop(
  client: SubagentStopClient | null | undefined,
  sessionId: unknown,
  label: unknown,
  failed: (message: string) => void,
  settled: (state: 'completed' | 'error') => void = () => undefined,
) {
  if (!client || typeof sessionId !== 'string' || !sessionId) return;
  const named = typeof label === 'string' && label ? label : sessionId;
  stopSubagent(client, sessionId).then(
    (reply) => { const state = stopOutcome(reply?.status); if (state) settled(state); },
    (e) => failed(`Could not stop ${named}: ${e instanceof Error ? e.message : String(e)}`),
  );
}
