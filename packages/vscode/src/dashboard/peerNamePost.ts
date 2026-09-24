// The peer-broker name post: the fresh-session post and the reattach replay, which both want the
// same "have a name? post it" shape.

export function postPeerName(
  peerName: string | undefined,
  sessionId: string,
  post: (msg: { type: 'peerName'; sessionId: string; peerName: string }) => void,
) {
  if (peerName) post({ type: 'peerName', sessionId, peerName });
}
