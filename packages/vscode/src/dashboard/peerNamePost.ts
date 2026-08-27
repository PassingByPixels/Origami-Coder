// The peer-broker name post — DashboardPanel.ts was at its cap, so this
// pair (fresh-session post + reattach replay) lives here instead. Both call
// sites want the same "have a name? post it" shape.

export function postPeerName(
  peerName: string | undefined,
  sessionId: string,
  post: (msg: { type: 'peerName'; sessionId: string; peerName: string }) => void,
) {
  if (peerName) post({ type: 'peerName', sessionId, peerName });
}
