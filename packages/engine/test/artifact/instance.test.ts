// t-tijhw6 (scout B #22). `artifactStore()` memoises the open. A FAILED open
// (the data folder not writable, a locked database) was memoised too, so
// every artifact publish, route and ACP call in the process got the same
// rejection until the engine restarted. A failed open is not kept: the next
// call opens again.
import { afterAll, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { artifactStore, resetArtifactStore } from "@/artifact/instance"

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "artifact-instance-"))
afterAll(() => {
  resetArtifactStore()
  fs.rmSync(tmp, { recursive: true, force: true })
})

test("a failed open is not kept: the next call opens the store", async () => {
  // A folder cannot be made under a regular file, so this open rejects.
  const file = path.join(tmp, "not-a-folder")
  fs.writeFileSync(file, "")
  resetArtifactStore()

  await expect(artifactStore(path.join(file, "artifacts"))).rejects.toThrow()

  const store = await artifactStore(path.join(tmp, "artifacts"))
  expect(fs.existsSync(path.join(tmp, "artifacts", "artifacts.db"))).toBe(true)
  // A good store is still shared.
  expect(await artifactStore()).toBe(store)
  store.close()
})
