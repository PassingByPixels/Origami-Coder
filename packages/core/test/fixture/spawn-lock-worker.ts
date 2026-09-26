// Takes the spawn lock the test shares and holds it for `holdMs`.
import { SpawnLock } from "../../src/spawn-lock"

declare const self: Worker

self.onmessage = (event: MessageEvent<{ buffer: SharedArrayBuffer; holdMs: number }>) => {
  SpawnLock.adopt(event.data.buffer)
  const pause = new Int32Array(new SharedArrayBuffer(4))
  SpawnLock.hold(() => {
    self.postMessage("held")
    Atomics.wait(pause, 0, 0, event.data.holdMs)
  })
  self.postMessage("released")
}
