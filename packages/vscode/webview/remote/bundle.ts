// Origami Remote — loading the REAL chat bundle.
//
// Extracted from `main.ts`, which is the boot ORDER and should read as one.
// The bundle cannot be a static <script> tag: `ChatView` reads the globals
// below during mount, and the session id only exists once the desktop's
// hydration has named it. See `shim.ts` for the rest of that argument.

import { native } from './native';

/** Phone-visible device name — the desktop shows it in the pairing list. The
 *  shell knows the real one ("Sam's iPhone"); a browser can only guess from
 *  the user agent, which is why this is async now. */
export async function deviceName(ua: string = navigator.userAgent): Promise<string> {
  const shell = native();
  if (shell) {
    try {
      const info = await shell.deviceInfo();
      if (info.name) return info.name;
    } catch {
      /* a shell that cannot name the device still gets the UA guess below */
    }
  }
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android phone';
  return 'Phone';
}

/** Load the untouched chat bundle, after pinning it to one session. */
export function loadChatBundle(sessionId: string): Promise<void> {
  const win = window as unknown as Record<string, unknown>;
  // ChatView reads these in onMount. Solo = ChatPane (transcript + composer);
  // empty would give us SidebarLauncher, which has neither.
  win.__ORIGAMI_SOLO_SESSION__ = sessionId;
  win.__ORIGAMI_VERSION__ = win.__ORIGAMI_VERSION__ ?? 'remote';
  win.__ORIGAMI_MEMORY__ = false;
  win.__ORIGAMI_BOARD__ = false;
  win.__ORIGAMI_RACE_COMPARE__ = null;
  win.__ORIGAMI_REPO_MAP__ = null;
  win.__ORIGAMI_COLLAB__ = null;
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'chat.js';
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('remote: chat bundle failed to load'));
    document.body.appendChild(s);
  });
}
