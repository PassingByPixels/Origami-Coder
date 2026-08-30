import {
  type AgentSideConnection,
  type AuthenticateRequest,
  type AuthenticateResponse,
  type AuthMethod,
  type CancelNotification,
  type CloseSessionRequest,
  type CloseSessionResponse,
  type ForkSessionRequest,
  type ForkSessionResponse,
  type InitializeRequest,
  type InitializeResponse,
  type ListSessionsRequest,
  type ListSessionsResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type McpServer,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type ResumeSessionRequest,
  type ResumeSessionResponse,
  type SessionInfo,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
  type SetSessionModelRequest,
  type SetSessionModelResponse,
  type SetSessionModeRequest,
  type SetSessionModeResponse,
} from "@agentclientprotocol/sdk"
import { InstallationVersion } from "@origami/core/installation/version"
import { AppNodeBuilder } from "@origami/core/effect/app-node-builder"
import { AppRuntime } from "@/effect/app-runtime"
// origami_change (t-kgu05m): peer discovery reads the ACP session store.
import { AgentBroker } from "@/origami/agent-broker"
import type { AssistantMessage, Message, OrigamiClient, SessionMessageResponse } from "@origami/sdk/v2"
import { Context, Effect, Layer, ManagedRuntime } from "effect"
import * as ACPError from "./error"
import { buildConfigOptions, parseModelSelection } from "./config-option"
import { promptContentToParts } from "./content"
import { Directory } from "./directory"
import { ACPEvent } from "./event"
import { Instructions } from "./instructions"
import { ACPAgentPlugins } from "./agent-plugins"
import { ACPMcp } from "./mcp"
import { ACPProviderAuth } from "./provider-auth"
import { ACPProviderUsage } from "./provider-usage"
import { SessionPromptCapture } from "@/session/prompt-capture"
import { SessionPrompt } from "@/session/prompt" // origami_change
import { SessionID } from "@/session/schema" // origami_change
import { PermissionPresets } from "@/permission/presets"
import { RunSteps } from "./run-steps"
import { RunStats } from "./run-stats"
import { SubagentTranscript } from "./subagent-transcript"
import { Skills } from "./skills"
import { ACPTools } from "./tools"
import { ACPCollab } from "@/collab/acp"
import type { CollabRunner } from "@/collab/runner"
import type { CollabStore } from "@/collab/store"
import { ACPSession } from "./session"
import { UsageService } from "./usage"
import { ACPProfile } from "./profile"
import { ProviderV2 } from "@origami/core/provider"
import { ModelV2 } from "@origami/core/model"
import { Provider } from "@/provider/provider"
import {
  isDefaultTitle,
  withSubagentModel,
  withCompactionThreshold,
  withVisionProfile,
  type CompactionThresholdOverride,
} from "@/session/session"
import { Command } from "@/command" // origami_change: the late MCP-prompt fold needs the service, not just its type
import { Config } from "@/config/config" // origami_change: provider_refresh re-reads config in-process
import { InstanceRef } from "@/effect/instance-ref" // origami_change
import { InstanceStore } from "@/project/instance-store" // origami_change
import { BackgroundJob } from "@/background/job"

export const AuthMethodID = "origami-login"

export type Error = ACPError.Error
type ServiceConnection = Pick<AgentSideConnection, "sessionUpdate"> &
  Partial<Pick<AgentSideConnection, "requestPermission" | "writeTextFile" | "extNotification">>

export type Interface = {
  readonly initialize: (input: InitializeRequest) => Effect.Effect<InitializeResponse, Error>
  readonly authenticate: (input: AuthenticateRequest) => Effect.Effect<AuthenticateResponse, Error>
  readonly newSession: (input: NewSessionRequest) => Effect.Effect<NewSessionResponse, Error>
  readonly loadSession: (input: LoadSessionRequest) => Effect.Effect<LoadSessionResponse, Error>
  readonly listSessions: (input: ListSessionsRequest) => Effect.Effect<ListSessionsResponse, Error>
  readonly resumeSession: (input: ResumeSessionRequest) => Effect.Effect<ResumeSessionResponse, Error>
  readonly closeSession: (input: CloseSessionRequest) => Effect.Effect<CloseSessionResponse, Error>
  readonly forkSession: (input: ForkSessionRequest) => Effect.Effect<ForkSessionResponse, Error>
  readonly setSessionConfigOption: (
    input: SetSessionConfigOptionRequest,
  ) => Effect.Effect<SetSessionConfigOptionResponse, Error>
  readonly setSessionMode: (input: SetSessionModeRequest) => Effect.Effect<SetSessionModeResponse, Error>
  readonly setSessionModel: (input: SetSessionModelRequest) => Effect.Effect<SetSessionModelResponse, Error>
  readonly prompt: (input: PromptRequest) => Effect.Effect<PromptResponse, Error>
  readonly cancel: (input: CancelNotification) => Effect.Effect<void, Error>
  readonly runSteps: (input: RunStepsRequest) => Effect.Effect<RunSteps.RunStepsResult, Error>
  readonly runStats: (input: RunStatsRequest) => Effect.Effect<RunStats.RunStatsResult, Error>
  readonly subagentTranscript: (
    input: SubagentTranscriptRequest,
  ) => Effect.Effect<SubagentTranscript.SubagentTranscriptResult, Error>
  readonly listInstructions: (input: ListInstructionsRequest) => Effect.Effect<Instructions.InstructionSet, Error>
  readonly promptCapture: (input: PromptCaptureRequest) => Effect.Effect<PromptCaptureResult, Error>
  readonly cacheStats: (input: CacheStatsRequest) => Effect.Effect<CacheStatsResult, Error>
  readonly listSkills: (input: ListSkillsRequest) => Effect.Effect<Skills.SkillsResult, Error>
  readonly listTools: (input: ListToolsRequest) => Effect.Effect<ACPTools.ToolsResult, Error>
  readonly listAgentPlugins: (input: ListAgentPluginsRequest) => Effect.Effect<ACPAgentPlugins.PluginsResult, Error>
  readonly agentPluginAdd: (input: AgentPluginAddRequest) => Effect.Effect<ACPAgentPlugins.WriteResult, Error>
  readonly agentPluginSetEnabled: (
    input: AgentPluginSetEnabledRequest,
  ) => Effect.Effect<ACPAgentPlugins.SetEnabledResult, Error>
  readonly mcpList: (input: McpListRequest) => Effect.Effect<ACPMcp.ListResult, Error>
  readonly mcpAdd: (input: McpAddRequest) => Effect.Effect<ACPMcp.WriteResult, Error>
  readonly mcpRemove: (input: McpNameRequest) => Effect.Effect<ACPMcp.WriteResult, Error>
  readonly mcpSetEnabled: (input: McpSetEnabledRequest) => Effect.Effect<ACPMcp.WriteResult, Error>
  readonly mcpConnect: (input: McpNameRequest) => Effect.Effect<ACPMcp.WriteResult, Error>
  readonly mcpDisconnect: (input: McpNameRequest) => Effect.Effect<ACPMcp.WriteResult, Error>
  readonly mcpAuthenticate: (input: McpNameRequest) => Effect.Effect<ACPMcp.WriteResult, Error>
  readonly mcpAuthRemove: (input: McpNameRequest) => Effect.Effect<ACPMcp.WriteResult, Error>
  readonly providerAuthList: (input: ProviderAuthListRequest) => Effect.Effect<ACPProviderAuth.ListResult, Error>
  readonly providerAuthAuthorize: (
    input: ProviderAuthAuthorizeRequest,
  ) => Effect.Effect<ACPProviderAuth.AuthorizeResult, Error>
  readonly providerAuthCallback: (
    input: ProviderAuthCallbackRequest,
  ) => Effect.Effect<ACPProviderAuth.CallbackResult, Error>
  readonly providerAuthUsage: (input: ProviderAuthUsageRequest) => Effect.Effect<ACPProviderUsage.UsageResult, Error>
  readonly providerRefresh: (input: ProviderRefreshRequest) => Effect.Effect<{ ok: true }, Error>
  readonly collabAgents: (
    input: CollabAgentsRequest,
  ) => Effect.Effect<{ agents: readonly ACPCollab.AgentEntry[] }, Error>
  readonly collabList: (input: CollabListRequest) => Effect.Effect<{ collabs: readonly ACPCollab.CollabEntry[] }, Error>
  readonly collabCreate: (input: CollabCreateRequest) => Effect.Effect<{ collab: ACPCollab.CollabEntry }, Error>
  readonly collabPost: (input: CollabPostRequest) => Effect.Effect<ACPCollab.PostResult, Error>
  readonly collabPreview: (input: CollabPreviewRequest) => Effect.Effect<ACPCollab.PreviewResult, Error>
  readonly collabState: (input: CollabStateRequest) => Effect.Effect<ACPCollab.State, Error>
  readonly collabSetCap: (input: CollabSetCapRequest) => Effect.Effect<{ ok: true }, Error>
  readonly collabSetConcurrency: (input: CollabSetConcurrencyRequest) => Effect.Effect<{ ok: true }, Error>
  readonly collabSetFlavor: (input: CollabSetFlavorRequest) => Effect.Effect<{ ok: true }, Error>
  readonly collabSetLead: (input: CollabSetLeadRequest) => Effect.Effect<{ ok: true }, Error>
  readonly collabSetObjective: (input: CollabSetObjectiveRequest) => Effect.Effect<{ ok: true }, Error>
  readonly collabTaskAdd: (input: CollabTaskAddRequest) => Effect.Effect<{ task: ACPCollab.TaskEntry }, Error>
  readonly collabTaskUpdate: (input: CollabTaskUpdateRequest) => Effect.Effect<{ task: ACPCollab.TaskEntry }, Error>
  readonly collabReview: (input: CollabReviewRequest) => Effect.Effect<{ task: ACPCollab.TaskEntry }, Error>
  readonly collabLedger: (
    input: CollabLedgerRequest,
  ) => Effect.Effect<{ entries: readonly ACPCollab.LedgerEntry[]; totals: readonly ACPCollab.CostTotalEntry[] }, Error>
  readonly collabStop: (input: CollabStopRequest) => Effect.Effect<{ ok: true }, Error>
  readonly collabStopAgent: (input: CollabStopAgentRequest) => Effect.Effect<CollabRunner.StopAgentResult, Error>
  readonly collabRedirect: (input: CollabRedirectRequest) => Effect.Effect<{ seq: number }, Error>
  readonly collabArchive: (input: CollabArchiveRequest) => Effect.Effect<{ ok: true }, Error>
  readonly collabUnarchive: (input: CollabArchiveRequest) => Effect.Effect<{ ok: true }, Error>
  readonly collabRename: (input: CollabRenameRequest) => Effect.Effect<{ ok: true }, Error>
  readonly collabAddParticipant: (input: CollabParticipantRequest) => Effect.Effect<{ ok: true }, Error>
  readonly collabRemoveParticipant: (input: CollabParticipantRequest) => Effect.Effect<{ ok: true }, Error>
  readonly shellStop: (input: ShellStopRequest) => Effect.Effect<{ status: string }, Error>
  // origami_change: push a message INTO the running turn.
  readonly interject: (input: InterjectRequest) => Effect.Effect<InterjectReply, Error>
}

/**
 * How many root sessions `listSessions` will read out of the store for ONE
 * directory before it stops. This is the ceiling the DB layer used to apply
 * silently at 100 (`session/session.ts` listByProject, `limit ?? 100`); naming
 * it here makes the cut visible and moves it far enough out that the cursor
 * paging — not an invisible default — decides what a client sees.
 */
export const SESSION_LIST_MAX = 5000

export type ShellStopRequest = { readonly jobId: string; readonly sessionId: string }
// origami_change-start (interject)
export type InterjectRequest = { readonly sessionId: string; readonly text: string }
/** `delivered` is the acknowledgement the composer waits on: the message is
 *  durably in the transcript, and the turn will read it at its next tool
 *  boundary. `promoted` counts the blocking foreground shells handed to the
 *  background to bring that boundary forward. */
export type InterjectReply = { readonly delivered: true; readonly busy: boolean; readonly promoted: number }
// origami_change-end

/** Fork-owned ext method `run_steps`: review a past run's steps. Read-only. */
export type RunStepsRequest = {
  readonly sessionId: string
  readonly cwd?: string
}

/** Fork-owned ext method `run_stats`: counts for a PAGE of past runs, in one call. Read-only. */
export type RunStatsRequest = {
  readonly sessionIds: readonly string[]
  readonly cwd?: string
}

/**
 * Fork-owned ext method `subagent_transcript`: ONE sub-agent's own conversation,
 * projected into the shapes the chat renders. Read-only.
 *
 * `sessionId` is the CHILD's id — the one `tool/task.ts` stamps on the spawning
 * tool part's metadata and the engine rides as `_meta.origami_task_session`.
 * `cwd` scopes the read exactly as it does for `run_steps`.
 *
 * NOT scoped to a caller's own children, deliberately, and the same way
 * `run_steps` is not: any stored session id can be reviewed. The transport IS
 * the boundary — a local shell that spawned this engine over its own stdio —
 * and it is the same shell that would call `run_steps` on the parent to learn
 * the child id in the first place. Enforcing descent would also cost a second
 * read of the parent and would refuse the legitimate case of a grandchild,
 * whose spawn is recorded in the child's stream, not the caller's.
 */
export type SubagentTranscriptRequest = {
  readonly sessionId: string
  readonly cwd?: string
}

/** Fork-owned ext method `list_instructions`: what feeds the system prompt. */
export type ListInstructionsRequest = {
  readonly cwd?: string
}

/**
 * Fork-owned ext method `list_tools`: the workspace's base tool list with the
 * deferred-catalog verdict per tool. Read-only, and `cwd` is optional exactly
 * like `list_instructions` — an active-session caller omits it.
 */
export type ListToolsRequest = {
  readonly cwd?: string
}

/**
 * Fork-owned ext method `prompt_capture`: what the engine ACTUALLY sent the
 * model on this session's last turn. Takes no `cwd` — unlike the inventory
 * methods it resolves nothing from disk, and an engine session id already
 * identifies one session in this process.
 *
 * Unlike `list_instructions`, this DOES send text. That is the whole feature:
 * sizes alone cannot answer "what is in those 10k tokens", and the caller is
 * the local shell that spawned this engine over its own stdio.
 */
export type PromptCaptureRequest = {
  readonly sessionId: string
}

export type PromptCaptureResult = {
  readonly sessionId: string
  /** Null until this session has sent a turn — an unsent session is not an error. */
  readonly capture: SessionPromptCapture.Capture | null
}

/**
 * Fork-owned ext method `cache_stats`: this session's prompt-cache token
 * accounting plus a LIFETIME sum across the directory, for the Insights
 * cache-hit-ratio card (t-kgtw47). `cwd` is optional exactly like
 * `list_instructions` — an active-session caller omits it and the engine
 * resolves its own process directory.
 */
export type CacheStatsRequest = {
  readonly sessionId: string
  readonly cwd?: string
}

export type CacheStatsResult = {
  readonly sessionId: string
  /** Null when this session's row was not in the listing (e.g. deleted
   *  mid-read) — the lifetime total below is still real either way. */
  readonly current: UsageService.SessionCacheTokens | null
  readonly lifetime: UsageService.SessionCacheTokens
  /** How many session rows fed the lifetime sum — context for the number. */
  readonly sessionCount: number
}

/** Fork-owned ext method `list_skills`: the workspace's discovered skills. */
export type ListSkillsRequest = {
  readonly cwd?: string
  /** Re-walk the skill directories first, instead of answering from the boot-time scan. */
  readonly refresh?: boolean
}

/** Fork-owned ext method `list_agent_plugins`: installed agent-plugins.org
 *  plugins from `agentPlugins` config + loader state, for the Plugins pane. */
export type ListAgentPluginsRequest = {
  readonly cwd?: string
}

/** Fork-owned ext method `agent_plugin_add`: validate `dir` as a plugin
 *  (reusing the manifest parser) and append it to the project config. */
export type AgentPluginAddRequest = {
  readonly cwd?: string
  readonly dir: string
}

/** Fork-owned ext method `agent_plugin_set_enabled`: toggle one plugin's
 *  enabled state in whichever config file already names it. */
export type AgentPluginSetEnabledRequest = {
  readonly cwd?: string
  readonly spec: string
  readonly enabled: boolean
}

/** Fork-owned ext method `mcp_list`: every MCP server the engine knows -
 *  config-declared AND plugin-provided - with its live connection status. */
export type McpListRequest = {
  readonly cwd?: string
}

/** Fork-owned ext method `mcp_add`: validate a server config, persist it to the
 *  project or global file, then connect it without a session restart. */
export type McpAddRequest = {
  readonly cwd?: string
  readonly name: string
  /** A `ConfigMCPV1.Info` shape. Validated engine-side against that schema. */
  readonly server: unknown
  readonly scope: "project" | "global"
}

/** The ext methods that act on ONE named server and take nothing else:
 *  `mcp_remove`, `mcp_connect`, `mcp_disconnect`, `mcp_authenticate`,
 *  `mcp_auth_remove`. */
export type McpNameRequest = {
  readonly cwd?: string
  readonly name: string
}

/** Fork-owned ext method `mcp_set_enabled`: flip one server in config AND at
 *  runtime, so the toggle does not need a restart to mean anything. */
export type McpSetEnabledRequest = {
  readonly cwd?: string
  readonly name: string
  readonly enabled: boolean
}

/** Fork-owned ext method `provider_auth_list`: each provider plugin's login
 *  methods, plus the TYPE of credential already on file. Never a token. */
export type ProviderAuthListRequest = {
  readonly cwd?: string
}

/** Fork-owned ext method `provider_auth_authorize`: start one provider's OAuth
 *  flow and answer with the URL to open. Returns as soon as the plugin is
 *  listening — it never waits for the browser. */
export type ProviderAuthAuthorizeRequest = {
  readonly cwd?: string
  readonly providerID: string
  readonly methodIndex: number
}

/** Fork-owned ext method `provider_auth_callback`: finish the flow `authorize`
 *  started. For a "code" method `code` carries what the user pasted; for an
 *  "auto" method this AWAITS the browser/device callback the plugin is
 *  already listening for. */
export type ProviderAuthCallbackRequest = {
  readonly cwd?: string
  readonly providerID: string
  readonly methodIndex: number
  readonly code?: string
}

/** Fork-owned ext method `provider_auth_usage`: how much of a SUBSCRIPTION
 *  connection's quota is spent. Read-only, no flow, and — unlike the other three
 *  — no `cwd`: the credential store is global, not per-instance. Answers
 *  `{ ok: false, unavailable }` rather than failing whenever the provider has no
 *  usage source, which is the normal case for every provider except openai. */
export type ProviderAuthUsageRequest = {
  readonly providerID: string
}

/**
 * Fork-owned ext method `provider_refresh`: re-read provider configuration in a
 * RUNNING engine, so a credential the shell just wrote takes effect without a
 * window reload.
 *
 * THE PROBLEM IT SOLVES. The shell writes `provider.<id>.options.apiKey` into
 * the global origami.json itself, and nothing in the engine notices: the global
 * file is cached with `Duration.infinity` (config/config.ts), the merged
 * per-instance config and the provider list are `InstanceState` entries with no
 * TTL, and there is no watcher on the config directory. Until this existed the
 * only cure was restarting the engine - which is what "reload the window" in
 * the connect toast has always meant.
 *
 * WHAT IT INVALIDATES, and what it deliberately does not. Two memos, in the
 * session's own instance: `Config.invalidateInstance()` (the global file cache
 * plus the merged config) and `Provider.invalidate()` (the provider list, the
 * SDK client map and the language-model map, which are built FROM that config
 * and survive its invalidation on their own). Nothing else is touched.
 *
 * Not the HTTP `config.refresh` route, even though `resolveConfiguredModel` and
 * `resolveRequestedAgent` both call it for their own self-heal: that route
 * disposes the WHOLE instance (`markInstanceForDisposal`), taking session, MCP
 * and background state with it, and it can only do so because disposal is hung
 * off an HTTP pre-response handler. This call has no request to hang anything
 * off, and a connect can land while a turn is streaming. Neither state
 * invalidated here registers a finalizer, so this is a memo drop and not a
 * teardown - an in-flight turn keeps the client it holds and its next step
 * rebuilds against the new credential.
 *
 * NOT a snapshot refresh either. A model that only exists in config written a
 * moment ago is already self-healed on use by `resolveConfiguredModel`, which
 * refreshes the directory snapshot and retries once.
 */
export type ProviderRefreshRequest = {
  readonly cwd?: string
}

/** Fork-owned ext method `collab_agents`: the agent definitions that opted into Collabs. */
export type CollabAgentsRequest = {
  readonly cwd?: string
}

/** Fork-owned ext method `collab_list`: every Collab, archived ones included. */
export type CollabListRequest = {
  readonly cwd?: string
}

/** Fork-owned ext method `collab_create`: open a stream with a fixed roster. */
export type CollabCreateRequest = {
  readonly title: string
  readonly agentSlugs: readonly string[]
  readonly objective?: string
  readonly cwd?: string
}

/**
 * Fork-owned ext method `collab_post`: add a HUMAN message. Answers with its
 * sequence number as soon as the message is durable - the turns it fans out to
 * the roster run detached, and are observed through `collab_state`.
 *
 * `mentions` addresses the post to named agents. Every slug must be on the
 * ACTIVE roster; one that is not fails the call outright rather than recording
 * a message nobody will ever receive.
 *
 * `images` attaches `data:` URLs to the post. Bounded by the engine in count
 * and size; a set that breaks either bound fails the call and appends nothing,
 * for the same reason a bad mention does.
 */
export type CollabPostRequest = {
  readonly collabId: string
  readonly text: string
  readonly mentions?: readonly string[]
  readonly images?: readonly string[]
  readonly cwd?: string
}

/**
 * Fork-owned ext method `collab_preview`: who the draft in the composer WOULD
 * wake. A pure read - nothing is posted, no turn is scheduled and no token is
 * spent - so it is safe to call while the human is still typing.
 *
 * There is no `text`: the wake rules read a message's kind and its address
 * list, never its prose, so the draft's words cannot change the answer.
 */
export type CollabPreviewRequest = {
  readonly collabId: string
  readonly mentions?: readonly string[]
  readonly cwd?: string
}

/**
 * Fork-owned ext method `collab_state`: the whole Collab picture in one
 * round-trip. `sinceSeq` narrows the MESSAGES only; the roster, the per-agent
 * turn status and the suspended verdict always describe the whole stream.
 */
export type CollabStateRequest = {
  readonly collabId: string
  readonly sinceSeq?: number
  readonly cwd?: string
}

/** Fork-owned ext method `collab_set_cap`: null restores the default, 0 is off. */
export type CollabSetCapRequest = {
  readonly collabId: string
  readonly cap: number | null
  readonly cwd?: string
}

/**
 * Fork-owned ext method `collab_set_concurrency`: how many participant turns
 * this room dispatches at once. 1 is the serial default. Raising it is REFUSED
 * unless every member is read-only for files - see CollabParallel's header for
 * why that gate exists instead of per-worker worktrees.
 */
export type CollabSetConcurrencyRequest = {
  readonly collabId: string
  readonly concurrency: number
  readonly cwd?: string
}

/**
 * Fork-owned ext method `collab_set_flavor`: what KIND of room this is -
 * `discuss` (the chain) or `council` (one question to every member at once,
 * blind, then a synthesis). Turning a room into a council is REFUSED unless
 * every member is read-only for files, because a council dispatches in
 * parallel; going back is never refused.
 */
export type CollabSetFlavorRequest = {
  readonly collabId: string
  readonly flavor: string
  readonly cwd?: string
}

/**
 * Fork-owned ext method `collab_set_lead`: name the agent an unaddressed human
 * message reaches, or clear the seat with an explicit null.
 */
export type CollabSetLeadRequest = {
  readonly collabId: string
  readonly agentSlug: string | null
  readonly cwd?: string
}

/** Fork-owned ext method `collab_set_objective`: the room's standing goal. */
export type CollabSetObjectiveRequest = {
  readonly collabId: string
  readonly objective: string
  readonly cwd?: string
}

/** Fork-owned ext method `collab_task_add`: put one open task on the board. */
export type CollabTaskAddRequest = {
  readonly collabId: string
  readonly title: string
  readonly cwd?: string
}

/**
 * Fork-owned ext method `collab_task_update`: move one task along the board.
 * Only the contracted transitions are accepted; anything else is refused with
 * the reason, so a stale button in a shell cannot corrupt the board.
 */
export type CollabTaskUpdateRequest = {
  readonly collabId: string
  readonly taskId: string
  readonly action: CollabStore.TaskAction
  readonly result?: string
  readonly note?: string
  readonly owner?: string
  readonly cwd?: string
}

/**
 * Fork-owned ext method `collab_review`: the human's verdict on a task an agent
 * completed - `approve` accepts it, `reject` sends it back to its owner with
 * the reason, which the room row then carries so the owner can act on it. Runs
 * the same two board transitions `collab_task_update` does; only a COMPLETED
 * task can take a verdict.
 */
export type CollabReviewRequest = {
  readonly collabId: string
  readonly taskId: string
  readonly verdict: ACPCollab.Verdict
  readonly note?: string
  readonly cwd?: string
}

/** Fork-owned ext method `collab_ledger`: turn costs, newest first, plus totals. */
export type CollabLedgerRequest = {
  readonly collabId: string
  readonly limit?: number
  readonly cwd?: string
}

/**
 * Fork-owned ext method `collab_stop`: interrupt the turn in flight, drop the
 * queue behind it and spend the rest of the hop budget. The next human post
 * buys a new one - this is a pause, not an archive.
 */
export type CollabStopRequest = {
  readonly collabId: string
  readonly cwd?: string
}

/**
 * Fork-owned ext method `collab_stop_agent`: stop ONE agent and leave the room
 * running. Its turn in flight is interrupted and its child session cancelled,
 * its slug alone comes out of the queue, and the hop budget is untouched -
 * everything `collab_stop` does to the whole room, narrowed to one member.
 */
export type CollabStopAgentRequest = {
  readonly collabId: string
  readonly agentSlug: string
  readonly cwd?: string
}

/**
 * Fork-owned ext method `collab_redirect`: correct ONE agent. A human message
 * addressed to it alone, with its turn moved to the front of the queue so the
 * correction lands before the work it corrects carries on. Buys a fresh hop
 * budget like any human post, so a suspended room can be steered as well as
 * released.
 */
export type CollabRedirectRequest = {
  readonly collabId: string
  readonly agentSlug: string
  readonly text: string
  readonly cwd?: string
}

/**
 * Fork-owned ext methods `collab_archive` / `collab_unarchive`: close a stream,
 * and reopen it. Archived collabs stay listable - archiving is "read-only from
 * here", not "delete" - and `collab_unarchive` is what makes that true, because
 * a room with no way back is a delete the user was told was not one.
 */
export type CollabArchiveRequest = {
  readonly collabId: string
  readonly cwd?: string
}

/** Fork-owned ext method `collab_rename`: retitle a stream. */
export type CollabRenameRequest = {
  readonly collabId: string
  readonly title: string
  readonly cwd?: string
}

/**
 * Fork-owned ext methods `collab_add_participant` / `collab_remove_participant`:
 * change the roster of a live stream. Removal is a SOFT delete - the agent's
 * session and its messages both survive it, and adding the slug back restores
 * the same member rather than a fresh one.
 */
export type CollabParticipantRequest = {
  readonly collabId: string
  readonly agentSlug: string
  readonly cwd?: string
}

export class Service extends Context.Service<Service, Interface>()("@origami/ACP/Service") {}

export function make(input: {
  sdk: OrigamiClient
  connection?: ServiceConnection
  directory?: Directory.Interface
  session?: ACPSession.Interface
  usage?: UsageService.Interface
  instructions?: Instructions.Interface
  /** Reader for the prompt-capture store; injectable so a test needs no engine. */
  promptCapture?: (sessionID: string) => SessionPromptCapture.Capture | null
  skills?: Skills.Interface
  collab?: ACPCollab.Interface
  eventSubscription?: (subscription: ACPEvent.Subscription) => void
  /**
   * origami_change: reader for the engine's SETTLED command vocabulary — the
   * one that waits for background MCP prompt discovery (see `settledCommands`).
   *
   * ABSENT means no late fold, and that is the default on purpose: the real
   * reader runs the process-wide AppRuntime, which a caller that fakes the sdk
   * has no engine for. `ACP.init` wires it, because the ACP CLI is the one
   * place that really does run the engine in this process.
   */
  settledCommands?: (directory: string) => Promise<readonly Command.Info[]>
}): Interface {
  const session = input.session ?? makeSessionService()
  const directoryService = input.directory ?? makeDirectoryService(input.sdk)
  const registeredMcp = new Map<string, Set<string>>()
  const sessionSnapshots = new Map<string, Directory.Snapshot>()
  const instructionsService = input.instructions ?? makeInstructionsService()
  // Plain module state, not an AppRuntime call: the prompt loop writes this map
  // in THIS process (cli/cmd/acp.ts starts the server in-process), so there is
  // nothing to resolve and no service to yield.
  const readCapture = input.promptCapture ?? SessionPromptCapture.get
  const skillsService = input.skills ?? makeSkillsService()
  const collabService = input.collab ?? makeCollabService()
  // ONE instance for the whole connection. It was built per call before, which
  // threw away its context-limit cache every time; now it also owns the
  // mid-turn throttle, which is meaningless without a stable instance.
  const usageService = input.usage ?? makeUsageService(input.sdk)
  const events = input.connection
    ? ACPEvent.start({ sdk: input.sdk, connection: input.connection, session, usage: usageService })
    : undefined
  if (events) input.eventSubscription?.(events)
  // origami_change (t-kgu05m): the peer broker publishes which sessions are
  // reachable. This store is the only place that knows which are INTERACTIVE —
  // a sub-agent's session is never registered here — so "interactive only" is a
  // property of the source. Handing over a reader, not data: the broker's own
  // heartbeat decides when to read it, and a process that never registered
  // (every test that builds this service) writes nothing at all.
  AgentBroker.attachSessions(() => Effect.runSync(session.list()).map((info) => info.id))

  const initialize = Effect.fn("ACP.initialize")(function* (params: InitializeRequest) {
    const started = performance.now()
    const authMethod: AuthMethod = {
      description: "Run `origami auth login` in the terminal",
      name: "Login with origami",
      id: AuthMethodID,
    }

    if (params.clientCapabilities?._meta?.["terminal-auth"] === true) {
      authMethod._meta = {
        "terminal-auth": {
          command: "origami",
          args: ["auth", "login"],
          label: "Origami Login",
        },
      }
    }

    // origami_change: the peer broker's display name for THIS
    // engine process, riding agentInfo._meta — the ACP-sanctioned extension
    // point (Implementation._meta), same pattern authMethod._meta uses above.
    // Undefined for a background engine that never registered (AgentBroker.
    // self() is then undefined), so the key is left off entirely rather than
    // published as an empty string. This is the ONLY string that resolves the
    // "which chat is which agent" question: it is exactly the name send_message
    // and list_agents address this session by (agents.ts, AgentBroker.self()),
    // not the archetype/mode label the UI already calls "agentName".
    const peerName = AgentBroker.self()?.name
    const response = {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        mcpCapabilities: {
          http: true,
          sse: true,
        },
        promptCapabilities: {
          embeddedContext: true,
          image: true,
        },
        sessionCapabilities: {
          close: {},
          fork: {},
          list: {},
          resume: {},
        },
      },
      authMethods: [authMethod],
      agentInfo: {
        name: "Origami",
        version: InstallationVersion,
        ...(peerName ? { _meta: { peerName } } : {}),
      },
    }
    ACPProfile.duration("acp.initialize", started)
    return response
  })

  const authenticate = Effect.fn("ACP.authenticate")(function* (params: AuthenticateRequest) {
    if (params.methodId !== AuthMethodID) {
      return yield* new ACPError.UnknownAuthMethodError({ methodId: params.methodId })
    }
    return {}
  })

  const directorySnapshot = Effect.fn("ACP.directorySnapshot")(function* (cwd: string) {
    const started = performance.now()
    const snapshot = yield* directoryService.get(cwd)
    ACPProfile.duration("acp.directory.snapshot", started)
    return snapshot
  })

  // origami_change-start: MCP prompt commands land AFTER the chat is live.
  //
  // `session/new` no longer waits for MCP servers to connect (command/index.ts
  // says why), so the snapshot it answers from carries the builtin, config-file
  // and skill commands only. This is the other half: once discovery settles,
  // re-read the vocabulary and, if it grew, push a fresh
  // `available_commands_update`. That notification is a REPLACEMENT on the
  // client — the composer rebuilds its list from each message it receives
  // (`InputBar.svelte`: "Engine commands replace the list") — so a late set
  // needs no session restart.
  //
  // One job per directory, shared by every chat in it: the reload behind it is
  // a full directory load, and N chats opening at once must not each pay for
  // one.
  const commandFolds = new Map<string, Promise<Directory.Snapshot | undefined>>()

  const foldMcpCommands = (
    read: (directory: string) => Promise<readonly Command.Info[]>,
    cwd: string,
    snapshot: Directory.Snapshot,
  ) => {
    const current = commandFolds.get(cwd)
    if (current) return current
    const started = performance.now()
    const job = read(cwd)
      .then((all) => {
        const known = new Set(snapshot.availableCommands.map((item) => item.name))
        if (all.every((item) => known.has(item.name))) return undefined
        // The snapshot is immutable and cached per directory, and `prompt` reads
        // it to resolve a typed `/name` — so a late command has to land THERE
        // too, or the slash the composer now offers would silently do nothing.
        return Effect.runPromise(directoryService.refresh(cwd))
      })
      .catch(() => undefined)
      .then((next) => {
        ACPProfile.duration("acp.directory.command.mcpFold", started, { folded: !!next })
        return next
      })
    commandFolds.set(cwd, job)
    return job
  }

  /** Push the chat's command list, then push it AGAIN if MCP prompts arrive later. */
  const pushAvailableCommands = (sessionId: string, cwd: string, snapshot: Directory.Snapshot) =>
    Effect.gen(function* () {
      yield* sendAvailableCommands(input.connection, sessionId, snapshot)
      const read = input.settledCommands
      if (!read || !input.connection) return
      const known = new Set(snapshot.availableCommands.map((item) => item.name))
      void foldMcpCommands(read, cwd, snapshot).then((next) => {
        // Compared against THIS chat's snapshot: a chat opened after the fold
        // already had the full list, and re-sending it would be noise.
        if (!next || next.availableCommands.every((item) => known.has(item.name))) return
        void Effect.runPromise(sendAvailableCommands(input.connection, sessionId, next))
      })
    })
  // origami_change-end

  const configSnapshot = Effect.fn("ACP.configSnapshot")(function* (state: ACPSession.Info) {
    const snapshot = sessionSnapshots.get(state.id)
    if (snapshot) return snapshot
    const loaded = yield* directorySnapshot(state.cwd)
    sessionSnapshots.set(state.id, loaded)
    return loaded
  })

  /**
   * The agent a client asked a session to be created AS, off ACP's `_meta` bag.
   *
   * `session/new` has no agent field, and `_meta` is the protocol's own
   * extension point (the same channel `agentInfo._meta.peerName` and the usage
   * update's `_meta.subagents` already ride). NOT a second way to say who is
   * speaking: it feeds the one field a turn resolves identity from — the
   * `agent` on `session.prompt` — one call earlier than the client could
   * otherwise reach it.
   */
  const requestedAgent = (meta: NewSessionRequest["_meta"]) => {
    const value = meta?.["agent"]
    if (typeof value !== "string") return undefined
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : undefined
  }

  /**
   * An agent id, resolved fail-closed against a directory snapshot, refreshing
   * ONCE on a miss.
   *
   * The same self-heal `resolveConfiguredModel` does for a model the snapshot
   * predates, and for the same reason: a definition written a moment ago (the
   * Bots pane scaffolds one, then offers "Start session") is not in the agent
   * registry this snapshot was built from, and `Agent.rescan` is called from
   * the collab paths only. `config.refresh` disposes the directory's instance,
   * so the next read rebuilds the registry from disk.
   *
   * Returns the (possibly refreshed) snapshot, because the caller answers with
   * `configOptions` built from it — a stale one would advertise a mode list
   * that does not contain the agent the session is now running as.
   *
   * A second miss is a real refusal, and it NAMES the ids the engine offers:
   * the shell cannot fix an identity it is not told the valid values for, and
   * at session-create time it has no session to read a mode option from.
   */
  const resolveRequestedAgent = Effect.fn("ACP.resolveRequestedAgent")(function* (
    cwd: string,
    snapshot: Directory.Snapshot,
    agent: string,
  ) {
    const known = (snap: Directory.Snapshot) => snap.availableModes.some((mode) => mode.id === agent)
    let snap = snapshot
    if (!known(snap)) {
      yield* Effect.promise(() =>
        input.sdk.config.refresh({ directory: cwd }).then(
          () => {},
          () => {},
        ),
      )
      snap = yield* directoryService.refresh(cwd)
    }
    if (!known(snap)) {
      const offered = snap.availableModes.map((mode) => mode.id).join(", ") || "(none)"
      return yield* new ACPError.RefusalError({
        safeMessage:
          `No agent DEFINITION named "${agent}" is loaded. This is a definition - an agent/*.md file in an ` +
          `Origami config directory, bot definitions saved from the Bots pane included - and NOT a model, ` +
          `so a model of that name being served changes nothing here. Definitions loaded now: ${offered}.`,
        service: "session",
      })
    }
    return snap
  })

  const newSession = Effect.fn("ACP.newSession")(function* (params: NewSessionRequest) {
    const started = performance.now()
    const requested = requestedAgent(params._meta)
    // Resolved BEFORE `session.create`, so a refusal creates nothing. A chat
    // that opened, named after a bot, and answered as the engine default is the
    // defect this whole path exists to close (test/acp/bot-session-agent.test.ts).
    const snapshot = requested
      ? yield* resolveRequestedAgent(params.cwd, yield* directorySnapshot(params.cwd), requested)
      : yield* directorySnapshot(params.cwd)
    const selected = selectDefaultModel(snapshot)
    const variant = selectVariant(snapshot, selected)
    const modeId = requested ?? (snapshot.availableModes.length > 0 ? snapshot.defaultModeID : undefined)
    const created = yield* profiledRequest(
      "acp.newSession.session.create",
      () =>
        input.sdk.session.create(
          {
            directory: params.cwd,
            ...(modeId ? { agent: modeId } : {}),
            model: {
              providerID: selected.providerID,
              id: selected.modelID,
              ...(variant ? { variant } : {}),
            },
          },
          { throwOnError: true },
        ),
      "session",
    )
    const state = yield* session.create({
      id: created.id,
      cwd: params.cwd,
      mcpServers: params.mcpServers,
      model: selected,
      variant,
      modeId,
    })
    sessionSnapshots.set(state.id, snapshot)

    yield* registerMcpServers(input.sdk, registeredMcp, params.cwd, state.id, params.mcpServers)
    yield* pushAvailableCommands(state.id, params.cwd, snapshot) // origami_change

    const response = {
      sessionId: state.id,
      configOptions: configOptions(snapshot, {
        model: state.model ?? selected,
        variant: state.variant,
        modeId: state.modeId,
        // Off the row the engine just created, like the three restore paths
        // below - a brand-new session carries no preset rules, so this is
        // `default`, but it is read rather than assumed.
        permissionMode: PermissionPresets.modeFor(created.permission),
      }),
    }
    ACPProfile.duration("acp.newSession", started)
    return response
  })

  /**
   * Push the session's STORED todo list to the client on a restore.
   *
   * The live drawer is fed by the `todowrite` tool frames, which a reopened
   * chat only gets if the transcript is replayed - `resume` does not replay at
   * all, and a fork's replayed transcript describes the PARENT's writes. The
   * todo table is the one durable copy, so a restore reads that and says where
   * it came from (`session_restore`). Sent as the ext notification the client
   * already handles, so nothing on the extension side changes.
   *
   * Best-effort by construction: a client without `extNotification`, or a read
   * that fails, must not stop a chat from opening.
   */
  const replayTodos = Effect.fn("ACP.replayTodos")(function* (cwd: string, sessionId: string) {
    // Bound, so the connection keeps its own `this` when it is called later.
    const send = input.connection?.extNotification?.bind(input.connection)
    if (!send) return
    const todos = yield* request(
      () => input.sdk.session.todo({ directory: cwd, sessionID: sessionId }, { throwOnError: true }),
      "session",
    )
    if (!todos?.length) return
    yield* Effect.promise(() =>
      send("origami/todoSnapshot", {
        sessionId,
        source: "session_restore",
        // The client's wire shape. `activeForm` mirrors what the live todowrite
        // path sends (it falls back to `content`), so a restored strip and a
        // live one render the same.
        // `depth` is read STRUCTURALLY, not off the SDK's row type: that type is
        // generated from the checked-in OpenAPI document (script/generate.ts)
        // and is regenerated on its own cadence, so it lags a schema field by
        // however long that takes. The value itself comes off the engine's own
        // encoder, and the client clamps whatever arrives.
        todos: todos.map((todo, index) => {
          const depth = (todo as Record<string, unknown>).depth
          return {
            id: index,
            content: todo.content,
            activeForm: todo.content,
            status: todo.status,
            depth: typeof depth === "number" ? depth : 0,
          }
        }),
      }).catch(() => {}),
    )
  })

  const loadSession = Effect.fn("ACP.loadSession")(function* (params: LoadSessionRequest) {
    const snapshot = yield* directorySnapshot(params.cwd)
    const row = yield* request(
      () => input.sdk.session.get({ directory: params.cwd, sessionID: params.sessionId }, { throwOnError: true }),
      "session",
    )
    const messages = yield* request(
      () => input.sdk.session.messages({ directory: params.cwd, sessionID: params.sessionId }, { throwOnError: true }),
      "session",
    )
    const restored = restoreFromMessages(messages.map((item) => item.info))
    const model = restored.model ?? selectDefaultModel(snapshot)
    const state = yield* session.load({
      id: params.sessionId,
      cwd: params.cwd,
      mcpServers: params.mcpServers,
      model,
      variant: restored.variant ?? selectVariant(snapshot, model),
      modeId: restored.modeId ?? (snapshot.availableModes.length > 0 ? snapshot.defaultModeID : undefined),
      // The auto-approve preset lives on the ROW, so it is the row that says
      // which one this chat was left on. Dropping it here made a reopened chat
      // report `default` and then CLEAR its own stored grant with the empty
      // `tools` map its next prompt sends.
      permissionMode: PermissionPresets.modeFor(row.permission),
    })
    sessionSnapshots.set(state.id, snapshot)

    yield* registerMcpServers(input.sdk, registeredMcp, params.cwd, state.id, params.mcpServers)
    yield* pushAvailableCommands(state.id, params.cwd, snapshot) // origami_change
    // The row's stored title, pushed the way the live one is. This is the only
    // moment a reconnecting client can learn the name of the chat it just
    // reopened: `session.updated` fired in the engine process that generated the
    // title, which no longer exists.
    yield* replayTitle(events, state.id, row.title)
    yield* replayMessages(events, messages)
    // After the replay: the transcript can carry an older todowrite frame, and
    // the stored list is the one that should have the last word.
    yield* replayTodos(params.cwd, state.id).pipe(Effect.ignore)

    return {
      configOptions: configOptions(snapshot, {
        model: state.model ?? model,
        variant: state.variant,
        modeId: state.modeId,
        // From the ROW, not from `state`: this is the answer a reconnecting
        // client seeds its approve control from, and the row is the only copy
        // that outlived the window it was set in.
        permissionMode: PermissionPresets.modeFor(row.permission),
      }),
    }
  })

  const listSessions = Effect.fn("ACP.listSessions")(function* (params: ListSessionsRequest) {
    const cursor = params.cursor ? Number(params.cursor) : undefined
    const limit = 100
    const sessions = yield* request(
      () =>
        input.sdk.session.list(
          {
            ...(params.cwd ? { directory: params.cwd } : {}),
            roots: true,
            // HONEST CEILING, stated here because the alternative was an
            // invisible one. `session.list` defaults to `limit ?? 100` down in
            // the DB layer (session/session.ts, listByProject), so omitting it
            // silently returned only the 100 most recently updated roots and
            // dropped everything older — no cursor could reach past it, because
            // the cursor below filters a list that had ALREADY been cut. The
            // paging in this function was therefore decorative: `nextCursor`
            // could never be emitted, since 100 rows in never exceeds a page of
            // 100. Asking for the ceiling makes the DB cut visible and puts the
            // paging back in charge of what a client actually sees.
            limit: SESSION_LIST_MAX,
          },
          { throwOnError: true },
        ),
      "session",
    )
    // Purge turnless "New session - <ISO>" placeholders: a default title, untouched
    // since creation (no turn ever ran), not currently open, AND at least a day
    // old. The age floor is load-bearing: each shell chat runs its OWN engine
    // process against the shared store, so a fresh turnless session in the list
    // may be another live instance's just-created chat — `liveIds` only covers
    // THIS instance, and deleting a sibling's newborn session bricks its first
    // prompt ({"service":"session"} internal error). KNOWN HOLE the floor only
    // narrows: a sibling's chat opened >24h ago and never typed in is STILL
    // reaped here (its liveness is invisible to us) — its next prompt fails and
    // the user must open a new chat. Real cross-instance ownership (an owner-
    // asserted liveness marker) is the v2 backend's job; until then the floor
    // trades a seconds-wide race for a day-wide one.
    const REAP_AGE_MS = 24 * 60 * 60 * 1000
    const reapBefore = Date.now() - REAP_AGE_MS
    const live = yield* session.list(params.cwd ?? undefined)
    const liveIds = new Set(live.map((item) => item.id))
    const keptServer: typeof sessions = []
    for (const item of sessions) {
      if (
        isDefaultTitle(item.title) &&
        item.time.created === item.time.updated &&
        !liveIds.has(item.id) &&
        item.time.created < reapBefore
      ) {
        yield* request(
          () => input.sdk.session.delete({ sessionID: item.id, directory: item.directory }, { throwOnError: false }),
          "session",
        ).pipe(Effect.ignore)
        continue
      }
      keptServer.push(item)
    }
    const serverEntries = keptServer.map(
      (item): SessionInfo => ({
        sessionId: item.id,
        cwd: item.directory,
        title: item.title,
        updatedAt: new Date(item.time.updated).toISOString(),
      }),
    )
    const liveEntries = live
      .filter((item) => !serverEntries.some((entry) => entry.sessionId === item.id))
      .map(
        (item): SessionInfo => ({
          sessionId: item.id,
          cwd: item.cwd,
          updatedAt: item.createdAt.toISOString(),
        }),
      )
    const sorted = [...liveEntries, ...serverEntries].toSorted(
      (a, b) => new Date(b.updatedAt ?? 0).getTime() - new Date(a.updatedAt ?? 0).getTime(),
    )
    const filtered =
      cursor === undefined || !Number.isFinite(cursor)
        ? sorted
        : sorted.filter((item) => new Date(item.updatedAt ?? 0).getTime() < cursor)
    const page = filtered.slice(0, limit)
    // Never split a group of sessions that share one `updatedAt`. The cursor
    // below is a plain millisecond stamp and the filter above is a STRICT `<`,
    // so a tie straddling the page edge would leave the ones after the edge
    // unreachable by any cursor — a silent, permanent drop. Extending the page
    // to the end of the tie group is what makes `<` exact.
    if (page.length === limit) {
      const edge = new Date(page.at(-1)?.updatedAt ?? 0).getTime()
      for (const item of filtered.slice(limit)) {
        if (new Date(item.updatedAt ?? 0).getTime() !== edge) break
        page.push(item)
      }
    }
    const last = page.at(-1)
    return {
      sessions: page,
      ...(filtered.length > page.length && last
        ? { nextCursor: String(new Date(last.updatedAt ?? 0).getTime()) }
        : {}),
    }
  })

  // Read-only review of a COMPLETED run. Deliberately does not touch
  // `session.load`/`create`/`resume`: the session being reviewed is usually not
  // open in this connection, and opening it would replay its events into the
  // live UI. Only `session.messages` is called, which is a plain GET.
  const runSteps = Effect.fn("ACP.runSteps")(function* (params: RunStepsRequest) {
    const read = (sessionID: string) =>
      request(
        () =>
          input.sdk.session.messages(
            { ...(params.cwd ? { directory: params.cwd } : {}), sessionID },
            { throwOnError: true },
          ),
        "session",
      )

    const messages = yield* read(params.sessionId)

    // Expand subagents breadth-first: each level's task steps name the next
    // level's sessions. Bounded on BOTH axes — depth by MAX_SUBAGENT_DEPTH, and
    // total reads by MAX_CHILD_SESSIONS, so a fan-out of 30 sub-agents cannot
    // turn one review into an open-ended burst of round trips. Anything past
    // the budget is simply not expanded; its spawning step is still returned.
    const children = new Map<string, readonly SessionMessageResponse[]>()
    let frontier = RunSteps.childSessionIds(messages ?? [])
    for (let depth = 0; depth < RunSteps.MAX_SUBAGENT_DEPTH && frontier.length > 0; depth++) {
      const budget = RunSteps.MAX_CHILD_SESSIONS - children.size
      if (budget <= 0) break
      const wanted = frontier.filter((id) => id !== params.sessionId && !children.has(id)).slice(0, budget)
      const fetched = yield* Effect.forEach(
        wanted,
        // A child that was deleted, or lives in another project, must not fail
        // the whole review — drop it and keep the parent's own steps.
        (id) =>
          read(id).pipe(
            Effect.map((items) => [id, items ?? []] as const),
            Effect.catch(() => Effect.succeed(undefined)),
          ),
        { concurrency: 8 },
      )
      const next: string[] = []
      for (const entry of fetched) {
        if (!entry) continue
        const [id, items] = entry
        children.set(id, items)
        next.push(...RunSteps.childSessionIds(items))
      }
      frontier = next
    }

    return RunSteps.project(messages ?? [], children)
  })

  // One read per session, same plain GET `runSteps` uses — never `load`/`resume`,
  // which would replay a stale run's events into the live UI.
  const runStats = Effect.fn("ACP.runStats")(function* (params: RunStatsRequest) {
    const { ids, truncated } = RunStats.plan(params.sessionIds ?? [])
    const stats = yield* Effect.forEach(
      ids,
      (sessionID) =>
        request(
          () =>
            input.sdk.session.messages(
              { ...(params.cwd ? { directory: params.cwd } : {}), sessionID },
              { throwOnError: true },
            ),
          "session",
        ).pipe(
          Effect.map((messages) => RunStats.stat(sessionID, messages ?? [])),
          // One unreadable session must not blank the whole index page: report
          // it by id with every count omitted rather than failing the batch.
          Effect.catch(() => Effect.succeed(RunStats.unreadable(sessionID))),
        ),
      { concurrency: 8 },
    )
    return { stats, truncated, requested: (params.sessionIds ?? []).length }
  })

  // ONE plain GET of the child's stored messages, the same read `runSteps` uses
  // and for the same reason: the child is not open in this connection, and
  // `load`/`resume` would replay a finished run's events into the live UI.
  //
  // An unreadable child degrades to an empty, FOUND:FALSE answer instead of
  // failing — the caller is a panel that has to draw something, and a rejected
  // promise there kills the view. Same convention `runStats` uses for a session
  // it cannot read, and the opposite of `runSteps`, whose caller asked to review
  // one named run and deserves to be told it is gone.
  const subagentTranscript = Effect.fn("ACP.subagentTranscript")(function* (params: SubagentTranscriptRequest) {
    const messages = yield* request(
      () =>
        input.sdk.session.messages(
          { ...(params.cwd ? { directory: params.cwd } : {}), sessionID: params.sessionId },
          { throwOnError: true },
        ),
      "session",
    ).pipe(Effect.catch(() => Effect.succeed(null)))
    // `null` is the read failing; `undefined`/`[]` is a real session with
    // nothing in it yet, which is a transcript, not an absence.
    if (messages === null) return SubagentTranscript.missing(params.sessionId)
    return SubagentTranscript.project(params.sessionId, messages ?? [], params.cwd)
  })

  const listInstructions = Effect.fn("ACP.listInstructions")(function* (params: ListInstructionsRequest) {
    return yield* instructionsService.list(params.cwd ?? process.cwd())
  })

  const promptCapture = Effect.fn("ACP.promptCapture")(function* (params: PromptCaptureRequest) {
    return { sessionId: params.sessionId, capture: readCapture(params.sessionId) } satisfies PromptCaptureResult
  })

  // ONE read (roots:false, same listing the sendUpdate rollup already uses)
  // covers both this session's own row and the lifetime sum — a failed
  // listing degrades to an empty answer rather than failing the card, same
  // convention as sendUpdate's rollup.
  const cacheStats = Effect.fn("ACP.cacheStats")(function* (params: CacheStatsRequest) {
    const rows = yield* request(
      () =>
        input.sdk.session.list(
          { ...(params.cwd ? { directory: params.cwd } : {}), roots: false },
          { throwOnError: true },
        ),
      "session",
    ).pipe(
      Effect.map((rows) => rows as readonly UsageService.SessionRow[]),
      Effect.catch(() => Effect.succeed([] as readonly UsageService.SessionRow[])),
    )
    const { current, lifetime, sessionCount } = UsageService.cacheStatsFromRows(rows, params.sessionId)
    return { sessionId: params.sessionId, current, lifetime, sessionCount } satisfies CacheStatsResult
  })

  const listSkills = Effect.fn("ACP.listSkills")(function* (params: ListSkillsRequest) {
    return yield* skillsService.list(params.cwd ?? process.cwd(), { refresh: params.refresh === true })
  })

  // The list is the engine's OWN `/experimental/tool` answer, so the pane can
  // never drift from what a turn is offered; only the deferral verdict is
  // computed here (acp/tools.ts), from the same config the session layer reads.
  // A config read that fails degrades to the shipped defaults rather than
  // failing the pane — the tool list is the part the user came for.
  //
  // `meta` is a THIRD, separate read (source/location per tool, for the Tools
  // pane's source badge and copy-path button) run on the process-wide
  // AppRuntime — same rationale as makeInstructionsService below: this process
  // already boots the engine in-process, and it degrades to an empty map
  // rather than failing the pane, same as the config read beside it. An empty
  // map is a HONEST degrade, not a silent one: every row then reads
  // `source: "builtin"` with no location, so the pane offers no copy-path
  // button rather than offering one that would copy nothing.
  const listTools = Effect.fn("ACP.listTools")(function* (params: ListToolsRequest) {
    const cwd = params.cwd ?? process.cwd()
    const snapshot = yield* directoryService.get(cwd)
    const model = selectDefaultModel(snapshot)
    const [list, config, meta, problems] = yield* Effect.all([
      request(
        () =>
          input.sdk.tool.list(
            { directory: cwd, provider: model.providerID, model: model.modelID },
            { throwOnError: true },
          ),
        "tool",
      ),
      request(() => input.sdk.config.get({ directory: cwd }, { throwOnError: true }), "config").pipe(
        Effect.catch(() => Effect.succeed(undefined)),
      ),
      request(() => AppRuntime.runPromise(inInstance(cwd, ACPTools.meta())), "tool").pipe(
        Effect.catch(() => Effect.succeed(new Map<string, ACPTools.ToolMeta>())),
      ),
      // Degrades to "no problems" for the same reason `meta` degrades to an
      // empty map: a pane that cannot say WHY a tool is missing is still better
      // than no pane. The message these carry is a path to the USER'S OWN file
      // plus the loader's reason — deliberately NOT run through the
      // `fromUnknownError` redaction that hid this failure class in the first
      // place. A filename is not a secret, and the redacted
      // "Origami service failure" is what made the original incident
      // undiagnosable from the client.
      request(() => AppRuntime.runPromise(inInstance(cwd, ACPTools.problems())), "tool").pipe(
        Effect.catch(() => Effect.succeed([] as ACPTools.ToolProblem[])),
      ),
    ])
    return ACPTools.project(list, config, meta, problems)
  })

  // Same rationale as listTools' `meta` read above: this process already boots
  // the engine in-process, so these run on the process-wide AppRuntime rather
  // than a private layer stack, which would stand up a second instance.
  const listAgentPlugins = Effect.fn("ACP.listAgentPlugins")(function* (params: ListAgentPluginsRequest) {
    const cwd = params.cwd ?? process.cwd()
    return yield* request(() => AppRuntime.runPromise(ACPAgentPlugins.list(cwd)), "agent-plugins")
  })

  const agentPluginAdd = Effect.fn("ACP.agentPluginAdd")(function* (params: AgentPluginAddRequest) {
    const cwd = params.cwd ?? process.cwd()
    return yield* request(() => AppRuntime.runPromise(ACPAgentPlugins.add(cwd, params.dir)), "agent-plugins")
  })

  const agentPluginSetEnabled = Effect.fn("ACP.agentPluginSetEnabled")(function* (
    params: AgentPluginSetEnabledRequest,
  ) {
    const cwd = params.cwd ?? process.cwd()
    return yield* request(
      () => AppRuntime.runPromise(ACPAgentPlugins.setEnabled(cwd, params.spec, params.enabled)),
      "agent-plugins",
    )
  })

  // MCP management. Same AppRuntime rationale as the plugin trio above: the
  // engine owns the config files, the merge with plugin-provided servers and
  // every live client, so these stay thin proxies over `acp/mcp.ts`.
  const mcpList = Effect.fn("ACP.mcpList")(function* (params: McpListRequest) {
    const cwd = params.cwd ?? process.cwd()
    return yield* request(() => AppRuntime.runPromise(ACPMcp.list(cwd)), "mcp")
  })

  const mcpAdd = Effect.fn("ACP.mcpAdd")(function* (params: McpAddRequest) {
    const cwd = params.cwd ?? process.cwd()
    return yield* request(() => AppRuntime.runPromise(ACPMcp.add(cwd, params.name, params.server, params.scope)), "mcp")
  })

  const mcpRemove = Effect.fn("ACP.mcpRemove")(function* (params: McpNameRequest) {
    const cwd = params.cwd ?? process.cwd()
    return yield* request(() => AppRuntime.runPromise(ACPMcp.remove(cwd, params.name)), "mcp")
  })

  const mcpSetEnabled = Effect.fn("ACP.mcpSetEnabled")(function* (params: McpSetEnabledRequest) {
    const cwd = params.cwd ?? process.cwd()
    return yield* request(() => AppRuntime.runPromise(ACPMcp.setEnabled(cwd, params.name, params.enabled)), "mcp")
  })

  const mcpConnect = Effect.fn("ACP.mcpConnect")(function* (params: McpNameRequest) {
    const cwd = params.cwd ?? process.cwd()
    return yield* request(() => AppRuntime.runPromise(ACPMcp.connect(cwd, params.name)), "mcp")
  })

  const mcpDisconnect = Effect.fn("ACP.mcpDisconnect")(function* (params: McpNameRequest) {
    const cwd = params.cwd ?? process.cwd()
    return yield* request(() => AppRuntime.runPromise(ACPMcp.disconnect(cwd, params.name)), "mcp")
  })

  /**
   * Blocks for as long as the sign-in takes - safe for the reason
   * `providerAuthCallback` documents (the SDK dispatches without awaiting).
   * The authorization URL goes out as a NOTIFICATION the moment the flow
   * produces it, because the ANSWER to this request cannot arrive until the
   * user has already finished with that URL.
   */
  const mcpAuthenticate = Effect.fn("ACP.mcpAuthenticate")(function* (params: McpNameRequest) {
    const cwd = params.cwd ?? process.cwd()
    const send = input.connection?.extNotification?.bind(input.connection)
    const onUrl = send
      ? (url: string) => void send("origami/mcpAuthUrl", { name: params.name, url }).catch(() => {})
      : undefined
    return yield* request(() => AppRuntime.runPromise(ACPMcp.authenticate(cwd, params.name, onUrl)), "mcp")
  })

  const mcpAuthRemove = Effect.fn("ACP.mcpAuthRemove")(function* (params: McpNameRequest) {
    const cwd = params.cwd ?? process.cwd()
    return yield* request(() => AppRuntime.runPromise(ACPMcp.authRemove(cwd, params.name)), "mcp")
  })

  // Provider OAuth. Thin proxies over ProviderAuth.Service — the flow itself is
  // the plugins' (codex.ts / xai.ts), the orchestration is provider/auth.ts's,
  // and acp/provider-auth.ts only shapes the three calls for the wire.
  const providerAuthList = Effect.fn("ACP.providerAuthList")(function* (params: ProviderAuthListRequest) {
    const cwd = params.cwd ?? process.cwd()
    return yield* request(() => AppRuntime.runPromise(ACPProviderAuth.list(cwd)), "provider-auth")
  })

  const providerAuthAuthorize = Effect.fn("ACP.providerAuthAuthorize")(function* (
    params: ProviderAuthAuthorizeRequest,
  ) {
    const cwd = params.cwd ?? process.cwd()
    return yield* request(
      () => AppRuntime.runPromise(ACPProviderAuth.authorize(cwd, params.providerID, params.methodIndex)),
      "provider-auth",
    )
  })

  const providerAuthCallback = Effect.fn("ACP.providerAuthCallback")(function* (params: ProviderAuthCallbackRequest) {
    const cwd = params.cwd ?? process.cwd()
    return yield* request(
      () => AppRuntime.runPromise(ACPProviderAuth.callback(cwd, params.providerID, params.methodIndex, params.code)),
      "provider-auth",
    )
  })

  // Usage is NOT part of the sign-in flow, so it does not go through
  // ProviderAuth — acp/provider-usage.ts reads the stored credential itself and
  // makes one lazy GET. Kept beside the three above because it is the same
  // surface to a caller: "what is the state of this OAuth connection".
  const providerAuthUsage = Effect.fn("ACP.providerAuthUsage")(function* (params: ProviderAuthUsageRequest) {
    return yield* request(() => AppRuntime.runPromise(ACPProviderUsage.usage(params.providerID)), "provider-auth")
  })

  // Make a just-written provider credential live. See ProviderRefreshRequest for
  // what this invalidates and why it is not the HTTP `config.refresh` route.
  //
  // `inInstance` is not optional here: this runs on the bare fiber `acp/agent.ts`
  // starts every request on, and both services reach their state through
  // `InstanceState`, which DIES with "InstanceRef not provided" when the
  // reference is absent - and `request()` would launder that defect into a
  // redacted "Origami service failure". The cwd resolves the SAME instance the
  // session's turns run under, which is what makes this invalidation visible to
  // them (the incident is written up on the `inInstance` helper itself).
  const providerRefresh = Effect.fn("ACP.providerRefresh")(function* (params: ProviderRefreshRequest) {
    const cwd = params.cwd ?? process.cwd()
    yield* request(
      () =>
        AppRuntime.runPromise(
          inInstance(
            cwd,
            Effect.gen(function* () {
              // BOTH halves, and both are load-bearing - each on its own leaves
              // the old credential on the wire, proved by mutation. Config
              // alone re-reads the files but the provider list is a second
              // InstanceState built from them and survives it; Provider alone
              // rebuilds that list from a `config.get()` that is still cached.
              yield* Config.Service.use((config) => config.invalidateInstance())
              yield* Provider.Service.use((provider) => provider.invalidate())
            }),
          ),
        ),
      "config",
    )
    return { ok: true } as const
  })

  const collabAgents = Effect.fn("ACP.collabAgents")(function* (params: CollabAgentsRequest) {
    return yield* collabService.agents(params.cwd ?? process.cwd())
  })

  const collabList = Effect.fn("ACP.collabList")(function* (params: CollabListRequest) {
    return yield* collabService.list(params.cwd ?? process.cwd())
  })

  const collabCreate = Effect.fn("ACP.collabCreate")(function* (params: CollabCreateRequest) {
    return yield* collabService.create(params.cwd ?? process.cwd(), {
      title: params.title,
      agentSlugs: params.agentSlugs,
      ...(params.objective !== undefined ? { objective: params.objective } : {}),
    })
  })

  const collabPost = Effect.fn("ACP.collabPost")(function* (params: CollabPostRequest) {
    return yield* collabService.post(params.cwd ?? process.cwd(), {
      collabId: params.collabId,
      text: params.text,
      ...(params.mentions !== undefined ? { mentions: params.mentions } : {}),
      ...(params.images !== undefined ? { images: params.images } : {}),
    })
  })

  const collabPreview = Effect.fn("ACP.collabPreview")(function* (params: CollabPreviewRequest) {
    return yield* collabService.preview(params.cwd ?? process.cwd(), {
      collabId: params.collabId,
      ...(params.mentions !== undefined ? { mentions: params.mentions } : {}),
    })
  })

  const collabState = Effect.fn("ACP.collabState")(function* (params: CollabStateRequest) {
    return yield* collabService.state(params.cwd ?? process.cwd(), {
      collabId: params.collabId,
      ...(params.sinceSeq !== undefined ? { sinceSeq: params.sinceSeq } : {}),
    })
  })

  const collabSetCap = Effect.fn("ACP.collabSetCap")(function* (params: CollabSetCapRequest) {
    return yield* collabService.setCap(params.cwd ?? process.cwd(), {
      collabId: params.collabId,
      cap: params.cap,
    })
  })

  const collabSetConcurrency = Effect.fn("ACP.collabSetConcurrency")(function* (
    params: CollabSetConcurrencyRequest,
  ) {
    return yield* collabService.setConcurrency(params.cwd ?? process.cwd(), {
      collabId: params.collabId,
      concurrency: params.concurrency,
    })
  })

  const collabSetFlavor = Effect.fn("ACP.collabSetFlavor")(function* (params: CollabSetFlavorRequest) {
    return yield* collabService.setFlavor(params.cwd ?? process.cwd(), {
      collabId: params.collabId,
      flavor: params.flavor,
    })
  })

  const collabSetLead = Effect.fn("ACP.collabSetLead")(function* (params: CollabSetLeadRequest) {
    return yield* collabService.setLead(params.cwd ?? process.cwd(), {
      collabId: params.collabId,
      agentSlug: params.agentSlug,
    })
  })

  const collabSetObjective = Effect.fn("ACP.collabSetObjective")(function* (params: CollabSetObjectiveRequest) {
    return yield* collabService.setObjective(params.cwd ?? process.cwd(), {
      collabId: params.collabId,
      objective: params.objective,
    })
  })

  const collabTaskAdd = Effect.fn("ACP.collabTaskAdd")(function* (params: CollabTaskAddRequest) {
    return yield* collabService.taskAdd(params.cwd ?? process.cwd(), {
      collabId: params.collabId,
      title: params.title,
    })
  })

  const collabTaskUpdate = Effect.fn("ACP.collabTaskUpdate")(function* (params: CollabTaskUpdateRequest) {
    return yield* collabService.taskUpdate(params.cwd ?? process.cwd(), {
      collabId: params.collabId,
      taskId: params.taskId,
      action: params.action,
      ...(params.result !== undefined ? { result: params.result } : {}),
      ...(params.note !== undefined ? { note: params.note } : {}),
      ...(params.owner !== undefined ? { owner: params.owner } : {}),
    })
  })

  const collabReview = Effect.fn("ACP.collabReview")(function* (params: CollabReviewRequest) {
    return yield* collabService.review(params.cwd ?? process.cwd(), {
      collabId: params.collabId,
      taskId: params.taskId,
      verdict: params.verdict,
      ...(params.note !== undefined ? { note: params.note } : {}),
    })
  })

  const collabLedger = Effect.fn("ACP.collabLedger")(function* (params: CollabLedgerRequest) {
    return yield* collabService.ledger(params.cwd ?? process.cwd(), {
      collabId: params.collabId,
      ...(params.limit !== undefined ? { limit: params.limit } : {}),
    })
  })

  const collabStop = Effect.fn("ACP.collabStop")(function* (params: CollabStopRequest) {
    return yield* collabService.stop(params.cwd ?? process.cwd(), { collabId: params.collabId })
  })

  const collabStopAgent = Effect.fn("ACP.collabStopAgent")(function* (params: CollabStopAgentRequest) {
    return yield* collabService.stopAgent(params.cwd ?? process.cwd(), {
      collabId: params.collabId,
      agentSlug: params.agentSlug,
    })
  })

  const collabRedirect = Effect.fn("ACP.collabRedirect")(function* (params: CollabRedirectRequest) {
    return yield* collabService.redirect(params.cwd ?? process.cwd(), {
      collabId: params.collabId,
      agentSlug: params.agentSlug,
      text: params.text,
    })
  })

  const collabArchive = Effect.fn("ACP.collabArchive")(function* (params: CollabArchiveRequest) {
    return yield* collabService.archive(params.cwd ?? process.cwd(), { collabId: params.collabId })
  })

  const collabUnarchive = Effect.fn("ACP.collabUnarchive")(function* (params: CollabArchiveRequest) {
    return yield* collabService.unarchive(params.cwd ?? process.cwd(), { collabId: params.collabId })
  })

  const collabRename = Effect.fn("ACP.collabRename")(function* (params: CollabRenameRequest) {
    return yield* collabService.rename(params.cwd ?? process.cwd(), {
      collabId: params.collabId,
      title: params.title,
    })
  })

  const collabAddParticipant = Effect.fn("ACP.collabAddParticipant")(function* (params: CollabParticipantRequest) {
    return yield* collabService.addParticipant(params.cwd ?? process.cwd(), {
      collabId: params.collabId,
      agentSlug: params.agentSlug,
    })
  })

  const collabRemoveParticipant = Effect.fn("ACP.collabRemoveParticipant")(function* (
    params: CollabParticipantRequest,
  ) {
    return yield* collabService.removeParticipant(params.cwd ?? process.cwd(), {
      collabId: params.collabId,
      agentSlug: params.agentSlug,
    })
  })

  const resumeSession = Effect.fn("ACP.resumeSession")(function* (params: ResumeSessionRequest) {
    const snapshot = yield* directorySnapshot(params.cwd)
    const row = yield* request(
      () => input.sdk.session.get({ directory: params.cwd, sessionID: params.sessionId }, { throwOnError: true }),
      "session",
    )
    const messages = yield* request(
      () =>
        input.sdk.session.messages(
          { directory: params.cwd, sessionID: params.sessionId, limit: 20 },
          { throwOnError: true },
        ),
      "session",
    )
    const restored = restoreFromMessages(messages.map((item) => item.info))
    const model = restored.model ?? selectDefaultModel(snapshot)
    const state = yield* session.load({
      id: params.sessionId,
      cwd: params.cwd,
      mcpServers: params.mcpServers ?? [],
      model,
      variant: restored.variant ?? selectVariant(snapshot, model),
      modeId: restored.modeId ?? (snapshot.availableModes.length > 0 ? snapshot.defaultModeID : undefined),
      // See loadSession: the preset comes back off the row, or the resumed chat
      // clears it on its next prompt.
      permissionMode: PermissionPresets.modeFor(row.permission),
    })
    sessionSnapshots.set(state.id, snapshot)

    yield* registerMcpServers(input.sdk, registeredMcp, params.cwd, state.id, params.mcpServers ?? [])
    yield* pushAvailableCommands(state.id, params.cwd, snapshot) // origami_change
    // `resume` replays no messages at all, so this is the ONLY thing that tells
    // a resumed chat what its task list is.
    yield* replayTodos(params.cwd, state.id).pipe(Effect.ignore)

    return {
      configOptions: configOptions(snapshot, {
        model: state.model ?? model,
        variant: state.variant,
        modeId: state.modeId,
        // See loadSession: read off the row, not the in-memory string.
        permissionMode: PermissionPresets.modeFor(row.permission),
      }),
    }
  })

  const abortBackingSession = Effect.fn("ACP.abortBackingSession")(function* (current: ACPSession.Info) {
    yield* request(
      () => input.sdk.session.abort({ directory: current.cwd, sessionID: current.id }, { throwOnError: true }),
      "session",
    ).pipe(
      Effect.catch((error) =>
        Effect.logError("failed to abort ACP backing session", { error: error, sessionID: current.id }),
      ),
    )
  })

  const closeSession = Effect.fn("ACP.closeSession")(function* (params: CloseSessionRequest) {
    const removed = yield* session.remove(params.sessionId)
    registeredMcp.delete(params.sessionId)
    sessionSnapshots.delete(params.sessionId)
    if (!removed) return {}

    yield* abortBackingSession(removed)
    return {}
  })

  const cancel = Effect.fn("ACP.cancel")(function* (params: CancelNotification) {
    const current = yield* session.get(params.sessionId)
    yield* abortBackingSession(current)
  })

  const forkSession = Effect.fn("ACP.forkSession")(function* (params: ForkSessionRequest) {
    const snapshot = yield* directorySnapshot(params.cwd)
    const forked = yield* request(
      () =>
        input.sdk.session.fork(
          {
            directory: params.cwd,
            sessionID: params.sessionId,
          },
          { throwOnError: true },
        ),
      "session",
    )
    const messages = yield* request(
      () =>
        input.sdk.session.messages({ directory: params.cwd, sessionID: forked.id, limit: 20 }, { throwOnError: true }),
      "session",
    )
    const restored = restoreFromMessages(messages.map((item) => item.info))
    const model = restored.model ?? selectDefaultModel(snapshot)
    const state = yield* session.load({
      id: forked.id,
      cwd: params.cwd,
      mcpServers: params.mcpServers ?? [],
      model,
      variant: restored.variant ?? selectVariant(snapshot, model),
      modeId: restored.modeId ?? (snapshot.availableModes.length > 0 ? snapshot.defaultModeID : undefined),
      // Read off the FORK's own row, like the other restored fields. Session.fork
      // does not copy the parent's ruleset today, so a fork opens on `default` -
      // the same as before this line existed; it is here so the fork follows its
      // row rather than a separate assumption if that ever changes.
      permissionMode: PermissionPresets.modeFor(forked.permission),
    })
    sessionSnapshots.set(state.id, snapshot)

    yield* registerMcpServers(input.sdk, registeredMcp, params.cwd, state.id, params.mcpServers ?? [])
    yield* pushAvailableCommands(state.id, params.cwd, snapshot) // origami_change
    yield* replayMessages(events, messages)
    // The FORK's own rows, like the permission preset above - the replayed
    // transcript describes the parent's todowrite calls, not the fork's list.
    yield* replayTodos(params.cwd, state.id).pipe(Effect.ignore)

    return {
      sessionId: state.id,
      configOptions: configOptions(snapshot, {
        model: state.model ?? model,
        variant: state.variant,
        modeId: state.modeId,
        // The FORK's own row, matching the seed above.
        permissionMode: PermissionPresets.modeFor(forked.permission),
      }),
    }
  })

  /**
   * A configured model id, resolved fail-closed against the SESSION SNAPSHOT
   * frozen at session start. If the shell just wrote a NEW model to origami.json
   * (a fresh LM Studio model, or an OpenRouter model the user just picked), it
   * isn't in that snapshot yet. Rather than force a window reload, self-heal:
   * ask the engine to re-read config (config.refresh = invalidate the global
   * config cache + dispose this directory's instance), refresh the directory
   * snapshot, re-seed THIS session, and retry once. A second miss is a real
   * InvalidModelError. Only the miss path pays the reload cost.
   *
   * Returns the (possibly refreshed) snapshot alongside the selection, because
   * every caller answers with `configOptions` built from the same snapshot the
   * model was validated against — a stale one would report the old catalog.
   */
  const resolveConfiguredModel = Effect.fn("ACP.resolveConfiguredModel")(function* (
    current: ACPSession.Info,
    snapshot: Directory.Snapshot,
    value: string,
  ) {
    // Mirror parseSelectedModel's lookup as a pure predicate (no throw) so we
    // can refresh BEFORE parsing.
    const inSnapshot = (s: Directory.Snapshot) => {
      const sel = parseModelSelection(value, Object.values(s.providers))
      return !!s.providers[ProviderV2.ID.make(sel.model.providerID)]?.models[ModelV2.ID.make(sel.model.modelID)]
    }
    let snap = snapshot
    if (!inSnapshot(snap)) {
      yield* Effect.promise(() =>
        input.sdk.config.refresh({ directory: current.cwd }).then(
          () => {},
          () => {},
        ),
      )
      snap = yield* directoryService.refresh(current.cwd)
      sessionSnapshots.set(current.id, snap)
    }
    return { snap, selected: yield* parseSelectedModel(snap, value) }
  })

  const setSessionConfigOption = Effect.fn("ACP.setSessionConfigOption")(function* (
    params: SetSessionConfigOptionRequest,
  ) {
    const current = yield* session.get(params.sessionId)
    const snapshot = yield* configSnapshot(current)
    if (typeof params.value !== "string") {
      return yield* new ACPError.InvalidConfigOptionError({ configId: params.configId })
    }

    if (params.configId === "model") {
      const { snap, selected } = yield* resolveConfiguredModel(current, snapshot, params.value)
      const variant = selected.variant ?? selectVariant(snap, selected.model)
      const state = yield* session
        .setVariant(params.sessionId, Directory.variants(snap, selected.model) ? variant : undefined)
        .pipe(Effect.andThen(session.setModel(params.sessionId, selected.model)))
      return {
        configOptions: configOptions(snap, {
          model: state.model ?? selected.model,
          variant: state.variant,
          modeId: state.modeId,
          permissionMode: state.permissionMode,
        }),
      }
    }

    if (params.configId === "subagentModel") {
      // Per-chat SUB-AGENT model override: every sub-agent this chat spawns runs
      // on this model, ahead of the flock binding and the agent's own pin
      // (tool/task.ts owns that precedence). Same validation as `model` — an
      // override the provider registry cannot serve would fail at spawn time,
      // inside a child session the user cannot see. "" / "default" CLEARS it.
      //
      // The winner has to land on the ENGINE's session row, not just here: the
      // task tool reads the parent session, and only the row survives an engine
      // restart. Sent through the same session.update channel `title` uses, with
      // the row's other metadata carried through by withSubagentModel.
      //
      // t-lmqe0g: an optional trailing "@<positive integer>" is a CONTEXT-WINDOW
      // override for the sub-agents' turns, stripped BEFORE model resolution so
      // `resolveConfiguredModel`/`parseModelSelection` see a plain "provider/model"
      // string exactly as before. It rides the same value string because the ACP
      // config channel is one string per call (see the temperature/topP comment
      // below) and this is one pick, not two settings. A malformed suffix (an "@"
      // followed by anything but digits, or "@0") fails the whole call rather than
      // silently dropping the context half of what the user asked for.
      const trimmed = params.value.trim()
      const clearing = trimmed === "" || trimmed.toLowerCase() === "default"
      const contextMatch = clearing ? null : /^(.*)@(\d+)$/.exec(trimmed)
      const modelPart = contextMatch ? contextMatch[1] : trimmed
      const context = contextMatch ? Number(contextMatch[2]) : undefined
      if (context !== undefined && context <= 0) {
        return yield* new ACPError.InvalidConfigOptionError({ configId: params.configId })
      }
      const resolved = clearing ? undefined : yield* resolveConfiguredModel(current, snapshot, modelPart)
      const snap = resolved?.snap ?? snapshot
      const state = yield* session.setSubagentModel(params.sessionId, resolved?.selected.model)
      const row = yield* request(
        () => input.sdk.session.get({ directory: current.cwd, sessionID: params.sessionId }, { throwOnError: true }),
        "session",
      )
      yield* request(
        () =>
          input.sdk.session.update(
            {
              sessionID: params.sessionId,
              directory: current.cwd,
              metadata: withSubagentModel(
                row.metadata,
                resolved ? { ...resolved.selected.model, ...(context !== undefined ? { context } : {}) } : undefined,
              ),
            },
            { throwOnError: true },
          ),
        "session",
      )
      return {
        configOptions: configOptions(snap, {
          model: state.model ?? selectDefaultModel(snap),
          variant: state.variant,
          modeId: state.modeId,
          permissionMode: state.permissionMode,
        }),
      }
    }

    if (params.configId === "effort") {
      const model = current.model ?? selectDefaultModel(snapshot)
      const variants = Directory.variants(snapshot, model)
      if (!variants || !Object.keys(variants).includes(params.value)) {
        return yield* new ACPError.InvalidEffortError({ effort: params.value })
      }
      const state = yield* session.setVariant(params.sessionId, params.value)
      return {
        configOptions: configOptions(snapshot, {
          model: state.model ?? model,
          variant: state.variant,
          modeId: state.modeId,
          permissionMode: state.permissionMode,
        }),
      }
    }

    if (params.configId === "mode") {
      // Refreshes ONCE on a miss, exactly as the `model` branch above does. Same
      // root cause: this validated against the snapshot FROZEN at session start,
      // so a definition written since — every bot the Bots pane just scaffolded —
      // was unreachable from the Folds board's per-session agent picker too.
      const snap = yield* resolveRequestedAgent(current.cwd, snapshot, params.value).pipe(
        Effect.catchTag("ACPRefusalError", () => new ACPError.InvalidModeError({ mode: params.value })),
      )
      sessionSnapshots.set(current.id, snap)
      const state = yield* session.setMode(params.sessionId, params.value)
      return {
        configOptions: configOptions(snap, {
          model: state.model ?? selectDefaultModel(snap),
          variant: state.variant,
          modeId: state.modeId,
          permissionMode: state.permissionMode,
        }),
      }
    }

    if (params.configId === "permission") {
      // Scoped auto-approve preset for THIS chat, rides the same string config
      // channel: "default" (ask normally), "auto" (auto-approve file edits),
      // "bypass" (auto-approve everything).
      //
      // The winner has to land on the ENGINE's session row, not just here — same
      // convention as `subagentModel` below, and for a sharper reason: the `tools`
      // map only rides an ordinary USER prompt, so a preset pressed mid-turn, or
      // before an auto-continue or a slash command, would otherwise never reach
      // the ruleset at all. The tool gate re-reads that ruleset live per ask
      // (session/tools.ts), so writing it here makes the preset bite on the very
      // next ask of the turn that is already running.
      const value = params.value.trim().toLowerCase()
      if (value !== "default" && value !== "auto" && value !== "bypass") {
        return yield* new ACPError.InvalidConfigOptionError({ configId: params.configId })
      }
      const state = yield* session.setPermissionMode(params.sessionId, value)
      yield* request(
        () =>
          input.sdk.session.update(
            {
              sessionID: params.sessionId,
              directory: current.cwd,
              permission: PermissionPresets.rules(value),
            },
            { throwOnError: true },
          ),
        "session",
      )
      return {
        configOptions: configOptions(snapshot, {
          model: state.model ?? selectDefaultModel(snapshot),
          variant: state.variant,
          modeId: state.modeId,
          permissionMode: state.permissionMode,
        }),
      }
    }

    if (params.configId === "visionProfile") {
      // Per-chat VISION PROFILE (t-kgtr6c): the slug of a vision-capable agent
      // this chat may hand an image to when its own model cannot see one.
      // "" / "off" CLEARS it, mirroring the `auto`/`default` clear-words the
      // other string options use. The slug is NOT resolved against the agent
      // registry here: agent defs are re-scanned per turn off the filesystem,
      // so a profile saved a second before this call would fail a check made
      // against the snapshot this session opened with. The prompt loop
      // resolves it, and says so in the tool result when the slug is gone.
      //
      // The winner has to land on the ENGINE's session row, not just here —
      // the prompt loop reads the row, and only the row survives an engine
      // restart. Same session.update channel `subagentModel` uses, with the
      // row's other metadata carried through by withVisionProfile.
      const trimmed = params.value.trim()
      const slug = trimmed === "" || trimmed.toLowerCase() === "off" ? undefined : trimmed
      if (slug && !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(slug)) {
        return yield* new ACPError.InvalidConfigOptionError({ configId: params.configId })
      }
      const state = yield* session.setVisionProfile(params.sessionId, slug)
      const row = yield* request(
        () => input.sdk.session.get({ directory: current.cwd, sessionID: params.sessionId }, { throwOnError: true }),
        "session",
      )
      yield* request(
        () =>
          input.sdk.session.update(
            {
              sessionID: params.sessionId,
              directory: current.cwd,
              metadata: withVisionProfile(row.metadata, slug),
            },
            { throwOnError: true },
          ),
        "session",
      )
      return {
        configOptions: configOptions(snapshot, {
          model: state.model ?? selectDefaultModel(snapshot),
          variant: state.variant,
          modeId: state.modeId,
          permissionMode: state.permissionMode,
        }),
      }
    }

    if (params.configId === "revert" || params.configId === "unrevert") {
      // Deterministic rollback. Rides the same string config channel as `title`
      // (both are actions, not real selects): "revert" restores the working tree
      // to the snapshot taken before the given assistant message's turn and marks
      // that turn (and everything after) for removal; "unrevert" undoes it (valid
      // until the next prompt, which finalises the deletion). The engine does all
      // the work — files, snapshots, message pruning — via sdk.session.revert.
      if (params.configId === "revert") {
        const messageID = params.value.trim()
        if (!messageID) {
          return yield* new ACPError.InvalidConfigOptionError({ configId: params.configId })
        }
        yield* request(
          () =>
            input.sdk.session.revert(
              { sessionID: params.sessionId, directory: current.cwd, messageID },
              { throwOnError: true },
            ),
          "session",
        )
      } else {
        yield* request(
          () =>
            input.sdk.session.unrevert({ sessionID: params.sessionId, directory: current.cwd }, { throwOnError: true }),
          "session",
        )
      }
      return {
        configOptions: configOptions(snapshot, {
          model: current.model ?? selectDefaultModel(snapshot),
          variant: current.variant,
          modeId: current.modeId,
          permissionMode: current.permissionMode,
        }),
      }
    }

    if (params.configId === "title") {
      // Rename the chat. Rides the same string config channel as the other options;
      // the PATCH publishes session.updated, which the ACP layer echoes back as
      // session_info_update - so no extra display plumbing is needed.
      const trimmed = params.value.trim()
      if (trimmed) {
        yield* request(
          () =>
            input.sdk.session.update(
              { sessionID: params.sessionId, directory: current.cwd, title: trimmed },
              { throwOnError: true },
            ),
          "session",
        )
      }
      return {
        configOptions: configOptions(snapshot, {
          model: current.model ?? selectDefaultModel(snapshot),
          variant: current.variant,
          modeId: current.modeId,
          permissionMode: current.permissionMode,
        }),
      }
    }

    if (params.configId === "temperature" || params.configId === "topP") {
      // Per-session sampling override. The ACP protocol has no numeric option type,
      // so the value rides as a string: "" / "auto" CLEARS the override; anything
      // else is parsed as a float and clamped. Applied live per request via the
      // llm.run merge (per-session > global > agent default) — no reload.
      const trimmed = params.value.trim()
      const isClear = trimmed === "" || trimmed.toLowerCase() === "auto"
      const parsed = Number(trimmed)
      if (!isClear && !Number.isFinite(parsed)) {
        return yield* new ACPError.InvalidConfigOptionError({ configId: params.configId })
      }
      const max = params.configId === "topP" ? 1 : 2
      const value = isClear ? undefined : Math.max(0, Math.min(max, parsed))
      const state = yield* params.configId === "temperature"
        ? session.setTemperature(params.sessionId, value)
        : session.setTopP(params.sessionId, value)
      return {
        configOptions: configOptions(snapshot, {
          model: state.model ?? selectDefaultModel(snapshot),
          variant: state.variant,
          modeId: state.modeId,
          permissionMode: state.permissionMode,
        }),
      }
    }

    if (params.configId === "compactionThreshold") {
      // Per-chat auto-compaction TRIGGER override (t-kgsdsw): the UAT report
      // was DeepSeek overflowing well past the cfg-derived reserve, and the
      // fix is a threshold the user sets ahead of time. Rides the session
      // row's metadata, same as `subagentModel` above — a real column would
      // need a schema migration for a value only the overflow check reads.
      // "" / "auto" CLEARS it. A trailing "%" picks a fraction of the model's
      // context window (re-resolved at check time, since a later model switch
      // changes what the percentage means); a bare number is an absolute
      // token count. `overflow.ts` reads whichever the row carries.
      const trimmed = params.value.trim()
      const clearing = trimmed === "" || trimmed.toLowerCase() === "auto"
      let override: CompactionThresholdOverride | undefined
      if (!clearing) {
        const isPercent = trimmed.endsWith("%")
        const numeric = Number(isPercent ? trimmed.slice(0, -1) : trimmed)
        if (!Number.isFinite(numeric) || numeric <= 0 || (isPercent && numeric > 100)) {
          return yield* new ACPError.InvalidConfigOptionError({ configId: params.configId })
        }
        override = isPercent ? { kind: "percent", value: numeric / 100 } : { kind: "tokens", value: Math.floor(numeric) }
      }
      const row = yield* request(
        () => input.sdk.session.get({ directory: current.cwd, sessionID: params.sessionId }, { throwOnError: true }),
        "session",
      )
      yield* request(
        () =>
          input.sdk.session.update(
            {
              sessionID: params.sessionId,
              directory: current.cwd,
              metadata: withCompactionThreshold(row.metadata, override),
            },
            { throwOnError: true },
          ),
        "session",
      )
      return {
        configOptions: configOptions(snapshot, {
          model: current.model ?? selectDefaultModel(snapshot),
          variant: current.variant,
          modeId: current.modeId,
          permissionMode: current.permissionMode,
        }),
      }
    }

    return yield* new ACPError.InvalidConfigOptionError({ configId: params.configId })
  })

  const setSessionMode = Effect.fn("ACP.setSessionMode")(function* (params: SetSessionModeRequest) {
    const current = yield* session.get(params.sessionId)
    const snapshot = yield* configSnapshot(current)
    if (!snapshot.availableModes.some((mode) => mode.id === params.modeId)) {
      return yield* new ACPError.InvalidModeError({ mode: params.modeId })
    }
    yield* session.setMode(params.sessionId, params.modeId)
    return {}
  })

  const setSessionModel = Effect.fn("ACP.setSessionModel")(function* (params: SetSessionModelRequest) {
    const current = yield* session.get(params.sessionId)
    const snapshot = yield* configSnapshot(current)
    const selected = yield* parseSelectedModel(snapshot, params.modelId)
    yield* session
      .setVariant(
        params.sessionId,
        Directory.variants(snapshot, selected.model)
          ? (selected.variant ?? selectVariant(snapshot, selected.model))
          : undefined,
      )
      .pipe(Effect.andThen(session.setModel(params.sessionId, selected.model)))
    return {}
  })

  // origami_change: targeted background-shell stop, separate from turn cancel.
  const shellStop = Effect.fn("ACP.shellStop")(function* (params: ShellStopRequest) {
    const current = yield* session.get(params.sessionId)
    const found = yield* request(
      () =>
        AppRuntime.runPromise(
          inInstance(current.cwd, BackgroundJob.Service.use((jobs) => jobs.get(params.jobId))),
        ),
      "background job",
    )
    if (!found || found.metadata?.sessionId !== current.id) {
      return yield* new ACPError.ServiceFailureError({
        service: "background job",
        safeMessage: `Background shell job ${params.jobId} was not found in this session`,
        errorName: "BackgroundShellNotFound",
      })
    }
    const info = yield* request(
      () =>
        AppRuntime.runPromise(
          inInstance(current.cwd, BackgroundJob.Service.use((jobs) => jobs.cancel(params.jobId))),
        ),
      "background job",
    )
    return { status: info?.status ?? found.status }
  })

  // origami_change-start (interject): deliver a queued message into the turn
  // that is already running, instead of making the user cancel it to be heard.
  const interject = Effect.fn("ACP.interject")(function* (params: InterjectRequest) {
    const current = yield* session.get(params.sessionId)
    const text = params.text.trim()
    if (!text) {
      return yield* new ACPError.ServiceFailureError({
        service: "session",
        safeMessage: "An interjection needs some text to deliver",
        errorName: "InterjectEmpty",
      })
    }
    const result = yield* request(
      () =>
        AppRuntime.runPromise(
          inInstance(
            current.cwd,
            SessionPrompt.Service.use((prompts) =>
              prompts.interject({ sessionID: SessionID.make(current.id), text }),
            ),
          ),
        ),
      "session",
    )
    return { delivered: true as const, busy: result.busy, promoted: result.promoted }
  })
  // origami_change-end

  return {
    initialize,
    authenticate,
    newSession,
    loadSession,
    listSessions,
    resumeSession,
    closeSession,
    forkSession,
    runSteps,
    runStats,
    subagentTranscript,
    listInstructions,
    promptCapture,
    cacheStats,
    listSkills,
    listTools,
    listAgentPlugins,
    agentPluginAdd,
    agentPluginSetEnabled,
    mcpList,
    mcpAdd,
    mcpRemove,
    mcpSetEnabled,
    mcpConnect,
    mcpDisconnect,
    mcpAuthenticate,
    mcpAuthRemove,
    providerAuthList,
    providerAuthAuthorize,
    providerAuthCallback,
    providerAuthUsage,
    providerRefresh,
    collabAgents,
    collabList,
    collabCreate,
    collabPost,
    collabPreview,
    collabState,
    collabSetCap,
    collabSetConcurrency,
    collabSetFlavor,
    collabSetLead,
    collabSetObjective,
    collabTaskAdd,
    collabTaskUpdate,
    collabReview,
    collabLedger,
    collabStop,
    collabStopAgent,
    collabRedirect,
    collabArchive,
    collabUnarchive,
    collabRename,
    collabAddParticipant,
    collabRemoveParticipant,
    shellStop,
    interject, // origami_change
    setSessionConfigOption,
    setSessionMode,
    setSessionModel,
    prompt: Effect.fn("ACP.prompt")(function* (params: PromptRequest) {
      const current = yield* session.get(params.sessionId)
      const snapshot = yield* directorySnapshot(current.cwd)
      const selected = current.model ?? selectDefaultModel(snapshot)
      if (!current.model) {
        yield* session.setModel(params.sessionId, selected)
      }
      const variant = current.variant ?? selectVariant(snapshot, selected)
      const modeId = current.modeId ?? (snapshot.availableModes.length > 0 ? snapshot.defaultModeID : undefined)
      const parts = promptContentToParts(params.prompt)
      const command = detectSlashCommand(parts)

      if (!command) {
        const response = yield* request(
          () =>
            input.sdk.session.prompt(
              {
                sessionID: current.id,
                model: {
                  providerID: selected.providerID,
                  modelID: selected.modelID,
                },
                ...(variant ? { variant } : {}),
                parts,
                ...(modeId ? { agent: modeId } : {}),
                // Scoped auto-approve preset → a session permission ruleset. "auto"
                // allows file edits, "bypass" allows everything, "default"/undefined
                // yields an EMPTY map. ALWAYS sent: the engine now treats a present
                // `tools` map (prompt.ts `input.tools !== undefined`) as an
                // authoritative replace, so an empty map from "default" actively
                // CLEARS an already-persisted auto/bypass ruleset back to ask - the
                // reset a conditional send (or the old `permissions.length > 0`
                // engine guard) could not express.
                tools: PermissionPresets.tools(current.permissionMode),
                // Per-chat sampling override for THIS session (set via the
                // temperature/topP config options); undefined = provider/agent
                // default. Applied live per request by the llm.run merge.
                ...(current.temperature !== undefined ? { temperature: current.temperature } : {}),
                ...(current.topP !== undefined ? { topP: current.topP } : {}),
                directory: current.cwd,
              },
              { throwOnError: true },
            ),
          "session",
        )
        yield* sendUsageUpdate(usageService, input.connection, current.id, current.cwd)
        return yield* promptResponse(response.info, params.messageId)
      }

      const known = snapshot.availableCommands.find((item) => item.name === command.name)
      if (known) {
        const response = yield* request(
          () =>
            input.sdk.session.command(
              {
                sessionID: current.id,
                command: known.name,
                arguments: command.args,
                model: `${selected.providerID}/${selected.modelID}`,
                ...(variant ? { variant } : {}),
                ...(modeId ? { agent: modeId } : {}),
                directory: current.cwd,
              },
              { throwOnError: true },
            ),
          "session",
        )
        yield* sendUsageUpdate(usageService, input.connection, current.id, current.cwd)
        return yield* promptResponse(response.info, params.messageId)
      }

      if (command.name === "compact") {
        yield* request(
          () =>
            input.sdk.session.summarize(
              {
                sessionID: current.id,
                directory: current.cwd,
                providerID: selected.providerID,
                modelID: selected.modelID,
              },
              { throwOnError: true },
            ),
          "session",
        )
      }

      yield* sendUsageUpdate(usageService, input.connection, current.id, current.cwd)
      return yield* promptResponse(undefined, params.messageId)
    }),
    cancel,
  }
}

function makeSessionService() {
  return ManagedRuntime.make(AppNodeBuilder.build(ACPSession.node)).runSync(
    ACPSession.Service.use((service) => Effect.succeed(service)),
  )
}

// Runs on the process-wide AppRuntime rather than a private layer stack: the
// ACP process already boots the engine in-process (cli/cmd/acp.ts), and
// standing up a second Database/Config/Plugin instance deadlocks against it.
function makeInstructionsService(): Instructions.Interface {
  return {
    list: (directory: string) => request(() => AppRuntime.runPromise(Instructions.list(directory)), "instructions"),
  }
}

// Same rationale as makeInstructionsService: the ACP process already boots the
// engine in-process, so this runs on the process-wide AppRuntime rather than a
// private layer stack.
function makeSkillsService(): Skills.Interface {
  return {
    list: (directory: string, options?: Skills.ListOptions) =>
      request(() => AppRuntime.runPromise(Skills.list(directory, options)), "skills"),
  }
}

// Same rationale as makeSkillsService: the Collab methods read the engine's own
// Database/Agent/Session services, which the in-process AppRuntime already holds.
function makeCollabService(): ACPCollab.Interface {
  return {
    agents: (directory: string) => request(() => AppRuntime.runPromise(ACPCollab.agents(directory)), "collab"),
    list: (directory: string) => request(() => AppRuntime.runPromise(ACPCollab.list(directory)), "collab"),
    create: (directory: string, params: { title: string; agentSlugs: readonly string[]; objective?: string }) =>
      request(() => AppRuntime.runPromise(ACPCollab.create(directory, params)), "collab"),
    post: (directory: string, params: { collabId: string; text: string; mentions?: readonly string[] }) =>
      request(() => AppRuntime.runPromise(ACPCollab.post(directory, params)), "collab"),
    preview: (directory: string, params: { collabId: string; mentions?: readonly string[] }) =>
      request(() => AppRuntime.runPromise(ACPCollab.preview(directory, params)), "collab"),
    state: (directory: string, params: { collabId: string; sinceSeq?: number }) =>
      request(() => AppRuntime.runPromise(ACPCollab.state(directory, params)), "collab"),
    setCap: (directory: string, params: { collabId: string; cap: number | null }) =>
      request(() => AppRuntime.runPromise(ACPCollab.setCap(directory, params)), "collab"),
    setConcurrency: (directory: string, params: { collabId: string; concurrency: number }) =>
      request(() => AppRuntime.runPromise(ACPCollab.setConcurrency(directory, params)), "collab"),
    setFlavor: (directory: string, params: { collabId: string; flavor: string }) =>
      request(() => AppRuntime.runPromise(ACPCollab.setFlavor(directory, params)), "collab"),
    setLead: (directory: string, params: { collabId: string; agentSlug: string | null }) =>
      request(() => AppRuntime.runPromise(ACPCollab.setLead(directory, params)), "collab"),
    setObjective: (directory: string, params: { collabId: string; objective: string }) =>
      request(() => AppRuntime.runPromise(ACPCollab.setObjective(directory, params)), "collab"),
    taskAdd: (directory: string, params: { collabId: string; title: string }) =>
      request(() => AppRuntime.runPromise(ACPCollab.taskAdd(directory, params)), "collab"),
    taskUpdate: (
      directory: string,
      params: {
        collabId: string
        taskId: string
        action: CollabStore.TaskAction
        result?: string
        note?: string
        owner?: string
      },
    ) => request(() => AppRuntime.runPromise(ACPCollab.taskUpdate(directory, params)), "collab"),
    review: (
      directory: string,
      params: { collabId: string; taskId: string; verdict: ACPCollab.Verdict; note?: string },
    ) => request(() => AppRuntime.runPromise(ACPCollab.review(directory, params)), "collab"),
    ledger: (directory: string, params: { collabId: string; limit?: number }) =>
      request(() => AppRuntime.runPromise(ACPCollab.ledger(directory, params)), "collab"),
    stop: (directory: string, params: { collabId: string }) =>
      request(() => AppRuntime.runPromise(ACPCollab.stop(directory, params)), "collab"),
    stopAgent: (directory: string, params: { collabId: string; agentSlug: string }) =>
      request(() => AppRuntime.runPromise(ACPCollab.stopAgent(directory, params)), "collab"),
    redirect: (directory: string, params: { collabId: string; agentSlug: string; text: string }) =>
      request(() => AppRuntime.runPromise(ACPCollab.redirect(directory, params)), "collab"),
    archive: (directory: string, params: { collabId: string }) =>
      request(() => AppRuntime.runPromise(ACPCollab.archive(directory, params)), "collab"),
    unarchive: (directory: string, params: { collabId: string }) =>
      request(() => AppRuntime.runPromise(ACPCollab.unarchive(directory, params)), "collab"),
    rename: (directory: string, params: { collabId: string; title: string }) =>
      request(() => AppRuntime.runPromise(ACPCollab.rename(directory, params)), "collab"),
    addParticipant: (directory: string, params: { collabId: string; agentSlug: string }) =>
      request(() => AppRuntime.runPromise(ACPCollab.addParticipant(directory, params)), "collab"),
    removeParticipant: (directory: string, params: { collabId: string; agentSlug: string }) =>
      request(() => AppRuntime.runPromise(ACPCollab.removeParticipant(directory, params)), "collab"),
  }
}

function makeDirectoryService(sdk: OrigamiClient) {
  return ManagedRuntime.make(
    AppNodeBuilder.build(Directory.node, [
      [
        Directory.loaderNode,
        Layer.succeed(
          Directory.Loader,
          Directory.Loader.of({
            load: (directory) => request(() => loadDirectorySnapshot(sdk, directory), "directory"),
          }),
        ),
      ],
    ]),
  ).runSync(Directory.Service.use((service) => Effect.succeed(service)))
}

function makeUsageService(sdk: OrigamiClient) {
  const limits = new Map<string, Promise<number | undefined>>()
  const contextLimit: UsageService.Interface["contextLimit"] = Effect.fn("ACP.promptUsage.contextLimit")(
    function* (params) {
      const key = `${params.directory}\u0000${params.providerID}\u0000${params.modelID}`
      const current = limits.get(key)
      if (current) return yield* Effect.promise(() => current)

      const next = sdk.config
        .providers({ directory: params.directory }, { throwOnError: true })
        .then((response) => {
          const providers = Object.fromEntries(
            (response.data?.providers ?? []).map((provider) => [provider.id, provider]),
          ) as Record<ProviderV2.ID, Provider.Info>
          return UsageService.findContextLimit(providers, params.providerID, params.modelID)
        })
        .catch(() => undefined)
      limits.set(key, next)
      return yield* Effect.promise(() => next)
    },
  )

  const sendUpdate: UsageService.Interface["sendUpdate"] = Effect.fn("ACP.promptUsage.sendUpdate")(function* (params) {
    const messages = yield* request(
      () =>
        sdk.session.messages(
          {
            sessionID: params.sessionID,
            directory: params.directory,
          },
          { throwOnError: true },
        ),
      "session",
    ).pipe(
      Effect.map((messages) => messages as readonly UsageService.SessionMessage[]),
      Effect.catch((error) =>
        Effect.logError("failed to fetch messages for usage update", { error: error }).pipe(Effect.as(undefined)),
      ),
    )
    if (!messages) return

    const message = UsageService.latestAssistantMessage(messages)
    if (!message?.providerID || !message.modelID) return

    // Skip the /compact summariser turn. Its tokens describe reading the WHOLE
    // pre-compaction history: input would spike the gauge, output alone
    // under-reports (omits the preserved tail + the system/tools overhead every
    // turn re-sends). Compaction reduction is lazy anyway, so hold the gauge and
    // let the NEXT real turn's measured input report the true reduced footprint.
    if ((message as { summary?: boolean }).summary === true) return

    const size = yield* contextLimit({
      directory: params.directory,
      providerID: ProviderV2.ID.make(message.providerID),
      modelID: ModelV2.ID.make(message.modelID),
    })
    if (!size) return

    // Subagent rollup. roots:false keeps the task tool's child sessions in the
    // listing; their rows already carry running cost/token totals, so no
    // per-child message fetch is needed. A failed listing costs the rollup
    // only — the gauge and the parent's own cost still go out.
    const rows = yield* request(
      () => sdk.session.list({ directory: params.directory, roots: false }, { throwOnError: true }),
      "session",
    ).pipe(
      Effect.map((rows) => rows as readonly UsageService.SessionRow[]),
      Effect.catch(() => Effect.succeed([] as readonly UsageService.SessionRow[])),
    )

    yield* Effect.promise(() =>
      params.connection
        .sessionUpdate({
          sessionId: params.sessionID,
          update: UsageService.buildUsageUpdate({
            used: message.tokens.input + message.tokens.cache.read,
            size,
            cost: UsageService.totalSessionCost(messages),
            subagents: UsageService.subagentTotals(rows, params.sessionID),
            cacheReadTokens: message.tokens.cache.read,
            cacheWriteTokens: message.tokens.cache.write,
          }),
        })
        .catch(() => {}),
    )
  })

  return UsageService.Service.of({
    buildUsage: UsageService.buildUsage,
    latestAssistantMessage: UsageService.latestAssistantMessage,
    totalSessionCost: UsageService.totalSessionCost,
    contextLimit,
    sendUpdate,
  })
}

/** A placeholder ("New session - <ISO>") is not a name - the client has its own
 *  fallback for that and would only have to filter this back out. */
function replayTitle(subscription: ACPEvent.Subscription | undefined, sessionId: string, title: string | undefined) {
  if (!subscription || !title || isDefaultTitle(title)) return Effect.void
  return Effect.promise(() => subscription.replayTitle(sessionId, title).catch(() => {}))
}

function replayMessages(subscription: ACPEvent.Subscription | undefined, messages: SessionMessageResponse[]) {
  if (!subscription) return Effect.void
  return Effect.promise(async () => {
    for (const message of messages) {
      await subscription.replayMessage(message).catch(() => {})
    }
  })
}

type ConfigState = {
  readonly model: Directory.DefaultModel
  readonly variant?: string
  readonly modeId?: string
  /**
   * The chat's live auto-approve preset. Absent = `default`. Every session
   * entry point derives this from the ENGINE ROW (the only durable copy), not
   * from the ACP session's in-memory string, which is empty on a fresh
   * connection - that gap is what let a client seed its approve control from
   * its own memory and claim a mode the engine was not on.
   */
  readonly permissionMode?: string
}

type SdkResponse<T> = {
  readonly data?: T
  readonly error?: unknown
}

type MessageInfo = {
  readonly role?: Message["role"]
  readonly model?: Extract<Message, { role: "user" }>["model"]
  readonly providerID?: Extract<Message, { role: "assistant" }>["providerID"]
  readonly modelID?: Extract<Message, { role: "assistant" }>["modelID"]
  readonly variant?: Extract<Message, { role: "assistant" }>["variant"]
  readonly mode?: Extract<Message, { role: "assistant" }>["mode"]
  readonly agent?: Message["agent"]
}

type AssistantError = NonNullable<AssistantMessage["error"]>
type AssistantInfo = (UsageService.AssistantTokenCost & Pick<AssistantMessage, "error">) | undefined

/**
 * origami_change: run engine work on the process-wide AppRuntime WITH the
 * instance it belongs to.
 *
 * `acp/agent.ts` starts every request on a bare fiber (`Effect.runPromise`), so
 * nothing on it carries `InstanceRef`. Every engine service that keeps
 * per-project state reaches it through `InstanceState`, which `Effect.die`s
 * with "InstanceRef not provided" when it is absent (effect/instance-state.ts).
 * `request()` then maps that defect to `ServiceFailureError`, whose
 * `safeMessage` to the client stays a redacted "Origami service failure" -
 * but `mapRequestError` (by `fromUnknownError`, below) now logs the real
 * cause first, so a handler built without this helper still fails, but no
 * longer silently.
 *
 * `store.load` is memoised per directory, and the session prompt reaches the
 * engine as `directory: current.cwd` (server instance-context middleware loads
 * it the same way), so passing the session's cwd here resolves the SAME
 * instance the turn itself is running under - which is what makes a write from
 * this side visible to that turn.
 *
 * Same shape as `ACPProviderAuth.withInstance` and `CollabACP.inInstance`.
 */
function inInstance<A, E, R>(directory: string, body: Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    const store = yield* InstanceStore.Service
    const ctx = yield* store.load({ directory })
    return yield* body.pipe(Effect.provideService(InstanceRef, ctx))
  })
}

function request<T>(fn: () => Promise<T | SdkResponse<T>>, service?: string) {
  return Effect.tryPromise({
    try: async () => {
      const result = await fn()
      if (isSdkResponse<T>(result)) {
        if (result.error) throw result.error
        if (result.data !== undefined) return result.data
      }
      return result as T
    },
    // Keep the raw error alive past this boundary - `mapRequestError` logs it
    // before `fromUnknownError` discards it into the generic branch.
    catch: (error) => error,
  }).pipe(Effect.catch((error) => mapRequestError(error, service)))
}

function profiledRequest<T>(name: string, fn: () => Promise<T | SdkResponse<T>>, service?: string) {
  return request(() => ACPProfile.measure(name, fn), service)
}

async function loadDirectorySnapshot(sdk: OrigamiClient, directory: string) {
  return ACPProfile.measure("acp.directory.load", async () => {
    const [providersResponse, agentsResponse, commandsResponse, skillsResponse, configResponse] = await Promise.all([
      ACPProfile.measure("acp.directory.provider.list", () =>
        sdk.config.providers({ directory }, { throwOnError: true }),
      ),
      ACPProfile.measure("acp.directory.mode.defaultAgent.load", () =>
        sdk.app.agents({ directory }, { throwOnError: true }),
      ),
      ACPProfile.measure("acp.directory.command.list", () => sdk.command.list({ directory }, { throwOnError: true })),
      ACPProfile.measure("acp.directory.skill.list", () => sdk.app.skills({ directory }, { throwOnError: true })),
      ACPProfile.measure("acp.directory.defaultModel.config", () =>
        sdk.config.get({ directory }, { throwOnError: true }).catch(() => undefined),
      ),
    ])
    const providersData = providersResponse.data!
    const agents = agentsResponse.data!
    const commandsData = commandsResponse.data!
    const skills = skillsResponse.data!
    const providers = Object.fromEntries(providersData.providers.map((provider) => [provider.id, provider])) as Record<
      ProviderV2.ID,
      Provider.Info
    >
    const defaultModelStarted = performance.now()
    const defaultModel = defaultModelFromConfig(configResponse?.data?.model, providers)
    ACPProfile.duration("acp.directory.defaultModel.resolve", defaultModelStarted, { configured: !!defaultModel })
    // Hidden NON-native definitions ride this list - every bot the Bots pane
    // saves is one (Directory.modeOptionsFrom says why). The picker filters
    // them back out; `resolveRequestedAgent` does not, because they are exactly
    // the identities "Start session" on a bot asks for.
    const modes = Directory.modeOptionsFrom(agents)
    const commands = [
      ...commandsData,
      ...skills
        .filter((skill) => !commandsData.some((command) => command.name === skill.name))
        .map((skill) => ({
          name: skill.name,
          description: skill.description,
          source: "skill" as const,
          template: skill.content,
          hints: [],
        })),
    ] as Command.Info[]

    return Directory.build({
      directory,
      providers,
      modes,
      defaultModeID: agents.find((agent) => agent.mode === "primary" && agent.hidden !== true)?.name ?? "build",
      commands: commands.toSorted((a, b) => a.name.localeCompare(b.name)),
      ...(defaultModel ? { defaultModel } : {}),
    })
  })
}

/** Exported for test: the preference order is the contract, not an implementation detail. */
export function defaultModelFromConfig(
  configuredModel: string | undefined,
  providers: Record<ProviderV2.ID, Provider.Info>,
): Directory.DefaultModel | undefined {
  const configured = configuredModel ? Provider.parseModel(configuredModel) : undefined
  if (configured && providers[configured.providerID]?.models[configured.modelID]) return configured

  // First-session ACP startup must not scan historical sessions just to infer
  // a default. Configured model, OpenCode Zen provider, then sorted best model
  // keep the protocol response deterministic without extra session/message reads.
  // The id is `opencode` — the id the shipped models.dev catalog serves.
  const zenProvider = providers[ProviderV2.ID.make("opencode")]
  const zenModel = zenProvider ? Provider.sort(Object.values(zenProvider.models))[0] : undefined
  if (zenProvider && zenModel) return { providerID: zenProvider.id, modelID: zenModel.id }

  const best = Provider.sort(Object.values(providers).flatMap((provider) => Object.values(provider.models)))[0]
  if (best) return { providerID: best.providerID, modelID: best.id }
  if (configured) return configured
}

function selectDefaultModel(snapshot: Directory.Snapshot) {
  if (snapshot.defaultModel) return snapshot.defaultModel
  const model = snapshot.modelOptions[0]
  if (model) return { providerID: model.providerID, modelID: model.modelID }
  return { providerID: "unknown" as ProviderV2.ID, modelID: "unknown" as ModelV2.ID }
}

function detectSlashCommand(parts: ReturnType<typeof promptContentToParts>) {
  const text = parts
    .filter((part): part is Extract<(typeof parts)[number], { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("")
    .trim()
  if (!text.startsWith("/")) return

  const [name, ...rest] = text.slice(1).split(/\s+/)
  if (!name) return
  return { name, args: rest.join(" ").trim() }
}

const promptResponse = Effect.fn("ACP.promptResponse")(function* (
  info: AssistantInfo,
  messageId: string | null | undefined,
) {
  if (!info?.error) {
    return {
      stopReason: "end_turn" as const,
      ...(info ? { usage: UsageService.buildUsage(info) } : {}),
      ...(messageId ? { userMessageId: messageId } : {}),
      _meta: {},
    }
  }

  const base = {
    usage: UsageService.buildUsage(info),
    ...(messageId ? { userMessageId: messageId } : {}),
    _meta: {},
  }

  if (info.error.name === "MessageAbortedError") {
    return {
      stopReason: "cancelled" as const,
      ...base,
    }
  }

  if (info.error.name === "MessageOutputLengthError") {
    return {
      stopReason: "max_tokens" as const,
      ...base,
    }
  }

  if (info.error.name === "ContentFilterError") {
    return {
      stopReason: "refusal" as const,
      ...base,
    }
  }

  if (info.error.name === "ProviderAuthError") {
    return yield* new ACPError.AuthRequiredError({ providerId: info.error.data.providerID })
  }

  return yield* new ACPError.ServiceFailureError({
    service: "session",
    safeMessage: promptErrorMessage(info.error),
    errorName: info.error.name,
  })
})

function promptErrorMessage(error: AssistantError) {
  if ("message" in error.data && typeof error.data.message === "string") return error.data.message
  return "Origami prompt failed"
}

function sendUsageUpdate(
  usage: UsageService.Interface,
  connection: ServiceConnection | undefined,
  sessionID: string,
  directory: string,
) {
  if (!connection) return Effect.void
  return usage.sendUpdate({
    connection,
    sessionID,
    directory,
  })
}

function selectVariant(snapshot: Directory.Snapshot, model: Directory.DefaultModel) {
  const variants = Directory.variants(snapshot, model)
  if (!variants) return
  if (variants.default) return "default"
  return Object.keys(variants)[0]
}

/**
 * The modes a PICKER may show.
 *
 * `availableModes` is "what may back a session", which since W8-L1 includes
 * every hidden definition the Bots pane saved. The picker is the narrower
 * question, and the two differ in one place only: a chat running AS a hidden
 * definition keeps its own agent on the list. A select whose `currentValue` is
 * absent from its options renders as nothing chosen, so without that a bot chat
 * would show a blank agent control over a chat that is answering as the bot.
 */
const pickerModes = (modes: readonly Directory.ModeOption[], currentModeId?: string) =>
  modes.filter((mode) => !mode.hidden || mode.id === currentModeId)

function configOptions(snapshot: Directory.Snapshot, session: ConfigState) {
  return buildConfigOptions({
    providers: Object.values(snapshot.providers),
    currentModel: session.model,
    currentVariant: session.variant,
    modes: pickerModes(snapshot.availableModes, session.modeId),
    currentModeId: session.modeId,
    currentPermissionMode: session.permissionMode,
  })
}

function parseSelectedModel(snapshot: Directory.Snapshot, modelId: string) {
  const selected = parseModelSelection(modelId, Object.values(snapshot.providers))
  const provider = snapshot.providers[ProviderV2.ID.make(selected.model.providerID)]
  const model = provider?.models[ModelV2.ID.make(selected.model.modelID)]
  if (!model) {
    return Effect.fail(
      new ACPError.InvalidModelError({
        providerId: selected.model.providerID,
        modelId,
      }),
    )
  }
  if (selected.variant && !model.variants?.[selected.variant]) {
    return Effect.fail(new ACPError.InvalidEffortError({ effort: selected.variant }))
  }
  return Effect.succeed({
    model: {
      providerID: provider.id,
      modelID: model.id,
    },
    variant: selected.variant,
  })
}

/**
 * origami_change: the engine's COMPLETE command vocabulary for a directory —
 * builtin, config-file and skill commands PLUS the MCP prompts, waiting for
 * background discovery if it is still in flight.
 *
 * Runs against the process-wide AppRuntime, which already provides
 * `Command.Service` (`AppLayer` in `@/effect/app-runtime`) and shares its
 * instances with the in-process HTTP server through the module-wide `memoMap`.
 * That sharing is the whole point: this waits on the SAME discovery the
 * `command.list` route reads, rather than standing up a second engine and
 * connecting every MCP server twice. Same rule `Skills.list` follows.
 */
export const settledCommands = (directory: string): Promise<readonly Command.Info[]> =>
  AppRuntime.runPromise(
    Effect.gen(function* () {
      const store = yield* InstanceStore.Service
      const command = yield* Command.Service
      const ctx = yield* store.load({ directory })
      return yield* command.listSettled().pipe(Effect.provideService(InstanceRef, ctx))
    }),
  )

function sendAvailableCommands(
  connection: Pick<AgentSideConnection, "sessionUpdate"> | undefined,
  sessionId: string,
  snapshot: Directory.Snapshot,
) {
  if (!connection) return Effect.void
  return Effect.sync(() => {
    setTimeout(() => {
      void connection.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: "available_commands_update",
          availableCommands: snapshot.availableCommands.map((command) => ({
            name: command.name,
            description: command.description ?? "",
          })),
        },
      })
    }, 0)
  })
}

function registerMcpServers(
  sdk: OrigamiClient,
  registered: Map<string, Set<string>>,
  directory: string,
  sessionId: string,
  servers: readonly McpServer[],
) {
  const started = performance.now()
  const current = registered.get(sessionId) ?? new Set<string>()
  registered.set(sessionId, current)
  const pending = new Set<string>()

  return Effect.all(
    servers
      .map((server) => ({ server, config: mcpConfig(server) }))
      .filter((entry) => {
        const key = mcpRegistrationKey(entry.server.name, entry.config)
        if (current.has(key) || pending.has(key)) return false
        pending.add(key)
        return true
      })
      .map((entry) =>
        request(
          () =>
            sdk.mcp.add(
              {
                directory,
                name: entry.server.name,
                config: entry.config,
              },
              { throwOnError: true },
            ),
          "mcp",
        ).pipe(
          Effect.tap(() => Effect.sync(() => current.add(mcpRegistrationKey(entry.server.name, entry.config)))),
          Effect.ignore,
        ),
      ),
    { concurrency: "unbounded" },
  ).pipe(
    Effect.tap(() =>
      Effect.sync(() =>
        ACPProfile.duration("acp.mcp.register", started, {
          count: pending.size,
        }),
      ),
    ),
    Effect.asVoid,
  )
}

function mcpRegistrationKey(name: string, config: ReturnType<typeof mcpConfig>) {
  return `${name}:${stableStringify(config)}`
}

function mcpConfig(server: McpServer) {
  if ("type" in server) {
    return {
      type: "remote" as const,
      url: server.url,
      headers: Object.fromEntries(server.headers.map((header) => [header.name, header.value])),
    }
  }
  return {
    type: "local" as const,
    command: [server.command, ...server.args],
    environment: Object.fromEntries(server.env.map((entry) => [entry.name, entry.value])),
  }
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`
  if (!value || typeof value !== "object") return JSON.stringify(value)
  return `{${Object.entries(value)
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
    .join(",")}}`
}

function restoreFromMessages(messages: readonly MessageInfo[]) {
  const user = messages.findLast(
    (message) => message.role === "user" && message.model?.providerID && message.model.modelID,
  )
  if (user?.model?.providerID && user.model.modelID) {
    return {
      model: { providerID: user.model.providerID as ProviderV2.ID, modelID: user.model.modelID as ModelV2.ID },
      variant: user.model.variant,
      modeId: user.agent,
    }
  }

  const assistant = messages.findLast((message) => message.providerID && message.modelID)
  if (assistant?.providerID && assistant.modelID) {
    return {
      model: { providerID: assistant.providerID as ProviderV2.ID, modelID: assistant.modelID as ModelV2.ID },
      variant: assistant.variant,
      modeId: assistant.mode ?? assistant.agent,
    }
  }

  return {}
}

function isSdkResponse<T>(value: T | SdkResponse<T>): value is SdkResponse<T> {
  return typeof value === "object" && value !== null && ("data" in value || "error" in value)
}

function fromUnknownError(error: unknown, service?: string): Error {
  if (isACPError(error)) return error
  if (isAuthRequired(error)) {
    return new ACPError.AuthRequiredError({ providerId: findProviderID(error) })
  }
  return new ACPError.ServiceFailureError({ safeMessage: "Origami service failure", service })
}

/**
 * origami_change: `fromUnknownError`'s generic branch is the one that
 * discards the raw cause behind `ServiceFailureError`'s redacted
 * `safeMessage` - see the comment on `inInstance` above for the incident this
 * caused (`InstanceRef not provided` invisible in the engine log for weeks).
 *
 * The log call lives here, in `request()`'s catch path, rather than inside
 * `fromUnknownError` itself: `fromUnknownError` is a plain synchronous
 * mapper with no Effect context to run `Effect.logError` through, and this is
 * its only caller. Auth-required and already-ACP errors take their existing
 * branches untouched and are not logged here, because `fromUnknownError`
 * does not discard anything for them - the client-visible shape for every
 * branch is unchanged.
 */
function mapRequestError(error: unknown, service?: string) {
  return Effect.gen(function* () {
    if (!isACPError(error) && !isAuthRequired(error)) {
      yield* Effect.logError("acp request failed with an unrecognized error", {
        service,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      })
    }
    return yield* Effect.fail(fromUnknownError(error, service))
  })
}

function isACPError(error: unknown): error is Error {
  return (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    typeof error._tag === "string" &&
    error._tag.startsWith("ACP")
  )
}

function isAuthRequired(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false
  if (value instanceof Error && (value.name === "ProviderAuthError" || value.name === "LoadAPIKeyError")) return true
  if (
    value instanceof Error &&
    (value.message.includes("ProviderAuthError") || value.message.includes("LoadAPIKeyError"))
  ) {
    return true
  }
  if ("name" in value && (value.name === "ProviderAuthError" || value.name === "LoadAPIKeyError")) return true
  if ("_tag" in value && (value._tag === "ProviderAuthError" || value._tag === "LoadAPIKeyError")) return true
  if ("error" in value && isAuthRequired(value.error)) return true
  if ("data" in value && isAuthRequired(value.data)) return true
  return false
}

function findProviderID(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return
  if ("providerID" in value && typeof value.providerID === "string") return value.providerID
  if ("providerId" in value && typeof value.providerId === "string") return value.providerId
  if ("data" in value) return findProviderID(value.data)
  if ("error" in value) return findProviderID(value.error)
}
