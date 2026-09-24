// The pane's JOIN verbs: invite, join, answer a join, cancel. Extracted from
// groupControl.ts (t-sj32zl), which sat at its cap when the Accept step needed
// a verb there. Same seam, same rule: with Nests off nothing here may dial.

import type { GroupController } from './groupController';
import { registered } from './groupControl';

/** Nests off (t-s9jr6u): nothing that dials the relay may run. */
const NESTS_OFF = 'Nests is off. Turn it on to add or join a desk.';

/** The controller, for the verbs that dial the relay; refused in words otherwise. */
function live(): GroupController {
  const registration = registered();
  if (!registration) throw new Error('origami group: this window has no remote controller');
  if (!registration.enabled()) throw new Error(NESTS_OFF);
  return registration.target();
}

export async function groupInvite(): Promise<{ key: string; expiresAt: number }> {
  return live().invite();
}

export async function groupJoin(keyText: unknown): Promise<void> {
  await live().join(keyText);
}

/** Accept or Decline the desk that asked to join. Only Accept sends Kg. */
export async function groupAnswerJoin(accept: boolean): Promise<void> {
  await live().answerJoin(accept);
}

// With Nests off there is no invite to close: asking target() would construct
// the controller, and the controller is what opens sockets.
export function groupCancelInvite(): void {
  const registration = registered();
  if (registration?.enabled()) registration.target().closeInvite();
}
