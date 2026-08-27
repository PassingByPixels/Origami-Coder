import { describe, expect, it } from "bun:test"
import type { AgentSideConnection, SessionNotification } from "@agentclientprotocol/sdk"
import type { OrigamiClient } from "@origami/sdk/v2"
import { Effect } from "effect"
import * as ACPService from "@/acp/service"
import { Directory } from "@/acp/directory"
import type { Command } from "@/command"

/**
 * The other half of the lazy MCP prompt discovery (command/index.ts): a chat
 * opens on the commands known NOW, and the MCP-contributed ones are pushed as a
 * second `available_commands_update` when discovery lands. The client rebuilds
 * its list from each such message (`InputBar.svelte`), so no session restarts.
 */
describe("ACP late MCP command fold", () => {
  const command = (name: string): Command.Info => ({
    name,
    description: name,
    source: name.includes(":") ? "mcp" : "command",
    template: name,
    hints: [],
  })

  const snapshot = (commands: readonly Command.Info[]) =>
    Directory.build({
      directory: "/workspace",
      providers: {},
      modes: [{ id: "build", name: "build" }],
      defaultModeID: "build",
      commands,
    })

  const makeService = (settledCommands: (directory: string) => Promise<readonly Command.Info[]>) => {
    const updates: SessionNotification[] = []
    const refreshes: string[] = []
    const fast = snapshot([command("init")])
    const full = snapshot([command("init"), command("plugin:review")])

    const sdk = {
      session: { create: () => Promise.resolve({ data: { id: "ses_new" } }) },
    } as unknown as OrigamiClient

    const connection = {
      sessionUpdate: (update: SessionNotification) => {
        updates.push(update)
        return Promise.resolve()
      },
    } as Pick<AgentSideConnection, "sessionUpdate">

    const directory = Directory.Service.of({
      get: () => Effect.succeed(fast),
      refresh: (dir: string) =>
        Effect.sync(() => {
          refreshes.push(dir)
          return full
        }),
      variants: Directory.variants,
    })

    return {
      service: ACPService.make({ sdk, connection, directory, settledCommands }),
      updates,
      refreshes,
    }
  }

  const commandNames = (updates: readonly SessionNotification[]) =>
    updates
      .filter((update) => update.update.sessionUpdate === "available_commands_update")
      .map((update) =>
        (update.update as { availableCommands: readonly { name: string }[] }).availableCommands.map(
          (item) => item.name,
        ),
      )

  const settle = async (predicate: () => boolean, message: string) => {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (predicate()) return
      await Bun.sleep(10)
    }
    throw new Error(message)
  }

  it("answers session/new without waiting for MCP discovery, then pushes the folded list", async () => {
    let release = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const { service, updates, refreshes } = makeService(async () => {
      await gate
      return [command("init"), command("plugin:review")]
    })

    const result = await Effect.runPromise(service.newSession({ cwd: "/workspace", mcpServers: [] }))
    expect(result.sessionId).toBe("ses_new")

    // The chat is live and the first list is already out while discovery is
    // still blocked — this is the whole point of the change.
    await settle(() => commandNames(updates).length === 1, "first available_commands_update never arrived")
    expect(commandNames(updates)[0]).toEqual(["init"])
    expect(refreshes).toEqual([])

    release()

    await settle(() => commandNames(updates).length === 2, "folded available_commands_update never arrived")
    expect(commandNames(updates)[1]).toEqual(["init", "plugin:review"])
    // The cached snapshot is reloaded, because `prompt` resolves a typed
    // `/plugin:review` against it — a command the composer offers and the
    // prompt path cannot find would silently do nothing.
    expect(refreshes).toEqual(["/workspace"])
  })

  it("does not re-push or reload when discovery adds nothing", async () => {
    const { service, updates, refreshes } = makeService(async () => [command("init")])

    await Effect.runPromise(service.newSession({ cwd: "/workspace", mcpServers: [] }))

    await settle(() => commandNames(updates).length === 1, "first available_commands_update never arrived")
    await Bun.sleep(50)
    expect(commandNames(updates)).toHaveLength(1)
    expect(refreshes).toEqual([])
  })

  it("survives a discovery read that fails", async () => {
    const { service, updates, refreshes } = makeService(() => Promise.reject(new Error("engine unavailable")))

    const result = await Effect.runPromise(service.newSession({ cwd: "/workspace", mcpServers: [] }))

    expect(result.sessionId).toBe("ses_new")
    await settle(() => commandNames(updates).length === 1, "first available_commands_update never arrived")
    await Bun.sleep(50)
    expect(commandNames(updates)).toHaveLength(1)
    expect(refreshes).toEqual([])
  })
})
