import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import type { OrigamiClient } from "@origami/sdk/v2"
import { Agent } from "@/acp/agent"
import * as ACPService from "@/acp/service"
import { ACPCollab } from "@/collab/acp"
import type { CollabStore } from "@/collab/store"
import type { Agent as AgentRegistry } from "@/agent/agent"
import { ModelV2 } from "@origami/core/model"
import { ProviderV2 } from "@origami/core/provider"

const info = (input: Partial<AgentRegistry.Info> & { name: string }): AgentRegistry.Info => ({
  mode: "subagent",
  permission: [],
  options: {},
  ...input,
})

describe("collab agent projection", () => {
  it("treats only a truthy `collab` option as opted in", () => {
    expect(ACPCollab.collabCapable(info({ name: "plain" }))).toBe(false)
    expect(ACPCollab.collabCapable(info({ name: "off", options: { collab: false } }))).toBe(false)
    expect(ACPCollab.collabCapable(info({ name: "on", options: { collab: true } }))).toBe(true)
    // Frontmatter is swept into `options` unparsed, so a string "true" is what
    // a hand-written def actually produces.
    expect(ACPCollab.collabCapable(info({ name: "yaml", options: { collab: "true" } }))).toBe(true)
  })

  it("falls back to the slug when a definition carries no description", () => {
    expect(ACPCollab.agentEntry(info({ name: "alice" }))).toEqual({
      slug: "alice",
      displayName: "alice",
      model: null,
    })
  })

  it("puts the pinned model on the wire as one provider/model string", () => {
    expect(
      ACPCollab.agentEntry(
        info({
          name: "alice",
          description: "Alice Reviewer",
          model: { providerID: ProviderV2.ID.make("anthropic"), modelID: ModelV2.ID.make("claude-sonnet-4") },
        }),
      ),
    ).toEqual({ slug: "alice", displayName: "Alice Reviewer", model: "anthropic/claude-sonnet-4" })
  })

  const participant = (over: Partial<Parameters<typeof ACPCollab.participantEntry>[0]> = {}) =>
    ACPCollab.participantEntry(
      { collabId: "clb_1", agentSlug: "alice", sessionId: null, lastSeenSeq: 0, addedAt: 1, ...over },
      undefined,
    )

  it("omits sessionId until the agent has actually taken a turn", () => {
    // Omitted, never null: a shell tests presence to decide whether there is a
    // session to open, and `null` would answer that question wrongly.
    expect("sessionId" in participant()).toBe(false)
    expect(participant({ sessionId: "ses_alice" }).sessionId).toBe("ses_alice")
  })

  it("keeps a removed member on the wire, marked with when it left", () => {
    const entry = participant({ removedAt: 9 })
    expect(entry.removedAt).toBe(new Date(9).toISOString())
    expect("removedAt" in participant()).toBe(false)
  })

  it("falls back to the slug when no definition backs a roster row any more", () => {
    expect(participant()).toEqual({ agentSlug: "alice", displayName: "alice", model: null })
  })

  it("omits an absent archivedAt rather than sending null", () => {
    const entry = ACPCollab.collabEntry({
      id: "clb_1",
      title: "Ship it",
      createdAt: 5,
      updatedAt: 6,
      loopBreakerCap: null,
      lead: null,
      objective: null,
      concurrency: null,
      flavor: null,
    })
    expect(entry).toEqual({
      id: "clb_1",
      title: "Ship it",
      createdAt: new Date(5).toISOString(),
      loopBreakerCap: null,
      lead: null,
      objective: null,
      concurrency: null,
      // A room that was never given a flavor projects the RESOLVED one, not the
      // raw null: an unset flavor and `discuss` are the same room.
      flavor: "discuss",
    })
    expect("archivedAt" in entry).toBe(false)
  })

  it("carries the lead and the objective on every collab entry", () => {
    const entry = ACPCollab.collabEntry({
      id: "clb_1",
      title: "Ship it",
      createdAt: 5,
      updatedAt: 6,
      loopBreakerCap: 3,
      lead: "alice",
      objective: "cut the release",
      concurrency: 2,
      flavor: "council",
    })
    expect(entry.lead).toBe("alice")
    expect(entry.objective).toBe("cut the release")
    // The dispatch width rides the same entry: a shell that can draw the hop
    // cap has to be able to draw this beside it.
    expect(entry.concurrency).toBe(2)
    // ...and so does the room's KIND, resolved rather than raw.
    expect(entry.flavor).toBe("council")
  })

  it("reads a flavor this build does not know as the safest one it does", () => {
    // A room written by a newer shell must not start dispatching in parallel on
    // an engine that cannot enforce the write gate behind that flavor.
    const entry = ACPCollab.collabEntry({
      id: "clb_1",
      title: "Ship it",
      createdAt: 5,
      updatedAt: 6,
      loopBreakerCap: null,
      lead: null,
      objective: null,
      concurrency: null,
      flavor: "senate",
    })
    expect(entry.flavor).toBe("discuss")
  })
})

describe("collab message projection", () => {
  const message = (over: Partial<CollabStore.Message> = {}): CollabStore.Message => ({
    id: "clbm_1",
    collabId: "clb_1",
    seq: 4,
    authorId: "alice",
    authorKind: "agent",
    kind: "say",
    text: "done",
    mentions: [],
    taskId: null,
    trace: null,
    createdAt: 1700000000000,
    ...over,
  })

  it("turns the stored epoch into the ISO string the wire carries", () => {
    // The DB holds epoch-ms; every *At field on the wire is an ISO string, and
    // a shell that had to guess which it was given could not sort a log.
    expect(ACPCollab.messageEntry(message()).createdAt).toBe(new Date(1700000000000).toISOString())
  })

  it("carries kind, mentions, taskId and trace through unchanged", () => {
    const trace = [{ tool: "read", summary: "src/index.ts", status: "ok" as const }]
    const entry = ACPCollab.messageEntry(
      message({ kind: "ask", mentions: ["bob"], taskId: "clbt_1", trace, replyToSeq: 2 }),
    )
    expect(entry).toEqual({
      id: "clbm_1",
      seq: 4,
      authorId: "alice",
      authorKind: "agent",
      kind: "ask",
      text: "done",
      replyToSeq: 2,
      mentions: ["bob"],
      taskId: "clbt_1",
      trace,
      createdAt: new Date(1700000000000).toISOString(),
    })
  })

  it("sends replyToSeq as null rather than omitting it", () => {
    // Present-and-null, not absent: the ext types declare `number | null`, and
    // a missing key would make every reply-link check a two-way test.
    const entry = ACPCollab.messageEntry(message())
    expect("replyToSeq" in entry).toBe(true)
    expect(entry.replyToSeq).toBeNull()
  })
})

describe("collab task board projection", () => {
  const task = (over: Partial<CollabStore.Task> & { id: string; state: CollabStore.TaskState }): CollabStore.Task => ({
    collabId: "clb_1",
    title: over.id,
    owner: null,
    createdBy: "user",
    result: null,
    note: null,
    originSeq: null,
    createdAt: 1,
    updatedAt: 2,
    ...over,
  })

  it("puts everything still in play first and accepted work last", () => {
    const board = ACPCollab.taskBoard([
      task({ id: "a", state: "accepted" }),
      task({ id: "b", state: "open" }),
      task({ id: "c", state: "accepted" }),
      task({ id: "d", state: "done" }),
      task({ id: "e", state: "claimed" }),
    ])
    expect(board.map((entry) => entry.id)).toEqual(["b", "d", "e", "a", "c"])
  })

  it("caps the board, so an accepted backlog cannot crowd out live work", () => {
    const board = ACPCollab.taskBoard([
      ...Array.from({ length: 60 }, (_, index) => task({ id: `old-${index}`, state: "accepted" })),
      task({ id: "live", state: "open" }),
    ])
    expect(board).toHaveLength(ACPCollab.TASK_BOARD_LIMIT)
    expect(board[0]!.id).toBe("live")
  })

  it("turns both task timestamps into ISO strings", () => {
    const entry = ACPCollab.taskBoard([task({ id: "a", state: "open", createdAt: 5, updatedAt: 9 })])[0]!
    expect(entry.createdAt).toBe(new Date(5).toISOString())
    expect(entry.updatedAt).toBe(new Date(9).toISOString())
  })
})

describe("collab hop state", () => {
  it("reads a spent budget as the room waiting on a human", () => {
    // The number itself comes from the runner's live budget now, not from the
    // shape of the log: the hops a chain of asks spent leave no trailing agent
    // messages to count.
    expect(ACPCollab.suspended({ remaining: 6, cap: 6 })).toBe(false)
    expect(ACPCollab.suspended({ remaining: 1, cap: 6 })).toBe(false)
    expect(ACPCollab.suspended({ remaining: 0, cap: 6 })).toBe(true)
  })

  it("never reads an OFF budget as suspended", () => {
    // A cap of 0 is overnight mode. Reporting it as suspended would be the
    // exact opposite of what it means.
    expect(ACPCollab.suspended({ remaining: null, cap: null })).toBe(false)
  })
})

describe("collab service methods", () => {
  const stubSdk = {} as unknown as OrigamiClient

  const entry = (over: Partial<ACPCollab.CollabEntry> = {}): ACPCollab.CollabEntry => ({
    id: "clb_1",
    title: "t",
    createdAt: new Date(1).toISOString(),
    loopBreakerCap: null,
    lead: null,
    objective: null,
    flavor: "discuss" as const,
    concurrency: null,
    ...over,
  })

  const task: ACPCollab.TaskEntry = {
    id: "clbt_1",
    title: "ship it",
    owner: null,
    state: "open",
    createdBy: "user",
    result: null,
    note: null,
    originSeq: null,
    createdAt: new Date(1).toISOString(),
    updatedAt: new Date(1).toISOString(),
  }

  const serviceWith = (record: unknown[]) => {
    const collab: ACPCollab.Interface = {
      agents: (directory) => {
        record.push({ call: "agents", directory })
        return Effect.succeed({ agents: [] })
      },
      list: (directory) => {
        record.push({ call: "list", directory })
        return Effect.succeed({ collabs: [] })
      },
      create: (directory, input) => {
        record.push({ call: "create", directory, ...input })
        return Effect.succeed({ collab: entry({ title: input.title }) })
      },
      post: (directory, input) => {
        record.push({ call: "post", directory, ...input })
        return Effect.succeed({ seq: 1 })
      },
      preview: (directory, input) => {
        record.push({ call: "preview", directory, ...input })
        return Effect.succeed({ wake: [] })
      },
      state: (directory, input) => {
        record.push({ call: "state", directory, ...input })
        return Effect.succeed({
          collab: entry({ id: input.collabId }),
          participants: [],
          messages: [],
          agents: [],
          lead: null,
          objective: null,
          tasks: [],
          costTotals: [],
          hopState: { remaining: 6, cap: 6 },
          suspended: false,
        })
      },
      setCap: (directory, input) => {
        record.push({ call: "setCap", directory, ...input })
        return Effect.succeed({ ok: true as const })
      },
      setConcurrency: (directory, input) => {
        record.push({ call: "setConcurrency", directory, ...input })
        return Effect.succeed({ ok: true as const })
      },
      setFlavor: (directory, input) => {
        record.push({ call: "setFlavor", directory, ...input })
        return Effect.succeed({ ok: true as const })
      },
      setLead: (directory, input) => {
        record.push({ call: "setLead", directory, ...input })
        return Effect.succeed({ ok: true as const })
      },
      setObjective: (directory, input) => {
        record.push({ call: "setObjective", directory, ...input })
        return Effect.succeed({ ok: true as const })
      },
      taskAdd: (directory, input) => {
        record.push({ call: "taskAdd", directory, ...input })
        return Effect.succeed({ task })
      },
      taskUpdate: (directory, input) => {
        record.push({ call: "taskUpdate", directory, ...input })
        return Effect.succeed({ task })
      },
      review: (directory, input) => {
        record.push({ call: "review", directory, ...input })
        return Effect.succeed({ task })
      },
      ledger: (directory, input) => {
        record.push({ call: "ledger", directory, ...input })
        return Effect.succeed({ entries: [], totals: [] })
      },
      stop: (directory, input) => {
        record.push({ call: "stop", directory, ...input })
        return Effect.succeed({ ok: true as const })
      },
      stopAgent: (directory, input) => {
        record.push({ call: "stopAgent", directory, ...input })
        return Effect.succeed({ interrupted: false, dequeued: false })
      },
      redirect: (directory, input) => {
        record.push({ call: "redirect", directory, ...input })
        return Effect.succeed({ seq: 1 })
      },
      archive: (directory, input) => {
        record.push({ call: "archive", directory, ...input })
        return Effect.succeed({ ok: true as const })
      },
      unarchive: (directory, input) => {
        record.push({ call: "unarchive", directory, ...input })
        return Effect.succeed({ ok: true as const })
      },
      rename: (directory, input) => {
        record.push({ call: "rename", directory, ...input })
        return Effect.succeed({ ok: true as const })
      },
      addParticipant: (directory, input) => {
        record.push({ call: "addParticipant", directory, ...input })
        return Effect.succeed({ ok: true as const })
      },
      removeParticipant: (directory, input) => {
        record.push({ call: "removeParticipant", directory, ...input })
        return Effect.succeed({ ok: true as const })
      },
    }
    return ACPService.make({ sdk: stubSdk, collab })
  }

  it("passes the requested cwd and params through to every method", async () => {
    const record: unknown[] = []
    const service = serviceWith(record)
    await Effect.runPromise(service.collabAgents({ cwd: "/w" }))
    await Effect.runPromise(service.collabList({ cwd: "/w" }))
    await Effect.runPromise(service.collabCreate({ cwd: "/w", title: "Ship it", agentSlugs: ["alice"] }))
    await Effect.runPromise(service.collabPost({ cwd: "/w", collabId: "clb_1", text: "hi" }))
    await Effect.runPromise(service.collabState({ cwd: "/w", collabId: "clb_1", sinceSeq: 3 }))
    await Effect.runPromise(service.collabSetCap({ cwd: "/w", collabId: "clb_1", cap: 0 }))
    await Effect.runPromise(service.collabSetLead({ cwd: "/w", collabId: "clb_1", agentSlug: "alice" }))
    await Effect.runPromise(service.collabSetObjective({ cwd: "/w", collabId: "clb_1", objective: "ship" }))
    await Effect.runPromise(service.collabTaskAdd({ cwd: "/w", collabId: "clb_1", title: "ship it" }))
    await Effect.runPromise(
      service.collabTaskUpdate({ cwd: "/w", collabId: "clb_1", taskId: "clbt_1", action: "claim", owner: "alice" }),
    )
    await Effect.runPromise(service.collabPreview({ cwd: "/w", collabId: "clb_1", mentions: ["alice"] }))
    await Effect.runPromise(
      service.collabReview({ cwd: "/w", collabId: "clb_1", taskId: "clbt_1", verdict: "reject", note: "again" }),
    )
    await Effect.runPromise(service.collabStopAgent({ cwd: "/w", collabId: "clb_1", agentSlug: "alice" }))
    await Effect.runPromise(service.collabRedirect({ cwd: "/w", collabId: "clb_1", agentSlug: "bob", text: "do X" }))
    await Effect.runPromise(service.collabLedger({ cwd: "/w", collabId: "clb_1", limit: 5 }))
    await Effect.runPromise(service.collabArchive({ cwd: "/w", collabId: "clb_1" }))
    await Effect.runPromise(service.collabUnarchive({ cwd: "/w", collabId: "clb_1" }))
    await Effect.runPromise(service.collabRename({ cwd: "/w", collabId: "clb_1", title: "Renamed" }))
    await Effect.runPromise(service.collabAddParticipant({ cwd: "/w", collabId: "clb_1", agentSlug: "bob" }))
    await Effect.runPromise(service.collabRemoveParticipant({ cwd: "/w", collabId: "clb_1", agentSlug: "bob" }))

    expect(record).toEqual([
      { call: "agents", directory: "/w" },
      { call: "list", directory: "/w" },
      { call: "create", directory: "/w", title: "Ship it", agentSlugs: ["alice"] },
      { call: "post", directory: "/w", collabId: "clb_1", text: "hi" },
      { call: "state", directory: "/w", collabId: "clb_1", sinceSeq: 3 },
      { call: "setCap", directory: "/w", collabId: "clb_1", cap: 0 },
      { call: "setLead", directory: "/w", collabId: "clb_1", agentSlug: "alice" },
      { call: "setObjective", directory: "/w", collabId: "clb_1", objective: "ship" },
      { call: "taskAdd", directory: "/w", collabId: "clb_1", title: "ship it" },
      { call: "taskUpdate", directory: "/w", collabId: "clb_1", taskId: "clbt_1", action: "claim", owner: "alice" },
      { call: "preview", directory: "/w", collabId: "clb_1", mentions: ["alice"] },
      { call: "review", directory: "/w", collabId: "clb_1", taskId: "clbt_1", verdict: "reject", note: "again" },
      { call: "stopAgent", directory: "/w", collabId: "clb_1", agentSlug: "alice" },
      { call: "redirect", directory: "/w", collabId: "clb_1", agentSlug: "bob", text: "do X" },
      { call: "ledger", directory: "/w", collabId: "clb_1", limit: 5 },
      { call: "archive", directory: "/w", collabId: "clb_1" },
      { call: "unarchive", directory: "/w", collabId: "clb_1" },
      { call: "rename", directory: "/w", collabId: "clb_1", title: "Renamed" },
      { call: "addParticipant", directory: "/w", collabId: "clb_1", agentSlug: "bob" },
      { call: "removeParticipant", directory: "/w", collabId: "clb_1", agentSlug: "bob" },
    ])
  })

  it("omits sinceSeq entirely when the caller did not send one", async () => {
    const record: { sinceSeq?: number }[] = []
    const service = serviceWith(record)
    await Effect.runPromise(service.collabState({ cwd: "/w", collabId: "clb_1" }))
    expect("sinceSeq" in record[0]!).toBe(false)
  })

  it("omits every optional collab field the caller did not send", async () => {
    const record: Record<string, unknown>[] = []
    const service = serviceWith(record)
    await Effect.runPromise(service.collabCreate({ cwd: "/w", title: "t", agentSlugs: [] }))
    await Effect.runPromise(service.collabPost({ cwd: "/w", collabId: "clb_1", text: "hi" }))
    await Effect.runPromise(service.collabTaskUpdate({ cwd: "/w", collabId: "clb_1", taskId: "t", action: "accept" }))
    await Effect.runPromise(service.collabLedger({ cwd: "/w", collabId: "clb_1" }))
    await Effect.runPromise(service.collabPreview({ cwd: "/w", collabId: "clb_1" }))
    await Effect.runPromise(service.collabReview({ cwd: "/w", collabId: "clb_1", taskId: "t", verdict: "approve" }))
    // Absent, never undefined: the store distinguishes "leave it alone" from
    // "set it to nothing", and an explicit undefined would erase that.
    expect("objective" in record[0]!).toBe(false)
    expect("mentions" in record[1]!).toBe(false)
    expect(["result", "note", "owner"].some((key) => key in record[2]!)).toBe(false)
    expect("limit" in record[3]!).toBe(false)
    expect("mentions" in record[4]!).toBe(false)
    expect("note" in record[5]!).toBe(false)
  })

  it("falls back to the process cwd when none is supplied", async () => {
    const record: { directory?: string }[] = []
    const service = serviceWith(record)
    await Effect.runPromise(service.collabList({}))
    expect(record[0]!.directory).toBe(process.cwd())
  })
})

describe("collab ext method dispatch", () => {
  const seen: Record<string, unknown>[] = []
  const service = {
    collabAgents: (input: unknown) => {
      seen.push({ method: "agents", input })
      return Effect.succeed({ agents: [] })
    },
    collabList: (input: unknown) => {
      seen.push({ method: "list", input })
      return Effect.succeed({ collabs: [] })
    },
    collabCreate: (input: unknown) => {
      seen.push({ method: "create", input })
      return Effect.succeed({ collab: { id: "clb_1", title: "t", createdAt: 1, loopBreakerCap: null } })
    },
    collabPost: (input: unknown) => {
      seen.push({ method: "post", input })
      return Effect.succeed({ seq: 1 })
    },
    collabState: (input: unknown) => {
      seen.push({ method: "state", input })
      return Effect.succeed({ collabs: [] })
    },
    collabSetCap: (input: unknown) => {
      seen.push({ method: "setCap", input })
      return Effect.succeed({ ok: true })
    },
    collabSetLead: (input: unknown) => {
      seen.push({ method: "setLead", input })
      return Effect.succeed({ ok: true })
    },
    collabSetObjective: (input: unknown) => {
      seen.push({ method: "setObjective", input })
      return Effect.succeed({ ok: true })
    },
    collabTaskAdd: (input: unknown) => {
      seen.push({ method: "taskAdd", input })
      return Effect.succeed({ task: {} })
    },
    collabTaskUpdate: (input: unknown) => {
      seen.push({ method: "taskUpdate", input })
      return Effect.succeed({ task: {} })
    },
    collabPreview: (input: unknown) => {
      seen.push({ method: "preview", input })
      return Effect.succeed({ wake: [] })
    },
    collabReview: (input: unknown) => {
      seen.push({ method: "review", input })
      return Effect.succeed({ task: {} })
    },
    collabStopAgent: (input: unknown) => {
      seen.push({ method: "stopAgent", input })
      return Effect.succeed({ interrupted: false, dequeued: false })
    },
    collabRedirect: (input: unknown) => {
      seen.push({ method: "redirect", input })
      return Effect.succeed({ seq: 1 })
    },
    collabLedger: (input: unknown) => {
      seen.push({ method: "ledger", input })
      return Effect.succeed({ entries: [], totals: [] })
    },
    collabStop: (input: unknown) => {
      seen.push({ method: "stop", input })
      return Effect.succeed({ ok: true })
    },
    collabArchive: (input: unknown) => {
      seen.push({ method: "archive", input })
      return Effect.succeed({ ok: true })
    },
    collabUnarchive: (input: unknown) => {
      seen.push({ method: "unarchive", input })
      return Effect.succeed({ ok: true })
    },
    collabRename: (input: unknown) => {
      seen.push({ method: "rename", input })
      return Effect.succeed({ ok: true })
    },
    collabAddParticipant: (input: unknown) => {
      seen.push({ method: "addParticipant", input })
      return Effect.succeed({ ok: true })
    },
    collabRemoveParticipant: (input: unknown) => {
      seen.push({ method: "removeParticipant", input })
      return Effect.succeed({ ok: true })
    },
  } as unknown as ACPService.Interface

  const agent = () => new Agent(service)

  it("accepts the `_` wire prefix clients send for extension methods", async () => {
    expect(await agent().extMethod("_collab_list", {})).toEqual(await agent().extMethod("collab_list", {}))
  })

  it("forwards each method's params, omitting an absent cwd", async () => {
    seen.length = 0
    await agent().extMethod("collab_agents", { cwd: "/w" })
    await agent().extMethod("collab_create", { title: "Ship it", agentSlugs: ["alice", "bob"], cwd: "/w" })
    await agent().extMethod("collab_post", { collabId: "clb_1", text: "hi" })
    await agent().extMethod("collab_state", { collabId: "clb_1", sinceSeq: 4 })
    await agent().extMethod("collab_set_cap", { collabId: "clb_1", cap: null })
    await agent().extMethod("collab_set_lead", { collabId: "clb_1", agentSlug: null })
    await agent().extMethod("collab_set_objective", { collabId: "clb_1", objective: "ship it" })
    await agent().extMethod("collab_task_add", { collabId: "clb_1", title: "write the migration" })
    await agent().extMethod("collab_task_update", { collabId: "clb_1", taskId: "clbt_1", action: "done", result: "ok" })
    await agent().extMethod("collab_ledger", { collabId: "clb_1", limit: 20 })
    await agent().extMethod("collab_archive", { collabId: "clb_1" })
    await agent().extMethod("collab_unarchive", { collabId: "clb_1" })
    await agent().extMethod("collab_rename", { collabId: "clb_1", title: "Renamed", cwd: "/w" })
    await agent().extMethod("collab_add_participant", { collabId: "clb_1", agentSlug: "bob" })
    await agent().extMethod("collab_remove_participant", { collabId: "clb_1", agentSlug: "bob" })

    expect(seen).toEqual([
      { method: "agents", input: { cwd: "/w" } },
      { method: "create", input: { title: "Ship it", agentSlugs: ["alice", "bob"], cwd: "/w" } },
      { method: "post", input: { collabId: "clb_1", text: "hi" } },
      { method: "state", input: { collabId: "clb_1", sinceSeq: 4 } },
      { method: "setCap", input: { collabId: "clb_1", cap: null } },
      { method: "setLead", input: { collabId: "clb_1", agentSlug: null } },
      { method: "setObjective", input: { collabId: "clb_1", objective: "ship it" } },
      { method: "taskAdd", input: { collabId: "clb_1", title: "write the migration" } },
      { method: "taskUpdate", input: { collabId: "clb_1", taskId: "clbt_1", action: "done", result: "ok" } },
      { method: "ledger", input: { collabId: "clb_1", limit: 20 } },
      { method: "archive", input: { collabId: "clb_1" } },
      { method: "unarchive", input: { collabId: "clb_1" } },
      { method: "rename", input: { collabId: "clb_1", title: "Renamed", cwd: "/w" } },
      { method: "addParticipant", input: { collabId: "clb_1", agentSlug: "bob" } },
      { method: "removeParticipant", input: { collabId: "clb_1", agentSlug: "bob" } },
    ])
  })

  it("forwards mentions and objective, and omits them when absent", async () => {
    seen.length = 0
    await agent().extMethod("collab_post", { collabId: "clb_1", text: "hi", mentions: ["alice", "bob"] })
    await agent().extMethod("collab_post", { collabId: "clb_1", text: "hi" })
    await agent().extMethod("collab_create", { title: "t", agentSlugs: [], objective: "ship" })
    await agent().extMethod("collab_create", { title: "t", agentSlugs: [] })

    expect(seen.map((call) => call["input"])).toEqual([
      { collabId: "clb_1", text: "hi", mentions: ["alice", "bob"] },
      { collabId: "clb_1", text: "hi" },
      { title: "t", agentSlugs: [], objective: "ship" },
      { title: "t", agentSlugs: [] },
    ])
  })

  // `extMethod` validates params BEFORE it returns a promise, so a bad call
  // throws synchronously - a `.catch()` would sail straight past it.
  const rejects = async (method: string, params: Record<string, unknown>) => {
    try {
      await agent().extMethod(method, params)
      return undefined
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  }

  it("rejects a create without a usable title or roster", async () => {
    expect(await rejects("collab_create", { agentSlugs: ["alice"] })).toBeDefined()
    expect(await rejects("collab_create", { title: "", agentSlugs: ["alice"] })).toBeDefined()
    expect(await rejects("collab_create", { title: "t" })).toBeDefined()
    expect(await rejects("collab_create", { title: "t", agentSlugs: "alice" })).toBeDefined()
    expect(await rejects("collab_create", { title: "t", agentSlugs: ["alice", 7] })).toBeDefined()
    expect(await rejects("collab_create", { title: "t", agentSlugs: [] })).toBeUndefined()
  })

  it("rejects a per-collab call with no collab id", async () => {
    const methods = [
      "collab_post",
      "collab_state",
      "collab_set_cap",
      "collab_set_lead",
      "collab_set_objective",
      "collab_task_add",
      "collab_task_update",
      "collab_ledger",
      "collab_stop",
      "collab_archive",
      "collab_unarchive",
      "collab_rename",
      "collab_add_participant",
      "collab_remove_participant",
    ]
    const filled = {
      text: "hi",
      cap: null,
      title: "t",
      agentSlug: "bob",
      objective: "o",
      taskId: "t",
      action: "accept",
    }
    for (const method of methods) {
      expect(await rejects(method, filled)).toBeDefined()
      expect(await rejects(method, { collabId: "", ...filled })).toBeDefined()
    }
  })

  it("rejects a rename with no usable title", async () => {
    // An empty title would leave the stream unnameable in every list it
    // appears in, so it is refused at the door rather than stored.
    expect(await rejects("collab_rename", { collabId: "clb_1" })).toBeDefined()
    expect(await rejects("collab_rename", { collabId: "clb_1", title: "" })).toBeDefined()
    expect(await rejects("collab_rename", { collabId: "clb_1", title: 7 })).toBeDefined()
    expect(await rejects("collab_rename", { collabId: "clb_1", title: "Renamed" })).toBeUndefined()
  })

  it("rejects a roster change with no usable agent slug", async () => {
    for (const method of ["collab_add_participant", "collab_remove_participant"]) {
      expect(await rejects(method, { collabId: "clb_1" })).toBeDefined()
      expect(await rejects(method, { collabId: "clb_1", agentSlug: "" })).toBeDefined()
      expect(await rejects(method, { collabId: "clb_1", agentSlug: 7 })).toBeDefined()
      expect(await rejects(method, { collabId: "clb_1", agentSlug: "bob" })).toBeUndefined()
    }
  })

  it("rejects a post whose text is not a string", async () => {
    expect(await rejects("collab_post", { collabId: "clb_1" })).toBeDefined()
    expect(await rejects("collab_post", { collabId: "clb_1", text: 7 })).toBeDefined()
    // An EMPTY post is allowed: it is a real "carry on" that releases a
    // suspended stream, not a malformed call.
    expect(await rejects("collab_post", { collabId: "clb_1", text: "" })).toBeUndefined()
  })

  it("rejects a sinceSeq that is not an integer", async () => {
    expect(await rejects("collab_state", { collabId: "clb_1", sinceSeq: "4" })).toBeDefined()
    expect(await rejects("collab_state", { collabId: "clb_1", sinceSeq: 1.5 })).toBeDefined()
    expect(await rejects("collab_state", { collabId: "clb_1", sinceSeq: 0 })).toBeUndefined()
    expect(await rejects("collab_state", { collabId: "clb_1" })).toBeUndefined()
  })

  it("requires an explicit cap, and takes only null or a non-negative integer", async () => {
    // An ABSENT key must not read as "restore the default": a malformed call
    // would then quietly undo a deliberate overnight setting.
    expect(await rejects("collab_set_cap", { collabId: "clb_1" })).toBeDefined()
    expect(await rejects("collab_set_cap", { collabId: "clb_1", cap: -1 })).toBeDefined()
    expect(await rejects("collab_set_cap", { collabId: "clb_1", cap: 2.5 })).toBeDefined()
    expect(await rejects("collab_set_cap", { collabId: "clb_1", cap: "6" })).toBeDefined()
    expect(await rejects("collab_set_cap", { collabId: "clb_1", cap: 0 })).toBeUndefined()
    expect(await rejects("collab_set_cap", { collabId: "clb_1", cap: null })).toBeUndefined()
  })

  it("takes only an array of non-empty slugs as mentions", async () => {
    // A slug that decoded to nothing would be dropped silently and change who
    // the post reaches, so the whole call is refused instead.
    expect(await rejects("collab_post", { collabId: "clb_1", text: "hi", mentions: "alice" })).toBeDefined()
    expect(await rejects("collab_post", { collabId: "clb_1", text: "hi", mentions: ["alice", 7] })).toBeDefined()
    expect(await rejects("collab_post", { collabId: "clb_1", text: "hi", mentions: ["alice", ""] })).toBeDefined()
    expect(await rejects("collab_post", { collabId: "clb_1", text: "hi", mentions: [] })).toBeUndefined()
  })

  it("requires an explicit lead, and takes only a non-empty slug or null", async () => {
    // An ABSENT key must not read as "clear the seat": a malformed call would
    // then silently mute the room's whole default routing.
    expect(await rejects("collab_set_lead", { collabId: "clb_1" })).toBeDefined()
    expect(await rejects("collab_set_lead", { collabId: "clb_1", agentSlug: "" })).toBeDefined()
    expect(await rejects("collab_set_lead", { collabId: "clb_1", agentSlug: 7 })).toBeDefined()
    expect(await rejects("collab_set_lead", { collabId: "clb_1", agentSlug: null })).toBeUndefined()
    expect(await rejects("collab_set_lead", { collabId: "clb_1", agentSlug: "alice" })).toBeUndefined()
  })

  it("rejects a task add or update the board could not act on", async () => {
    expect(await rejects("collab_task_add", { collabId: "clb_1" })).toBeDefined()
    expect(await rejects("collab_task_add", { collabId: "clb_1", title: "" })).toBeDefined()
    expect(await rejects("collab_task_update", { collabId: "clb_1", action: "claim" })).toBeDefined()
    expect(await rejects("collab_task_update", { collabId: "clb_1", taskId: "clbt_1" })).toBeDefined()
    expect(await rejects("collab_task_update", { collabId: "clb_1", taskId: "clbt_1", action: "finish" })).toBeDefined()
    expect(
      await rejects("collab_task_update", { collabId: "clb_1", taskId: "clbt_1", action: "claim", owner: 7 }),
    ).toBeDefined()
    expect(
      await rejects("collab_task_update", { collabId: "clb_1", taskId: "clbt_1", action: "claim", owner: "alice" }),
    ).toBeUndefined()
  })

  it("takes only a positive integer ledger limit", async () => {
    expect(await rejects("collab_ledger", { collabId: "clb_1", limit: 0 })).toBeDefined()
    expect(await rejects("collab_ledger", { collabId: "clb_1", limit: -5 })).toBeDefined()
    expect(await rejects("collab_ledger", { collabId: "clb_1", limit: 2.5 })).toBeDefined()
    expect(await rejects("collab_ledger", { collabId: "clb_1", limit: "10" })).toBeDefined()
    expect(await rejects("collab_ledger", { collabId: "clb_1", limit: 10 })).toBeUndefined()
    expect(await rejects("collab_ledger", { collabId: "clb_1" })).toBeUndefined()
  })

  it("takes collab_stop, and still requires a collab id for it", async () => {
    seen.length = 0
    expect(await rejects("collab_stop", {})).toBeDefined()
    expect(await rejects("collab_stop", { collabId: "" })).toBeDefined()
    expect(await rejects("collab_stop", { collabId: "clb_1" })).toBeUndefined()
    expect(seen).toEqual([{ method: "stop", input: { collabId: "clb_1" } }])
  })

  it("forwards the per-agent supervision methods, and still requires a collab id", async () => {
    seen.length = 0
    await agent().extMethod("collab_preview", { collabId: "clb_1", mentions: ["alice"] })
    await agent().extMethod("collab_review", { collabId: "clb_1", taskId: "clbt_1", verdict: "reject", note: "again" })
    await agent().extMethod("collab_stop_agent", { collabId: "clb_1", agentSlug: "alice" })
    await agent().extMethod("collab_redirect", { collabId: "clb_1", agentSlug: "bob", text: "do X" })
    expect(seen).toEqual([
      { method: "preview", input: { collabId: "clb_1", mentions: ["alice"] } },
      { method: "review", input: { collabId: "clb_1", taskId: "clbt_1", verdict: "reject", note: "again" } },
      { method: "stopAgent", input: { collabId: "clb_1", agentSlug: "alice" } },
      { method: "redirect", input: { collabId: "clb_1", agentSlug: "bob", text: "do X" } },
    ])
    for (const method of ["collab_preview", "collab_review", "collab_stop_agent", "collab_redirect"]) {
      expect(await rejects(method, { taskId: "t", verdict: "approve", agentSlug: "a", text: "x" })).toBeDefined()
    }
  })

  it("takes a preview with no mentions at all - an unaddressed draft is the common one", async () => {
    seen.length = 0
    expect(await rejects("collab_preview", { collabId: "clb_1" })).toBeUndefined()
    expect(await rejects("collab_preview", { collabId: "clb_1", mentions: "alice" })).toBeDefined()
    expect(await rejects("collab_preview", { collabId: "clb_1", mentions: ["alice", ""] })).toBeDefined()
    // No `text` is READ, so sending one changes nothing about what is forwarded.
    await agent().extMethod("collab_preview", { collabId: "clb_1", text: "shall we ship?" })
    expect(seen.at(-1)).toEqual({ method: "preview", input: { collabId: "clb_1" } })
  })

  it("takes only approve or reject as a verdict, on a task it can name", async () => {
    expect(await rejects("collab_review", { collabId: "clb_1", verdict: "approve" })).toBeDefined()
    expect(await rejects("collab_review", { collabId: "clb_1", taskId: "clbt_1" })).toBeDefined()
    expect(await rejects("collab_review", { collabId: "clb_1", taskId: "clbt_1", verdict: "accept" })).toBeDefined()
    expect(await rejects("collab_review", { collabId: "clb_1", taskId: "", verdict: "approve" })).toBeDefined()
    expect(await rejects("collab_review", { collabId: "clb_1", taskId: "clbt_1", verdict: "approve" })).toBeUndefined()
  })

  it("refuses a supervision call with no usable agent slug, or an empty correction", async () => {
    for (const method of ["collab_stop_agent", "collab_redirect"]) {
      expect(await rejects(method, { collabId: "clb_1", text: "do X" })).toBeDefined()
      expect(await rejects(method, { collabId: "clb_1", agentSlug: "", text: "do X" })).toBeDefined()
    }
    // A blank correction corrects nothing and would wake the target to read an
    // empty line - unlike `collab_post`, where an empty body releases a room.
    expect(await rejects("collab_redirect", { collabId: "clb_1", agentSlug: "bob" })).toBeDefined()
    expect(await rejects("collab_redirect", { collabId: "clb_1", agentSlug: "bob", text: "   " })).toBeDefined()
    expect(await rejects("collab_redirect", { collabId: "clb_1", agentSlug: "bob", text: "do X" })).toBeUndefined()
  })

  it("still refuses a method it does not know", async () => {
    expect(await rejects("collab_delete", { collabId: "clb_1" })).toBeDefined()
    expect(await rejects("collab_pause", { collabId: "clb_1" })).toBeDefined()
  })
})
