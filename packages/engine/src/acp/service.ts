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
import { AgentMailbox } from "@/origami/agent-mailbox"
import type { AssistantMessage, Message, OrigamiClient, Part, SessionMessageResponse } from "@origami/sdk/v2"
import { Context, Effect, Layer, ManagedRuntime } from "effect"
import * as ACPError from "./error"
import { buildConfigOptions, parseModelSelection } from "./config-option"
import { promptContentToParts, type PromptPart } from "./content"
import { Directory } from "./directory"
import { ACPEvent } from "./event"
import { Instructions } from "./instructions"
import { ACPAgentPlugins } from "./agent-plugins"
import { FlockBoot } from "@/flock/boot"
import { ACPArtifacts } from "./artifacts"
import { ACPFlock } from "./flock"
import { ACPMcp } from "./mcp"
import { ACPProviderAuth } from "./provider-auth"
import { ACPProviderUsage } from "./provider-usage"
import { ACPSecondOpinion } from "./second-opinion"
import { SessionCacheState } from "@/session/cache-state"
import { SessionPromptCapture } from "@/session/prompt-capture"
import { EngineProcessMemory } from "@/engine-process-memory" // origami_change (t-w2u5vf): free a closed chat's memory
import { StorageRetention } from "@/storage/retention" // origami_change: the Insights Storage card's two ext methods
import { StorageJournal } from "@/storage/journal" // origami_change: journal compaction and the one-time VACUUM
import { ACPNests } from "./nests" // origami_change (t-s9jgzh): Nests L4a ext methods
import { SessionPrompt } from "@/session/prompt" // origami_change
import { MessageID, PartID, SessionID } from "@/session/schema" // origami_change
import { MessageV2 } from "@/session/message-v2" // origami_change: t-krxap7 paged subagent transcript
import { PermissionPresets } from "@/permission/presets"
import { RunSteps } from "./run-steps"
import { RunStats } from "./run-stats"
import { ForeignTranscript } from "./foreign-transcript" // origami_change: session_append_foreign
import { SubagentTranscript } from "./subagent-transcript"
import { ACPHistory } from "./history" // origami_change (t-ucnjwp): bounded restore, history pages, global find
import { ACPHistoryStore } from "./history-store" // origami_change (t-ucnjwp)
import { SubagentTodos } from "./subagent-todos" // origami_change (t-qd2riw): bounded todowrite lookup
import { SubagentChanges } from "./subagent-changes" // origami_change (t-ru0by6): bounded diff-parts lookup
import * as SubagentStop from "./subagent-stop" // origami_change (t-q910fo): the per-row sub-agent stop
import { Skills } from "./skills"
import { ACPTools } from "./tools"
import { ACPSubagentTools } from "./subagent-tools"
import { ACPCollab } from "@/collab/acp"
import type { CollabRunner } from "@/collab/runner"
import type { CollabStore } from "@/collab/store"
import { ACPSession } from "./session"
import { UsageService } from "./usage"
import { ACPProfile } from "./profile"
import { ProviderV2 } from "@origami/core/provider"
import { ModelV2 } from "@origami/core/model"
import { Provider } from "@/provider/provider"
import { ClaudeSubscription } from "@/provider/claude-subscription"
import { ProviderCatalogCache } from "@/provider/catalog-cache"
import { resetDiscoveryCache } from "@/provider/discovery"
import {
  Session, // origami_change: session_append_foreign writes through the store's OWN service
  isDefaultTitle,
  withSubagentModel,
  withCompactionThreshold,
  withVisionProfile,
  type CompactionThresholdOverride,
} from "@/session/session"
import { Command } from "@/command" // origami_change: the late MCP-prompt fold needs the service, not just its type
import { Config } from "@/config/config" // origami_change: provider_refresh re-reads config in-process
import { InstanceRef } from "@/effect/instance-ref" // origami_change
import { InstanceState } from "@/effect/instance-state" // origami_change: session_append_foreign stamps the real cwd/root
import { InstanceStore } from "@/project/instance-store" // origami_change
import { ElasticSpare } from "@/elastic/spare" // origami_change (t-w2u2ki)
import { BackgroundJob } from "@/background/job"

export const AuthMethodID = "origami-login"

export type Error = ACPError.Error
type ServiceConnection = Pick<AgentSideConnection, "sessionUpdate"> &
  Partial<Pick<AgentSideConnection, "requestPermission" | "writeTextFile" | "extNotification">>

export type Interface = ACPNests.Methods & {
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
  readonly sessionDelete: (input: SessionDeleteRequest) => Effect.Effect<{ ok: true }, Error>
  readonly sessionAppendForeign: (
    input: SessionAppendForeignRequest,
  ) => Effect.Effect<SessionAppendForeignResult, Error>
  readonly runSteps: (input: RunStepsRequest) => Effect.Effect<RunSteps.RunStepsResult, Error>
  readonly runStats: (input: RunStatsRequest) => Effect.Effect<RunStats.RunStatsResult, Error>
  readonly subagentTranscript: (
    input: SubagentTranscriptRequest,
  ) => Effect.Effect<SubagentTranscript.SubagentTranscriptResult, Error>
  // origami_change (t-qd2riw): the child's latest todowrite, without reading its
  // whole stored session.
  readonly subagentTodos: (input: SubagentTodosRequest) => Effect.Effect<SubagentTodos.SubagentTodosResult, Error>
  // origami_change (t-ru0by6): the child's diff-bearing tool parts, capped and
  // paged, without reading its whole stored session.
  readonly subagentChanges: (input: SubagentChangesRequest) => Effect.Effect<SubagentChangesResult, Error>
  // origami_change (t-ucnjwp): lazy loading. An older page of the chat as tagged frames,
  // an engine-side find over the whole chat, and one row per sub-agent from the rows.
  readonly historyPage: (input: ACPHistory.HistoryPageRequest) => Effect.Effect<ACPHistory.HistoryPageResult, Error>
  readonly historySearch: (
    input: ACPHistory.HistorySearchRequest,
  ) => Effect.Effect<ACPHistory.HistorySearchResult, Error>
  readonly subagentRoster: (input: ACPHistory.SubagentRosterRequest) => Effect.Effect<ACPHistory.SubagentRoster, Error>
  readonly listInstructions: (input: ListInstructionsRequest) => Effect.Effect<Instructions.InstructionSet, Error>
  readonly promptCapture: (input: PromptCaptureRequest) => Effect.Effect<PromptCaptureResult, Error>
  readonly cacheStats: (input: CacheStatsRequest) => Effect.Effect<CacheStatsResult, Error>
  readonly storageStats: () => Effect.Effect<StorageRetention.Stats, Error>
  readonly storagePrune: (input: StoragePruneRequest) => Effect.Effect<StorageRetention.PruneResult, Error>
  readonly storageCompact: (input: StorageCompactRequest) => Effect.Effect<StorageJournal.CompactionResult, Error>
  readonly storageVacuum: (input: StorageVacuumRequest) => Effect.Effect<StorageJournal.VacuumResult, Error>
  readonly listSkills: (input: ListSkillsRequest) => Effect.Effect<Skills.SkillsResult, Error>
  readonly listTools: (input: ListToolsRequest) => Effect.Effect<ACPTools.ToolsResult, Error>
  readonly listAgentPlugins: (input: ListAgentPluginsRequest) => Effect.Effect<ACPAgentPlugins.PluginsResult, Error>
  readonly agentPluginAdd: (input: AgentPluginAddRequest) => Effect.Effect<ACPAgentPlugins.WriteResult, Error>
  readonly agentPluginSetEnabled: (
    input: AgentPluginSetEnabledRequest,
  ) => Effect.Effect<ACPAgentPlugins.SetEnabledResult, Error>
  // Flock (cross-person questions); request shapes live in `acp/flock.ts`. The two
  // queue methods need an instance context; the other seven are plain file work.
  readonly flockState: (input: FlockCwdRequest) => Effect.Effect<ACPFlock.State, Error>
  readonly flockPending: (input: FlockCwdRequest) => Effect.Effect<{ questions: readonly ACPFlock.PendingQuestion[] }, Error>
  readonly flockInvite: (input: ACPFlock.InviteRequest) => Effect.Effect<ACPFlock.WriteResult, Error>
  readonly flockAccept: (input: ACPFlock.AcceptRequest) => Effect.Effect<ACPFlock.WriteResult, Error>
  readonly flockRevoke: (input: ACPFlock.HandleRequest) => Effect.Effect<ACPFlock.WriteResult, Error>
  readonly flockSetIdentity: (input: ACPFlock.SetIdentityRequest) => Effect.Effect<ACPFlock.WriteResult, Error>
  readonly flockSetPolicy: (input: ACPFlock.SetPolicyRequest) => Effect.Effect<ACPFlock.WriteResult, Error>
  readonly flockFrontDesk: (input: ACPFlock.FrontDeskRequest) => Effect.Effect<ACPFlock.WriteResult, Error>
  readonly flockSetSpecialties: (input: ACPFlock.SpecialtiesRequest) => Effect.Effect<ACPFlock.WriteResult, Error>
  readonly flockMailbox: (input: FlockCwdRequest) => Effect.Effect<ACPFlock.Mailbox, Error>
  readonly flockDiagnose: (input: FlockCwdRequest) => Effect.Effect<ReturnType<typeof ACPFlock.diagnose>, Error>
  readonly flockDecide: (input: ACPFlock.DecideRequest & { cwd?: string }) => Effect.Effect<ACPFlock.WriteResult, Error>
  readonly flockSend: (input: ACPFlock.SendRequest & { cwd?: string }) => Effect.Effect<ACPFlock.WriteResult, Error>
  readonly flockPost: (input: ACPFlock.PostRequest) => Effect.Effect<ACPFlock.WriteResult, Error>
  readonly flockMark: (input: ACPFlock.MarkRequest) => Effect.Effect<ACPFlock.WriteResult, Error>
  readonly flockDeliver: (input: ACPFlock.DeliverRequest) => Effect.Effect<ACPFlock.WriteResult, Error>
  // Artifacts (the pages an agent publishes); request shapes live in `acp/artifacts.ts`.
  // All six are store work on this process's one ArtifactStore — no instance context,
  // wrapped in `request` for the uniform error mapping.
  readonly artifactList: (input: ACPArtifacts.ListRequest) => Effect.Effect<ACPArtifacts.ListResult, Error>
  readonly artifactVersions: (input: ACPArtifacts.ArtifactIdRequest) => Effect.Effect<ACPArtifacts.VersionsResult, Error>
  readonly artifactOpen: (input: ACPArtifacts.OpenRequest) => Effect.Effect<ACPArtifacts.OpenResult, Error>
  readonly artifactRestore: (input: ACPArtifacts.RestoreRequest) => Effect.Effect<ACPArtifacts.RestoreResult, Error>
  readonly artifactDiff: (input: ACPArtifacts.DiffRequest) => Effect.Effect<ACPArtifacts.DiffResult, Error>
  readonly artifactRename: (input: ACPArtifacts.RenameRequest) => Effect.Effect<ACPArtifacts.RenameResult, Error>
  readonly artifactDelete: (input: ACPArtifacts.DeleteRequest) => Effect.Effect<ACPArtifacts.DeleteResult, Error>
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
  /** Gate B's last answer for the picker (t-tjt9wd): synchronous, no CLI spawn —
   *  see provider/claude-subscription.ts's `readiness()`/`readinessWireState`. */
  readonly claudeSubscriptionStatus: () => Effect.Effect<ClaudeSubscription.WireStatus, Error>
  readonly secondOpinion: (
    input: SecondOpinionRequest,
  ) => Effect.Effect<ACPSecondOpinion.SecondOpinionResult, Error>
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
  // origami_change (t-q910fo): stop ONE sub-agent child, by its own session id.
  readonly subagentStop: (input: SubagentStopRequest) => Effect.Effect<SubagentStopResult, Error>
  // origami_change: push a message INTO the running turn.
  readonly interject: (input: InterjectRequest) => Effect.Effect<InterjectReply, Error>
}

/** Ceiling on root sessions `listSessions` reads for ONE directory, so cursor paging -
 *  not an invisible DB default - decides what a client sees. */
export const SESSION_LIST_MAX = 5000

export type ShellStopRequest = { readonly jobId: string; readonly sessionId: string }
/** origami_change (t-q910fo): `sessionId` is the CHILD's session id, which is also
 *  the id its background job is registered under (tool/task.ts `background.start`).
 *  `cwd` picks the instance the job lives in, like every other read here. */
export type SubagentStopRequest = { readonly sessionId: string; readonly cwd?: string }
/** `stopped` for a job this call cancelled, `not_found` when no sub-agent job is
 *  registered under that id (already settled, or never a child), and the job's own
 *  status for one that had already ended. */
export type SubagentStopResult = { readonly status: string }
// origami_change-start (interject)
/** `images` are the base64 pairs an ACP `image` content block carries; they become
 *  parts through the SAME converter a prompted image uses (`promptContentToParts`). */
export type InterjectRequest = {
  readonly sessionId: string
  readonly text: string
  readonly images?: readonly { readonly mimeType: string; readonly data: string }[]
}
/** `delivered`: the message is durably in the transcript, to be read at the turn's next
 *  tool boundary. `promoted` counts foreground shells backgrounded to bring it forward. */
export type InterjectReply = { readonly delivered: true; readonly busy: boolean; readonly promoted: number }
// origami_change-end

/**
 * Fork-owned ext method `session_delete`: remove ONE stored session.
 *
 * The only destructive session method this layer exposes. `Session.remove` cascades
 * into child sessions, their jobs, messages and parts, so a client never walks the
 * tree itself. NOT reversible and there is no soft-delete tier under it:
 * `collab_archive` is the "put it away and keep it readable" option.
 */
export type SessionDeleteRequest = {
  readonly sessionId: string
  readonly cwd?: string
}

/** Fork-owned ext method `session_append_foreign`: copy a transcript produced
 *  somewhere ELSE into this session's own message store, WITHOUT running a turn.
 *  Bounded and idempotent: at most MAX_MESSAGES per call, and a message whose `id`
 *  this session already carries is skipped rather than doubled. The rows it writes
 *  are unpriced - see foreign-transcript.ts. */
export type SessionAppendForeignRequest = {
  readonly sessionId: string
  readonly source: string
  readonly messages: readonly ForeignTranscript.ForeignMessage[]
  readonly cwd?: string
}

export type SessionAppendForeignResult = {
  readonly appended: number
  readonly skipped: number
}

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
 * `sessionId` is the CHILD's id - the one `tool/task.ts` stamps on the spawning tool
 * part's metadata. `cwd` scopes the read exactly as it does for `run_steps`.
 * Any stored session id can be reviewed; the transport is the boundary.
 */
export type SubagentTranscriptRequest = {
  readonly sessionId: string
  readonly cwd?: string
  /** t-krxap7. Page size: the NEWEST `limit` stored messages, not the whole run.
   *  Omitted (or <= 0) keeps the original whole-transcript read, byte for byte. */
  readonly limit?: number
  /** t-krxap7. Opaque cursor from a previous paged answer's `cursor`. Only read
   *  when `limit` is set, because the store rejects `before` without a limit. */
  readonly before?: string
}

/**
 * Fork-owned ext method `subagent_todos` (t-qd2riw): the CHILD's latest
 * todowrite call, found by paging its stored session backward in bounded
 * blocks instead of the whole-transcript read `subagent_transcript` still
 * makes for the same job. `sessionId`/`cwd` mean exactly what they mean there.
 */
export type SubagentTodosRequest = {
  readonly sessionId: string
  readonly cwd?: string
}

/**
 * Fork-owned ext method `subagent_changes` (t-ru0by6, same family as
 * `subagent_todos`): the CHILD's diff-bearing tool parts, found by paging its
 * stored session backward in bounded blocks instead of the whole-transcript
 * read `subagent_transcript` still makes for the changed-files pill.
 * `sessionId`/`cwd` mean exactly what they mean there.
 */
export type SubagentChangesRequest = {
  readonly sessionId: string
  readonly cwd?: string
}

export type SubagentChangesResult = {
  readonly sessionId: string
  /** False when the child's messages could not be read at all. Same meaning
   *  as `SubagentTranscriptResult.found`. */
  readonly found: boolean
  /** Diff-bearing tool parts, newest first, capped at SUBAGENT_CHANGES_CAP. */
  readonly diffs: readonly SubagentChanges.RawFileDiff[]
  /** True when the walk stopped (the cap, or SUBAGENT_CHANGES_MAX_PAGES) before
   *  reaching the head of the child's history — there may be older diffs this
   *  answer does not carry. */
  readonly hasMore: boolean
  /** Opaque `before` cursor for the block preceding the last page read, only
   *  when `hasMore` is true. */
  readonly cursor?: string
}

/** Fork-owned ext method `list_instructions`: what feeds the system prompt. */
export type ListInstructionsRequest = {
  readonly cwd?: string
}

/** Fork-owned ext method `list_tools`: the workspace's base tool list with the
 *  deferred-catalog verdict per tool. Read-only, and `cwd` is optional. */
export type ListToolsRequest = {
  readonly cwd?: string
}

/** Fork-owned ext method `prompt_capture`: what the engine ACTUALLY sent the model on
 *  this session's last turn. Takes no `cwd` - an engine session id already names one
 *  session in this process. Unlike `list_instructions` this DOES send text: sizes alone
 *  cannot answer "what is in those 10k tokens". */
export type PromptCaptureRequest = {
  readonly sessionId: string
}

export type PromptCaptureResult = {
  readonly sessionId: string
  /** Null until this session has sent a turn — an unsent session is not an error. */
  readonly capture: SessionPromptCapture.Capture | null
}

/** Fork-owned ext method `cache_stats`: this session's prompt-cache token accounting
 *  plus a LIFETIME sum across the directory. `cwd` is optional, as for
 *  `list_instructions`. */
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

/** Fork-owned ext method `storage_prune`: compact old tool payloads out of the
 *  session store. Takes no `cwd` - the store is one file for the whole machine,
 *  not a per-directory thing. `dryRun` measures and writes nothing, which is what
 *  the Insights card shows before it offers the confirm. */
export type StoragePruneRequest = {
  readonly olderThanDays: number
  readonly dryRun: boolean
}

/** Fork-owned ext method `storage_compact`: collapse the event journal to one row
 *  per part. `dryRun` measures and writes nothing, like the prune above.
 *  `sessionId` limits the pass to one chat; without it every eligible session is
 *  compacted. */
export type StorageCompactRequest = {
  readonly dryRun: boolean
  readonly sessionId?: string
}

/** Fork-owned ext method `storage_vacuum`: rewrite the store so the pages a
 *  compaction freed go back to the disk. `confirm` is the user having pressed the
 *  second button, not the first: without it this measures and refuses. */
export type StorageVacuumRequest = {
  readonly confirm: boolean
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

/** The two Flock reads that need an INSTANCE: the pending queue is the live
 *  `Permission` service's per-instance state. The other seven take no cwd at all. */
export type FlockCwdRequest = {
  readonly cwd?: string
  /** Test-only override of the global config directory; never sent by a client. */
  readonly directory?: string
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
 *  started. For a "code" method `code` carries what the user pasted; for an "auto"
 *  method this AWAITS the browser/device callback the plugin is listening for. */
export type ProviderAuthCallbackRequest = {
  readonly cwd?: string
  readonly providerID: string
  readonly methodIndex: number
  readonly code?: string
}

/** Fork-owned ext method `provider_auth_usage`: how much of a SUBSCRIPTION
 *  connection's quota is spent. Read-only, and no `cwd` - the credential store is
 *  global. Answers `{ ok: false, unavailable }` when a provider has no usage source. */
export type ProviderAuthUsageRequest = {
  readonly providerID: string
}

/**
 * Fork-owned ext method `second_opinion`: hand ONE chat's last completed turn to a
 * DIFFERENT model - the one the user picked - and answer with its review.
 *
 * `providerID`/`modelID` arrive already split by the extension host;
 * `currentModelLabel` is display text inside the review instruction. Long-running by
 * design, which is safe because the ACP SDK dispatches without awaiting each request.
 */
export type SecondOpinionRequest = {
  readonly cwd?: string
  readonly sessionId: string
  readonly providerID: string
  readonly modelID: string
  readonly currentModelLabel?: string
}

/** Fork-owned ext method `provider_refresh`: re-read provider configuration in a
 *  RUNNING engine, so a credential the shell just wrote takes effect without a window
 *  reload. Nothing else notices that write: the global config file is cached with
 *  `Duration.infinity` and the provider list is untimed `InstanceState`.
 *  Invalidates exactly two memos in the session's own instance -
 *  `Config.invalidateInstance()` and `Provider.invalidate()`. Deliberately NOT the HTTP
 *  `config.refresh` route, which disposes the WHOLE instance: a connect can land while
 *  a turn is streaming, and a memo drop lets that turn keep the client it holds. */
export type ProviderRefreshRequest = {
  readonly cwd?: string
  /** origami_change (t-ttmo5w): the Connections Refresh button. Also forget every
   *  memoised live-discovery answer and every cached catalog on disk, so the rebuild
   *  asks each provider again. The plain refresh (every picker open) keeps both.
   *  t-ty02bb: hard also re-runs Claude (subscription)'s Gate B. */
  readonly hard?: boolean
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
 * Fork-owned ext method `collab_post`: add a HUMAN message. Answers with its sequence
 * number as soon as the message is durable; the turns it fans out to the roster run
 * detached and are observed through `collab_state`.
 *
 * `mentions` must name ACTIVE roster slugs, and `images` must be inside the engine's
 * count and size bounds; either breach fails the call and appends nothing.
 */
export type CollabPostRequest = {
  readonly collabId: string
  readonly text: string
  readonly mentions?: readonly string[]
  readonly images?: readonly string[]
  readonly cwd?: string
}

/** Fork-owned ext method `collab_preview`: who the draft in the composer WOULD wake. A
 *  pure read - nothing posted, no turn scheduled, no token spent - so it is safe to
 *  call while the human is still typing. There is no `text`: the wake rules read a
 *  message's kind and its address list, never its prose. */
export type CollabPreviewRequest = {
  readonly collabId: string
  readonly mentions?: readonly string[]
  readonly cwd?: string
}

/** Fork-owned ext method `collab_state`: the whole Collab picture in one
 *  round-trip. `sinceSeq` narrows the MESSAGES only; the roster, the per-agent
 *  turn status and the suspended verdict always describe the whole stream. */
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

/** Fork-owned ext method `collab_set_concurrency`: how many participant turns
 *  room dispatches at once. 1 is the serial default. Raising it is REFUSED unless every
 *  member is read-only for files - see CollabParallel for why that gate exists. */
export type CollabSetConcurrencyRequest = {
  readonly collabId: string
  readonly concurrency: number
  readonly cwd?: string
}

/** Fork-owned ext method `collab_set_flavor`: `discuss` (the chain) or `council` (one
 *  question to every member at once, blind, then a synthesis). Becoming a council is
 *  REFUSED unless every member is read-only for files, because a council dispatches in
 *  parallel; going back is never refused. */
export type CollabSetFlavorRequest = {
  readonly collabId: string
  readonly flavor: string
  readonly cwd?: string
}

/** Fork-owned ext method `collab_set_lead`: name the agent an unaddressed human
 *  message reaches, or clear the seat with an explicit null. */
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

/** Fork-owned ext method `collab_task_update`: move one task along the board.
 *  Only the contracted transitions are accepted; anything else is refused with
 *  the reason, so a stale button in a shell cannot corrupt the board. */
export type CollabTaskUpdateRequest = {
  readonly collabId: string
  readonly taskId: string
  readonly action: CollabStore.TaskAction
  readonly result?: string
  readonly note?: string
  readonly owner?: string
  readonly cwd?: string
}

/** Fork-owned ext method `collab_review`: the human's verdict on a task an agent
 *  completed - `approve` accepts it, `reject` sends it back to its owner with the
 *  reason. Runs the same two board transitions `collab_task_update` does; only a
 *  COMPLETED task can take a verdict. */
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

/** Fork-owned ext method `collab_stop`: interrupt the turn in flight, drop the
 *  queue behind it and spend the rest of the hop budget. The next human post
 *  buys a new one - this is a pause, not an archive. */
export type CollabStopRequest = {
  readonly collabId: string
  readonly cwd?: string
}

/** Fork-owned ext method `collab_stop_agent`: everything `collab_stop` does to the
 *  whole room, narrowed to one member - its turn in flight interrupted, its child
 *  session cancelled, its slug alone out of the queue, hop budget untouched. */
export type CollabStopAgentRequest = {
  readonly collabId: string
  readonly agentSlug: string
  readonly cwd?: string
}

/** Fork-owned ext method `collab_redirect`: correct ONE agent. A human message
 *  addressed to it alone, with its turn moved to the front of the queue. Buys a fresh
 *  hop budget like any human post, so a suspended room can be steered as well as released. */
export type CollabRedirectRequest = {
  readonly collabId: string
  readonly agentSlug: string
  readonly text: string
  readonly cwd?: string
}

/** Fork-owned ext methods `collab_archive` / `collab_unarchive`: close a stream, and
 *  reopen it. Archived collabs stay listable - archiving is "read-only from here", not
 *  "delete" - and `collab_unarchive` is what keeps that true. */
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

/** Fork-owned ext methods `collab_add_participant` / `collab_remove_participant`:
 *  change the roster of a live stream. Removal is a SOFT delete - the agent's session
 *  and its messages both survive it, and adding the slug back restores the same member. */
export type CollabParticipantRequest = {
  readonly collabId: string
  readonly agentSlug: string
  readonly cwd?: string
}

export class Service extends Context.Service<Service, Interface>()("@origami/ACP/Service") {}

/** Ceiling on ONE directory (provider snapshot) rebuild during a model switch.
 *  Below the shell's own 30 s switch deadline on purpose: the engine gives up
 *  first, so the user is told WHICH provider stalled. */
export const DIRECTORY_REFRESH_TIMEOUT_MS = 20_000

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
  /** t-tc2rlo #8: overrides how the subscription gets its event stream.
   *  Defaults to `ACPEvent.globalBusEventSource` (in-process); a test that
   *  cares about the SDK-transport path itself (subscribe count, and so on)
   *  can pass its own fake `sdk.global.event`-backed source here. */
  events?: Parameters<typeof ACPEvent.start>[0]["events"]
  /** origami_change: reader for the engine's SETTLED command vocabulary (see
   *  `settledCommands`). ABSENT means no late fold, and that is the default on purpose:
   *  the real reader needs the process-wide AppRuntime, which only `ACP.init` has. */
  settledCommands?: (directory: string) => Promise<readonly Command.Info[]>
  /** Ceiling on a model switch's directory rebuild; injectable so a test need not wait 20 s. */
  directoryRefreshTimeoutMs?: number
  /** origami_change (t-ucnjwp): the message count and the descendant rows, read in-process.
   *  ABSENT (the default, as for `settledCommands`) = no total and an empty roster; only
   *  `ACP.init` wires the real reader, which needs the process-wide AppRuntime. */
  history?: ACPHistoryStore.Reader
}): Interface {
  const session = input.session ?? makeSessionService()
  const directoryService = input.directory ?? makeDirectoryService(input.sdk)
  const directoryRefreshTimeoutMs = input.directoryRefreshTimeoutMs ?? DIRECTORY_REFRESH_TIMEOUT_MS
  const registeredMcp = new Map<string, Set<string>>()
  const sessionSnapshots = new Map<string, Directory.Snapshot>()
  const instructionsService = input.instructions ?? makeInstructionsService()
  // Plain module state, not an AppRuntime call: the prompt loop writes this map in
  // THIS process (cli/cmd/acp.ts starts the server in-process).
  const readCapture = input.promptCapture ?? SessionPromptCapture.get
  const skillsService = input.skills ?? makeSkillsService()
  const collabService = input.collab ?? makeCollabService()
  // ONE instance for the whole connection: it caches context limits and owns the
  // mid-turn throttle, which is meaningless without a stable instance.
  const usageService = input.usage ?? UsageService.makeUsageService(input.sdk, readCapture, input.history)
  const events = input.connection
    ? ACPEvent.start({
        sdk: input.sdk,
        connection: input.connection,
        session,
        usage: usageService,
        // t-tc2rlo #8: read GlobalBus in-process instead of looping this
        // engine's own events back through its own HTTP server.
        events: input.events ?? ACPEvent.globalBusEventSource,
        // t-z1xlfy: the live roster for the agent map. Called after a debounce, so
        // `readRoster` (declared below) exists by then. No context reads: the map
        // shows none, and a big fan-out would pay one per row per change.
        roster: (sessionId, cwd) =>
          Effect.runPromise(
            readRoster(cwd, sessionId, false).pipe(
              Effect.flatMap((roster) => (roster ? notify("origami/subagentRoster", roster) : Effect.void)),
            ),
          ),
      })
    : undefined
  if (events) input.eventSubscription?.(events)
  // origami_change (t-kgu05m): the peer broker publishes which sessions are reachable.
  // This store is the only place that knows which are INTERACTIVE - a sub-agent's
  // session is never registered here - so "interactive only" is a property of the
  // source. A reader, not data: the broker's own heartbeat decides when to read it.
  AgentBroker.attachSessions(() => Effect.runSync(session.list()).map((info) => info.id))
  // origami_change (t-w2txb2): a chat whose engine was PARKED may have messages
  // kept in its mailbox. Called once the session is registered on load/resume:
  // each body goes through this engine's own prompt_async route (the same
  // duplicate-peer check a live POST meets) and its file is deleted only after
  // it was admitted. Never fails the load.
  const admitInto =
    (cwd: string, sessionID: string): AgentMailbox.Admit =>
    async (body) => {
      type Params = Parameters<OrigamiClient["session"]["promptAsync"]>[0]
      await input.sdk.session.promptAsync(
        { ...(body as Partial<Params>), sessionID, directory: cwd },
        { throwOnError: true },
      )
    }
  const wakeMailbox = (cwd: string, sessionID: string) =>
    Effect.promise(() => AgentMailbox.restore(sessionID, admitInto(cwd, sessionID)))
  // origami_change (t-wdybz9): `_elastic_unpark` drains the same way, for each
  // session this connection holds (its directory is the one it was opened in).
  AgentMailbox.attachAdmitter((sessionID) => {
    const info = Effect.runSync(session.list()).find((item) => item.id === sessionID)
    return info ? admitInto(info.cwd, sessionID) : undefined
  })
  // origami_change (t-s9jgzh): Nests L4a. Inert until the host calls a nest method
  // with `enabled: true` (see ACPNests.dispatch).
  const nests = ACPNests.make({ sdk: input.sdk, session, request })

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

    // origami_change: the peer broker's display name for THIS engine process, riding
    // agentInfo._meta, the ACP-sanctioned extension point. Undefined for a background
    // engine that never registered, so the key is left off rather than sent empty. This
    // is the name send_message and list_agents address this session by, not the
    // archetype/mode label the UI calls "agentName".
    const peerName = AgentBroker.self()?.name ?? ElasticSpare.pendingName() // t-w2u2ki: a warm spare registers at adoption, under this name
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
  // `session/new` no longer waits for MCP servers to connect, so the snapshot it
  // answers from carries builtin, config-file and skill commands only. Once discovery
  // settles, re-read the vocabulary and, if it grew, push a fresh
  // `available_commands_update` - a REPLACEMENT on the client, so no session restart.
  //
  // One job per directory, shared by every chat in it: the reload behind it is a full
  // directory load, and N chats opening at once must not each pay for one.
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
        // The snapshot is immutable and cached per directory, and `prompt` resolves a
        // typed `/name` from it - so a late command has to land THERE too.
        return Effect.runPromise(directoryService.refresh(cwd))
      })
      .catch(() => {
        // A failed read or reload is not kept (t-tijhw6): the next chat in
        // this folder folds again.
        if (commandFolds.get(cwd) === job) commandFolds.delete(cwd)
        return undefined
      })
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
   * `session/new` has no agent field, and `_meta` is the protocol's own extension
   * point. NOT a second way to say who is speaking: it feeds the `agent` on
   * `session.prompt`, one call earlier than the client could otherwise reach it.
   */
  const requestedAgent = (meta: NewSessionRequest["_meta"]) => {
    const value = meta?.["agent"]
    if (typeof value !== "string") return undefined
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : undefined
  }

  /** An agent id, resolved fail-closed against a directory snapshot, refreshing ONCE on
   *  a miss - the same self-heal `resolveConfiguredModel` does, and for the same reason:
   *  a definition written a moment ago (the Bots pane scaffolds one) is not in the
   *  registry this snapshot was built from. `config.refresh` disposes the directory's
   *  instance, so the next read rebuilds from disk.
   *  Returns the (possibly refreshed) snapshot, because the caller answers with
   *  `configOptions` built from it. A second miss is a real refusal, and it NAMES the
   *  ids the engine offers. */
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
    // Resolved BEFORE `session.create`, so a refusal creates nothing. A chat that
    // opened named after a bot and answered as the engine default is the defect this
    // path exists to close (test/acp/bot-session-agent.test.ts).
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
        // Off the row the engine just created, like the three restore paths below. A
        // brand-new session is `default`, but it is read rather than assumed.
        permissionMode: PermissionPresets.modeFor(created.permission),
      }),
    }
    ACPProfile.duration("acp.newSession", started)
    return response
  })

  /**
   * Push the session's STORED todo list to the client on a restore.
   *
   * The live drawer is fed by the `todowrite` tool frames, which a reopened chat only
   * gets if the transcript is replayed - `resume` does not replay at all, and a fork's
   * replay describes the PARENT's writes. The todo table is the one durable copy.
   * Best-effort: a client without `extNotification` must not stop a chat from opening.
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
        // The client's wire shape. `activeForm` mirrors what the live todowrite path
        // sends, so a restored strip and a live one render the same. `depth` is read
        // STRUCTURALLY, not off the SDK's generated row type, which lags the schema; the
        // value comes off the engine's own encoder and the client clamps what arrives.
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

  // --- origami_change (t-ucnjwp): the bounded restore and the history calls ---
  // wire shapes: reports/lazy_loading_plan_2026-09-24/wire_contract.md

  /** ONE page: `limit + 1` rows asked, the newest `limit` kept, then the byte cap. */
  const readPage = (
    cwd: string | undefined,
    sessionId: string,
    before?: string,
    limit: number = ACPHistory.PAGE_SIZE,
    byteCap: number = ACPHistory.PAGE_BYTE_CAP,
  ) =>
    request(
      () =>
        input.sdk.session.messages(
          { ...(cwd ? { directory: cwd } : {}), sessionID: sessionId, limit: limit + 1, ...(before ? { before } : {}) },
          { throwOnError: true },
        ),
      "session",
    ).pipe(Effect.map((rows) => ACPHistory.cutPage(rows ?? [], limit, byteCap)))

  /**
   * The newest page, plus the model/variant/mode today's full read gave. Older pages
   * are read (model fields only, never replayed) only while no user message with a
   * model has been seen, with a yield between them (plan 3.2 R3; check M5).
   */
  const restoreHistory = Effect.fn("ACP.restoreHistory")(function* (cwd: string, sessionId: string) {
    const page = yield* readPage(cwd, sessionId)
    const scan = ACPHistory.restoreScan()
    let cursor = scan.visit(page.kept) ? null : page.cursor
    while (cursor) {
      yield* Effect.yieldNow
      const older = yield* readPage(cwd, sessionId, cursor, ACPHistory.PAGE_SIZE, Number.POSITIVE_INFINITY)
      cursor = scan.visit(older.kept) ? null : older.cursor
    }
    return { page, ...scan.result() }
  })

  const countMessages = (sessionId: string) => {
    const reader = input.history
    if (!reader) return Effect.succeed(null)
    return Effect.tryPromise(() => reader.countMessages(sessionId)).pipe(
      Effect.map((count): number | null => count),
      Effect.catch(() => Effect.succeed(null)),
    )
  }

  /** `context` of one child (owner answer Q3): ONE read of its newest message, never
   *  its transcript. null when that message has no measured step. */
  const childContext = (cwd: string | undefined, childId: string) =>
    request(
      () =>
        input.sdk.session.messages(
          { ...(cwd ? { directory: cwd } : {}), sessionID: childId, limit: 1 },
          { throwOnError: true },
        ),
      "session",
    ).pipe(
      Effect.map((rows) => {
        const stat = RunStats.stat(childId, rows ?? [])
        return stat.tokens && typeof stat.context === "number" ? stat.context : null
      }),
      Effect.catch(() => Effect.succeed(null)),
    )

  /** Every sub-agent of the chat, from the rows: its descendants and, for a fork, the
   *  source's up to the fork point (t-uhxos2, the store's `roster`). undefined when the
   *  read failed. */
  const readRoster = Effect.fn("ACP.readRoster")(function* (
    cwd: string | undefined,
    sessionId: string,
    withContext = true,
  ) {
    const reader = input.history
    if (!reader) return { sessionId, rows: [], truncated: false } satisfies ACPHistory.SubagentRoster
    const tree = yield* Effect.tryPromise(() =>
      reader.roster ? reader.roster(sessionId) : reader.descendants(sessionId),
    ).pipe(
      Effect.catch(() => Effect.succeed(undefined)),
    )
    if (!tree) return undefined
    const status = yield* request(
      () => input.sdk.session.status({ ...(cwd ? { directory: cwd } : {}) }, { throwOnError: true }),
      "session",
    ).pipe(
      Effect.map((value) => (value ?? {}) as Record<string, { type?: string } | undefined>),
      Effect.catch(() => Effect.succeed({} as Record<string, { type?: string } | undefined>)),
    )
    const contexts = withContext
      ? yield* Effect.forEach(tree.rows, (row) => childContext(cwd, row.id), { concurrency: 8 })
      : []
    return {
      sessionId,
      rows: tree.rows.map(
        (row, index): ACPHistory.RosterRow => ({
          ...row,
          status: status[row.id]?.type && status[row.id]?.type !== "idle" ? "running" : "idle",
          context: contexts[index] ?? null,
        }),
      ),
      truncated: tree.truncated,
    } satisfies ACPHistory.SubagentRoster
  })

  /** A task marker's rider for a child with no roster row: its ROW plus one newest message. */
  const rowRider = (cwd: string | undefined) => async (childId: string) => {
    const child = await input.sdk.session
      .get({ ...(cwd ? { directory: cwd } : {}), sessionID: childId }, { throwOnError: true })
      .then((response) => response.data)
      .catch(() => undefined)
    if (!child) return undefined
    // `steps` is read STRUCTURALLY: lane L2 adds the column, and the SDK type lags it.
    const steps = (child as Record<string, unknown>).steps
    return ACPHistory.riderOf({
      tokens: {
        input: child.tokens?.input ?? 0,
        output: child.tokens?.output ?? 0,
        reasoning: child.tokens?.reasoning ?? 0,
        cacheRead: child.tokens?.cache?.read ?? 0,
        cacheWrite: child.tokens?.cache?.write ?? 0,
      },
      cost: child.cost ?? 0,
      steps: typeof steps === "number" ? steps : null,
      context: await Effect.runPromise(childContext(cwd, childId)),
    })
  }

  const notify = (method: string, params: Record<string, unknown>) => {
    const send = input.connection?.extNotification?.bind(input.connection)
    if (!send) return Effect.void
    return Effect.promise(() => send(method, params).catch(() => {}))
  }

  /**
   * load and fork, after the ACP session exists: the roster (before the first frame,
   * so a child above the page has a row), the newest page, then the window. Reads no
   * child transcript: each marker's rider comes from the roster row.
   */
  const replayRestore = Effect.fn("ACP.replayRestore")(function* (
    cwd: string,
    sessionId: string,
    history: Effect.Success<ReturnType<typeof restoreHistory>>,
  ) {
    const roster = yield* readRoster(cwd, sessionId)
    if (roster) yield* notify("origami/subagentRoster", roster)
    const rows = new Map((roster?.rows ?? []).map((row) => [row.id, row]))
    const fallback = rowRider(cwd)
    const spend = (childId: string) => {
      const row = rows.get(childId)
      return row ? Promise.resolve(ACPHistory.riderOf(row)) : fallback(childId)
    }
    yield* replayMessages(events, history.page.kept, { spend })
    const window = ACPHistory.historyWindow({
      sessionId,
      page: history.page,
      totalMessages: yield* countMessages(sessionId),
      latestUser: history.latestUser,
    })
    yield* notify("origami/historyWindow", window)
    return window
  })

  const historyPage = Effect.fn("ACP.historyPage")(function* (params: ACPHistory.HistoryPageRequest) {
    // Loaded on THIS connection, or `session not found` (-32602): the frames are
    // addressed to a chat the client has open.
    const current = yield* session.get(params.sessionId)
    const cwd = params.cwd ?? current.cwd
    const pageId = params.pageId ?? params.before ?? "head"
    const page = yield* readPage(cwd, params.sessionId, params.before, params.limit ?? ACPHistory.PAGE_SIZE)
    yield* replayMessages(events, page.kept, { page: pageId, spend: rowRider(cwd) })
    return {
      sessionId: params.sessionId,
      pageId,
      cursor: page.cursor,
      hasMore: page.hasMore,
      messageIds: ACPHistory.messageIds(page.kept),
      messages: page.kept.length,
      totalMessages: yield* countMessages(params.sessionId),
      capped: page.capped,
    } satisfies ACPHistory.HistoryPageResult
  })

  const historySearch = Effect.fn("ACP.historySearch")(function* (params: ACPHistory.HistorySearchRequest) {
    const cwd = params.cwd ?? (yield* session.tryGet(params.sessionId))?.cwd
    const limit = params.limit ?? ACPHistory.SEARCH_LIMIT_DEFAULT
    const pattern = ACPHistory.searchPattern(params.query)
    const start = params.cursor ? ACPHistory.decodeSearchCursor(params.cursor) : undefined
    const hits: ACPHistory.SearchHit[] = []
    let before = start?.b
    let fromEnd = start?.n ?? 0
    let scanned = 0
    const answer = (done: boolean, cursor: string | null) =>
      ({ sessionId: params.sessionId, query: params.query, hits, scanned, done, cursor }) satisfies ACPHistory.HistorySearchResult
    while (true) {
      if (scanned > 0) yield* Effect.yieldNow
      const page = yield* readPage(cwd, params.sessionId, before, ACPHistory.PAGE_SIZE, Number.POSITIVE_INFINITY)
      for (let index = page.kept.length - 1; index >= 0; index--) {
        const message = page.kept[index]!
        hits.push(...ACPHistory.searchMessage(message, pattern, fromEnd))
        fromEnd++
        scanned++
        if (hits.length < limit && scanned < ACPHistory.SEARCH_SCAN_BUDGET) continue
        const at = index > 0 || page.hasMore ? ACPHistory.cursorOf(message) : null
        return answer(at === null, at === null ? null : ACPHistory.encodeSearchCursor({ b: at, n: fromEnd }))
      }
      if (!page.hasMore || !page.cursor) return answer(true, null)
      before = page.cursor
    }
  })

  const subagentRoster = Effect.fn("ACP.subagentRoster")(function* (params: ACPHistory.SubagentRosterRequest) {
    const cwd = params.cwd ?? (yield* session.tryGet(params.sessionId))?.cwd
    return (
      (yield* readRoster(cwd, params.sessionId)) ??
      ({ sessionId: params.sessionId, rows: [], truncated: false } satisfies ACPHistory.SubagentRoster)
    )
  })
  // --- end t-ucnjwp ---

  const loadSession = Effect.fn("ACP.loadSession")(function* (params: LoadSessionRequest) {
    const snapshot = yield* directorySnapshot(params.cwd)
    const row = yield* request(
      () => input.sdk.session.get({ directory: params.cwd, sessionID: params.sessionId }, { throwOnError: true }),
      "session",
    )
    // t-ucnjwp: the NEWEST page, not the whole chat; older pages come on demand
    // through `history_page`.
    const history = yield* restoreHistory(params.cwd, params.sessionId)
    const restored = history.restored
    const model = restored.model ?? selectDefaultModel(snapshot)
    const state = yield* session.load({
      id: params.sessionId,
      cwd: params.cwd,
      mcpServers: params.mcpServers,
      model,
      variant: restored.variant ?? selectVariant(snapshot, model),
      modeId: restored.modeId ?? (snapshot.availableModes.length > 0 ? snapshot.defaultModeID : undefined),
      // The auto-approve preset lives on the ROW, so it is the row that says which one
      // this chat was left on. Dropping it made a reopened chat report `default` and
      // then CLEAR its own stored grant with the empty `tools` map its next prompt sends.
      permissionMode: PermissionPresets.modeFor(row.permission),
    })
    sessionSnapshots.set(state.id, snapshot)

    yield* registerMcpServers(input.sdk, registeredMcp, params.cwd, state.id, params.mcpServers)
    yield* pushAvailableCommands(state.id, params.cwd, snapshot) // origami_change
    // The row's stored title, pushed the way the live one is. The only moment a
    // reconnecting client can learn the name of the chat it just reopened:
    // `session.updated` fired in an engine process that no longer exists.
    yield* replayTitle(events, state.id, row.title)
    const window = yield* replayRestore(params.cwd, state.id, history)
    // After the replay: the transcript can carry an older todowrite frame, and
    // the stored list is the one that should have the last word.
    yield* replayTodos(params.cwd, state.id).pipe(Effect.ignore)
    // After the replay too, so a kept message's turn follows the history.
    yield* wakeMailbox(params.cwd, state.id) // origami_change (t-w2txb2)

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
      _meta: { origami_history: window },
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
            // Ask for the ceiling explicitly. `session.list` defaults to `limit ?? 100`
            // down in the DB layer, which cut the list before the cursor below could page
            // it - so `nextCursor` could never be emitted and the paging was decorative.
            limit: SESSION_LIST_MAX,
          },
          { throwOnError: true },
        ),
      "session",
    )
    // Purge turnless "New session - <ISO>" placeholders: a default title, no turn ever
    // ran, not currently open, AND at least a day old. The age floor is load-bearing:
    // each shell chat runs its OWN engine process against the shared store, so a fresh
    // turnless session may be another live instance's just-created chat, and deleting a
    // sibling's newborn session bricks its first prompt. KNOWN HOLE the floor only
    // narrows: a sibling's chat opened >24h ago and never typed in is still reaped.
    // Real cross-instance ownership is the v2 backend's job.
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
    // Never split a group of sessions that share one `updatedAt`. The cursor below is a
    // plain millisecond stamp and the filter above is a STRICT `<`, so a tie straddling
    // the page edge would be unreachable by any cursor - a silent, permanent drop.
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

  // The SAME `sdk.session.delete` the turnless-placeholder reaper calls, exposed for one
  // named session. `throwOnError: true` is the difference that matters: the reaper is
  // best-effort and swallows a failure, whereas a user who pressed Delete has to be told.
  // No existence pre-check - a read-then-delete would report "already gone" for a session
  // another engine process removed a moment earlier while still racing it.
  const sessionDelete = Effect.fn("ACP.sessionDelete")(function* (params: SessionDeleteRequest) {
    yield* nests.guard(params.sessionId, "delete") // origami_change (t-sb9tlk)
    yield* request(
      () =>
        input.sdk.session.delete(
          { sessionID: params.sessionId, ...(params.cwd ? { directory: params.cwd } : {}) },
          { throwOnError: true },
        ),
      "session",
    )
    return { ok: true } as const
  })

  // origami_change-start (session_append_foreign): mirror a transcript that another
  // harness produced into this session's OWN message store.
  //
  // The seam is the turn loop's own: messages are published with
  // `Session.updateMessage` / `Session.updatePart` and the projector turns those into
  // the rows `sdk.session.messages` reads back. Writing SQLite directly would bypass the
  // projector, the event log and every subscriber. `inInstance` is mandatory for the
  // reason `provider_refresh` documents on itself. Idempotency is decided against what
  // the session already holds, so a window reload cannot double a transcript.
  const sessionAppendForeign = Effect.fn("ACP.sessionAppendForeign")(function* (
    params: SessionAppendForeignRequest,
  ) {
    yield* nests.guard(params.sessionId, "append") // origami_change (t-sb9tlk)
    const cwd = params.cwd ?? process.cwd()
    const sessionID = SessionID.make(params.sessionId)
    return yield* request(
      () =>
        AppRuntime.runPromise(
          inInstance(
            cwd,
            Effect.gen(function* () {
              // Refuses an id that names no session: `get` fails NotFound, and a
              // client that mirrored into nothing has to be told.
              const info = yield* Session.Service.use((sessions) => sessions.get(sessionID))
              const existing = yield* Session.Service.use((sessions) => sessions.messages({ sessionID }))
              // The same pair the turn loop stamps on an assistant message, read from
              // the instance `inInstance` just resolved - so a worktree session's root
              // is its worktree, not a second copy of its cwd.
              const ctx = yield* InstanceState.context
              const { rows, skipped } = ForeignTranscript.plan({
                sessionID,
                source: params.source,
                incoming: params.messages,
                stored: ForeignTranscript.storedIds(existing),
                ...optionalLastUser(ForeignTranscript.lastUserID(existing)),
                path: { cwd: ctx.directory, root: ctx.worktree },
                agent: info.agent ?? "build",
                // The FOREIGN harness owns the model, so BOTH halves say so: the
                // session's own `model` is the ENGINE's and would misattribute the turn.
                // The batch does not carry the CLI's resolved model id today.
                providerID: params.source,
                modelID: params.source,
                nextMessageID: () => MessageID.ascending(),
                nextPartID: () => PartID.ascending(),
                now: () => Date.now(),
              })
              yield* Session.Service.use((sessions) =>
                Effect.forEach(rows, (row) =>
                  Effect.gen(function* () {
                    yield* sessions.updateMessage(row.info)
                    for (const part of row.parts) yield* sessions.updatePart(part)
                  }),
                ),
              )
              // Sorts the chat to the top of History, the same as a real turn.
              if (rows.length > 0) yield* Session.Service.use((sessions) => sessions.touch(sessionID))
              return { appended: rows.length, skipped } satisfies SessionAppendForeignResult
            }),
          ),
        ),
      "session",
    )
  })
  // origami_change-end

  // Read-only review of a COMPLETED run. Deliberately does not touch
  // `session.load`/`create`/`resume`: the session is usually not open in this
  // connection, and opening it would replay its events into the live UI.
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

    // Expand subagents breadth-first: each level's task steps name the next level's
    // sessions. Bounded on BOTH axes - depth by MAX_SUBAGENT_DEPTH, total reads by
    // MAX_CHILD_SESSIONS. Anything past the budget is not expanded; its spawning step
    // is still returned.
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

  // ONE plain GET of the child's stored messages, the same read `runSteps` uses and for
  // the same reason: `load`/`resume` would replay a finished run into the live UI.
  // An unreadable child degrades to an empty, FOUND:FALSE answer instead of failing -
  // the caller is a panel that has to draw something. The opposite of `runSteps`, whose
  // caller asked to review one named run and deserves to be told it is gone.
  const subagentTranscript = Effect.fn("ACP.subagentTranscript")(function* (params: SubagentTranscriptRequest) {
    // t-krxap7. A page is ONE extra row over the asked-for size: the reply being
    // longer than `limit` is what proves an older block exists, and it costs one
    // row rather than a second COUNT query. The store's own index covers it
    // (session_id, time_created, id - core/session/sql.ts).
    const limit = typeof params.limit === "number" && params.limit > 0 ? Math.floor(params.limit) : 0
    const messages = yield* request(
      () =>
        input.sdk.session.messages(
          {
            ...(params.cwd ? { directory: params.cwd } : {}),
            sessionID: params.sessionId,
            ...(limit > 0 ? { limit: limit + 1 } : {}),
            ...(limit > 0 && params.before ? { before: params.before } : {}),
          },
          { throwOnError: true },
        ),
      "session",
    ).pipe(Effect.catch(() => Effect.succeed(null)))
    // `null` is the read failing; `undefined`/`[]` is a real session with
    // nothing in it yet, which is a transcript, not an absence.
    if (messages === null) return SubagentTranscript.missing(params.sessionId)
    if (limit <= 0) return SubagentTranscript.project(params.sessionId, messages ?? [], params.cwd)
    const slice = SubagentTranscript.pageSlice(messages ?? [], limit)
    return SubagentTranscript.project(params.sessionId, slice.kept, params.cwd, {
      hasMore: slice.hasMore,
      ...(slice.oldest
        ? { cursor: MessageV2.cursor.encode({ id: slice.oldest.id as MessageID, time: slice.oldest.time }) }
        : {}),
    })
  })

  // t-qd2riw. Same page size the transcript panel pages at (t-krxap7); walking
  // backward in bounded blocks IS the fix — every `session.messages` call asks
  // for at most PAGE+1 rows, never the whole session, however far back the
  // child's last todowrite sits. MAX_PAGES is a runaway guard, not the
  // boundedness mechanism itself: a page that never sets `hasMore:false` (a
  // store bug) must not spin forever.
  const SUBAGENT_TODOS_PAGE = 50
  const SUBAGENT_TODOS_MAX_PAGES = 40
  const subagentTodos = Effect.fn("ACP.subagentTodos")(function* (params: SubagentTodosRequest) {
    let before: string | undefined
    for (let page = 0; page < SUBAGENT_TODOS_MAX_PAGES; page++) {
      const messages = yield* request(
        () =>
          input.sdk.session.messages(
            {
              ...(params.cwd ? { directory: params.cwd } : {}),
              sessionID: params.sessionId,
              limit: SUBAGENT_TODOS_PAGE + 1,
              ...(before ? { before } : {}),
            },
            { throwOnError: true },
          ),
        "session",
      ).pipe(Effect.catch(() => Effect.succeed(null)))
      if (messages === null) return { sessionId: params.sessionId, found: false }
      const slice = SubagentTranscript.pageSlice(messages ?? [], SUBAGENT_TODOS_PAGE)
      const hit = SubagentTodos.latestTodoWrite(slice.kept)
      if (hit) return { sessionId: params.sessionId, found: true, rawInput: hit.rawInput }
      if (!slice.hasMore || !slice.oldest) return { sessionId: params.sessionId, found: true }
      before = MessageV2.cursor.encode({ id: slice.oldest.id as MessageID, time: slice.oldest.time })
    }
    // Walked MAX_PAGES blocks without a hit or reaching the head — report "read
    // fine, nothing found" rather than spinning past the guard.
    return { sessionId: params.sessionId, found: true }
  })

  // t-ru0by6, same family as t-qd2riw above: bounded backward walk, capped on
  // TOTAL diffs collected (not just page count) since a page can hold many.
  // Every `session.messages` call still asks for at most PAGE+1 rows.
  const SUBAGENT_CHANGES_PAGE = 50
  const SUBAGENT_CHANGES_MAX_PAGES = 40
  const SUBAGENT_CHANGES_CAP = 200
  const subagentChanges = Effect.fn("ACP.subagentChanges")(function* (params: SubagentChangesRequest) {
    const diffs: SubagentChanges.RawFileDiff[] = []
    let before: string | undefined
    for (let page = 0; page < SUBAGENT_CHANGES_MAX_PAGES; page++) {
      const messages = yield* request(
        () =>
          input.sdk.session.messages(
            {
              ...(params.cwd ? { directory: params.cwd } : {}),
              sessionID: params.sessionId,
              limit: SUBAGENT_CHANGES_PAGE + 1,
              ...(before ? { before } : {}),
            },
            { throwOnError: true },
          ),
        "session",
      ).pipe(Effect.catch(() => Effect.succeed(null)))
      if (messages === null) return { sessionId: params.sessionId, found: diffs.length > 0, diffs, hasMore: false }
      const slice = SubagentTranscript.pageSlice(messages ?? [], SUBAGENT_CHANGES_PAGE)
      const projected = SubagentTranscript.project(params.sessionId, slice.kept, params.cwd)
      diffs.push(...SubagentChanges.diffBearingParts(projected.entries))
      if (diffs.length >= SUBAGENT_CHANGES_CAP) {
        return { sessionId: params.sessionId, found: true, diffs: diffs.slice(0, SUBAGENT_CHANGES_CAP), hasMore: true, ...(before ? { cursor: before } : {}) }
      }
      if (!slice.hasMore || !slice.oldest) {
        return { sessionId: params.sessionId, found: true, diffs, hasMore: false }
      }
      before = MessageV2.cursor.encode({ id: slice.oldest.id as MessageID, time: slice.oldest.time })
    }
    // Walked MAX_PAGES blocks without reaching the head — report what was
    // collected so far, flagged as incomplete, rather than spinning past the guard.
    return { sessionId: params.sessionId, found: true, diffs, hasMore: true, ...(before ? { cursor: before } : {}) }
  })

  const listInstructions = Effect.fn("ACP.listInstructions")(function* (params: ListInstructionsRequest) {
    return yield* instructionsService.list(params.cwd ?? process.cwd())
  })

  const promptCapture = Effect.fn("ACP.promptCapture")(function* (params: PromptCaptureRequest) {
    return { sessionId: params.sessionId, capture: readCapture(params.sessionId) } satisfies PromptCaptureResult
  })

  // ONE read covers this session's own row and the lifetime sum: every session of its
  // project (and of `cwd`, when given), subagents included. t-ucndru: a store read with
  // no limit - `session.list` stopped at the 100 newest rows. A failed read, or a
  // service made without the store (`input.history`), degrades to an empty answer
  // rather than failing the card.
  const cacheStats = Effect.fn("ACP.cacheStats")(function* (params: CacheStatsRequest) {
    const read = input.history?.projectTokens
    const rows = read
      ? yield* Effect.tryPromise(() => read(params.sessionId, params.cwd)).pipe(
          Effect.catch(() => Effect.succeed([] as readonly UsageService.SessionRow[])),
        )
      : []
    const { current, lifetime, sessionCount } = UsageService.cacheStatsFromRows(rows, params.sessionId)
    return { sessionId: params.sessionId, current, lifetime, sessionCount } satisfies CacheStatsResult
  })

  // Retention. Both run on the process-wide AppRuntime for the reason the plugin
  // trio below documents: the store is reached through `Database.Service`, which
  // only that runtime holds. The measurement is a full scan of a multi-gigabyte
  // table and takes seconds, so the card asks for it rather than polling.
  const storageStats = Effect.fn("ACP.storageStats")(function* () {
    return yield* request(() => AppRuntime.runPromise(StorageRetention.stats()), "storage")
  })

  const storagePrune = Effect.fn("ACP.storagePrune")(function* (params: StoragePruneRequest) {
    return yield* request(
      () => AppRuntime.runPromise(StorageRetention.prune({ olderThanDays: params.olderThanDays, dryRun: params.dryRun })),
      "storage",
    )
  })

  const storageCompact = Effect.fn("ACP.storageCompact")(function* (params: StorageCompactRequest) {
    return yield* request(
      () =>
        AppRuntime.runPromise(
          StorageJournal.compact({
            dryRun: params.dryRun,
            ...(params.sessionId ? { sessionID: params.sessionId } : {}),
          }),
        ),
      "storage",
    )
  })

  const storageVacuum = Effect.fn("ACP.storageVacuum")(function* (params: StorageVacuumRequest) {
    return yield* request(() => AppRuntime.runPromise(StorageJournal.vacuum({ confirm: params.confirm })), "storage")
  })

  const listSkills = Effect.fn("ACP.listSkills")(function* (params: ListSkillsRequest) {
    return yield* skillsService.list(params.cwd ?? process.cwd(), { refresh: params.refresh === true })
  })

  // The list is the engine's OWN `/experimental/tool` answer, so the pane cannot drift
  // from what a turn is offered; only the deferral verdict is computed here
  // (acp/tools.ts). A config read that fails degrades to the shipped defaults.
  //
  // `meta` (source/location per tool) is a THIRD read on the process-wide AppRuntime,
  // same rationale as makeInstructionsService below. An empty map is an HONEST degrade:
  // every row reads `source: "builtin"` and the pane offers no copy-path button.
  const listTools = Effect.fn("ACP.listTools")(function* (params: ListToolsRequest) {
    const cwd = params.cwd ?? process.cwd()
    const snapshot = yield* directoryService.get(cwd)
    const model = selectDefaultModel(snapshot)
    const [list, config, meta, problems, agents] = yield* Effect.all([
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
      // Degrades to "no problems" for the same reason `meta` degrades to an empty map.
      // The message carries a path to the USER'S OWN file plus the loader's reason,
      // deliberately NOT run through the `fromUnknownError` redaction that hid this
      // failure class: a filename is not a secret, and the redacted "Origami service
      // failure" is what made the original incident undiagnosable from the client.
      request(() => AppRuntime.runPromise(inInstance(cwd, ACPTools.problems())), "tool").pipe(
        Effect.catch(() => Effect.succeed([] as ACPTools.ToolProblem[])),
      ),
      // The sub-agent matrix's rows. Degrades to "no rows" like the two reads
      // above: the pane then shows the workspace tools and says the sub-agent
      // section could not be read, rather than drawing a matrix of guesses.
      request(() => AppRuntime.runPromise(inInstance(cwd, ACPTools.agents())), "tool").pipe(
        Effect.catch(() => Effect.succeed([] as ACPSubagentTools.SubagentInfo[])),
      ),
    ])
    return ACPTools.project(list, config, meta, problems, agents)
  })

  // Same rationale as listTools' `meta` read above: this process already boots the
  // engine in-process, so these run on the process-wide AppRuntime.
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

  /** Blocks for as long as the sign-in takes - safe for the reason
   *  `providerAuthCallback` documents (the SDK dispatches without awaiting). The
   *  authorization URL goes out as a NOTIFICATION the moment the flow produces it. */
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

  // Artifacts: the pane over the local artifact store. Every one of these is one
  // short read (or, for restore, one copy-forward) on the store this process already
  // holds, so there is no instance context to thread — `request` is here for the
  // error mapping alone, exactly as it is for the flock file reads below.
  const artifactList = Effect.fn("ACP.artifactList")(function* (params: ACPArtifacts.ListRequest) {
    return yield* request(() => ACPArtifacts.list(params), "artifact")
  })

  const artifactVersions = Effect.fn("ACP.artifactVersions")(function* (params: ACPArtifacts.ArtifactIdRequest) {
    return yield* request(() => ACPArtifacts.versions(params), "artifact")
  })

  const artifactOpen = Effect.fn("ACP.artifactOpen")(function* (params: ACPArtifacts.OpenRequest) {
    return yield* request(() => ACPArtifacts.open(params), "artifact")
  })

  const artifactRestore = Effect.fn("ACP.artifactRestore")(function* (params: ACPArtifacts.RestoreRequest) {
    return yield* request(() => ACPArtifacts.restore(params), "artifact")
  })

  const artifactDiff = Effect.fn("ACP.artifactDiff")(function* (params: ACPArtifacts.DiffRequest) {
    return yield* request(() => ACPArtifacts.diff(params), "artifact")
  })

  const artifactRename = Effect.fn("ACP.artifactRename")(function* (params: ACPArtifacts.RenameRequest) {
    return yield* request(() => ACPArtifacts.rename(params), "artifact")
  })

  const artifactDelete = Effect.fn("ACP.artifactDelete")(function* (params: ACPArtifacts.DeleteRequest) {
    return yield* request(() => ACPArtifacts.remove(params), "artifact")
  })

  // Flock: the cross-person question feature's pane. Seven of these are synchronous
  // file work on the GLOBAL config directory, wrapped in `request` only for the uniform
  // error mapping. The two that touch the live permission queue go through `inInstance`:
  // that queue is per-instance state, and answering into the wrong instance would leave
  // the real one blocked forever.
  const flockState = Effect.fn("ACP.flockState")(function* (params: FlockCwdRequest) {
    return yield* request(async () => ACPFlock.state(params.directory ? { directory: params.directory } : {}), "flock")
  })

  // A FILE READ, not an instance one: the queue is a view over `flock.json` and needs
  // no session context.
  const flockPending = Effect.fn("ACP.flockPending")(function* (params: FlockCwdRequest) {
    return yield* request(async () => ACPFlock.pending(params.directory ? { directory: params.directory } : {}), "flock")
  })

  const flockMailbox = Effect.fn("ACP.flockMailbox")(function* (params: FlockCwdRequest) {
    return yield* request(async () => ACPFlock.mailbox(params.directory ? { directory: params.directory } : {}), "flock")
  })

  // One read that explains a silent Flock - identity, contacts and their route, the
  // lease, this engine's transport, whether a desk model is set, the mailbox counts and
  // the last lifecycle lines. No wire, no writes; safe from anywhere.
  const flockDiagnose = Effect.fn("ACP.flockDiagnose")(function* (params: FlockCwdRequest) {
    return yield* request(async () => ACPFlock.diagnose(params.directory ? { directory: params.directory } : {}), "flock")
  })

  const flockInvite = Effect.fn("ACP.flockInvite")(function* (params: ACPFlock.InviteRequest) {
    return yield* request(async () => ACPFlock.invite(params), "flock")
  })

  const flockAccept = Effect.fn("ACP.flockAccept")(function* (params: ACPFlock.AcceptRequest) {
    return yield* request(async () => ACPFlock.accept(params), "flock")
  })

  const flockSetIdentity = Effect.fn("ACP.flockSetIdentity")(function* (params: ACPFlock.SetIdentityRequest) {
    return yield* request(async () => ACPFlock.setIdentity(params), "flock")
  })

  const flockRevoke = Effect.fn("ACP.flockRevoke")(function* (params: ACPFlock.HandleRequest) {
    return yield* request(async () => ACPFlock.revoke(params), "flock")
  })

  const flockSetPolicy = Effect.fn("ACP.flockSetPolicy")(function* (params: ACPFlock.SetPolicyRequest) {
    return yield* request(async () => ACPFlock.setPolicy(params), "flock")
  })

  const flockFrontDesk = Effect.fn("ACP.flockFrontDesk")(function* (params: ACPFlock.FrontDeskRequest) {
    return yield* request(async () => ACPFlock.frontDesk(params), "flock")
  })

  const flockSetSpecialties = Effect.fn("ACP.flockSetSpecialties")(function* (params: ACPFlock.SpecialtiesRequest) {
    return yield* request(async () => ACPFlock.setSpecialties(params), "flock")
  })

  // The desk turn needs a cwd, the store write does not. `FlockBoot.runner` opens its
  // child session inside the instance the owner is looking at, which is what makes the
  // Front Desk chat one they can watch; everything else here is global `flock.json`.
  const flockDecide = Effect.fn("ACP.flockDecide")(function* (params: ACPFlock.DecideRequest & { cwd?: string }) {
    const cwd = params.cwd ?? process.cwd()
    return yield* request(() => ACPFlock.decide(params, { runner: FlockBoot.runner(cwd), worktree: cwd }), "flock")
  })

  const flockSend = Effect.fn("ACP.flockSend")(function* (params: ACPFlock.SendRequest & { cwd?: string }) {
    const cwd = params.cwd ?? process.cwd()
    return yield* request(() => ACPFlock.send(params, { runner: FlockBoot.runner(cwd), worktree: cwd }), "flock")
  })

  const flockPost = Effect.fn("ACP.flockPost")(function* (params: ACPFlock.PostRequest) {
    return yield* request(() => ACPFlock.post(params), "flock")
  })

  const flockMark = Effect.fn("ACP.flockMark")(function* (params: ACPFlock.MarkRequest) {
    return yield* request(async () => ACPFlock.mark(params), "flock")
  })

  const flockDeliver = Effect.fn("ACP.flockDeliver")(function* (params: ACPFlock.DeliverRequest) {
    return yield* request(() => ACPFlock.deliver(params), "flock")
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

  // Usage is NOT part of the sign-in flow, so it does not go through ProviderAuth -
  // acp/provider-usage.ts reads the stored credential itself and makes one lazy GET.
  // Kept beside the three above because to a caller it is the same surface.
  const providerAuthUsage = Effect.fn("ACP.providerAuthUsage")(function* (params: ProviderAuthUsageRequest) {
    return yield* request(() => AppRuntime.runPromise(ACPProviderUsage.usage(params.providerID)), "provider-auth")
  })

  // Second opinion — one turn, reviewed by the model the user named. The whole
  // job (digest, model resolution, the tool-less one-shot) is acp/second-opinion.ts;
  // this is the cwd default every other method here also applies.
  const secondOpinion = Effect.fn("ACP.secondOpinion")(function* (params: SecondOpinionRequest) {
    const cwd = params.cwd ?? process.cwd()
    return yield* request(
      () =>
        AppRuntime.runPromise(
          ACPSecondOpinion.review({
            directory: cwd,
            sessionId: params.sessionId,
            providerID: params.providerID,
            modelID: params.modelID,
            currentModelLabel: params.currentModelLabel ?? "",
          }),
        ),
      "second-opinion",
    )
  })

  // Make a just-written provider credential live. See ProviderRefreshRequest for what
  // this invalidates and why it is not the HTTP `config.refresh` route.
  //
  // `inInstance` is not optional here: this runs on the bare fiber `acp/agent.ts` starts
  // every request on, and both services reach their state through `InstanceState`, which
  // DIES with "InstanceRef not provided" when the reference is absent. The cwd resolves
  // the SAME instance the session's turns run under, which is what makes this
  // invalidation visible to them.
  const providerRefresh = Effect.fn("ACP.providerRefresh")(function* (params: ProviderRefreshRequest) {
    const cwd = params.cwd ?? process.cwd()
    if (params.hard) {
      resetDiscoveryCache()
      ProviderCatalogCache.clear()
      // t-ty02bb: the Refresh press re-runs Gate B too (after `claude update`, say).
      yield* Effect.promise(() => ClaudeSubscription.recheck())
    }
    yield* request(
      () =>
        AppRuntime.runPromise(
          inInstance(
            cwd,
            Effect.gen(function* () {
              // BOTH halves are load-bearing: Config alone re-reads the files but the
              // provider list is a second InstanceState built from them and survives it;
              // Provider alone rebuilds that list from a `config.get()` still cached.
              yield* Config.Service.use((config) => config.invalidateInstance())
              yield* Provider.Service.use((provider) => provider.invalidate())
            }),
          ),
        ),
      "config",
    )
    return { ok: true } as const
  })

  // t-tjt9wd. Reads the last Gate B answer, so the picker can poll it cheaply:
  // `providerInfo()` (every provider-list build while the flag is on) and the
  // hard `provider_refresh` keep it fresh. t-ty02bb: an engine that has not
  // asked yet (the host engine builds no provider list) runs Gate B on this
  // first read instead of answering "not been checked yet".
  const claudeSubscriptionStatus = Effect.fn("ACP.claudeSubscriptionStatus")(function* () {
    const answer = yield* Effect.promise(() => ClaudeSubscription.ensureChecked())
    return ClaudeSubscription.readinessWireState(answer)
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
    const restored = ACPHistory.restoreFromMessages(messages.map((item) => item.info))
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
    yield* wakeMailbox(params.cwd, state.id) // origami_change (t-w2txb2)

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

  // origami_change (t-w2u5vf): a closed chat's per-session memory in this process
  // (prompt capture, tool aging, cache warm ...) is freed, with its sub-agents'. Only
  // sessions that are not open here and not running: the abort spares detached
  // background sub-agents, and a failed abort leaves the turn running. A status that
  // cannot be read frees nothing (the old behaviour).
  const freeClosedMemory = Effect.fn("ACP.freeClosedMemory")(function* (closed: ACPSession.Info) {
    const reader = input.history
    const tree = reader
      ? yield* Effect.tryPromise(() => reader.descendants(closed.id, null)).pipe(
          Effect.catch(() => Effect.succeed(undefined)),
        )
      : undefined
    const status = yield* request(
      () => input.sdk.session.status({ directory: closed.cwd }, { throwOnError: true }),
      "session",
    ).pipe(
      Effect.map((value) => (value ?? {}) as Record<string, { type?: string } | undefined>),
      Effect.catch(() => Effect.succeed(undefined)),
    )
    if (!status) return
    for (const id of [closed.id, ...(tree?.rows ?? []).map((row) => row.id)]) {
      if (status[id]?.type && status[id]?.type !== "idle") continue
      if (yield* session.tryGet(id)) continue
      EngineProcessMemory.evictSession(id)
    }
  })

  const closeSession = Effect.fn("ACP.closeSession")(function* (params: CloseSessionRequest) {
    const removed = yield* session.remove(params.sessionId)
    registeredMcp.delete(params.sessionId)
    sessionSnapshots.delete(params.sessionId)
    if (!removed) return {}

    yield* abortBackingSession(removed)
    yield* freeClosedMemory(removed)
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
    // The same bounded restore as `loadSession` (t-ucnjwp): the newest page, and
    // `history_page` for the rest. A fork carries the parent's WHOLE transcript in its
    // own rows, and the window's `hasMore` is what tells the client so - the old
    // `limit: 20` without it drew a chat that seemed to start 20 messages ago.
    const history = yield* restoreHistory(params.cwd, forked.id)
    const restored = history.restored
    const model = restored.model ?? selectDefaultModel(snapshot)
    const state = yield* session.load({
      id: forked.id,
      cwd: params.cwd,
      mcpServers: params.mcpServers ?? [],
      model,
      variant: restored.variant ?? selectVariant(snapshot, model),
      modeId: restored.modeId ?? (snapshot.availableModes.length > 0 ? snapshot.defaultModeID : undefined),
      // Read off the FORK's own row, like the other restored fields. `Session.fork` does
      // not copy the parent's ruleset today, so a fork opens on `default`; this is here so
      // the fork follows its row rather than an assumption if that ever changes.
      permissionMode: PermissionPresets.modeFor(forked.permission),
    })
    sessionSnapshots.set(state.id, snapshot)

    yield* registerMcpServers(input.sdk, registeredMcp, params.cwd, state.id, params.mcpServers ?? [])
    yield* pushAvailableCommands(state.id, params.cwd, snapshot) // origami_change
    // The fork ALREADY has a name (`Session.fork` derives one from the parent's) but
    // nothing told the client, so a forked chat opened as an untitled tab. Same call and
    // position as `loadSession`, so a fork's replay matches a reopen frame for frame.
    yield* replayTitle(events, state.id, forked.title)
    const window = yield* replayRestore(params.cwd, state.id, history)
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
      _meta: { origami_history: window },
    }
  })

  /** A configured model id, resolved fail-closed against the SESSION SNAPSHOT frozen at
   *  session start. A model the shell wrote after that is not in the snapshot, so rather
   *  than force a window reload, self-heal: re-read config, refresh the directory
   *  snapshot, re-seed THIS session and retry once. A second miss is a real
   *  InvalidModelError, and only the miss path pays the reload cost.
   *  Returns the (possibly refreshed) snapshot alongside the selection, because every
   *  caller answers with `configOptions` built from it - a stale one reports the old
   *  catalog. */
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
      const providerID = parseModelSelection(value, Object.values(snap.providers)).model.providerID
      yield* Effect.promise(() =>
        input.sdk.config.refresh({ directory: current.cwd }).then(
          () => {},
          () => {},
        ),
      )
      // origami_change (t-wusuep): this rebuild lists EVERY provider, and a catalog
      // provider does it over the network. Unbounded it held the shell's model lock open
      // with no message; the client's own switch deadline is 30 s, so failing here FIRST
      // is what lets the user read WHICH provider stalled.
      snap = yield* directoryService.refresh(current.cwd).pipe(
        Effect.timeoutOrElse({
          duration: `${directoryRefreshTimeoutMs} millis`,
          orElse: () =>
            Effect.fail(
              new ACPError.ServiceFailureError({
                safeMessage: `switching to "${providerID}": the provider directory did not rebuild in ${Math.round(directoryRefreshTimeoutMs / 1000)}s - a model list is still refreshing`,
                service: "directory",
                errorName: "DirectoryRefreshTimeout",
              }),
            ),
        }),
      )
      sessionSnapshots.set(current.id, snap)
    }
    return { snap, selected: yield* parseSelectedModel(snap, value) }
  })

  const setSessionConfigOption = Effect.fn("ACP.setSessionConfigOption")(function* (
    params: SetSessionConfigOptionRequest,
  ) {
    const current = yield* session.get(params.sessionId)
    // origami_change (t-sb9tlk): the options that write the ENGINE's session row
    // are refused on a session another desk writes. The others (model, effort,
    // mode, temperature, topP) only set this connection's state for the next
    // turn, which the prompt guard refuses anyway.
    if (ROW_WRITING_CONFIG.has(params.configId)) yield* nests.guard(params.sessionId, params.configId)
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
      // Per-chat SUB-AGENT model override: every sub-agent this chat spawns runs on this
      // model, ahead of the flock binding and the agent's own pin (tool/task.ts owns that
      // precedence). Same validation as `model`. "" / "default" CLEARS it.
      //
      // The winner has to land on the ENGINE's session row, not just here: the task tool
      // reads the parent session, and only the row survives an engine restart.
      //
      // An optional trailing "@<positive integer>" is a CONTEXT-WINDOW override for the
      // sub-agents' turns, stripped BEFORE model resolution so `parseModelSelection` sees
      // a plain "provider/model". A malformed suffix fails the whole call rather than
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
      // Refreshes ONCE on a miss, exactly as the `model` branch above does. Same root
      // cause: this validated against the snapshot FROZEN at session start, so a
      // definition written since was unreachable from the per-session agent picker.
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
      // Scoped auto-approve preset for THIS chat, riding the same string config channel:
      // "default" (ask normally), "auto" (auto-approve file edits), "bypass" (everything).
      //
      // The winner has to land on the ENGINE's session row: the `tools` map only rides an
      // ordinary USER prompt, so a preset pressed mid-turn, or before an auto-continue,
      // would never reach the ruleset. The tool gate re-reads that ruleset live per ask,
      // so writing it here makes the preset bite on the next ask of the running turn.
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
      // Per-chat VISION PROFILE: the slug of a vision-capable agent this chat may hand an
      // image to when its own model cannot see one. "" / "off" CLEARS it. The slug is NOT
      // resolved against the agent registry here - agent defs are re-scanned per turn, so
      // a profile saved a second before this call would fail a check made against this
      // session's snapshot. The prompt loop resolves it, and says so in the tool result
      // when the slug is gone.
      //
      // The winner has to land on the ENGINE's session row, which is what survives an
      // engine restart.
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
      // Deterministic rollback, riding the same string config channel as `title` (both
      // are actions, not real selects): "revert" restores the working tree to the snapshot
      // taken before the given assistant message's turn and marks that turn, and
      // everything after, for removal; "unrevert" undoes it until the next prompt
      // finalises the deletion.
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
      // Rename the chat. The PATCH publishes session.updated, which the ACP layer echoes
      // back as session_info_update, so no extra display plumbing is needed.
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
      // Per-session sampling override. ACP has no numeric option type, so the value rides
      // as a string: "" / "auto" CLEARS it, anything else is parsed as a float and clamped.
      // Applied live per request via the llm.run merge (per-session > global > agent).
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
      // Per-chat auto-compaction TRIGGER override, riding the session row's metadata like
      // `subagentModel` (a real column would need a migration for a value only the
      // overflow check reads). "" / "auto" CLEARS it. A trailing "%" picks a fraction of
      // the model's context window, re-resolved at check time since a model switch
      // changes what it means; a bare number is an absolute token count.
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
    // The new model's cache holds nothing of this chat yet, whatever the old
    // one had (t-rylyhm). This is the ONE entry a chat changes model through.
    SessionCacheState.modelChanged(params.sessionId)
    return {}
  })

  // origami_change: targeted background-shell stop, separate from turn cancel.
  const shellStop = Effect.fn("ACP.shellStop")(function* (params: ShellStopRequest) {
    // origami_change (t-sb9tlk): stopping a job writes its tool part.
    yield* nests.guard(params.sessionId, "shell stop")
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

  /**
   * origami_change (t-q910fo): the USER's stop for ONE sub-agent, addressed by
   * the CHILD's session id. The rule — only that child and its descendants, the
   * parent turn untouched — lives in `subagent-stop.ts` so a test can drive it
   * against a real registry; this half is only the instance it runs in.
   */
  const subagentStop = Effect.fn("ACP.subagentStop")(function* (params: SubagentStopRequest) {
    const cwd = params.cwd ?? process.cwd()
    return yield* request(
      () =>
        AppRuntime.runPromise(
          inInstance(cwd, BackgroundJob.Service.use((jobs) => SubagentStop.stopSubagentJob(jobs, params.sessionId))),
        ),
      "background job",
    )
  })

  // origami_change-start (interject): deliver a queued message into the turn
  // that is already running, instead of making the user cancel it to be heard.
  const interject = Effect.fn("ACP.interject")(function* (params: InterjectRequest) {
    yield* nests.guard(params.sessionId, "interject") // origami_change (t-sb9tlk)
    const current = yield* session.get(params.sessionId)
    const text = params.text.trim()
    // The client's pictures, through the prompt path's own converter: an `image`
    // block becomes the `data:` file part `SessionPrompt` writes.
    const files = promptContentToParts(
      (params.images ?? []).map((image) => ({ type: "image" as const, data: image.data, mimeType: image.mimeType })),
    ).filter((part): part is Extract<PromptPart, { type: "file" }> => part.type === "file")
    // A picture with no words is a message; nothing at all is not.
    if (!text && files.length === 0) {
      return yield* new ACPError.ServiceFailureError({
        service: "session",
        safeMessage: "An interjection needs some text or an attachment to deliver",
        errorName: "InterjectEmpty",
      })
    }
    const result = yield* request(
      () =>
        AppRuntime.runPromise(
          inInstance(
            current.cwd,
            SessionPrompt.Service.use((prompts) =>
              prompts.interject({ sessionID: SessionID.make(current.id), text, ...(files.length ? { files } : {}) }),
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
    sessionDelete,
    sessionAppendForeign, // origami_change
    runSteps,
    runStats,
    subagentTranscript,
    subagentTodos, // origami_change (t-qd2riw)
    subagentChanges, // origami_change (t-ru0by6)
    historyPage, // origami_change (t-ucnjwp)
    historySearch, // origami_change (t-ucnjwp)
    subagentRoster, // origami_change (t-ucnjwp)
    listInstructions,
    promptCapture,
    cacheStats,
    storageStats,
    storagePrune,
    storageCompact,
    storageVacuum,
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
    flockState,
    flockPending,
    flockInvite,
    flockAccept,
    flockRevoke,
    flockSetIdentity,
    flockSetPolicy,
    flockFrontDesk,
    flockSetSpecialties,
    flockMailbox,
    flockDiagnose,
    flockDecide,
    flockSend,
    flockPost,
    flockMark,
    flockDeliver,
    artifactList,
    artifactVersions,
    artifactOpen,
    artifactRestore,
    artifactDiff,
    artifactRename,
    artifactDelete,
    providerAuthList,
    providerAuthAuthorize,
    providerAuthCallback,
    providerAuthUsage,
    providerRefresh,
    claudeSubscriptionStatus,
    secondOpinion,
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
    ...nests.methods, // origami_change (t-s9jgzh)
    shellStop,
    subagentStop, // origami_change (t-q910fo)
    interject, // origami_change
    setSessionConfigOption,
    setSessionMode,
    setSessionModel,
    prompt: Effect.fn("ACP.prompt")(function* (params: PromptRequest) {
      const current = yield* session.get(params.sessionId)
      // origami_change (t-s9jgzh, t-sb9tlk): a session another desk writes is
      // read only here. This one guard covers a plain prompt, a slash command
      // (`session.command`), `/compact` (`session.summarize`), and every tool a
      // turn runs (todowrite, bash): none of them has its own ACP entry.
      yield* nests.guard(params.sessionId, "prompt")
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
                // Scoped auto-approve preset -> a session permission ruleset. "auto"
                // allows file edits, "bypass" everything, "default"/undefined an EMPTY map.
                // ALWAYS sent: the engine treats a present `tools` map as an authoritative
                // replace, so an empty map CLEARS a persisted auto/bypass ruleset back to ask.
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
        return yield* promptResponse(response.info, params.messageId, response.parts)
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
        return yield* promptResponse(response.info, params.messageId, response.parts)
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

/** origami_change (t-sb9tlk): the `setSessionConfigOption` ids whose branch
 *  writes the engine's session row (`session.update`, `revert`, `unrevert`). */
const ROW_WRITING_CONFIG: ReadonlySet<string> = new Set([
  "title",
  "revert",
  "unrevert",
  "subagentModel",
  "permission",
  "visionProfile",
  "compactionThreshold",
])

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

// Same AppRuntime rationale as makeInstructionsService.
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

/** A placeholder ("New session - <ISO>") is not a name - the client has its own
 *  fallback for that and would only have to filter this back out. */
function replayTitle(subscription: ACPEvent.Subscription | undefined, sessionId: string, title: string | undefined) {
  if (!subscription || !title || isDefaultTitle(title)) return Effect.void
  return Effect.promise(() => subscription.replayTitle(sessionId, title).catch(() => {}))
}

function replayMessages(
  subscription: ACPEvent.Subscription | undefined,
  messages: readonly SessionMessageResponse[],
  options?: ACPEvent.ReplayOptions,
) {
  if (!subscription) return Effect.void
  return Effect.promise(async () => {
    for (const message of messages) {
      await subscription.replayMessage(message, options).catch(() => {})
    }
  })
}

type ConfigState = {
  readonly model: Directory.DefaultModel
  readonly variant?: string
  readonly modeId?: string
  /** The chat's live auto-approve preset. Absent = `default`. Every session entry point
   *  derives this from the ENGINE ROW (the only durable copy), not from the ACP session's
   *  in-memory string, which is empty on a fresh connection. */
  readonly permissionMode?: string
}

type SdkResponse<T> = {
  readonly data?: T
  readonly error?: unknown
}

type AssistantError = NonNullable<AssistantMessage["error"]>
type AssistantInfo = (UsageService.AssistantTokenCost & Pick<AssistantMessage, "error">) | undefined

/** origami_change: `exactOptionalPropertyTypes` refuses an explicit
 *  `lastUserID: undefined`, so the key is omitted rather than set to it. */
function optionalLastUser(id: string | undefined) {
  return id ? { lastUserID: id } : {}
}

/** origami_change: run engine work on the process-wide AppRuntime WITH the instance it
 *  belongs to. `acp/agent.ts` starts every request on a bare fiber, so nothing on it
 *  carries `InstanceRef`, and every service with per-project state `Effect.die`s with
 *  "InstanceRef not provided" without one. Passing the session's cwd resolves the SAME
 *  instance the turn runs under, which is what makes a write from this side visible to
 *  that turn. Same shape as `ACPProviderAuth.withInstance` and `CollabACP.inInstance`. */
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
    // Hidden NON-native definitions ride this list - every bot the Bots pane saves is
    // one. The picker filters them back out; `resolveRequestedAgent` does not, because
    // they are exactly the identities "Start session" on a bot asks for.
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

  // First-session ACP startup must not scan historical sessions just to infer a default.
  // Configured model, then the OpenCode Zen provider, then the sorted best model keeps
  // the response deterministic. The id is `opencode`, as the shipped catalog serves it.
  const zenProvider = providers[ProviderV2.ID.make("opencode")]
  const zenModel = zenProvider ? Provider.sort(Object.values(zenProvider.models))[0] : undefined
  if (zenProvider && zenModel) return { providerID: zenProvider.id, modelID: zenModel.id }

  const best = Provider.sort(Object.values(providers).flatMap((provider) => Object.values(provider.models)))[0]
  if (best) return { providerID: best.providerID, modelID: best.id }
  // NOTHING resolves. A configured model no provider serves is not a fallback, it is a
  // name for a connection that is gone, and returning it put an unreachable model in the
  // picker. Undefined is the honest answer; the caller renders the empty state.
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

// `parts` is the turn's own parts when the caller has them: the usage is then
// summed over its step-finish parts instead of read off the message, which
// carries only the LAST step's context (see UsageService.sumStepFinishTokens).
const promptResponse = Effect.fn("ACP.promptResponse")(function* (
  info: AssistantInfo,
  messageId: string | null | undefined,
  parts?: readonly Part[],
) {
  if (!info?.error) {
    return {
      stopReason: "end_turn" as const,
      ...(info ? { usage: UsageService.buildUsage(info, parts) } : {}),
      ...(messageId ? { userMessageId: messageId } : {}),
      _meta: {},
    }
  }

  const base = {
    usage: UsageService.buildUsage(info, parts),
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
 * `availableModes` is "what may back a session", which includes every hidden definition
 * the Bots pane saved. The two differ in one place only: a chat running AS a hidden
 * definition keeps its own agent on the list, or the control would render as nothing
 * chosen over a chat that is answering as the bot.
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
 * origami_change: the engine's COMPLETE command vocabulary for a directory - builtin,
 * config-file and skill commands PLUS the MCP prompts, waiting for background discovery
 * if it is still in flight.
 *
 * Runs against the process-wide AppRuntime, which shares its instances with the
 * in-process HTTP server, so this waits on the SAME discovery the `command.list` route
 * reads rather than connecting every MCP server twice. Same rule `Skills.list` follows.
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

function isSdkResponse<T>(value: T | SdkResponse<T>): value is SdkResponse<T> {
  return typeof value === "object" && value !== null && ("data" in value || "error" in value)
}

function fromUnknownError(error: unknown, service?: string): Error {
  if (isACPError(error)) return error
  if (isAuthRequired(error)) {
    return new ACPError.AuthRequiredError({ providerId: findProviderID(error) })
  }
  const owner = foreignOwner(error)
  if (owner !== undefined) {
    // origami_change (t-tjhmhw): the engine refused a write in its write
    // transaction because another desk took the chat after the guard passed.
    return new ACPError.RefusalError({
      safeMessage: `This chat is read only on this desk: desk ${owner} writes it (write refused).`,
      service: "nests",
    })
  }
  return new ACPError.ServiceFailureError({ safeMessage: "Origami service failure", service })
}

/** origami_change: `fromUnknownError`'s generic branch discards the raw cause behind
 *  `ServiceFailureError`'s redacted `safeMessage`, so the real cause is logged here
 *  first - see the comment on `inInstance` for the incident that caused.
 *  The log call lives in `request()`'s catch path rather than inside `fromUnknownError`,
 *  which is a plain synchronous mapper with no Effect context and has only this caller.
 *  Auth-required and already-ACP errors keep their existing branches, unlogged, because
 *  nothing is discarded for them. */
function mapRequestError(error: unknown, service?: string) {
  return Effect.gen(function* () {
    if (!isACPError(error) && !isAuthRequired(error) && foreignOwner(error) === undefined) {
      yield* Effect.logError("acp request failed with an unrecognized error", {
        service,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      })
    }
    return yield* Effect.fail(fromUnknownError(error, service))
  })
}

/** origami_change (t-tjhmhw): the desk named by the engine's `EventV2.ForeignOwner`
 *  response (server middleware/error.ts), or `undefined` for any other error. The
 *  SDK wraps the response body in an `Error` and keeps it at `cause.body`. */
function foreignOwner(value: unknown): string | undefined {
  const body = value instanceof Error ? (value.cause as { body?: unknown } | undefined)?.body : undefined
  if (typeof body !== "object" || body === null) return undefined
  if (!("name" in body) || body.name !== "EventV2.ForeignOwner" || !("data" in body)) return undefined
  const data = body.data
  if (typeof data !== "object" || data === null || !("owner" in data)) return undefined
  return typeof data.owner === "string" ? data.owner : undefined
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
