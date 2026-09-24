// chatBackdropSetting.ts — t-qn0wj5, proposal 24 (port of Mock-Redesign
// CHANGES.md #38). The one place this shell reads `origamicoder.chat.backdrop`,
// mirroring flockEnabled.ts's own shape: a single try/guarded read, default
// baked in here rather than trusted to a caller's fallback. DEFAULT TRUE — the
// backdrop is a static, no-cost decoration (a repeating CSS gradient), unlike
// Flock's relay socket, so an absent or malformed setting reads as "on".
import * as vscode from 'vscode';

export const CHAT_BACKDROP_SECTION = 'origamicoder.chat';
export const CHAT_BACKDROP_KEY = 'backdrop';

/** Is the chat pane's dot-grid backdrop on? Anything but an exact `false` is on. */
export function chatBackdropEnabled(): boolean {
  try {
    return vscode.workspace.getConfiguration(CHAT_BACKDROP_SECTION).get<boolean>(CHAT_BACKDROP_KEY) !== false;
  } catch {
    return true;
  }
}

// t-s9jr6u: the Settings view's "Dot-grid backdrop" row. Until now the setting
// had no control (settings.json only). The READ takes the `request*` prefix.
export const CHAT_BACKDROP_MESSAGE_TYPES = new Set(['requestChatBackdrop', 'chatBackdropSet']);

export interface ChatBackdropHost {
  post(message: Record<string, unknown>): void;
}

/** The reply goes through the panel's broadcast `post`, so every open chat
 *  pane hears it and redraws its backdrop without a reload. */
export async function handleChatBackdropMessage(
  host: ChatBackdropHost,
  m: { type?: string; [k: string]: unknown },
): Promise<void> {
  if (m.type === 'chatBackdropSet') {
    // Exact booleans only, the cacheWarmingSet rule: a string would read as ON.
    if (typeof m['enabled'] !== 'boolean') {
      host.post({ type: 'chatBackdropData', enabled: chatBackdropEnabled(), error: 'The backdrop takes true or false.' });
      return;
    }
    try {
      await vscode.workspace.getConfiguration(CHAT_BACKDROP_SECTION).update(CHAT_BACKDROP_KEY, m['enabled'], vscode.ConfigurationTarget.Global);
    } catch (e) {
      host.post({ type: 'chatBackdropData', enabled: chatBackdropEnabled(), error: e instanceof Error ? e.message : String(e) });
      return;
    }
  } else if (m.type !== 'requestChatBackdrop') return;
  host.post({ type: 'chatBackdropData', enabled: chatBackdropEnabled() });
}
