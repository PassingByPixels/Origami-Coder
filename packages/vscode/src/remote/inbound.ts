// Origami Remote — WHAT THE DESKTOP DOES WITH EACH MESSAGE THE PHONE SENDS.
// Every branch takes its collaborators as injected functions.
// THE ORDER IS THE SECURITY RULE:
//   0. THE ALLOWLIST (`remoteVerbs.ts`) — default deny, and first: every gate
//      under it was decorative while the phone could post `setApproveMode`.
//   1. `remote/challenge-response` — the only thing an unverified socket may do
//      besides say hello, so it is answered before the gate.
//   2. `remote/hello` — the handshake and the moment a device key is enrolled.
//      A hello with a key that is not the enrolled one is dropped and named.
//   3. the gate — with a device enrolled nothing below runs until a signature
//      verified. The phone's `remote/snapshot` predates it, so it is HELD.
//   4. PRIVILEGE — the signed set-mode and the signed approval. A page with no
//      enrolled key may only watch.
//   5. `view.deliver()`.

import type { DeviceSession } from './deviceSession';
import { permissionAnswer } from './inboundApproval';
import type { PairingManager } from './pairing';
import type { Privilege } from './privilege';
import { verbVerdict, type RemoteCapability } from './remoteVerbs';

/** Named because a test asserts the sentence, not a substring of it. */
export const FOREIGN_DEVICE_PREFIX = 'remote: another device tried to use this pairing — fingerprint ';
export const HELD_UNVERIFIED = 'remote: waiting for the phone to prove the enrolled device key';
export const DROPPED_UNVERIFIED = 'remote: dropped a message — the phone has not proved the enrolled device key';
/** NOT a refusal: the desktop re-offers the challenge and the phone re-answers. */
export const REPEATED_ANSWER = 'remote: the phone answered the device-key challenge again — already verified';

export interface InboundDeps {
  auth: DeviceSession;
  privilege: Privilege;
  /** Read live, so a desk that narrows the envelope needs no reconnect. */
  capability: () => RemoteCapability;
  pairing: PairingManager;
  rid: () => string | null;
  send: (msg: unknown) => Promise<void>;
  deliver: (msg: unknown) => void;
  /** `remote/focus` — the chat the phone READS, for the shaper's focus only. */
  focus: (msg: unknown) => void;
  hydrate: () => void;
  revoke: (reason: string) => Promise<void>;
  status: (text: string) => void;
}

/** The device-key verdict. Its reason goes on the status line verbatim: naming
 *  which of the four refusals happened is the whole diagnostic value. */
async function onChallengeResponse(msg: unknown, d: InboundDeps): Promise<void> {
  const result = await d.auth.accept(msg, d.rid());
  if (result.duplicate) {
    d.status(REPEATED_ANSWER);
    return;
  }
  d.status(result.ok ? 'remote: the phone proved the enrolled device key' : `remote: device key refused (${result.reason})`);
  if (result.ok && d.auth.takeHold()) d.hydrate();
}

async function onHello(msg: unknown, d: InboundDeps): Promise<void> {
  const foreign = d.auth.foreignKey(msg);
  if (foreign) {
    // NOT a revoke: revoke-by-connecting would be free denial of service.
    d.status(FOREIGN_DEVICE_PREFIX + foreign);
    return;
  }
  // ENROLMENT IS THE CONFIRMING HELLO AND ONLY THAT. `pending` is read BEFORE
  // confirm() flips it. Enrolling on a later hello would let anyone holding a
  // copied Ks enrol THEIR key and lock the owner out.
  const confirming = d.pairing.pending;
  if (!(await d.pairing.confirm())) {
    await d.send({ type: 'remote/revoked' });
    await d.revoke('the phone said hello after the pairing window closed');
    return;
  }
  if (confirming) await d.auth.enrol(msg);
  d.status('remote: phone paired');
  if (!d.auth.blocked) {
    d.hydrate();
    return;
  }
  d.auth.hold();
  d.status(HELD_UNVERIFIED);
}

export async function dispatchFromPhone(msg: unknown, d: InboundDeps): Promise<void> {
  const type = (msg as { type?: unknown })?.type;

  // DEFAULT DENY, before anything else looks at the message.
  //
  // A PAIRING WITH NO ENROLLED DEVICE KEY IS WATCH-ONLY, whatever the desk
  // allows: the desk's envelope is a CEILING on a phone that proved a key, not a
  // floor under one that never had it. ENROLMENT, not this socket's verdict, is
  // the test — a client that answers with a key it minted itself IS verified.
  // An enrolled device that has not yet verified is stopped below by
  // `auth.blocked`, which says why.
  const allowed = verbVerdict(msg, d.auth.device === null ? 'watch' : d.capability());
  if (!allowed.allow) {
    d.status(allowed.status);
    return;
  }

  if (type === 'remote/challenge-response') return onChallengeResponse(msg, d);
  if (type === 'remote/hello') return onHello(msg, d);

  if (d.auth.blocked) {
    // The snapshot is the phone's "hydrate me", sent on the same socket open as
    // its hello — before it can have seen the challenge. Holding it and replaying
    // on the verdict is what makes a legitimate phone's first paint work.
    if (type === 'remote/snapshot') d.auth.hold();
    d.status(type === 'remote/snapshot' ? HELD_UNVERIFIED : DROPPED_UNVERIFIED);
    return;
  }

  if (type === 'remote/snapshot') {
    d.hydrate();
    return;
  }
  // NOT delivered: the chat the phone READS, and the cursors already stamped.
  if (type === 'remote/focus' || type === 'remote/cursors') { d.focus(msg); return; }
  // The signed grants, for every phone: with none enrolled `privilege.ts` has no
  // key to verify against and refuses by reason.
  if (await d.privilege.handle(msg)) return;
  if (type === 'permission') return permissionAnswer(msg, d);
  d.deliver(msg);
}
