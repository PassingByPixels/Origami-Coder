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

export function init({ sdk: _sdk }: { sdk: OrigamiClient }) {
  return {
    create: (connection: AgentSideConnection) => {
      // The browser tool runs in this same process (cli/cmd/acp.ts starts the
      // server in-process), so registering the live connection here is what
      // makes `origami/browser` reachable from a tool call. EVERY client is
      // registered, VS Code or not - which client is on the other end is not
      // known here - so a client without the method rejects the call with
      // -32601, which the bridge maps to its unavailable prose (browser/bridge.ts).
      BrowserBridge.registerConnection(connection)
      // origami_change: `settledCommands` is wired HERE and nowhere else — it
      // reaches the engine through the process-wide AppRuntime, which only this
      // entry point (cli/cmd/acp.ts) actually runs. It is what lets a chat open
      // without waiting for MCP servers to connect and still receive their
      // prompt commands a moment later.
      return new Agent(ACPService.make({ sdk: _sdk, connection, settledCommands: ACPService.settledCommands }))
    },
  }
}

export class Agent implements ACPAgent {
  constructor(private readonly service: ACPService.Interface) {}

  initialize(params: InitializeRequest) {
    return run(this.service.initialize(params))
  }

  authenticate(params: AuthenticateRequest) {
    return run(this.service.authenticate(params))
  }

  newSession(params: NewSessionRequest) {
    return run(this.service.newSession(params))
  }

  loadSession(params: LoadSessionRequest) {
    return run(this.service.loadSession(params))
  }

  listSessions(params: ListSessionsRequest) {
    return run(this.service.listSessions(params))
  }

  resumeSession(params: ResumeSessionRequest) {
    return run(this.service.resumeSession(params))
  }

  closeSession(params: CloseSessionRequest) {
    return run(this.service.closeSession(params))
  }

  unstable_forkSession(params: ForkSessionRequest) {
    return run(this.service.forkSession(params))
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

  /**
   * Fork-owned ACP extension methods. The JS SDK routes anything it does not
   * recognise here VERBATIM (see its `default:` case) — it does not strip the
   * leading `_` that clients put on the wire for extension methods, so both
   * `run_steps` and `_run_steps` must land on the same handler.
   */
  extMethod(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const name = method.startsWith("_") ? method.slice(1) : method
    switch (name) {
      case "run_steps": {
        const sessionId = typeof params?.["sessionId"] === "string" ? (params["sessionId"] as string) : undefined
        if (!sessionId) throw RequestError.invalidParams("run_steps requires a string sessionId")
        const cwd = typeof params?.["cwd"] === "string" ? (params["cwd"] as string) : undefined
        return run(this.service.runSteps({ sessionId, ...(cwd ? { cwd } : {}) })) as Promise<Record<string, unknown>>
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
        // The CHILD's id, not the caller's — validated exactly like `run_steps`'
        // own sessionId, since it is the same kind of value read the same way.
        const sessionId = typeof params?.["sessionId"] === "string" ? (params["sessionId"] as string) : undefined
        if (!sessionId) throw RequestError.invalidParams("subagent_transcript requires a string sessionId")
        const cwd = typeof params?.["cwd"] === "string" ? (params["cwd"] as string) : undefined
        return run(this.service.subagentTranscript({ sessionId, ...(cwd ? { cwd } : {}) })) as Promise<
          Record<string, unknown>
        >
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
      case "interject": {
        // origami_change: fork-only. A message pushed into the running turn.
        const sessionId = typeof params?.["sessionId"] === "string" ? params["sessionId"] : undefined
        const text = typeof params?.["text"] === "string" ? params["text"] : undefined
        if (!sessionId || !text) throw RequestError.invalidParams("interject requires string sessionId and text")
        return run(this.service.interject({ sessionId, text })) as Promise<Record<string, unknown>>
      }
      case "prompt_capture": {
        // No cwd fallback: an engine session id resolves one session outright,
        // and answering for `process.cwd()` would be answering about a
        // different chat than the caller asked about.
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
        // `code` is absent for an "auto" method and REQUIRED for a "code" one;
        // which of those applies is the plugin's answer, not this layer's, so
        // only the shape is checked here and the engine decides the rest.
        return run(
          this.service.providerAuthCallback({
            providerID: providerIdOf(params, "provider_auth_callback"),
            methodIndex: methodIndexOf(params, "provider_auth_callback"),
            ...optionalText(params, "provider_auth_callback", "code"),
            ...cwdOf(params),
          }),
        ) as Promise<Record<string, unknown>>
      }
      case "provider_refresh": {
        // No providerID: the credential the shell just wrote could be for any
        // provider, and re-reading config is a whole-file job either way. `cwd`
        // picks the instance, exactly as the other cwd-bearing methods do.
        return run(this.service.providerRefresh(cwdOf(params))) as Promise<Record<string, unknown>>
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
        // `null` restores the default and must be sent explicitly - an absent
        // key reads as `undefined` here, and treating that as "restore" would
        // let a malformed call quietly reset a deliberate overnight setting.
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
        // The VALUE is not validated here beyond its type: which flavors exist
        // is the collab layer's business, and it refuses an unknown one with a
        // message naming the ones that do - which is more use than a schema
        // error from the transport.
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
        // `null` clears the seat and must be sent explicitly - an absent key
        // reads as `undefined` here, and treating that as "clear" would let a
        // malformed call silently mute a room's whole default routing.
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
        // Non-empty, unlike `collab_post`: an empty post is a real "carry on"
        // that releases a held room, but an empty correction corrects nothing
        // and would wake the target to read a blank line.
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

/**
 * An optional array of agent slugs. Absent stays absent; present must be an
 * array of non-empty strings, because a slug that decoded to nothing would be
 * dropped silently and change who the call reaches.
 */
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

/**
 * The method index into the plugin's own `methods` array. A non-integer would
 * index into `undefined` and die inside the provider service, and a negative
 * one would read off the end — both are rejected here rather than coerced,
 * because picking the WRONG login method silently is how a user ends up in a
 * flow they did not choose.
 */
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

/** The optional `cwd` every ext method accepts, omitted rather than invented when absent. */
function cwdOf(params: Record<string, unknown>): { cwd?: string } {
  const cwd = typeof params?.["cwd"] === "string" ? (params["cwd"] as string) : undefined
  return cwd ? { cwd } : {}
}

/**
 * origami_change: the second swallow point in the same class as the interject
 * incident (see the `mapRequestError` comment in `service.ts`). This is the
 * TOP-level catch-all: anything that doesn't fail as a typed `ACPService.Error`
 * lands here as a raw `Effect.die` defect - e.g. `InstanceState` dying with
 * "InstanceRef not provided" deep inside a handler that never went through
 * `request()` at all. `fromUnknownDefect` still returns the same redacted
 * `ServiceFailureError` (unchanged, error.ts) - the client-visible shape does
 * not change. What changes is that the real defect, and WHICH handler it died
 * in, now reach the engine log first.
 *
 * `run()` has no ambient Effect context - it's a plain `.then()` boundary, not
 * a generator - so `Effect.runPromise` (which discards the Cause down to a
 * bare defect via `causeSquash`) is swapped for `Effect.runPromiseExit`,
 * which hands back the full `Cause` to inspect before squashing it. That is
 * what recovers "which ACP method": every `ACPService.Interface` method is
 * built with `Effect.fn("ACP.xxx")`, which stamps a named span into the
 * fiber's stack-frame trace, and `Cause.pretty` renders it. `Cause.squash`
 * is the exact function `Effect.runPromise` used internally, so the value
 * thrown on the non-defect path is byte-identical to before.
 *
 * The log Effect is bridged through `AppRuntime` - the same escape hatch
 * `service.ts` already uses everywhere it needs to reach an Effect service
 * from plain (non-generator) code, e.g. every
 * `request(() => AppRuntime.runPromise(...), "...")` call there. A failure in
 * the log call itself is swallowed: it must never replace the real error the
 * client is waiting for.
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
