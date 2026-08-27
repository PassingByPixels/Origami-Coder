// origami_change: proves the fix for the second swallow point in the same
// class as the interject incident. `agent.ts`'s `run()` is the top-level
// catch for anything that fails as a raw `Effect.die` defect instead of a
// typed `ACPService.Error` - exactly what `InstanceState` did with
// "InstanceRef not provided". `fromUnknownDefect` (acp/error.ts) is
// untouched and still returns the same redacted `ServiceFailureError`; what
// changed is that the raw defect, and which ACP method it died in, now
// reach the real engine log before the client's redacted error goes out.
//
// This drives the REAL `Agent` class end to end and reads the REAL log file
// - safe under test because `test/preload.ts` points `XDG_DATA_HOME` at a
// per-process tmp dir before any src/ import, so `Global.Path.log` never
// resolves to the user's actual `~/.local/share/origami/log`.

import { describe, expect, it } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { RequestError, type InitializeRequest } from "@agentclientprotocol/sdk"
import { Effect } from "effect"
import { Global } from "@origami/core/global"
import { Agent } from "@/acp/agent"
import type * as ACPService from "@/acp/service"

const marker = `agent-defect-log-marker-${Date.now()}-${Math.random().toString(36).slice(2)}`

/** A service whose `initialize` dies instead of failing typed - the same
 * class of failure as the interject incident (`InstanceState` calling
 * `Effect.die("InstanceRef not provided")` deep inside a handler that never
 * reached `request()`). Wrapped in `Effect.fn("ACP.initialize")`, matching
 * the real `service.ts` (`const initialize = Effect.fn("ACP.initialize")(...)`),
 * so this exercises the actual mechanism `run()` relies on for context: the
 * span name reaching `Cause.pretty`. Every other method is unused here. */
function makeDyingService(): ACPService.Interface {
  return {
    initialize: Effect.fn("ACP.initialize")(function* () {
      return yield* Effect.die(new Error(marker))
    }),
  } as unknown as ACPService.Interface
}

async function readLogFile() {
  const file = path.join(Global.Path.log, "origami.log")
  try {
    return await fs.readFile(file, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return ""
    throw error
  }
}

/** `Logger.toFile`'s default `batchWindow` is 1s (effect's Logger.js), so the
 * line does not necessarily land the instant the Effect completes - poll,
 * the same way `interject-instance.test.ts` polls session state, instead of
 * asserting on a fixed sleep. */
async function pollLogFileFor(text: string, timeoutMs = 8000) {
  const start = Date.now()
  let content = await readLogFile()
  while (!content.includes(text) && Date.now() - start < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 100))
    content = await readLogFile()
  }
  return content
}

describe("acp.agent defect logging", () => {
  it(
    "logs the raw defect and which ACP method it died in, but the client still gets the redacted ServiceFailureError",
    async () => {
      const agent = new Agent(makeDyingService())

      const rejection = await agent.initialize({} as unknown as InitializeRequest).then(
        () => undefined,
        (error: unknown) => error,
      )

      // Wire contract: unchanged - same shape test/acp/error.test.ts already
      // pins for `fromUnknownDefect` ("wraps unknown defects without leaking
      // raw details"). No message, no stack, no marker.
      expect(rejection).toBeInstanceOf(RequestError)
      const requestError = rejection as RequestError
      expect(requestError.code).toBe(-32603)
      expect(requestError.message).toBe("Internal error: Internal service failure")
      const wire = JSON.stringify(requestError.toErrorResponse())
      expect(wire).not.toContain(marker)

      // The real cause reached the log sink - this is the fix. Before it,
      // this assertion is what fails: the file never contains the marker.
      const logged = await pollLogFileFor(marker)
      expect(logged).toContain(marker)
      // "Whatever request/method context is available at that boundary":
      // every ACPService method is built with Effect.fn("ACP.xxx"), which
      // stamps a named span into the fiber trace that Cause.pretty renders -
      // this is what says WHICH handler died, without threading a method
      // name through every run() call site in agent.ts.
      expect(logged).toContain("ACP.initialize")
    },
    15_000,
  )
})
