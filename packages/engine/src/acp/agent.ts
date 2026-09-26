import {
  RequestError,
  type Agent as ACPAgent,
  type AgentSideConnection,
  type AuthenticateRequest,
  type CancelNotification,
  type CloseSessionRequest,
  type ForkSessionRequest,
  type InitializeRequest,
  type ListSessionsRequest,
  type LoadSessionRequest,
  type NewSessionRequest,
  type PromptRequest,
  type ResumeSessionRequest,
  type SetSessionConfigOptionRequest,
  type SetSessionModelRequest,
  type SetSessionModeRequest,
} from "@agentclientprotocol/sdk"
import { Cause, Effect, Exit } from "effect"
import type { OrigamiClient } from "@origami/sdk/v2"
import { BrowserBridge } from "@/browser/bridge"
import { AppRuntime } from "@/effect/app-runtime"
import * as ACPError from "./error"
import * as ACPService from "./service"
import { ForeignTranscript } from "./foreign-transcript" // origami_change: session_append_foreign
import { ACPNests } from "./nests" // origami_change (t-s9jgzh): Nests L4a
import { ACPNestArtifacts } from "./nest-artifacts" // origami_change (t-sj39jx)
import { ACPHistory } from "./history" // origami_change (t-ucnjwp)
import { ACPHistoryStore } from "./history-store" // origami_change (t-ucnjwp)
import { ACPElastic } from "./elastic" // origami_change (t-w2qlop)
import { ElasticSpare } from "@/elastic/spare" // origami_change (t-w2u2ki): a session call adopts a warm spare first
import { ElasticWarm } from "@/elastic/warm" // origami_change (t-woacbl): a session call warms its folder for the first prompt

export function init({ sdk: _sdk }: { sdk: OrigamiClient }) {
  return {
    create: (connection: AgentSideConnection) => {
      // The browser tool runs in this same process (cli/cmd/acp.ts starts the
      // server in-process), so registering the live connection here is what makes
      // `origami/browser` reachable from a tool call. EVERY client is registered;
      // one without the method rejects with -32601, which the bridge maps to prose.
      BrowserBridge.registerConnection(connection)
      // origami_change: `settledCommands` is wired HERE and nowhere else - it
      // reaches the engine through the process-wide AppRuntime, which only this
      // entry point runs. It lets a chat open without waiting for MCP servers.
      return new Agent(
        ACPService.make({
          sdk: _sdk,
          connection,
          settledCommands: ACPService.settledCommands,
          history: ACPHistoryStore.live, // origami_change (t-ucnjwp): message count + roster rows
        }),
      )
    },
  }
}

/**
 * origami_change (t-xnvp72): ONE `adoption timings` line per adopted warm spare,
 * written by the session call that adopted it once that call has answered (or
 * failed). `adoptMs` = the call's wait for the held work; `sessionMs` = the
 * session call itself; `readyMs` = adoption start to answer;
 * `mainThreadMaxBlockMs` = the longest the main thread did not run meanwhile.
 * The instance boots of the same window log `boot step` / `boot timings`
 * (project/instance-store.ts). Every later call gets the same report: no line.
 */
function logAdoption(report: ElasticSpare.AdoptionReport | undefined, call: string, sessionStarted: number): void {
  if (!report || report.logged) return
  report.logged = true
  const now = performance.now()
  const fields = {
    call,
    readyMs: Math.round(now - report.startedAt),
    adoptMs: Math.round(sessionStarted - report.startedAt),
    disposeMs: report.disposeMs ?? "unfinished",
    disposeLimitHit: report.disposeLimitHit ?? false,
    peersMs: report.peersMs ?? "unfinished",
    adoptLimitHit: report.limitHit ?? false,
    sessionMs: Math.round(now - sessionStarted),
    mainThreadMaxBlockMs: report.lag.stop(),
  }
  AppRuntime.runPromise(Effect.logInfo("adoption timings", fields)).catch(() => undefined)
}

export class Agent implements ACPAgent {
  constructor(private readonly service: ACPService.Interface) {}

  initialize(params: InitializeRequest) {
    return run(this.service.initialize(params))
  }

  authenticate(params: AuthenticateRequest) {
    return run(this.service.authenticate(params))
  }

  async newSession(params: NewSessionRequest) {
    const adoption = await ElasticSpare.adopt()
    // origami_change (t-xnvp72): a new chat warms WHILE its session starts (instance
    // boot, MCP connects), not after the answer: the first message waits for less.
    ElasticWarm.atOpen(params.cwd)
    const started = performance.now()
    try {
      return await run(this.service.newSession(params))
    } finally {
      logAdoption(adoption, "session/new", started)
    }
  }

  async loadSession(params: LoadSessionRequest) {
    const adoption = await ElasticSpare.adopt()
    const started = performance.now()
    try {
      const result = await run(this.service.loadSession(params))
      ElasticWarm.afterSession(params.cwd)
      return result
    } finally {
      logAdoption(adoption, "session/load", started)
    }
  }

  listSessions(params: ListSessionsRequest) {
    // origami_change (t-y4x518): not before a running adoption has dropped the old instances.
    const adopting = ElasticSpare.inFlight()
    if (adopting) return adopting.then(() => run(this.service.listSessions(params)))
    return run(this.service.listSessions(params))
  }

  async resumeSession(params: ResumeSessionRequest) {
    const adoption = await ElasticSpare.adopt()
    const started = performance.now()
    try {
      const result = await run(this.service.resumeSession(params))
      ElasticWarm.afterSession(params.cwd)
      return result
    } finally {
      logAdoption(adoption, "session/resume", started)
    }
  }

  closeSession(params: CloseSessionRequest) {
    return run(this.service.closeSession(params))
  }

  async unstable_forkSession(params: ForkSessionRequest) {
    const adoption = await ElasticSpare.adopt()
    const started = performance.now()
    try {
      const result = await run(this.service.forkSession(params))
      ElasticWarm.afterSession(params.cwd)
      return result
    } finally {
      logAdoption(adoption, "session/fork", started)
    }
  }

  setSessionConfigOption(params: SetSessionConfigOptionRequest) {
    return run(this.service.setSessionConfigOption(params))
  }

  setSessionMode(params: SetSessionModeRequest) {
    return run(this.service.setSessionMode(params))
  }

  unstable_setSessionModel(params: SetSessionModelRequest) {
    return run(this.service.setSessionModel(params))
  }

  prompt(params: PromptRequest) {
    return run(this.service.prompt(params))
  }

  cancel(params: CancelNotification) {
    return run(this.service.cancel(params))
  }

  /** Fork-owned ACP extension methods. The JS SDK routes anything it does not
   *  recognise here VERBATIM and does not strip the leading `_` clients put on the
   *  wire, so both `run_steps` and `_run_steps` must land on the same handler. */
  extMethod(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const name = method.startsWith("_") ? method.slice(1) : method
    // origami_change (t-y4x518): a chat's call that arrives while its spare is being
    // adopted runs after the adoption, so it boots the chat's instance (once) against
    // the disk as it is now, not one the adoption disposes. The elastic methods answer
    // from process state and never wait.
    const adopting = name.startsWith("elastic_") ? undefined : ElasticSpare.inFlight()
    if (adopting) return adopting.then(() => this.extMethod(method, params))
    // origami_change (t-s9jgzh): the six nest_* methods, gated on the host's
    // `enabled` flag before anything runs.
    const nest = ACPNests.dispatch(name, params, this.service)
    if (nest) return run(nest) as Promise<Record<string, unknown>>
    const nestArtifact = ACPNestArtifacts.dispatch(name, params) // origami_change (t-sj39jx): artifacts in the nest
    if (nestArtifact) return run(nestArtifact) as Promise<Record<string, unknown>>
    const elastic = ACPElastic.dispatch(name, params) // origami_change (t-w2qlop): class, trim, idle report
    if (elastic) return elastic
    switch (name) {
      case "run_steps": {
        const sessionId = typeof params?.["sessionId"] === "string" ? (params["sessionId"] as string) : undefined
        if (!sessionId) throw RequestError.invalidParams("run_steps requires a string sessionId")
        const cwd = typeof params?.["cwd"] === "string" ? (params["cwd"] as string) : undefined
        return run(this.service.runSteps({ sessionId, ...(cwd ? { cwd } : {}) })) as Promise<Record<string, unknown>>
      }
      case "session_delete": {
        // The one DESTRUCTIVE ext method. A rejected shape must throw here rather
        // than reach the store, because the store's delete cascades: a session's
        // children, messages and parts go with the row.
        const sessionId = params?.["sessionId"]
        if (typeof sessionId !== "string" || sessionId.length === 0) {
          throw RequestError.invalidParams("session_delete requires a non-empty string sessionId")
        }
        return run(this.service.sessionDelete({ sessionId, ...cwdOf(params) })) as Promise<Record<string, unknown>>
      }
      case "session_append_foreign": {
        // origami_change. A WRITE, so every part of the shape is checked here
        // rather than left to the store: a malformed entry would be persisted as an
        // empty message, and a transcript with holes is worse than a loud failure.
        const sessionId = params?.["sessionId"]
        if (typeof sessionId !== "string" || sessionId.length === 0) {
          throw RequestError.invalidParams("session_append_foreign requires a non-empty string sessionId")
        }
        const source = params?.["source"]
        if (typeof source !== "string" || source.length === 0) {
          throw RequestError.invalidParams("session_append_foreign requires a non-empty string source")
        }
        const raw = params?.["messages"]
        if (!Array.isArray(raw)) {
          throw RequestError.invalidParams("session_append_foreign requires a messages array")
        }
        // Bounded BEFORE the entries are read: the point of the ceiling is that
        // a runaway batch never gets walked, let alone written.
        if (raw.length > ForeignTranscript.MAX_MESSAGES) {
          throw RequestError.invalidParams(
            `session_append_foreign accepts at most ${ForeignTranscript.MAX_MESSAGES} messages per call`,
          )
        }
        const messages = raw.map((item) => foreignMessage(item))
        return run(this.service.sessionAppendForeign({ sessionId, source, messages, ...cwdOf(params) })) as Promise<
          Record<string, unknown>
        >
      }
      case "run_stats": {
        const raw = params?.["sessionIds"]
        if (!Array.isArray(raw)) throw RequestError.invalidParams("run_stats requires a sessionIds array")
        const sessionIds = raw.filter((item): item is string => typeof item === "string" && item.length > 0)
        if (sessionIds.length !== raw.length) {
          throw RequestError.invalidParams("run_stats sessionIds must all be non-empty strings")
        }
        const cwd = typeof params?.["cwd"] === "string" ? (params["cwd"] as string) : undefined
        return run(this.service.runStats({ sessionIds, ...(cwd ? { cwd } : {}) })) as Promise<Record<string, unknown>>
      }
      case "subagent_transcript": {
        // The CHILD's id, not the caller's - validated exactly like `run_steps`'
        // own sessionId, since it is the same kind of value read the same way.
        const sessionId = typeof params?.["sessionId"] === "string" ? (params["sessionId"] as string) : undefined
        if (!sessionId) throw RequestError.invalidParams("subagent_transcript requires a string sessionId")
        const cwd = typeof params?.["cwd"] === "string" ? (params["cwd"] as string) : undefined
        // t-krxap7. `limit` turns this into a paged read of the NEWEST N messages;
        // `before` walks backwards from a previous answer's cursor. A `before`
        // without a `limit` is a caller bug, not a whole-transcript read - the
        // store rejects that pair - so it is refused here rather than silently
        // dropped, which would answer the newest page to a request for an old one.
        const rawLimit = params?.["limit"]
        if (rawLimit !== undefined && (typeof rawLimit !== "number" || !Number.isFinite(rawLimit) || rawLimit < 0)) {
          throw RequestError.invalidParams("subagent_transcript limit must be a non-negative number")
        }
        const limit = typeof rawLimit === "number" ? Math.floor(rawLimit) : undefined
        const before = typeof params?.["before"] === "string" ? (params["before"] as string) : undefined
        if (before && !limit) throw RequestError.invalidParams("subagent_transcript before requires a limit")
        return run(
          this.service.subagentTranscript({
            sessionId,
            ...(cwd ? { cwd } : {}),
            ...(limit !== undefined ? { limit } : {}),
            ...(before ? { before } : {}),
          }),
        ) as Promise<Record<string, unknown>>
      }
      case "subagent_todos": {
        // t-qd2riw. The CHILD's id, validated exactly like `subagent_transcript`'s —
        // no `limit`/`before` here, the paging is internal to the engine method.
        const sessionId = typeof params?.["sessionId"] === "string" ? (params["sessionId"] as string) : undefined
        if (!sessionId) throw RequestError.invalidParams("subagent_todos requires a string sessionId")
        const cwd = typeof params?.["cwd"] === "string" ? (params["cwd"] as string) : undefined
        return run(
          this.service.subagentTodos({ sessionId, ...(cwd ? { cwd } : {}) }),
        ) as Promise<Record<string, unknown>>
      }
      case "subagent_changes": {
        // t-ru0by6, same shape as subagent_todos above: no `limit`/`before`
        // here either, the paging is internal to the engine method.
        const sessionId = typeof params?.["sessionId"] === "string" ? (params["sessionId"] as string) : undefined
        if (!sessionId) throw RequestError.invalidParams("subagent_changes requires a string sessionId")
        const cwd = typeof params?.["cwd"] === "string" ? (params["cwd"] as string) : undefined
        return run(
          this.service.subagentChanges({ sessionId, ...(cwd ? { cwd } : {}) }),
        ) as Promise<Record<string, unknown>>
      }
      // origami_change (t-ucnjwp): lazy loading. Shapes and errors are fixed by
      // reports/lazy_loading_plan_2026-09-24/wire_contract.md; every bad value is
      // refused here, before a read, rather than coerced.
      case "history_page": {
        const sessionId = requiredId(params, "history_page")
        const before = params?.["before"]
        if (before !== undefined && (typeof before !== "string" || !ACPHistory.validCursor(before))) {
          throw RequestError.invalidParams("history_page before must be a cursor from a previous answer")
        }
        const limit = params?.["limit"]
        if (
          limit !== undefined &&
          (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > ACPHistory.PAGE_SIZE)
        ) {
          throw RequestError.invalidParams(`history_page limit must be an integer 1..${ACPHistory.PAGE_SIZE}`)
        }
        const pageId = params?.["pageId"]
        if (
          pageId !== undefined &&
          (typeof pageId !== "string" || pageId.length === 0 || pageId.length > ACPHistory.PAGE_ID_MAX)
        ) {
          throw RequestError.invalidParams(`history_page pageId must be a string of 1..${ACPHistory.PAGE_ID_MAX} chars`)
        }
        return run(
          this.service.historyPage({
            sessionId,
            ...(typeof before === "string" ? { before } : {}),
            ...(typeof limit === "number" ? { limit } : {}),
            ...(typeof pageId === "string" ? { pageId } : {}),
            ...cwdOf(params),
          }),
        ) as Promise<Record<string, unknown>>
      }
      case "history_search": {
        const sessionId = requiredId(params, "history_search")
        const query = params?.["query"]
        if (typeof query !== "string" || query.length === 0 || query.length > ACPHistory.SEARCH_QUERY_MAX) {
          throw RequestError.invalidParams(`history_search query must be a string of 1..${ACPHistory.SEARCH_QUERY_MAX} chars`)
        }
        const limit = params?.["limit"]
        if (
          limit !== undefined &&
          (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > ACPHistory.SEARCH_LIMIT_MAX)
        ) {
          throw RequestError.invalidParams(`history_search limit must be an integer 1..${ACPHistory.SEARCH_LIMIT_MAX}`)
        }
        const cursor = params?.["cursor"]
        if (cursor !== undefined && (typeof cursor !== "string" || !ACPHistory.decodeSearchCursor(cursor))) {
          throw RequestError.invalidParams("history_search cursor must be the cursor of a previous answer")
        }
        return run(
          this.service.historySearch({
            sessionId,
            query,
            ...(typeof limit === "number" ? { limit } : {}),
            ...(typeof cursor === "string" ? { cursor } : {}),
            ...cwdOf(params),
          }),
        ) as Promise<Record<string, unknown>>
      }
      case "subagent_roster": {
        const sessionId = requiredId(params, "subagent_roster")
        return run(this.service.subagentRoster({ sessionId, ...cwdOf(params) })) as Promise<Record<string, unknown>>
      }
      case "list_instructions": {
        const cwd = typeof params?.["cwd"] === "string" ? (params["cwd"] as string) : undefined
        return run(this.service.listInstructions({ ...(cwd ? { cwd } : {}) })) as Promise<Record<string, unknown>>
      }
      case "list_tools": {
        const cwd = typeof params?.["cwd"] === "string" ? (params["cwd"] as string) : undefined
        return run(this.service.listTools({ ...(cwd ? { cwd } : {}) })) as Promise<Record<string, unknown>>
      }
      case "shell_stop": {
        // origami_change: fork-only targeted background-shell stop.
        const jobId = typeof params?.["jobId"] === "string" ? params["jobId"] : undefined
        const sessionId = typeof params?.["sessionId"] === "string" ? params["sessionId"] : undefined
        if (!jobId || !sessionId) throw RequestError.invalidParams("shell_stop requires string jobId and sessionId")
        return run(this.service.shellStop({ jobId, sessionId })) as Promise<Record<string, unknown>>
      }
      case "subagent_stop": {
        // origami_change (t-q910fo): the CHILD's session id, validated exactly like
        // `subagent_transcript`'s — it is the same value read the same way, and it is
        // also the id the child's background job is registered under.
        const sessionId = typeof params?.["sessionId"] === "string" ? (params["sessionId"] as string) : undefined
        if (!sessionId) throw RequestError.invalidParams("subagent_stop requires a string sessionId")
        const cwd = typeof params?.["cwd"] === "string" ? (params["cwd"] as string) : undefined
        return run(this.service.subagentStop({ sessionId, ...(cwd ? { cwd } : {}) })) as Promise<
          Record<string, unknown>
        >
      }
      case "interject": {
        // origami_change: fork-only. A message pushed into the running turn.
        // `images` carries the same base64 pairs an ACP `image` content block does;
        // a malformed entry is REFUSED here rather than dropped.
        const sessionId = typeof params?.["sessionId"] === "string" ? params["sessionId"] : undefined
        const text = typeof params?.["text"] === "string" ? params["text"] : undefined
        const images = interjectImages(params?.["images"])
        if (!sessionId || text === undefined || images === undefined)
          throw RequestError.invalidParams("interject requires string sessionId and text, with optional images")
        if (!text && images.length === 0)
          throw RequestError.invalidParams("interject requires text or at least one image")
        // `images` is OMITTED when empty: a text-only interjection reaches the
        // service with the params it always had, which the dispatch test pins.
        return run(this.service.interject({ sessionId, text, ...(images.length ? { images } : {}) })) as Promise<
          Record<string, unknown>
        >
      }
      case "prompt_capture": {
        // No cwd fallback: an engine session id resolves one session outright, and
        // `process.cwd()` would answer about a different chat than the caller asked.
        const sessionId = typeof params?.["sessionId"] === "string" ? (params["sessionId"] as string) : undefined
        if (!sessionId) throw RequestError.invalidParams("prompt_capture requires a string sessionId")
        return run(this.service.promptCapture({ sessionId })) as Promise<Record<string, unknown>>
      }
      case "cache_stats": {
        const sessionId = typeof params?.["sessionId"] === "string" ? (params["sessionId"] as string) : undefined
        if (!sessionId) throw RequestError.invalidParams("cache_stats requires a string sessionId")
        const cwd = typeof params?.["cwd"] === "string" ? (params["cwd"] as string) : undefined
        return run(this.service.cacheStats({ sessionId, ...(cwd ? { cwd } : {}) })) as Promise<Record<string, unknown>>
      }
      case "storage_stats": {
        // No params: the session store is ONE file for the machine, so there is
        // nothing to scope it by.
        return run(this.service.storageStats()) as Promise<Record<string, unknown>>
      }
      case "storage_prune": {
        // A WRITE, so the shape is checked here rather than coerced downstream: a
        // window that arrives as "60" or NaN must be refused, not read as a
        // number that erases more than the caller meant. The engine still clamps
        // to its own floor (StorageRetention.MIN_WINDOW_DAYS); this is the outer
        // gate, not the only one.
        const olderThanDays = params?.["olderThanDays"]
        if (typeof olderThanDays !== "number" || !Number.isFinite(olderThanDays) || olderThanDays <= 0) {
          throw RequestError.invalidParams("storage_prune requires a positive number olderThanDays")
        }
        // Default DRY: only an exact `false` writes. A missing, misspelled or
        // truthy `dryRun` therefore measures, which is the safe reading of an
        // ambiguous call to a destructive verb.
        const dryRun = params?.["dryRun"] !== false
        return run(this.service.storagePrune({ olderThanDays, dryRun })) as Promise<Record<string, unknown>>
      }
      case "storage_compact": {
        // Same DRY default as `storage_prune`: only an exact `false` writes, so an
        // ambiguous call to a rewriting verb measures.
        const sessionId = typeof params?.["sessionId"] === "string" ? params["sessionId"] : undefined
        return run(
          this.service.storageCompact({ dryRun: params?.["dryRun"] !== false, ...(sessionId ? { sessionId } : {}) }),
        ) as Promise<Record<string, unknown>>
      }
      case "storage_vacuum": {
        // `confirm` must be EXACTLY true. VACUUM rewrites the whole store and
        // holds it while it does; "truthy" is not consent to that.
        return run(this.service.storageVacuum({ confirm: params?.["confirm"] === true })) as Promise<
          Record<string, unknown>
        >
      }
      case "list_skills": {
        const cwd = typeof params?.["cwd"] === "string" ? (params["cwd"] as string) : undefined
        // Strict `=== true`: a client sending "true", 1 or null must not
        // silently buy a full re-scan (and a network pull of every skills.url).
        const refresh = params?.["refresh"] === true
        return run(this.service.listSkills({ ...(cwd ? { cwd } : {}), ...(refresh ? { refresh } : {}) })) as Promise<
          Record<string, unknown>
        >
      }
      case "list_agent_plugins": {
        const cwd = typeof params?.["cwd"] === "string" ? (params["cwd"] as string) : undefined
        return run(this.service.listAgentPlugins({ ...(cwd ? { cwd } : {}) })) as Promise<Record<string, unknown>>
      }
      case "agent_plugin_add": {
        const dir = params?.["dir"]
        if (typeof dir !== "string" || dir.length === 0) {
          throw RequestError.invalidParams("agent_plugin_add requires a non-empty string dir")
        }
        const cwd = typeof params?.["cwd"] === "string" ? (params["cwd"] as string) : undefined
        return run(this.service.agentPluginAdd({ dir, ...(cwd ? { cwd } : {}) })) as Promise<Record<string, unknown>>
      }
      case "agent_plugin_set_enabled": {
        const spec = params?.["spec"]
        if (typeof spec !== "string" || spec.length === 0) {
          throw RequestError.invalidParams("agent_plugin_set_enabled requires a non-empty string spec")
        }
        const enabled = params?.["enabled"]
        if (typeof enabled !== "boolean") {
          throw RequestError.invalidParams("agent_plugin_set_enabled requires a boolean enabled")
        }
        const cwd = typeof params?.["cwd"] === "string" ? (params["cwd"] as string) : undefined
        return run(this.service.agentPluginSetEnabled({ spec, enabled, ...(cwd ? { cwd } : {}) })) as Promise<
          Record<string, unknown>
        >
      }
      // MCP management pane. `mcp_list` is the read; the rest are writes that
      // all name one server, so the name is validated once, by `mcpNameOf`.
      case "mcp_list": {
        return run(this.service.mcpList(cwdOf(params))) as Promise<Record<string, unknown>>
      }
      case "mcp_add": {
        const name = mcpNameOf(params, "mcp_add")
        const scope = params?.["scope"]
        if (scope !== "project" && scope !== "global") {
          throw RequestError.invalidParams("mcp_add requires scope 'project' or 'global'")
        }
        const server = params?.["server"]
        if (typeof server !== "object" || server === null || Array.isArray(server)) {
          throw RequestError.invalidParams("mcp_add requires a server object")
        }
        return run(this.service.mcpAdd({ name, server, scope, ...cwdOf(params) })) as Promise<Record<string, unknown>>
      }
      case "mcp_remove": {
        return run(
          this.service.mcpRemove({ name: mcpNameOf(params, "mcp_remove"), ...cwdOf(params) }),
        ) as Promise<Record<string, unknown>>
      }
      case "mcp_set_enabled": {
        const name = mcpNameOf(params, "mcp_set_enabled")
        const enabled = params?.["enabled"]
        if (typeof enabled !== "boolean") {
          throw RequestError.invalidParams("mcp_set_enabled requires a boolean enabled")
        }
        return run(this.service.mcpSetEnabled({ name, enabled, ...cwdOf(params) })) as Promise<
          Record<string, unknown>
        >
      }
      case "mcp_connect": {
        return run(
          this.service.mcpConnect({ name: mcpNameOf(params, "mcp_connect"), ...cwdOf(params) }),
        ) as Promise<Record<string, unknown>>
      }
      case "mcp_disconnect": {
        return run(
          this.service.mcpDisconnect({ name: mcpNameOf(params, "mcp_disconnect"), ...cwdOf(params) }),
        ) as Promise<Record<string, unknown>>
      }
      case "mcp_authenticate": {
        return run(
          this.service.mcpAuthenticate({ name: mcpNameOf(params, "mcp_authenticate"), ...cwdOf(params) }),
        ) as Promise<Record<string, unknown>>
      }
      case "mcp_auth_remove": {
        return run(
          this.service.mcpAuthRemove({ name: mcpNameOf(params, "mcp_auth_remove"), ...cwdOf(params) }),
        ) as Promise<Record<string, unknown>>
      }
      // Flock - the cross-person question pane. Everything but `flock_decide` and
      // `flock_send` is a global-file read or write with no cwd (those two may run
      // a Front Desk turn). The shapes are validated by the `flock*` readers below.
      case "flock_state": {
        return run(this.service.flockState(cwdOf(params))) as Promise<Record<string, unknown>>
      }
      case "flock_pending": {
        return run(this.service.flockPending(cwdOf(params))) as Promise<Record<string, unknown>>
      }
      case "flock_invite": {
        return run(this.service.flockInvite(optionalText(params, "flock_invite", "relay"))) as Promise<
          Record<string, unknown>
        >
      }
      case "flock_accept": {
        const invite = params?.["invite"]
        if (typeof invite !== "string" || invite.length === 0) {
          throw RequestError.invalidParams("flock_accept requires a non-empty string invite")
        }
        return run(
          this.service.flockAccept({
            invite,
            ...flockFlag(params, "flock_accept", "autoAnswer"),
            ...flockBudget(params, "flock_accept"),
          }),
        ) as Promise<Record<string, unknown>>
      }
      // The owner's own display name and sigil. Both optional plain strings: `null`
      // is not a value either one has. The icon's SHAPE is checked engine-side in
      // `FlockIdentity.normaliseIcon` so an id arriving over the relay passes it too.
      case "flock_set_identity": {
        return run(
          this.service.flockSetIdentity({
            ...optionalText(params, "flock_set_identity", "name"),
            ...optionalText(params, "flock_set_identity", "icon"),
          }),
        ) as Promise<Record<string, unknown>>
      }
      case "flock_revoke": {
        return run(this.service.flockRevoke({ handle: flockHandle(params, "flock_revoke") })) as Promise<
          Record<string, unknown>
        >
      }
      case "flock_set_policy": {
        // `null` is MEANINGFUL here (clear this override, fall back to the desk
        // default) and is not the same as absent, so it survives to the engine.
        return run(
          this.service.flockSetPolicy({
            handle: flockHandle(params, "flock_set_policy"),
            ...flockNullableFlag(params, "flock_set_policy", "autoAnswer"),
            ...flockNullableBudget(params, "flock_set_policy"),
            ...flockNullableText(params, "flock_set_policy", "model"),
            ...flockNullableText(params, "flock_set_policy", "displayName"),
            ...flockScope(params, "flock_set_policy"),
          }),
        ) as Promise<Record<string, unknown>>
      }
      case "flock_front_desk": {
        return run(
          this.service.flockFrontDesk({
            ...flockNullableText(params, "flock_front_desk", "model"),
            ...flockNullableBudget(params, "flock_front_desk"),
            ...flockScope(params, "flock_front_desk"),
            ...flockFlag(params, "flock_front_desk", "autoAnswer"),
          }),
        ) as Promise<Record<string, unknown>>
      }
      case "flock_set_specialties": {
        const raw = params?.["specialties"]
        if (!Array.isArray(raw) || !raw.every((item) => typeof item === "string")) {
          throw RequestError.invalidParams("flock_set_specialties requires an array of strings")
        }
        return run(this.service.flockSetSpecialties({ specialties: raw as string[] })) as Promise<
          Record<string, unknown>
        >
      }
      case "flock_mailbox": {
        return run(this.service.flockMailbox(cwdOf(params))) as Promise<Record<string, unknown>>
      }
      // "Why is my flock not working" as one read. No params but the optional test
      // directory: the answer must not depend on which engine you are talking to.
      case "flock_diagnose": {
        return run(this.service.flockDiagnose(cwdOf(params))) as unknown as Promise<Record<string, unknown>>
      }
      case "flock_decide": {
        const action = params?.["action"]
        if (action !== "answer" && action !== "decline") {
          throw RequestError.invalidParams('flock_decide requires action "answer" or "decline"')
        }
        return run(
          this.service.flockDecide({
            thread: flockThread(params, "flock_decide"),
            action,
            ...optionalText(params, "flock_decide", "guidance"),
            ...optionalText(params, "flock_decide", "reason"),
            ...cwdOf(params),
          }),
        ) as Promise<Record<string, unknown>>
      }
      case "flock_send": {
        return run(
          this.service.flockSend({
            thread: flockThread(params, "flock_send"),
            ...optionalText(params, "flock_send", "text"),
            ...cwdOf(params),
          }),
        ) as Promise<Record<string, unknown>>
      }
      case "flock_post": {
        const to = params?.["to"]
        const question = params?.["question"]
        if (typeof to !== "string" || to.length === 0) {
          throw RequestError.invalidParams("flock_post requires a non-empty string to")
        }
        if (typeof question !== "string" || question.length === 0) {
          throw RequestError.invalidParams("flock_post requires a non-empty string question")
        }
        return run(
          this.service.flockPost({ to, question, ...optionalText(params, "flock_post", "followUpOf") }),
        ) as Promise<Record<string, unknown>>
      }
      // The owner's "send to chat". `sessionID` is required and is the ENGINE's
      // own id: a webview id here would address a session no engine holds.
      case "flock_deliver": {
        const sessionID = params?.["sessionID"]
        if (typeof sessionID !== "string" || sessionID.length === 0) {
          throw RequestError.invalidParams("flock_deliver requires a non-empty string sessionID")
        }
        return run(
          this.service.flockDeliver({
            thread: flockThread(params, "flock_deliver"),
            sessionID,
            ...cwdOf(params),
          }),
        ) as Promise<Record<string, unknown>>
      }
      case "flock_mark": {
        const mark = params?.["mark"]
        if (mark !== "read" && mark !== "delivered") {
          throw RequestError.invalidParams('flock_mark requires mark "read" or "delivered"')
        }
        return run(
          this.service.flockMark({
            thread: flockThread(params, "flock_mark"),
            mark,
            ...optionalText(params, "flock_mark", "sessionID"),
          }),
        ) as Promise<Record<string, unknown>>
      }
      // Artifacts - the pane over this machine's artifact store. Reads take an
      // artifact id and version NUMBERS, so the shape check here is the whole
      // validation: the store's own errors are about rows that are not there.
      case "artifact_list": {
        const all = params?.["all"]
        if (all !== undefined && typeof all !== "boolean") {
          throw RequestError.invalidParams("artifact_list requires a boolean all")
        }
        return run(
          this.service.artifactList({
            ...(all === undefined ? {} : { all }),
            ...optionalText(params, "artifact_list", "projectPath"),
          }),
        ) as Promise<Record<string, unknown>>
      }
      case "artifact_versions": {
        return run(
          this.service.artifactVersions({ artifactId: artifactIdOf(params, "artifact_versions") }),
        ) as Promise<Record<string, unknown>>
      }
      // `version` is OPTIONAL and means "the latest", which is what the Open
      // button sends. An explicit one still has to be a real version number.
      case "artifact_open": {
        const version = optionalVersion(params, "artifact_open", "version")
        return run(
          this.service.artifactOpen({ artifactId: artifactIdOf(params, "artifact_open"), ...version }),
        ) as Promise<Record<string, unknown>>
      }
      // The one WRITE in this group: a copy-forward that mints a new version.
      case "artifact_restore": {
        return run(
          this.service.artifactRestore({
            artifactId: artifactIdOf(params, "artifact_restore"),
            version: versionOf(params, "artifact_restore", "version"),
          }),
        ) as Promise<Record<string, unknown>>
      }
      case "artifact_diff": {
        return run(
          this.service.artifactDiff({
            artifactId: artifactIdOf(params, "artifact_diff"),
            from: versionOf(params, "artifact_diff", "from"),
            to: versionOf(params, "artifact_diff", "to"),
          }),
        ) as unknown as Promise<Record<string, unknown>>
      }
      // Title only, no new version — the pane's inline rename.
      case "artifact_rename": {
        return run(
          this.service.artifactRename({
            artifactId: artifactIdOf(params, "artifact_rename"),
            title: titleOf(params, "artifact_rename"),
          }),
        ) as Promise<Record<string, unknown>>
      }
      // The pane commits this only after its own 4s Undo toast burns out.
      case "artifact_delete": {
        return run(
          this.service.artifactDelete({ artifactId: artifactIdOf(params, "artifact_delete") }),
        ) as Promise<Record<string, unknown>>
      }
      case "provider_auth_list": {
        return run(this.service.providerAuthList(cwdOf(params))) as Promise<Record<string, unknown>>
      }
      case "provider_auth_authorize": {
        return run(
          this.service.providerAuthAuthorize({
            providerID: providerIdOf(params, "provider_auth_authorize"),
            methodIndex: methodIndexOf(params, "provider_auth_authorize"),
            ...cwdOf(params),
          }),
        ) as Promise<Record<string, unknown>>
      }
      case "provider_auth_usage": {
        // No cwd: the credential store is global. No methodIndex: there is no
        // flow to resume, just a read of the connection already on file.
        return run(
          this.service.providerAuthUsage({ providerID: providerIdOf(params, "provider_auth_usage") }),
        ) as Promise<Record<string, unknown>>
      }
      case "provider_auth_callback": {
        // `code` is absent for an "auto" method and REQUIRED for a "code" one; which
        // applies is the plugin's answer, so only the shape is checked here.
        return run(
          this.service.providerAuthCallback({
            providerID: providerIdOf(params, "provider_auth_callback"),
            methodIndex: methodIndexOf(params, "provider_auth_callback"),
            ...optionalText(params, "provider_auth_callback", "code"),
            ...cwdOf(params),
          }),
        ) as Promise<Record<string, unknown>>
      }
      case "second_opinion": {
        // Three required strings: WHICH chat, and WHICH model reviews it. The model
        // arrives already split by the extension host, so an id that itself contains
        // a slash (every OpenRouter id does) cannot be mis-cut here.
        const sessionId = params?.["sessionId"]
        if (typeof sessionId !== "string" || sessionId.length === 0) {
          throw RequestError.invalidParams("second_opinion requires a non-empty string sessionId")
        }
        const modelID = params?.["modelID"]
        if (typeof modelID !== "string" || modelID.length === 0) {
          throw RequestError.invalidParams("second_opinion requires a non-empty string modelID")
        }
        return run(
          this.service.secondOpinion({
            sessionId,
            providerID: providerIdOf(params, "second_opinion"),
            modelID,
            ...optionalText(params, "second_opinion", "currentModelLabel"),
            ...cwdOf(params),
          }),
        ) as Promise<Record<string, unknown>>
      }
      case "provider_refresh": {
        // No providerID: the credential the shell just wrote could be for any
        // provider, and re-reading config is a whole-file job. `cwd` picks the instance.
        // `hard` (t-ttmo5w): the Connections Refresh button - see ProviderRefreshRequest.
        return run(this.service.providerRefresh({ ...cwdOf(params), hard: params?.["hard"] === true })) as Promise<
          Record<string, unknown>
        >
      }
      case "claude_subscription_status": {
        // No params. t-tjt9wd: the picker's one host call for Gate B's reason.
        return run(this.service.claudeSubscriptionStatus()) as Promise<Record<string, unknown>>
      }
      case "collab_agents": {
        return run(this.service.collabAgents(cwdOf(params))) as Promise<Record<string, unknown>>
      }
      case "collab_list": {
        return run(this.service.collabList(cwdOf(params))) as Promise<Record<string, unknown>>
      }
      case "collab_create": {
        const title = params?.["title"]
        if (typeof title !== "string" || title.length === 0) {
          throw RequestError.invalidParams("collab_create requires a non-empty string title")
        }
        const raw = params?.["agentSlugs"]
        if (!Array.isArray(raw)) throw RequestError.invalidParams("collab_create requires an agentSlugs array")
        const agentSlugs = raw.filter((item): item is string => typeof item === "string" && item.length > 0)
        if (agentSlugs.length !== raw.length) {
          throw RequestError.invalidParams("collab_create agentSlugs must all be non-empty strings")
        }
        const objective = params?.["objective"]
        if (objective !== undefined && typeof objective !== "string") {
          throw RequestError.invalidParams("collab_create objective must be a string")
        }
        return run(
          this.service.collabCreate({
            title,
            agentSlugs,
            ...(objective !== undefined ? { objective } : {}),
            ...cwdOf(params),
          }),
        ) as Promise<Record<string, unknown>>
      }
      case "collab_post": {
        const collabId = collabIdOf(params, "collab_post")
        const text = params?.["text"]
        if (typeof text !== "string") throw RequestError.invalidParams("collab_post requires a string text")
        const mentions = slugsOf(params, "collab_post", "mentions")
        // The engine bounds count and size; this only rejects the shape, so a
        // malformed entry cannot reach the log as an empty string.
        const rawImages = params?.["images"]
        let images: string[] | undefined
        if (rawImages !== undefined && rawImages !== null) {
          if (!Array.isArray(rawImages)) {
            throw RequestError.invalidParams("collab_post images must be an array of data: URLs")
          }
          if (!rawImages.every((item) => typeof item === "string" && item.length > 0)) {
            throw RequestError.invalidParams("collab_post images must all be non-empty strings")
          }
          images = rawImages as string[]
        }
        return run(
          this.service.collabPost({
            collabId,
            text,
            ...(mentions ? { mentions } : {}),
            ...(images ? { images } : {}),
            ...cwdOf(params),
          }),
        ) as Promise<Record<string, unknown>>
      }
      case "collab_preview": {
        const collabId = collabIdOf(params, "collab_preview")
        // No `text`: the wake rules read a message's kind and its address list,
        // never its prose, so a draft's words cannot change the answer.
        const mentions = slugsOf(params, "collab_preview", "mentions")
        return run(
          this.service.collabPreview({ collabId, ...(mentions ? { mentions } : {}), ...cwdOf(params) }),
        ) as Promise<Record<string, unknown>>
      }
      case "collab_state": {
        const collabId = collabIdOf(params, "collab_state")
        // Absent means "the whole log". A non-integer would silently widen or
        // narrow that, so it is rejected rather than coerced.
        const raw = params?.["sinceSeq"]
        if (raw !== undefined && raw !== null && !Number.isInteger(raw)) {
          throw RequestError.invalidParams("collab_state sinceSeq must be an integer")
        }
        const sinceSeq = typeof raw === "number" ? raw : undefined
        return run(
          this.service.collabState({ collabId, ...(sinceSeq !== undefined ? { sinceSeq } : {}), ...cwdOf(params) }),
        ) as Promise<Record<string, unknown>>
      }
      case "collab_set_cap": {
        const collabId = collabIdOf(params, "collab_set_cap")
        // `null` restores the default and must be sent explicitly - an absent key
        // reads as `undefined`, and treating that as "restore" would reset a setting.
        const cap = params?.["cap"]
        if (cap !== null && (typeof cap !== "number" || !Number.isInteger(cap) || cap < 0)) {
          throw RequestError.invalidParams("collab_set_cap requires a non-negative integer cap or null")
        }
        return run(this.service.collabSetCap({ collabId, cap, ...cwdOf(params) })) as Promise<Record<string, unknown>>
      }
      case "collab_set_concurrency": {
        const collabId = collabIdOf(params, "collab_set_concurrency")
        // No null here, unlike `cap`: this setting has no "restore the engine
        // default" value to send. 1 IS the default, and it is a number.
        const concurrency = params?.["concurrency"]
        if (typeof concurrency !== "number" || !Number.isInteger(concurrency) || concurrency < 1) {
          throw RequestError.invalidParams("collab_set_concurrency requires an integer concurrency of 1 or more")
        }
        return run(this.service.collabSetConcurrency({ collabId, concurrency, ...cwdOf(params) })) as Promise<
          Record<string, unknown>
        >
      }
      case "collab_set_flavor": {
        const collabId = collabIdOf(params, "collab_set_flavor")
        // The VALUE is not validated here beyond its type: which flavors exist is the
        // collab layer's business, and it refuses an unknown one by name.
        const flavor = params?.["flavor"]
        if (typeof flavor !== "string" || flavor.length === 0) {
          throw RequestError.invalidParams("collab_set_flavor requires a non-empty string flavor")
        }
        return run(this.service.collabSetFlavor({ collabId, flavor, ...cwdOf(params) })) as Promise<
          Record<string, unknown>
        >
      }
      case "collab_set_lead": {
        const collabId = collabIdOf(params, "collab_set_lead")
        // `null` clears the seat and must be sent explicitly - treating an absent key
        // as "clear" would let a malformed call mute a room's whole default routing.
        const agentSlug = params?.["agentSlug"]
        if (agentSlug !== null && (typeof agentSlug !== "string" || agentSlug.length === 0)) {
          throw RequestError.invalidParams("collab_set_lead requires a non-empty string agentSlug or null")
        }
        return run(this.service.collabSetLead({ collabId, agentSlug, ...cwdOf(params) })) as Promise<
          Record<string, unknown>
        >
      }
      case "collab_set_objective": {
        const collabId = collabIdOf(params, "collab_set_objective")
        const objective = params?.["objective"]
        if (typeof objective !== "string") {
          throw RequestError.invalidParams("collab_set_objective requires a string objective")
        }
        return run(this.service.collabSetObjective({ collabId, objective, ...cwdOf(params) })) as Promise<
          Record<string, unknown>
        >
      }
      case "collab_task_add": {
        const collabId = collabIdOf(params, "collab_task_add")
        const title = params?.["title"]
        if (typeof title !== "string" || title.length === 0) {
          throw RequestError.invalidParams("collab_task_add requires a non-empty string title")
        }
        return run(this.service.collabTaskAdd({ collabId, title, ...cwdOf(params) })) as Promise<
          Record<string, unknown>
        >
      }
      case "collab_task_update": {
        const collabId = collabIdOf(params, "collab_task_update")
        const taskId = params?.["taskId"]
        if (typeof taskId !== "string" || taskId.length === 0) {
          throw RequestError.invalidParams("collab_task_update requires a non-empty string taskId")
        }
        const action = params?.["action"]
        if (action !== "claim" && action !== "done" && action !== "accept" && action !== "reopen") {
          throw RequestError.invalidParams("collab_task_update action must be claim, done, accept or reopen")
        }
        return run(
          this.service.collabTaskUpdate({
            collabId,
            taskId,
            action,
            ...optionalText(params, "collab_task_update", "result"),
            ...optionalText(params, "collab_task_update", "note"),
            ...optionalText(params, "collab_task_update", "owner"),
            ...cwdOf(params),
          }),
        ) as Promise<Record<string, unknown>>
      }
      case "collab_review": {
        const collabId = collabIdOf(params, "collab_review")
        const taskId = params?.["taskId"]
        if (typeof taskId !== "string" || taskId.length === 0) {
          throw RequestError.invalidParams("collab_review requires a non-empty string taskId")
        }
        const verdict = params?.["verdict"]
        if (verdict !== "approve" && verdict !== "reject") {
          throw RequestError.invalidParams("collab_review verdict must be approve or reject")
        }
        return run(
          this.service.collabReview({
            collabId,
            taskId,
            verdict,
            ...optionalText(params, "collab_review", "note"),
            ...cwdOf(params),
          }),
        ) as Promise<Record<string, unknown>>
      }
      case "collab_ledger": {
        const collabId = collabIdOf(params, "collab_ledger")
        // Absent means the default page. A non-integer would silently widen or
        // narrow it, so it is rejected rather than coerced.
        const raw = params?.["limit"]
        if (raw !== undefined && raw !== null && (!Number.isInteger(raw) || (raw as number) <= 0)) {
          throw RequestError.invalidParams("collab_ledger limit must be a positive integer")
        }
        const limit = typeof raw === "number" ? raw : undefined
        return run(
          this.service.collabLedger({ collabId, ...(limit !== undefined ? { limit } : {}), ...cwdOf(params) }),
        ) as Promise<Record<string, unknown>>
      }
      case "collab_stop": {
        const collabId = collabIdOf(params, "collab_stop")
        return run(this.service.collabStop({ collabId, ...cwdOf(params) })) as Promise<Record<string, unknown>>
      }
      case "collab_stop_agent": {
        const collabId = collabIdOf(params, "collab_stop_agent")
        return run(
          this.service.collabStopAgent({
            collabId,
            agentSlug: agentSlugOf(params, "collab_stop_agent"),
            ...cwdOf(params),
          }),
        ) as Promise<Record<string, unknown>>
      }
      case "collab_redirect": {
        const collabId = collabIdOf(params, "collab_redirect")
        const text = params?.["text"]
        // Non-empty, unlike `collab_post`: an empty post releases a held room, but an
        // empty correction corrects nothing and would wake the target to a blank line.
        if (typeof text !== "string" || text.trim().length === 0) {
          throw RequestError.invalidParams("collab_redirect requires a non-empty string text")
        }
        return run(
          this.service.collabRedirect({
            collabId,
            agentSlug: agentSlugOf(params, "collab_redirect"),
            text,
            ...cwdOf(params),
          }),
        ) as Promise<Record<string, unknown>>
      }
      case "collab_archive": {
        const collabId = collabIdOf(params, "collab_archive")
        return run(this.service.collabArchive({ collabId, ...cwdOf(params) })) as Promise<Record<string, unknown>>
      }
      case "collab_unarchive": {
        const collabId = collabIdOf(params, "collab_unarchive")
        return run(this.service.collabUnarchive({ collabId, ...cwdOf(params) })) as Promise<Record<string, unknown>>
      }
      case "collab_rename": {
        const collabId = collabIdOf(params, "collab_rename")
        const title = params?.["title"]
        if (typeof title !== "string" || title.length === 0) {
          throw RequestError.invalidParams("collab_rename requires a non-empty string title")
        }
        return run(this.service.collabRename({ collabId, title, ...cwdOf(params) })) as Promise<Record<string, unknown>>
      }
      case "collab_add_participant": {
        const collabId = collabIdOf(params, "collab_add_participant")
        return run(
          this.service.collabAddParticipant({
            collabId,
            agentSlug: agentSlugOf(params, "collab_add_participant"),
            ...cwdOf(params),
          }),
        ) as Promise<Record<string, unknown>>
      }
      case "collab_remove_participant": {
        const collabId = collabIdOf(params, "collab_remove_participant")
        return run(
          this.service.collabRemoveParticipant({
            collabId,
            agentSlug: agentSlugOf(params, "collab_remove_participant"),
            ...cwdOf(params),
          }),
        ) as Promise<Record<string, unknown>>
      }
      default:
        throw RequestError.methodNotFound(method)
    }
  }
}

/** The collab id every per-collab method requires, validated the same way once. */
function collabIdOf(params: Record<string, unknown>, method: string): string {
  const collabId = params?.["collabId"]
  if (typeof collabId !== "string" || collabId.length === 0) {
    throw RequestError.invalidParams(`${method} requires a non-empty string collabId`)
  }
  return collabId
}

/** An optional array of agent slugs. Absent stays absent; present must be an
 *  array of non-empty strings, because a slug that decoded to nothing would be
 *  dropped silently and change who the call reaches. */
function slugsOf(params: Record<string, unknown>, method: string, key: string): string[] | undefined {
  const raw = params?.[key]
  if (raw === undefined || raw === null) return undefined
  if (!Array.isArray(raw)) throw RequestError.invalidParams(`${method} ${key} must be an array of agent slugs`)
  const slugs = raw.filter((item): item is string => typeof item === "string" && item.length > 0)
  if (slugs.length !== raw.length) throw RequestError.invalidParams(`${method} ${key} must all be non-empty strings`)
  return slugs
}

/** An optional string field, omitted rather than invented when absent. */
function optionalText(params: Record<string, unknown>, method: string, key: string): Record<string, string> {
  const raw = params?.[key]
  if (raw === undefined || raw === null) return {}
  if (typeof raw !== "string") throw RequestError.invalidParams(`${method} ${key} must be a string`)
  return { [key]: raw }
}

/** The provider id every provider-auth method requires, validated once. */
function providerIdOf(params: Record<string, unknown>, method: string): string {
  const providerID = params?.["providerID"]
  if (typeof providerID !== "string" || providerID.length === 0) {
    throw RequestError.invalidParams(`${method} requires a non-empty string providerID`)
  }
  return providerID
}

/** The method index into the plugin's own `methods` array. A non-integer would index
 *  into `undefined` and a negative one would read off the end - both are rejected
 *  rather than coerced, because picking the WRONG login method silently is how a
 *  user ends up in a flow they did not choose. */
function methodIndexOf(params: Record<string, unknown>, method: string): number {
  const raw = params?.["methodIndex"]
  if (!Number.isInteger(raw) || (raw as number) < 0) {
    throw RequestError.invalidParams(`${method} requires a non-negative integer methodIndex`)
  }
  return raw as number
}

/** The agent slug the roster methods require, validated the same way once. */
function agentSlugOf(params: Record<string, unknown>, method: string): string {
  const agentSlug = params?.["agentSlug"]
  if (typeof agentSlug !== "string" || agentSlug.length === 0) {
    throw RequestError.invalidParams(`${method} requires a non-empty string agentSlug`)
  }
  return agentSlug
}

/** The MCP server name every write method requires, validated once. Rejected
 *  rather than coerced: a blank name would write an `mcp[""]` entry the config
 *  reader can never match back to a server. */
function mcpNameOf(params: Record<string, unknown>, method: string): string {
  const name = params?.["name"]
  if (typeof name !== "string" || name.trim().length === 0) {
    throw RequestError.invalidParams(`${method} requires a non-empty string name`)
  }
  return name
}

/**
 * The Flock pane's parameter readers. They exist as a set because the pane sends
 * the SAME three kinds of field on five different methods, and because `null` has
 * to survive: a cleared budget and an untouched budget are different intentions,
 * and collapsing them would make a cap impossible to remove once set.
 */
function artifactIdOf(params: Record<string, unknown>, method: string): string {
  const artifactId = params?.["artifactId"]
  if (typeof artifactId !== "string" || artifactId.length === 0) {
    throw RequestError.invalidParams(`${method} requires a non-empty string artifactId`)
  }
  return artifactId
}

/** A version NUMBER: whole and at least 1, because versions start at 1 and a
 *  0 or a 1.5 would reach SQL as a row that can never exist. */
function versionOf(params: Record<string, unknown>, method: string, key: string): number {
  const value = params?.[key]
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw RequestError.invalidParams(`${method} requires a whole ${key} of 1 or more`)
  }
  return value
}

function optionalVersion(params: Record<string, unknown>, method: string, key: string): { version?: number } {
  if (params?.[key] === undefined) return {}
  return { version: versionOf(params, method, key) }
}

/** The new title `artifact_rename` requires — trimmed and non-empty, because a
 *  blank title would leave a row with nothing for the pane to print. */
function titleOf(params: Record<string, unknown>, method: string): string {
  const title = params?.["title"]
  if (typeof title !== "string" || title.trim().length === 0) {
    throw RequestError.invalidParams(`${method} requires a non-empty string title`)
  }
  return title.trim()
}

function flockHandle(params: Record<string, unknown>, method: string): string {
  const handle = params?.["handle"]
  if (typeof handle !== "string" || handle.length === 0) {
    throw RequestError.invalidParams(`${method} requires a non-empty string handle`)
  }
  return handle
}

/** As {@link flockHandle}, for the three methods that name a MAILBOX THREAD.
 *  A thread id is the envelope id, so a row addressed by a stale one must be
 *  refused rather than silently matched to nothing. */
function flockThread(params: Record<string, unknown>, method: string): string {
  const thread = params?.["thread"]
  if (typeof thread !== "string" || thread.length === 0) {
    throw RequestError.invalidParams(`${method} requires a non-empty string thread`)
  }
  return thread
}

function flockFlag(params: Record<string, unknown>, method: string, key: string): Record<string, boolean> {
  const value = params?.[key]
  if (value === undefined) return {}
  if (typeof value !== "boolean") throw RequestError.invalidParams(`${method} ${key} must be a boolean`)
  return { [key]: value }
}

/** As {@link flockFlag}, but `null` survives: on a per-friend row it means
 *  "revoke this override", which is not the same as switching it off. */
function flockNullableFlag(
  params: Record<string, unknown>,
  method: string,
  key: string,
): Record<string, boolean | null> {
  if (params?.[key] === null) return { [key]: null }
  return flockFlag(params, method, key)
}

function flockBudget(params: Record<string, unknown>, method: string): Record<string, number> {
  const value = params?.["dailyBudgetTokens"]
  if (value === undefined) return {}
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw RequestError.invalidParams(`${method} dailyBudgetTokens must be a non-negative number`)
  }
  return { dailyBudgetTokens: value }
}

function flockNullableBudget(params: Record<string, unknown>, method: string): Record<string, number | null> {
  if (params?.["dailyBudgetTokens"] === null) return { dailyBudgetTokens: null }
  return flockBudget(params, method)
}

function flockNullableText(
  params: Record<string, unknown>,
  method: string,
  key: string,
): Record<string, string | null> {
  if (params?.[key] === null) return { [key]: null }
  return optionalText(params, method, key)
}

/** A scope block is three optional string arrays and nothing else; a stray key
 *  would be written straight into the owner's config file, so it is rebuilt
 *  field by field rather than passed through. */
function flockScope(params: Record<string, unknown>, method: string): Record<string, unknown> {
  const scope = params?.["scope"]
  if (scope === undefined) return {}
  if (scope === null) return { scope: null }
  if (typeof scope !== "object" || Array.isArray(scope)) {
    throw RequestError.invalidParams(`${method} scope must be an object`)
  }
  const out: Record<string, string[]> = {}
  for (const key of ["repos", "wiki", "folders"] as const) {
    const value = (scope as Record<string, unknown>)[key]
    if (value === undefined) continue
    if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
      throw RequestError.invalidParams(`${method} scope.${key} must be an array of strings`)
    }
    out[key] = value as string[]
  }
  return { scope: out }
}

/** The optional `cwd` every ext method accepts, omitted rather than invented when absent. */
function cwdOf(params: Record<string, unknown>): { cwd?: string } {
  const cwd = typeof params?.["cwd"] === "string" ? (params["cwd"] as string) : undefined
  return cwd ? { cwd } : {}
}

/** origami_change (t-ucnjwp): a required non-empty string `sessionId`, or -32602. */
function requiredId(params: Record<string, unknown>, method: string): string {
  const sessionId = params?.["sessionId"]
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw RequestError.invalidParams(`${method} requires a non-empty string sessionId`)
  }
  return sessionId
}

/**
 * origami_change: ONE entry of a `session_append_foreign` batch, validated.
 *
 * `id` and `role` are the two the store cannot recover from being wrong. `text` is
 * allowed to be empty (a turn that only ran tools says nothing) but must be a
 * string, so an object cannot end up rendered as "[object Object]".
 */
function foreignMessage(item: unknown): ForeignTranscript.ForeignMessage {
  const value = typeof item === "object" && item !== null ? (item as Record<string, unknown>) : undefined
  const id = value?.["id"]
  if (typeof id !== "string" || id.length === 0) {
    throw RequestError.invalidParams("session_append_foreign messages need a non-empty string id")
  }
  const role = value?.["role"]
  if (role !== "user" && role !== "assistant") {
    throw RequestError.invalidParams("session_append_foreign messages need role 'user' or 'assistant'")
  }
  const text = value?.["text"]
  if (text !== undefined && typeof text !== "string") {
    throw RequestError.invalidParams("session_append_foreign message text must be a string")
  }
  const timestamp = value?.["timestamp"]
  if (timestamp !== undefined && (typeof timestamp !== "number" || !Number.isFinite(timestamp))) {
    throw RequestError.invalidParams("session_append_foreign message timestamp must be a finite number")
  }
  const rawCalls = value?.["toolCalls"]
  if (rawCalls !== undefined && !Array.isArray(rawCalls)) {
    throw RequestError.invalidParams("session_append_foreign message toolCalls must be an array")
  }
  const toolCalls = (rawCalls ?? []).map((call: unknown) => {
    const entry = typeof call === "object" && call !== null ? (call as Record<string, unknown>) : undefined
    const name = entry?.["name"]
    if (typeof name !== "string" || name.length === 0) {
      throw RequestError.invalidParams("session_append_foreign toolCalls need a non-empty string name")
    }
    return {
      name,
      ...(typeof entry?.["title"] === "string" ? { title: entry["title"] as string } : {}),
      ...(typeof entry?.["status"] === "string" ? { status: entry["status"] as string } : {}),
    }
  })
  return {
    id,
    role,
    text: (text as string | undefined) ?? "",
    ...(typeof timestamp === "number" ? { timestamp } : {}),
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    ...foreignTokens(value?.["tokens"]),
  }
}

/**
 * origami_change: the foreign harness's own token counts, carried through.
 *
 * REFUSES NOTHING. Unlike `id` and `role`, a bad count is not worth failing a
 * transcript the user can see on screen: a non-number is simply omitted, and
 * `ForeignTranscript.tokensOf` clamps whatever survives. The two things that make
 * a row cost money - `cost` and the step-finish part - are untouched.
 */
function foreignTokens(raw: unknown): { tokens?: ForeignTranscript.ForeignTokens } {
  const value = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined
  if (!value) return {}
  const tokens: Record<string, number> = {}
  for (const key of ["input", "output", "reasoning", "cacheRead", "cacheWrite"] as const) {
    const n = value[key]
    if (typeof n === "number" && Number.isFinite(n)) tokens[key] = n
  }
  return Object.keys(tokens).length > 0 ? { tokens: tokens as ForeignTranscript.ForeignTokens } : {}
}

/**
 * origami_change: the TOP-level catch-all. Anything that does not fail as a typed
 * `ACPService.Error` lands here as a raw `Effect.die` defect. `fromUnknownDefect`
 * still returns the same redacted `ServiceFailureError` (error.ts), so the
 * client-visible shape does not change; what changes is that the real defect, and
 * WHICH handler it died in, reach the engine log first.
 *
 * `Effect.runPromiseExit` rather than `Effect.runPromise`, which discards the Cause
 * down to a bare defect. The Cause carries the named span every
 * `ACPService.Interface` method is built with (`Effect.fn("ACP.xxx")`) - that is
 * what recovers "which ACP method". `Cause.squash` is the exact function
 * `Effect.runPromise` uses internally, so the value thrown on the non-defect path
 * is byte-identical to before.
 *
 * A failure in the log call itself is swallowed: it must never replace the real
 * error the client is waiting for.
 */
function logDefect(cause: Cause.Cause<unknown>, defect: unknown) {
  return AppRuntime.runPromise(
    Effect.logError("agent.run: unrecognized defect reached the top-level catch", {
      error: defect instanceof Error ? defect.message : String(defect),
      stack: defect instanceof Error ? defect.stack : undefined,
      trace: Cause.pretty(cause),
    }),
  ).catch(() => undefined)
}

/**
 * origami_change (interject): the `images` param, validated.
 *
 * `undefined` in (nothing attached) answers an empty list; a list of well-formed
 * base64 pairs answers itself; ANYTHING else answers `undefined`, which the caller
 * turns into an invalid-params refusal. Dropping a malformed entry instead would
 * hand the model an interjection missing the picture it is about, silently.
 */
function interjectImages(value: unknown): Array<{ mimeType: string; data: string }> | undefined {
  if (value === undefined) return []
  if (!Array.isArray(value)) return undefined
  const images: Array<{ mimeType: string; data: string }> = []
  for (const entry of value) {
    if (!entry || typeof entry !== "object") return undefined
    const { mimeType, data } = entry as { mimeType?: unknown; data?: unknown }
    if (typeof mimeType !== "string" || !mimeType || typeof data !== "string" || !data) return undefined
    images.push({ mimeType, data })
  }
  return images
}

function run<A>(effect: Effect.Effect<A, ACPService.Error>) {
  return Effect.runPromiseExit(effect.pipe(Effect.mapError(ACPError.toRequestError))).then(async (exit) => {
    if (Exit.isSuccess(exit)) return exit.value
    const defect = Cause.squash(exit.cause)
    if (defect instanceof RequestError) throw defect
    await logDefect(exit.cause, defect)
    throw ACPError.toRequestError(ACPError.fromUnknownDefect(defect))
  })
}

export * as ACP from "./agent"
