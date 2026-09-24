// Origami Remote — the phone's half of the signed privilege road.
// `src/remote/privilege.ts` is the desk's half and the authority; this file
// only produces what that one verifies. Every grant of authority is signed
// over a nonce the desktop minted, with the key the desktop enrolled.
//
// Ask signs an approve over the nonce; deny is unsigned. Yolo intercepts
// the bundle's bypass control and re-drives it over the signed set-mode
// road instead of the desk's unsigned one. No Face ID without the shell:
// the session binding at connect already proved this phone to the desktop.

import { b64urlDecode, b64urlEncode } from './crypto';
import { applyModeFrame } from './modeState';
import { native } from './native';

/** Each family carries its own domain separator, so a signature over one can
 *  never be reinterpreted as another. Must match `src/remote/authority.ts`. */
export const APPROVE_DOMAIN = 'origami-remote/v1/approve';
export const SET_MODE_DOMAIN = 'origami-remote/v1/set-mode';

/** utf8(domain) || nonce bytes || utf8(each remaining field, in order). One
 *  builder, so the two layouts below cannot fall out of step with each other. */
function authorityPayload(domain: string, nonce: Uint8Array, fields: readonly string[]): Uint8Array {
  const te = new TextEncoder();
  const parts = [te.encode(domain), nonce, ...fields.map((f) => te.encode(f))];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** An approval of ONE option on ONE tool call, on ONE nonce. */
export function approvePayload(nonce: Uint8Array, toolCallId: string, optionId: string): Uint8Array {
  return authorityPayload(APPROVE_DOMAIN, nonce, [toolCallId, optionId]);
}

/** A switch of ONE session into ONE mode, on ONE challenge nonce. */
export function setModePayload(nonce: Uint8Array, sessionId: string, mode: string): Uint8Array {
  return authorityPayload(SET_MODE_DOMAIN, nonce, [sessionId, mode]);
}

/** 'ask' is the default; 'pending' is a YOLO request awaiting its challenge. */
export type Mode = 'ask' | 'pending' | 'yolo';

/** Bound on remembered nonces, so an asker that never replies can't grow this map. */
const MAX_ASKS = 200;

interface PendingAsk {
  nonce: Uint8Array;
  /** optionIds whose option was a reject kind — those are sent unsigned. */
  denies: Set<string>;
}

export interface PrivilegeOptions {
  /** Phone -> desktop, for the three remote/set-mode control frames this file raises. */
  send: (msg: unknown) => void;
  /** Every mode-map write calls this; the app repaints its chip from it. */
  onModeChange?: (sessionId: string, mode: Mode, reason?: string) => void;
  /** The key fingerprint, a display hint; the desk verifies pub, so absent costs nothing. */
  fp?: string;
}

/** Feed `inbound()` every desk message and wrap the outbound path in
 *  `outbound()`. Both are no-ops except the four message types above. */
export class PhonePrivilege {
  private readonly asks = new Map<string, PendingAsk>();
  private readonly modes = new Map<string, Mode>();

  constructor(private readonly opts: PrivilegeOptions) {}

  public mode(sessionId: string): Mode {
    return this.modes.get(sessionId) ?? 'ask';
  }

  /** The only writer of `modes`, so no change can skip the hook. */
  private setMode(sessionId: string, mode: Mode, reason?: string): void {
    this.modes.set(sessionId, mode);
    this.opts.onModeChange?.(sessionId, mode, reason);
  }

  /** Every inbound desk message. True means this file consumed it and it
   *  must stay off the webview bus, since the chat bundle has no arm for it. */
  public inbound(msg: unknown): boolean {
    const m = msg as { type?: unknown } | null;
    if (m?.type === 'requestPermission') {
      this.note(msg);
      return false;
    }
    if (applyModeFrame(msg, this.modes, (s, mode, why) => this.setMode(s, mode, why))) return true;
    if (m?.type !== 'remote/mode-challenge') return false;
    void this.answerChallenge(msg);
    return true;
  }

  /** Translates the bundle's `setApproveMode`, which the desk refuses by
   *  name, onto the signed road: `bypass` requests, `default` reverts,
   *  and unsupported modes are dropped rather than sent to be refused. */
  public handleSetApproveMode(msg: unknown, activeSessionId: string): boolean {
    const m = msg as { type?: unknown; mode?: unknown; sessionId?: unknown } | null;
    if (!m || m.type !== 'setApproveMode') return false;
    const mode = typeof m.mode === 'string' ? m.mode : '';
    // The bundle names the chat it drew the card for; the strip's active chat
    // is the fallback, and is what a message with no session can only mean.
    const sessionId = (typeof m.sessionId === 'string' && m.sessionId) || activeSessionId;
    if (!sessionId) {
      console.warn(`[remote] the chat bundle asked for approve mode "${mode}" with no session, and no chat is active — dropped`);
      return true;
    }
    const now = this.mode(sessionId);
    if (mode === 'bypass') {
      // Idempotent: a second tap mid-handshake or already in YOLO must not open a second one.
      if (now === 'ask') this.requestYolo(sessionId);
      return true;
    }
    if (mode === 'default') {
      if (now !== 'ask') this.revert(sessionId);
      return true;
    }
    console.warn(`[remote] the chat bundle asked for approve mode "${mode}", which has no signed road — dropped`);
    return true;
  }

  /** Every other message the bundle posts, on its way to the wire. Only a
   *  `permission` is touched; everything else goes to `send` unchanged. */
  public outbound(msg: unknown, send: (m: unknown) => void): void {
    if ((msg as { type?: unknown } | null)?.type !== 'permission') return send(msg);
    void this.signApproval(msg, send);
  }


  /** Record the desk's per-ask nonce and deny options so the matching
   *  reply can be signed. Re-noting on hydration replay is a no-op. */
  private note(msg: unknown): void {
    const m = msg as { toolCallId?: unknown; approvalNonce?: unknown; options?: unknown };
    if (typeof m.toolCallId !== 'string' || typeof m.approvalNonce !== 'string') return;
    let nonce: Uint8Array;
    try {
      nonce = b64urlDecode(m.approvalNonce);
    } catch {
      console.warn('[remote] an approvalNonce was not base64url — approvals for that ask stay unsigned');
      return;
    }
    const denies = new Set<string>();
    for (const opt of Array.isArray(m.options) ? (m.options as Array<Record<string, unknown>>) : []) {
      if (typeof opt?.optionId === 'string' && typeof opt.kind === 'string' && opt.kind.startsWith('reject')) {
        denies.add(opt.optionId);
      }
    }
    this.asks.set(m.toolCallId, { nonce, denies });
    while (this.asks.size > MAX_ASKS) {
      const oldest = this.asks.keys().next().value;
      if (oldest === undefined) break;
      this.asks.delete(oldest);
    }
  }

  /** Sign an outbound `permission` if it approves a gated ask; everything
   *  else forwards unchanged. */
  private async signApproval(msg: unknown, send: (m: unknown) => void): Promise<void> {
    const m = msg as { toolCallId?: unknown; optionId?: unknown };
    const toolCallId = typeof m.toolCallId === 'string' ? m.toolCallId : '';
    const ask = this.asks.get(toolCallId);
    // The ask is resolved either way; a spent nonce must never be signed twice.
    this.asks.delete(toolCallId);
    const optionId = m.optionId;
    const shell = native();
    if (!ask || !shell || typeof optionId !== 'string' || ask.denies.has(optionId)) return send(msg);
    let biometric = false;
    try {
      // Optional and shell-owned: read the toggle off deviceInfo(), the only caller.
      const info = (await shell.deviceInfo()) as { approvalsBiometric?: unknown };
      biometric = info.approvalsBiometric === true;
    } catch {
      // A shell that can't report the toggle still signs, just without Face ID.
    }
    try {
      const { sig, pub } = await shell.signWithDevice({
        payload: b64urlEncode(approvePayload(ask.nonce, toolCallId, optionId)),
        reason: 'Approve this action on the desktop',
        biometric,
      });
      send({ ...(msg as object), sig, pub, fp: this.opts.fp ?? '' });
    } catch (err: unknown) {
      // Face ID refused or key unavailable: send unsigned; the desk drops it (safe).
      console.warn('[remote] the shell refused to sign an approval; sending it unsigned', err);
      send(msg);
    }
  }


  /** Step 1: ask the desk to switch this session to YOLO. Inert in a browser:
   *  without the shell there's no key to satisfy the challenge. */
  private requestYolo(sessionId: string): void {
    if (!native()) return;
    this.setMode(sessionId, 'pending');
    this.opts.send({ type: 'remote/set-mode-request', v: 1, mode: 'yolo', sessionId });
  }

  /** Revert to Ask. No signature — dropping authority is always free. */
  private revert(sessionId: string): void {
    this.setMode(sessionId, 'ask');
    this.opts.send({ type: 'remote/set-mode', v: 1, mode: 'ask', sessionId });
  }

  /** Steps 2 and 3: sign the desk's fresh nonce and reply, silently. */
  private async answerChallenge(msg: unknown): Promise<void> {
    const m = msg as { sessionId?: unknown; nonce?: unknown };
    const sessionId = typeof m.sessionId === 'string' ? m.sessionId : '';
    // Not one we asked for: an unsolicited challenge must not sign bytes nobody chose.
    if (this.mode(sessionId) !== 'pending') return;
    const shell = native();
    let nonce: Uint8Array | undefined;
    try {
      if (typeof m.nonce === 'string') nonce = b64urlDecode(m.nonce);
    } catch {
      nonce = undefined;
    }
    if (!shell || !nonce) {
      console.warn('[remote] a mode-challenge could not be answered — staying in Ask');
      this.setMode(sessionId, 'ask', 'the switch to YOLO could not be signed');
      return;
    }
    try {
      const { sig, pub } = await shell.signWithDevice({
        payload: b64urlEncode(setModePayload(nonce, sessionId, 'yolo')),
        reason: 'Turn on YOLO for this session',
        biometric: false,
      });
      this.opts.send({ type: 'remote/set-mode', v: 1, mode: 'yolo', sessionId, sig, pub, fp: this.opts.fp ?? '' });
      this.setMode(sessionId, 'yolo');
    } catch (err: unknown) {
      console.warn('[remote] the shell refused to sign the YOLO set-mode; staying in Ask', err);
      this.setMode(sessionId, 'ask', 'the switch to YOLO could not be signed');
    }
  }
}
