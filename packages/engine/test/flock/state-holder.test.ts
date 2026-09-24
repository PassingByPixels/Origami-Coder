// `flock_state` NAMES THE HOLDER — the piece the pane needs to tell "another
// window" from "a sibling chat in THIS one".
//
// `flock-owner.json` is a machine-wide file: any engine can read who holds the
// relay sockets, not only the holder itself. Before this, `flock_state` said
// only `transport: "other-engine"`, which is true whether the holder is a
// window across the desk or a second chat tab open right here — and the
// extension has no way to route around the second case without a pid to
// compare against its own sessions' engine pids. This proves the read, not the
// routing: `pickFlockClient` (webview/dashboard side) and the extension seam
// are exercised in the vscode package's own tests.
import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { ACPFlock } from "@/acp/flock"
import { FlockOwnerLease } from "@/flock/owner-lease"

const dirs: string[] = []
const tmp = () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "flock-state-holder-"))
  dirs.push(directory)
  return directory
}
afterAll(() => {
  for (const directory of dirs.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

const writeLease = (directory: string, record: Record<string, unknown>) =>
  fs.writeFileSync(path.join(directory, FlockOwnerLease.FILE), JSON.stringify(record))

describe("flock_state — the holder field", () => {
  test("no lease file at all: holder is absent", () => {
    const directory = tmp()
    expect(ACPFlock.state({ directory }).holder).toBeUndefined()
  })

  test("a lease with an address: holder names the pid and where to reach it", () => {
    const directory = tmp()
    writeLease(directory, { pid: 4242, startedAt: "2026-09-06T00:00:00.000Z", heartbeatAt: Date.now(), httpBase: "http://127.0.0.1:53411" })
    expect(ACPFlock.state({ directory }).holder).toEqual({ pid: 4242, httpBase: "http://127.0.0.1:53411" })
  })

  test("a lease written by an older build has no httpBase: holder is absent rather than unaddressable", () => {
    const directory = tmp()
    writeLease(directory, { pid: 4242, startedAt: "2026-09-06T00:00:00.000Z", heartbeatAt: Date.now() })
    expect(ACPFlock.state({ directory }).holder).toBeUndefined()
  })

  test("junk on disk reads as no lease, same as FlockOwnerLease.read", () => {
    const directory = tmp()
    fs.writeFileSync(path.join(directory, FlockOwnerLease.FILE), "{ not json")
    expect(ACPFlock.state({ directory }).holder).toBeUndefined()
  })

  test("the holder is present even when THIS process is the one named — the pane compares pids, it does not infer from transport alone", () => {
    const directory = tmp()
    writeLease(directory, { pid: process.pid, startedAt: "2026-09-06T00:00:00.000Z", heartbeatAt: Date.now(), httpBase: "http://127.0.0.1:1" })
    expect(ACPFlock.state({ directory }).holder).toEqual({ pid: process.pid, httpBase: "http://127.0.0.1:1" })
  })
})
