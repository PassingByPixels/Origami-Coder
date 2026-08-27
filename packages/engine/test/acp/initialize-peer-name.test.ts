import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import fsp from "fs/promises"
import os from "os"
import path from "path"
import { Effect } from "effect"
import type { OrigamiClient } from "@origami/sdk/v2"
import * as ACPService from "@/acp/service"
import { AgentBroker } from "@/origami/agent-broker"

// `initialize()`'s agentInfo._meta.peerName is the ONLY identity that answers
// "which chat is this" for a user addressing send_message/list_agents — see
// tool/agents.ts, where AgentBroker.self().name is exactly the string those
// tools resolve `to` against. Unlike the archetype/mode label the dashboard
// already calls "agentName" (a display default, never round-tripped to the
// engine), this one is genuinely per ENGINE PROCESS, i.e. per chat session
// (each AcpClient spawns its own origami-acp child — vscode/src/acpClient.ts).

let home: string
let previousHome: string | undefined

beforeEach(async () => {
  home = await fsp.mkdtemp(path.join(os.tmpdir(), "acp-init-peer-"))
  previousHome = process.env.ORIGAMI_TEST_HOME
  process.env.ORIGAMI_TEST_HOME = home
})

afterEach(async () => {
  if (previousHome === undefined) delete process.env.ORIGAMI_TEST_HOME
  else process.env.ORIGAMI_TEST_HOME = previousHome
  await fsp.rm(home, { recursive: true, force: true })
})

const sdk = {} as unknown as OrigamiClient

describe("ACP.initialize — agentInfo._meta.peerName", () => {
  it("carries this engine's registered peer-broker name", async () => {
    const broker = AgentBroker.start({ httpBase: "http://127.0.0.1:1", cwd: "/repos/cortex", kind: "interactive" })
    try {
      const service = ACPService.make({ sdk })
      const response = await Effect.runPromise(service.initialize({ protocolVersion: 1 }))

      expect(response.agentInfo?.name).toBe("Origami")
      expect((response.agentInfo as { _meta?: { peerName?: string } })._meta?.peerName).toBe(
        AgentBroker.displayName("/repos/cortex"),
      )
    } finally {
      await broker.stop()
    }
  })

  it("omits _meta entirely when this engine never registered a peer entry", async () => {
    // No AgentBroker.start() in this test — `self()` is undefined, exactly the
    // background-engine-that-opted-out case (agent-broker.ts start()).
    const service = ACPService.make({ sdk })
    const response = await Effect.runPromise(service.initialize({ protocolVersion: 1 }))

    expect(response.agentInfo?.name).toBe("Origami")
    expect((response.agentInfo as { _meta?: unknown })._meta).toBeUndefined()
  })
})
