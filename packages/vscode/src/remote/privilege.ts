// Origami Remote — THE PHONE DRIVING THE DESKTOP'S REAL PRIVILEGE SYSTEM.
//
// Two grants, one rule: every grant of authority from the phone is bound to a
// nonce THIS desktop minted for THAT grant, and signed by the key the desktop
// enrolled. A replayed frame or a copied pairing secret produces neither.
//
//   ASK   every `requestPermission` leaves here with a fresh `approvalNonce`;
//         an approval must come back signed over
//         utf8("origami-remote/v1/approve") || nonce || utf8(toolCallId)
//         || utf8(optionId), and the nonce is then spent. A DENY needs no
//         signature and is always honoured.
//   YOLO  `remote/set-mode-request` -> `remote/mode-challenge` (32 fresh bytes
//         per sessionId) -> `remote/set-mode` signed over
//         utf8("origami-remote/v1/set-mode") || nonce || utf8(sessionId) ||
//         utf8("yolo"). Bypass is then set through the SAME host message the
//         InputBar's own toggle posts.
// YOLO ends on facts, not a timer: the session closes, the phone reverts it, or
// the transport stops for good. A RECONNECT is not one of them. Nothing is
// persisted, so a restarted window comes back in Ask.

import { verifyByEnrolled, approvePayload, setModePayload, APPROVAL_NONCE_BYTES, MODE_NONCE_BYTES } from './authority';
import { b64urlEncode, randomBytes } from './crypto';
import type { EnrolledDevice } from './deviceAuth';
import { ModeReport } from './modeReport';

/** One session's mode, and WHO set it — the pane shows the device name and
 *  fingerprint, because "this chat is in YOLO" without an author is uncheckable. */
export interface ModeRecord {
  sessionId: string;
  mode: 'yolo';
  device: string;
  fp: string;
  at: number;
}

export interface PrivilegeDeps {
  /** The enrolled device, or null for a browser page. */
  enrolled: () => EnrolledDevice | null;
  /** Desktop -> phone. */
  send: (msg: unknown) => Promise<void>;
  /** Phone -> host, the same seam `deliver()` uses for every other message. */
  deliver: (msg: unknown) => void;
  status: (text: string) => void;
  now?: () => number;
  /** Bound on remembered nonces, so a phone cannot grow the map without limit. */
  max?: number;
}

/** Named because the tests assert the sentences, not substrings of them. */
export const APPROVAL_REFUSED = 'remote: dropped an approval from the phone — ';
export const MODE_REFUSED = 'remote: refused a mode change from the phone — ';
export const NO_NONCE = 'this approval answers no ask this desktop sent, or one already answered';
export const NO_CHALLENGE = 'no mode challenge is pending for that session';
export const MODE_SET = 'remote: the phone set this chat to YOLO — ';
export const MODE_REVERTED = 'remote: this chat is back to Ask — ';

/** What the host is posted to put a session into bypass, and back. */
const HOST_BYPASS = 'bypass';
const HOST_ASK_WIRE = 'ask'; // the phone-facing spelling of a revert (approveModeFailure.ts, the phone's own revert)
const HOST_ASK = 'default';

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

export class Privilege {
  /** approvalNonce per toolCallId, minted when the ask goes out. */
  private readonly nonces = new Map<string, Uint8Array>();
  /** mode-challenge nonce per sessionId, minted per set-mode-request. */
  private readonly challenges = new Map<string, Uint8Array>();
  private readonly sessions = new Map<string, ModeRecord>();
  private readonly report = new ModeReport();
  private readonly max: number;

  constructor(private readonly deps: PrivilegeDeps) {
    this.max = deps.max ?? 200;
  }

  /** The sessions this phone has escalated, oldest first. For the pane. */
  public get modes(): ModeRecord[] {
    return [...this.sessions.values()];
  }

  /**
     * EVERYTHING the desktop says to the phone passes through here. A `requestPermission`
     * is stamped with the nonce its approval must sign, once per toolCallId and reused —
     * a hydration replays asks the phone already holds, and a fresh nonce would make the
     * copy on its screen unanswerable. A `sessionClosed` forgets that session's mode.
     */
  public outbound(msg: unknown): unknown {
    const m = msg as { type?: unknown; toolCallId?: unknown; sessionId?: unknown } | null;
    this.report.note(m);
    if ((m?.type === 'sessionClosed' || (m?.type === 'remote/set-mode' && (m as { mode?: unknown }).mode === HOST_ASK_WIRE)) && typeof m.sessionId === 'string') {
      this.sessions.delete(m.sessionId);
      this.challenges.delete(m.sessionId);
      return msg;
    }
    if (m?.type !== 'requestPermission' || typeof m.toolCallId !== 'string') return msg;
    let nonce = this.nonces.get(m.toolCallId);
    if (!nonce) {
      nonce = randomBytes(APPROVAL_NONCE_BYTES);
      this.nonces.set(m.toolCallId, nonce);
      this.trim(this.nonces);
    }
    return { ...(msg as Record<string, unknown>), approvalNonce: b64urlEncode(nonce) };
  }

  /**
   * One `permission` reply that APPROVES, on a desk with a device enrolled. The
   * nonce is spent on success and on a bad signature alike, so an attacker gets
   * no unlimited attempts at one ask.
   */
  public async approve(msg: unknown): Promise<boolean> {
    const m = msg as { toolCallId?: unknown; optionId?: unknown; sig?: unknown; pub?: unknown };
    const toolCallId = str(m?.toolCallId);
    const nonce = this.nonces.get(toolCallId);
    if (!nonce) {
      this.deps.status(APPROVAL_REFUSED + NO_NONCE);
      return false;
    }
    this.nonces.delete(toolCallId);
    const verdict = await verifyByEnrolled({
      payload: approvePayload(nonce, toolCallId, str(m?.optionId)),
      sig: m?.sig,
      pub: m?.pub,
      enrolledPub: this.deps.enrolled()?.pub ?? null,
    });
    if (!verdict.ok) this.deps.status(APPROVAL_REFUSED + verdict.reason);
    return verdict.ok;
  }

  /** The two `remote/set-mode...` messages. True when this file handled it. */
  public async handle(msg: unknown): Promise<boolean> {
    const type = (msg as { type?: unknown } | null)?.type;
    if (type === 'remote/set-mode-request') {
      await this.challenge(msg);
      return true;
    }
    if (type !== 'remote/set-mode') return false;
    if ((msg as { mode?: unknown }).mode === 'yolo') await this.setYolo(msg);
    else this.revert(str((msg as { sessionId?: unknown }).sessionId), 'reverted from the phone');
    return true;
  }

  /** ONE per hydration, right behind the burst. modeReport.ts says why a report is not a grant. */
  public async sendModeState(): Promise<void> { await this.deps.send(this.report.frame(this.sessions)); }

  /** The transport stopped for good, or the pairing was revoked. Every escalated
   *  session goes back to Ask THROUGH THE HOST, not merely in this map. */
  public revertAll(): void {
    for (const sessionId of [...this.sessions.keys()]) this.deliverMode(sessionId, HOST_ASK);
    this.sessions.clear();
    this.challenges.clear();
    this.nonces.clear();
  }

  // ------------------------------------------------------------- internals --

  private async challenge(msg: unknown): Promise<void> {
    const sessionId = str((msg as { sessionId?: unknown }).sessionId);
    if (!sessionId) {
      this.deps.status(MODE_REFUSED + 'the request names no session');
      return;
    }
    const nonce = randomBytes(MODE_NONCE_BYTES);
    this.challenges.set(sessionId, nonce);
    this.trim(this.challenges);
    await this.deps.send({ type: 'remote/mode-challenge', v: 1, nonce: b64urlEncode(nonce), sessionId });
  }

  private async setYolo(msg: unknown): Promise<void> {
    const m = msg as { sessionId?: unknown; sig?: unknown; pub?: unknown };
    const sessionId = str(m.sessionId);
    const nonce = this.challenges.get(sessionId);
    if (!nonce) {
      this.deps.status(MODE_REFUSED + NO_CHALLENGE);
      return;
    }
    // Spent whatever the verdict: one challenge answers one request.
    this.challenges.delete(sessionId);
    const device = this.deps.enrolled();
    const verdict = await verifyByEnrolled({
      payload: setModePayload(nonce, sessionId, 'yolo'),
      sig: m.sig,
      pub: m.pub,
      enrolledPub: device?.pub ?? null,
    });
    if (!verdict.ok) {
      this.deps.status(MODE_REFUSED + verdict.reason);
      return;
    }
    this.sessions.set(sessionId, {
      sessionId,
      mode: 'yolo',
      device: device?.device || 'the paired phone',
      fp: device?.fp ?? '',
      at: (this.deps.now ?? Date.now)(),
    });
    this.deliverMode(sessionId, HOST_BYPASS);
    this.deps.status(MODE_SET + (device?.device || 'the paired phone'));
  }

  /** Back to Ask. No signature, no challenge: dropping authority must never fail. */
  private revert(sessionId: string, why: string): void {
    if (!sessionId) return;
    this.challenges.delete(sessionId);
    if (!this.sessions.delete(sessionId)) return;
    this.deliverMode(sessionId, HOST_ASK);
    this.deps.status(MODE_REVERTED + why);
  }

  /** The SAME message the InputBar's Actions row posts — the one road into the ruleset. */
  private deliverMode(sessionId: string, mode: string): void {
    this.deps.deliver({ type: 'setApproveMode', mode, sessionId });
  }

  private trim(map: Map<string, Uint8Array>): void {
    while (map.size > this.max) {
      const oldest = map.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  }
}
