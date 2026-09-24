// Origami Remote — THE PHONE IS NOT A SECOND SIDEBAR.
//
// `RemoteView` makes the phone look like one more attached webview, so every
// `DashboardPanel.post()` broadcast reaches it — which is what makes the phone
// work with no second code path, and what makes a reconnect expensive.
//
// So one DENY SET at the view boundary: `pipes.ts` owns the pipe, this owns
// what the phone is not sent. A deny set rather than an allowlist on purpose —
// an allowlist has to be built from what the mounted chat bundle really reads,
// and getting that wrong silently blanks the pane. Check the DASHBOARD bundle,
// not just `webview/remote`: the phone mounts the dashboard's ChatPane.

export { shapeForPhone } from './phonePictures';

/** The brand `RemoteView` stamps so the panel's replay can tell the phone from a tab. */
export const REMOTE_VIEW_BRAND = '__origamiRemoteView';

/** True for the webview `RemoteView` owns; anything else is a real VS Code webview. */
export function isRemoteWebview(webview: unknown): boolean {
  return (webview as Record<string, unknown> | null)?.[REMOTE_VIEW_BRAND] === true;
}

/** Broadcasts the phone is never sent. Each is a rebroadcast and neither is read
 *  by the phone's shell or by the chat pane it mounts. `remoteScope.ts`'s NEVER
 *  list drops the same two; the redundancy is deliberate. */
export const PHONE_DENIED_TYPES: ReadonlySet<string> = new Set([
  // Cron ticks and model load/unload — a desktop output-channel feed.
  'feedMessage',
  // The spend glidepath, every 30 minutes for ever (usageHistory.ts).
  'glidepathData',
]);

export function deniedToPhone(msg: unknown): boolean {
  const type = (msg as { type?: unknown } | null)?.type;
  return typeof type === 'string' && PHONE_DENIED_TYPES.has(type);
}

// ...and the one thing every phone frame carrying a PICTURE gets: never the
// model's base64 copy, always a capped JPEG thumbnail when one can be made.
// `shapeForPhone` moved to phonePictures.ts (t-dclrh8) once the read-image
// thumbnail and the browser-screenshot thumbnail both landed here and pushed
// this file over its architecture cap; the re-export above keeps callers
// (remoteView.ts, tests) unchanged.
