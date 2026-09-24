// t-ty02bb. The Connections card read "NOT READY: Claude (subscription) has not
// been checked yet; reload the provider list." on 0.4.170: the card asks the
// HOST engine (no chat open), and only a provider-list build ran Gate B, which
// that engine never does. These tests go through the real ACP service.
//
// No test here runs a real `claude`: PATH points at an empty folder, so Gate B
// answers `cli-missing` without spawning anything, and the one probe that must
// see a CLI uses the fake from packages/llm.

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import type { AgentSideConnection, SessionNotification } from "@agentclientprotocol/sdk"
import type { OrigamiClient } from "@origami/sdk/v2"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir as osTmpdir } from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { ClaudeCli } from "@origami/llm/route"
import * as ACPService from "@/acp/service"
import { ClaudeSubscription } from "@/provider/claude-subscription"
import { tmpdir } from "../fixture/fixture"

const FAKE = [process.execPath, path.resolve(import.meta.dir, "../../../llm/test/fixtures/claude-cli/fake-claude.ts")]

let saved: Record<string, string | undefined> = {}
const setEnv = (key: string, value: string | undefined) => {
  if (!(key in saved)) saved[key] = process.env[key]
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

beforeEach(() => {
  ClaudeSubscription.resetMemo()
  // An API key in the environment is its own Gate B answer; clear any so the
  // answer below is the CLI one.
  for (const key of Object.keys(process.env))
    if (ClaudeCli.envConflicts({ [key]: process.env[key] }).length > 0) setEnv(key, undefined)
})
/** PATH -> an empty folder. After any fixture that needs git. */
const hideCli = () => {
  const empty = mkdtempSync(path.join(osTmpdir(), "no-claude-"))
  setEnv("PATH", empty) // process.env is case-insensitive on Windows: this is `Path` too
}
afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  saved = {}
  ClaudeSubscription.resetMemo()
})

describe("claude_subscription_status runs Gate B itself", () => {
  it("the first read replaces 'not been checked yet' with no provider-list build", async () => {
    hideCli()
    expect(ClaudeSubscription.readiness()).toMatchObject({ reason: expect.stringContaining("not been checked yet") })
    const answer = await Effect.runPromise(makeService().claudeSubscriptionStatus())
    expect(answer).toEqual({ state: "cli-missing" })
    expect(ClaudeSubscription.readiness()).toMatchObject({ type: "unready", kind: "cli-missing" })
  })

  it("the Refresh press (hard provider_refresh) runs Gate B again; a plain refresh does not", async () => {
    const dir = await tmpdir({ git: true })
    await using _dir = dir
    hideCli()
    const log = mkdtempSync(path.join(osTmpdir(), "fake-claude-status-"))
    writeFileSync(path.join(log, "scenario.json"), JSON.stringify({ version: "2.1.198 (Claude Code)" }))
    await ClaudeSubscription.check({
      command: FAKE,
      env: { ...process.env, FAKE_SCENARIO: path.join(log, "scenario.json"), FAKE_LOG: log },
    })
    const service = makeService()
    expect(await Effect.runPromise(service.claudeSubscriptionStatus())).toMatchObject({ state: "version-too-old" })

    await Effect.runPromise(service.providerRefresh({ cwd: dir.path }))
    expect(await Effect.runPromise(service.claudeSubscriptionStatus())).toMatchObject({ state: "version-too-old" })

    // The CLI is gone from PATH now: only a new probe can know that.
    await Effect.runPromise(service.providerRefresh({ cwd: dir.path, hard: true }))
    expect(await Effect.runPromise(service.claudeSubscriptionStatus())).toEqual({ state: "cli-missing" })
  }, 120_000)
})

function makeService() {
  const sdk = {
    config: {
      providers: () => Promise.resolve({ data: { providers: [], default: {} } }),
      get: () => Promise.resolve({ data: {} }),
      refresh: () => Promise.resolve({ data: true }),
    },
    app: { agents: () => Promise.resolve({ data: [] }), skills: () => Promise.resolve({ data: [] }) },
    command: { list: () => Promise.resolve({ data: [] }) },
    session: { list: () => Promise.resolve({ data: [] }) },
  } as unknown as OrigamiClient
  const connection = {
    sessionUpdate: (_update: SessionNotification) => Promise.resolve(),
    extNotification: () => Promise.resolve(),
  } as unknown as Pick<AgentSideConnection, "sessionUpdate" | "extNotification">
  return ACPService.make({ sdk, connection })
}
