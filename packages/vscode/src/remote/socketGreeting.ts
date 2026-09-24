// Origami Remote — WHAT THE DESKTOP SAYS WHEN A SOCKET OPENS, AND WHEN THE
// PHONE COMES AND GOES. One rule with three entry points and one flag:
//
//   - `connecting` is a NEW SOCKET. Verification is per socket, so the device
//     verdict and the hydration generation both start again.
//   - `open` GREETS. The hello goes once; the device-key challenge rides EVERY
//     socket open and is re-offered when the phone comes back, because a send
//     made while the relay says `peer:absent` is dropped. Then a hydration: an
//     already-paired phone will not ask for one, since its socket never dropped.
//   - a relay control frame is the PRESENCE EDGE. `absent` pauses the fan-out;
//     `present` resumes and hydrates.
//
// A peer that REPLACED a verified one proves the key again first; a replacement
// that discarded no verdict is NOT acted on, since the frame may be a duplicate
// for the same phone. Every collaborator is injected.

import type { DeviceSession } from './deviceSession';
import type { HydrateGate } from './hydrateGate';
import { PEER_REPLACED, type PeerState } from './presence';
import { DESK_NONCE } from './remoteDelta';
import type { TransportStatus } from './transport';

export interface GreetingDeps {
  /** Whether the relay says a phone is attached. Owned by the controller. */
  peer: PeerState;
  /** ONE HYDRATION PER SOCKET. Opened here, spent by the controller. */
  gate: HydrateGate;
  auth: DeviceSession;
  /** The desk's name, as the phone shows it. */
  deviceName: string;
  /** Host -> phone, through the controller's one outbound path. */
  send: (msg: unknown) => Promise<void>;
  status: (text: string) => void;
  hydrate: () => void;
  /** Epoch ms of the PHONE's hello, or null while no phone has confirmed. */
  confirmedAt: () => number | null;
}

export class SocketGreeting {
  /** Said once per socket generation, and re-armed by an `arrived` edge — not by
   *  `connecting`: the reconnect ladder is answered by the presence edge after it. */
  private helloSent = false;

  constructor(private readonly d: GreetingDeps) {}

  /** A socket was opened or torn down by the controller: nothing said on it. */
  public reset(): void {
    this.helloSent = false;
  }

  public onTransportStatus(status: TransportStatus, detail?: string): void {
    this.d.status(`remote: ${status}${detail ? ` (${detail})` : ''}`);
    if (status === 'connecting') {
      this.d.auth.reset();
      this.d.gate.socket();
    }
    if (status === 'open') this.announce();
  }

  public onControl(text: string): void {
    const edge = this.d.peer.note(text);
    this.d.status(`remote: phone ${this.d.peer.presence}`);
    if (this.d.peer.paused) this.d.gate.absent();
    if (edge === null) return;
    // A phone that was really gone comes back to a NEW hydration; a flap does not.
    this.d.gate.arrived();
    const replaced = this.d.auth.peerArrived();
    // A replacement is a different client on the same pairing: it has nothing.
    if (replaced) {
      this.d.status(PEER_REPLACED);
      this.d.gate.socket();
    }
    if (edge === 'arrived') this.helloSent = false;
    else if (!replaced) return;
    this.announce();
  }

  /** Say hello, then push a hydration. `hydrate()` is idempotent (the gate). */
  private announce(): void {
    if (!this.helloSent) {
      this.helloSent = true;
      // `desk` is THIS extension host: session ids restart on every start.
      void this.d.send({ type: 'remote/hello', v: 1, device: this.d.deviceName, desk: DESK_NONCE });
    }
    void this.d.auth.offer((msg) => this.d.send(msg), !this.d.peer.paused);
    if (this.d.confirmedAt() === null) return;
    if (this.d.auth.blocked) this.d.auth.hold();
    else this.d.hydrate();
  }
}
