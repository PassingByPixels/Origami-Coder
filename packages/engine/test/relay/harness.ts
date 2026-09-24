/** Shared helpers for the relay tests: real sockets against a real Bun.serve. */

export function makeRid(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url")
}

/** A frame shaped like the wire spec header: version, role, seq, then filler. */
export function frame(role: 1 | 2, seq: number, payload = 32): Uint8Array {
  const bytes = new Uint8Array(18 + payload)
  bytes[0] = 1
  bytes[1] = role
  new DataView(bytes.buffer).setUint32(2, seq, false)
  bytes.fill(0xab, 18)
  return bytes
}

export interface CloseInfo {
  code: number
  reason: string
}

/** A test client that queues frames and the close event so no message can be missed. */
export class Peer {
  readonly ws: WebSocket
  readonly opened: Promise<void>
  private readonly frames: Uint8Array[] = []
  private readonly frameWaiters: Array<(frame: Uint8Array) => void> = []
  /** TEXT frames — the relay's presence control frames — kept in their OWN
   *  queue. They are not part of the opaque frame stream, and a test that says
   *  "the next thing this peer was sent" means a frame, not a control. */
  private readonly controls: string[] = []
  private readonly controlWaiters: Array<(text: string) => void> = []
  private closeInfo: CloseInfo | undefined
  private readonly closeWaiters: Array<(info: CloseInfo) => void> = []

  constructor(url: string) {
    this.ws = new WebSocket(url)
    this.ws.binaryType = "arraybuffer"
    this.opened = new Promise((resolve, reject) => {
      this.ws.addEventListener("open", () => resolve())
      this.ws.addEventListener("error", () => reject(new Error("websocket error")))
    })
    this.ws.addEventListener("message", (event) => {
      const raw = event.data
      if (typeof raw === "string") {
        const control = this.controlWaiters.shift()
        if (control) control(raw)
        else this.controls.push(raw)
        return
      }
      const bytes = raw instanceof ArrayBuffer ? new Uint8Array(raw) : raw instanceof Uint8Array ? raw : new Uint8Array(0)
      const waiter = this.frameWaiters.shift()
      if (waiter) waiter(bytes)
      else this.frames.push(bytes)
    })
    this.ws.addEventListener("close", (event) => {
      const info = { code: event.code, reason: event.reason }
      this.closeInfo = info
      while (this.closeWaiters.length > 0) this.closeWaiters.shift()!(info)
    })
  }

  send(data: Uint8Array | string) {
    if (typeof data === "string") this.ws.send(data)
    else this.ws.send(data)
  }

  nextFrame(timeoutMs = 5000): Promise<Uint8Array> {
    const queued = this.frames.shift()
    if (queued) return Promise.resolve(queued)
    return new Promise((resolve, reject) => {
      // A waiter left behind by a timeout (e.g. a `silentFor()` that ran out
      // the clock) must not sit in the queue: the NEXT real frame would be
      // handed to this already-abandoned callback and silently vanish,
      // instead of reaching whichever `nextFrame()` call is actually waiting.
      const waiter = (bytes: Uint8Array) => {
        clearTimeout(timer)
        resolve(bytes)
      }
      const timer = setTimeout(() => {
        const index = this.frameWaiters.indexOf(waiter)
        if (index !== -1) this.frameWaiters.splice(index, 1)
        reject(new Error("timed out waiting for a frame"))
      }, timeoutMs)
      this.frameWaiters.push(waiter)
    })
  }

  closed(timeoutMs = 5000): Promise<CloseInfo> {
    if (this.closeInfo) return Promise.resolve(this.closeInfo)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for close")), timeoutMs)
      this.closeWaiters.push((info) => {
        clearTimeout(timer)
        resolve(info)
      })
    })
  }

  /** The next presence control frame ("peer:present" / "peer:absent"). */
  nextControl(timeoutMs = 5000): Promise<string> {
    const queued = this.controls.shift()
    if (queued !== undefined) return Promise.resolve(queued)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for a control frame")), timeoutMs)
      this.controlWaiters.push((text) => {
        clearTimeout(timer)
        resolve(text)
      })
    })
  }

  /** Every control frame seen so far, without consuming the queue. */
  get seenControls(): readonly string[] {
    return this.controls
  }

  /** No frame within the window — used to prove a peer is NOT sent something. */
  async silentFor(ms: number): Promise<boolean> {
    try {
      await this.nextFrame(ms)
      return false
    } catch {
      return true
    }
  }

  close() {
    this.ws.close()
  }
}

export async function connect(
  base: string,
  rid: string,
  role: "desktop" | "phone",
  after?: number,
  lane?: "bulk",
): Promise<Peer> {
  const afterSuffix = after === undefined ? "" : `&after=${after}`
  const laneSuffix = lane === undefined ? "" : `&lane=${lane}`
  const peer = new Peer(`ws://${base}/r/${rid}?role=${role}${afterSuffix}${laneSuffix}`)
  await peer.opened
  return peer
}
