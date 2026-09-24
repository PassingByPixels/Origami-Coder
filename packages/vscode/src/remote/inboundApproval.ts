// Origami Remote — HOW A PERMISSION ANSWER FROM THE PHONE REACHES THE HOST.
//
// There is ONE road and it is the signature: the ask went out carrying an
// `approvalNonce` this desktop minted, and an approval comes back signed over
// that nonce with the ENROLLED key or not at all.
//
// A DENY carries no signature and is always honoured — a gate that made "no"
// slow would teach people to say yes. A PAGE WITH NO ENROLLED DEVICE CANNOT
// APPROVE: the verb gate already clamps it, and this is the second guard for a
// socket that answered the challenge with a key nothing ever enrolled.

import type { InboundDeps } from './inbound';

/** Named because a test asserts the sentence, not a substring of it. */
export const KEYLESS_APPROVAL =
  'remote: dropped an approval — this page has enrolled no device key, so it may watch only';

/** One `permission` reply. */
export async function permissionAnswer(msg: unknown, d: InboundDeps): Promise<void> {
  const optionId = (msg as { optionId?: unknown }).optionId;
  if (optionId === null || optionId === undefined) {
    d.deliver(msg);
    return;
  }
  if (d.auth.device === null) {
    d.status(KEYLESS_APPROVAL);
    return;
  }
  if (await d.privilege.approve(msg)) d.deliver(msg);
}
