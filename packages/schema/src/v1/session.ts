export * as SessionV1 from "./session"

import { Effect, Schema, Types } from "effect"
import { define, inventory } from "../event"
import { FileDiff } from "../file-diff"
import { Project } from "../project"
import { Provider } from "../provider"
import { Model } from "../model"
import { NonNegativeInt, optional, statics } from "../schema"
import { ascending } from "../identifier"
import { SessionID } from "../session-id"
import { WorkspaceID } from "../workspace-id"
import { PermissionV1 } from "./permission"

const Timestamp = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))

export const MessageID = Schema.String.check(Schema.isStartsWith("msg")).pipe(
  Schema.brand("MessageID"),
  statics((schema) => ({ ascending: (id?: string) => schema.make(id ?? "msg_" + ascending()) })),
)
export type MessageID = typeof MessageID.Type

export const PartID = Schema.String.check(Schema.isStartsWith("prt")).pipe(
  Schema.brand("PartID"),
  statics((schema) => ({ ascending: (id?: string) => schema.make(id ?? "prt_" + ascending()) })),
)
export type PartID = typeof PartID.Type

const namedError = <Name extends string, Fields extends Schema.Struct.Fields>(name: Name, fields: Fields) => {
  const schema = Schema.Struct({ name: Schema.Literal(name), data: Schema.Struct(fields) }).annotate({
    identifier: name,
  })
  return { Schema: schema, EffectSchema: schema }
}

export const OutputLengthError = namedError("MessageOutputLengthError", {})

export const AuthError = namedError("ProviderAuthError", {
  providerID: Schema.String,
  message: Schema.String,
})

export const AbortedError = namedError("MessageAbortedError", { message: Schema.String })
export const StructuredOutputError = namedError("StructuredOutputError", {
  message: Schema.String,
  retries: NonNegativeInt,
})
export const APIError = namedError("APIError", {
  message: Schema.String,
  statusCode: Schema.optional(NonNegativeInt),
  isRetryable: Schema.Boolean,
  responseHeaders: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  responseBody: Schema.optional(Schema.String),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.String)),
})
export type APIError = Schema.Schema.Type<typeof APIError.Schema>
export const ContextOverflowError = namedError("ContextOverflowError", {
  message: Schema.String,
  responseBody: Schema.optional(Schema.String),
})
export const ContentFilterError = namedError("ContentFilterError", {
  message: Schema.String,
})

export class OutputFormatText extends Schema.Class<OutputFormatText>("OutputFormatText")({
  type: Schema.Literal("text"),
}) {}

export class OutputFormatJsonSchema extends Schema.Class<OutputFormatJsonSchema>("OutputFormatJsonSchema")({
  type: Schema.Literal("json_schema"),
  schema: Schema.Record(Schema.String, Schema.Any).annotate({ identifier: "JSONSchema" }),
  retryCount: NonNegativeInt.pipe(Schema.optional, Schema.withDecodingDefault(Effect.succeed(2))),
}) {}

export const Format = Schema.Union([OutputFormatText, OutputFormatJsonSchema]).annotate({
  discriminator: "type",
  identifier: "OutputFormat",
})
export type OutputFormat = Schema.Schema.Type<typeof Format>

const partBase = {
  id: PartID,
  sessionID: SessionID,
  messageID: MessageID,
}

export const SnapshotPart = Schema.Struct({
  ...partBase,
  type: Schema.Literal("snapshot"),
  snapshot: Schema.String,
}).annotate({ identifier: "SnapshotPart" })
export type SnapshotPart = Types.DeepMutable<Schema.Schema.Type<typeof SnapshotPart>>

export const PatchPart = Schema.Struct({
  ...partBase,
  type: Schema.Literal("patch"),
  hash: Schema.String,
  files: Schema.Array(Schema.String),
}).annotate({ identifier: "PatchPart" })
export type PatchPart = Types.DeepMutable<Schema.Schema.Type<typeof PatchPart>>

export const TextPart = Schema.Struct({
  ...partBase,
  type: Schema.Literal("text"),
  text: Schema.String,
  synthetic: Schema.optional(Schema.Boolean),
  ignored: Schema.optional(Schema.Boolean),
  time: Schema.optional(
    Schema.Struct({
      start: NonNegativeInt,
      end: Schema.optional(NonNegativeInt),
    }),
  ),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Any)),
}).annotate({ identifier: "TextPart" })
export type TextPart = Types.DeepMutable<Schema.Schema.Type<typeof TextPart>>

export const ReasoningPart = Schema.Struct({
  ...partBase,
  type: Schema.Literal("reasoning"),
  text: Schema.String,
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Any)),
  time: Schema.Struct({
    start: NonNegativeInt,
    end: Schema.optional(NonNegativeInt),
  }),
}).annotate({ identifier: "ReasoningPart" })
export type ReasoningPart = Types.DeepMutable<Schema.Schema.Type<typeof ReasoningPart>>

const filePartSourceBase = {
  text: Schema.Struct({
    value: Schema.String,
    start: Schema.Finite,
    end: Schema.Finite,
  }).annotate({ identifier: "FilePartSourceText" }),
}

export const Range = Schema.Struct({
  start: Schema.Struct({ line: NonNegativeInt, character: NonNegativeInt }),
  end: Schema.Struct({ line: NonNegativeInt, character: NonNegativeInt }),
}).annotate({ identifier: "Range" })
export type Range = typeof Range.Type

export const FileSource = Schema.Struct({
  ...filePartSourceBase,
  type: Schema.Literal("file"),
  path: Schema.String,
}).annotate({ identifier: "FileSource" })

export const SymbolSource = Schema.Struct({
  ...filePartSourceBase,
  type: Schema.Literal("symbol"),
  path: Schema.String,
  range: Range,
  name: Schema.String,
  kind: NonNegativeInt,
}).annotate({ identifier: "SymbolSource" })

export const ResourceSource = Schema.Struct({
  ...filePartSourceBase,
  type: Schema.Literal("resource"),
  clientName: Schema.String,
  uri: Schema.String,
}).annotate({ identifier: "ResourceSource" })

export const FilePartSource = Schema.Union([FileSource, SymbolSource, ResourceSource]).annotate({
  discriminator: "type",
  identifier: "FilePartSource",
})

export const FilePart = Schema.Struct({
  ...partBase,
  type: Schema.Literal("file"),
  mime: Schema.String,
  filename: Schema.optional(Schema.String),
  url: Schema.String,
  source: Schema.optional(FilePartSource),
}).annotate({ identifier: "FilePart" })
export type FilePart = Types.DeepMutable<Schema.Schema.Type<typeof FilePart>>

export const AgentPart = Schema.Struct({
  ...partBase,
  type: Schema.Literal("agent"),
  name: Schema.String,
  source: Schema.optional(
    Schema.Struct({
      value: Schema.String,
      start: NonNegativeInt,
      end: NonNegativeInt,
    }),
  ),
}).annotate({ identifier: "AgentPart" })
export type AgentPart = Types.DeepMutable<Schema.Schema.Type<typeof AgentPart>>

export const CompactionPart = Schema.Struct({
  ...partBase,
  type: Schema.Literal("compaction"),
  auto: Schema.Boolean,
  overflow: Schema.optional(Schema.Boolean),
  tail_start_id: Schema.optional(MessageID),
}).annotate({ identifier: "CompactionPart" })
export type CompactionPart = Types.DeepMutable<Schema.Schema.Type<typeof CompactionPart>>

export const SubtaskPart = Schema.Struct({
  ...partBase,
  type: Schema.Literal("subtask"),
  prompt: Schema.String,
  description: Schema.String,
  agent: Schema.String,
  model: Schema.optional(
    Schema.Struct({
      providerID: Provider.ID,
      modelID: Model.ID,
    }),
  ),
  command: Schema.optional(Schema.String),
}).annotate({ identifier: "SubtaskPart" })
export type SubtaskPart = Types.DeepMutable<Schema.Schema.Type<typeof SubtaskPart>>

export const RetryPart = Schema.Struct({
  ...partBase,
  type: Schema.Literal("retry"),
  attempt: NonNegativeInt,
  error: APIError.EffectSchema,
  time: Schema.Struct({
    created: NonNegativeInt,
  }),
}).annotate({ identifier: "RetryPart" })
export type RetryPart = Omit<Types.DeepMutable<Schema.Schema.Type<typeof RetryPart>>, "error"> & {
  error: APIError
}

export const StepStartPart = Schema.Struct({
  ...partBase,
  type: Schema.Literal("step-start"),
  snapshot: Schema.optional(Schema.String),
}).annotate({ identifier: "StepStartPart" })
export type StepStartPart = Types.DeepMutable<Schema.Schema.Type<typeof StepStartPart>>

export const StepFinishPart = Schema.Struct({
  ...partBase,
  type: Schema.Literal("step-finish"),
  reason: Schema.String,
  snapshot: Schema.optional(Schema.String),
  cost: Schema.Finite,
  tokens: Schema.Struct({
    total: Schema.optional(Schema.Finite),
    input: Schema.Finite,
    output: Schema.Finite,
    reasoning: Schema.Finite,
    cache: Schema.Struct({
      read: Schema.Finite,
      write: Schema.Finite,
    }),
  }),
  /**
   * Digests of the two halves of the CACHED PREFIX this step was sent, each
   * the first 16 hex characters of a SHA-256. A prefix cache is an exact match
   * from byte 0, so two consecutive steps whose digests differ could not have
   * shared a cache entry - which turns "the cache dropped and nobody knows
   * why" into a fact with a named cause.
   *
   * ABSENT rather than zeroed when the request staged no prompt capture
   * (compaction, title generation), because an unmeasured prefix is a
   * different fact from an unchanged one.
   */
  prefix: Schema.optional(
    Schema.Struct({
      system: Schema.String,
      tools: Schema.String,
      /**
       * SHA-256 over the per-message digest list of the outbound array, first
       * 16 hex characters. The system and tool halves can both hold still while
       * an already-sent message comes back rewritten, which is a cache miss no
       * other digest here can see. ABSENT when the request layer handed the
       * capture no message array.
       */
      history: Schema.optional(Schema.String),
    }),
  ),
  /**
   * Why this step read nothing from the provider's prefix cache, and the facts
   * the answer was derived from. The engine derives it where it prepares the
   * request, because that is the only place that knows whether the array it is
   * about to send is byte-identical to the last one - a reader cannot recover
   * that from the stored rows.
   *
   * ABSENT entirely on a cache-BLIND provider (one whose usage reports no cache
   * tokens at all) and on a request that staged no prompt capture, because an
   * unmeasured cache is a different fact from a measured miss. Every member is
   * omitted when it was not measured; none is ever zeroed to stand in.
   */
  cache: Schema.optional(
    Schema.Struct({
      /** Present only on a MISS, and then exactly one: the precedence is fixed
       *  at cold > compaction > model > stopped > system > tools > history >
       *  idle > small > provider. `provider` is the residue - the prefix was
       *  byte-identical, inside the window, on the same model, and the provider
       *  missed anyway. `stopped` is the first request after an engine restart
       *  whose prefix changed against the last one persisted (see `stopped`). */
      cause: Schema.optional(
        Schema.Literals([
          "cold",
          "model",
          "compaction",
          "stopped",
          "idle",
          "system",
          "tools",
          "history",
          "provider",
          "small",
        ]),
      ),
      /** Whether the previous request's whole array survived as a byte-identical
       *  prefix of this one. Absent on a session's first measured request. */
      preserved: Schema.optional(Schema.Boolean),
      /** Where the outbound array first differed from the previous request's. */
      divergence: Schema.optional(
        Schema.Struct({
          message: Schema.Finite,
          role: Schema.String,
          offset: Schema.Finite,
          source: Schema.optional(Schema.Literals(["tool-aging", "reminder", "plugin", "unknown"])),
        }),
      ),
      /** Milliseconds since the previous request of this session. */
      idleMs: Schema.optional(Schema.Finite),
      /** The window the engine believes for this provider, and the one `idle`
       *  was judged against. ABSENT where the provider publishes none, and no
       *  `idle` is then claimed. */
      ttlSeconds: Schema.optional(Schema.Finite),
      /** A cache warm succeeded inside the gap before this request. */
      warmed: Schema.optional(Schema.Boolean),
      /** Only on the first request after an engine restart: the halves of the
       *  prefix that changed against the last request persisted before it.
       *  ABSENT when nothing changed or the previous request was in the same
       *  process. */
      stopped: Schema.optional(Schema.Array(Schema.Literals(["system", "tools", "history"]))),
    }),
  ),
  /**
   * Milliseconds from the moment the request started draining to the step's
   * first content-bearing event. The cache-blind providers (LM Studio, sglang)
   * report no cache tokens at all, and TTFT is the only signal left: a prefix
   * hit is flat, a miss scales with the prompt.
   *
   * ABSENT when the step produced no content event, never zero.
   */
  ttftMs: Schema.optional(Schema.Finite),
}).annotate({ identifier: "StepFinishPart" })
export type StepFinishPart = Types.DeepMutable<Schema.Schema.Type<typeof StepFinishPart>>

export const ToolStatePending = Schema.Struct({
  status: Schema.Literal("pending"),
  input: Schema.Record(Schema.String, Schema.Any),
  raw: Schema.String,
}).annotate({ identifier: "ToolStatePending" })
export type ToolStatePending = Types.DeepMutable<Schema.Schema.Type<typeof ToolStatePending>>

export const ToolStateRunning = Schema.Struct({
  status: Schema.Literal("running"),
  input: Schema.Record(Schema.String, Schema.Any),
  title: Schema.optional(Schema.String),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Any)),
  time: Schema.Struct({
    start: NonNegativeInt,
  }),
}).annotate({ identifier: "ToolStateRunning" })
export type ToolStateRunning = Types.DeepMutable<Schema.Schema.Type<typeof ToolStateRunning>>

export const ToolStateCompleted = Schema.Struct({
  status: Schema.Literal("completed"),
  input: Schema.Record(Schema.String, Schema.Any),
  output: Schema.String,
  title: Schema.String,
  metadata: Schema.Record(Schema.String, Schema.Any),
  time: Schema.Struct({
    start: NonNegativeInt,
    end: NonNegativeInt,
    compacted: Schema.optional(NonNegativeInt),
  }),
  attachments: Schema.optional(Schema.Array(FilePart)),
}).annotate({ identifier: "ToolStateCompleted" })
export type ToolStateCompleted = Types.DeepMutable<Schema.Schema.Type<typeof ToolStateCompleted>>

export const ToolStateError = Schema.Struct({
  status: Schema.Literal("error"),
  input: Schema.Record(Schema.String, Schema.Any),
  error: Schema.String,
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Any)),
  time: Schema.Struct({
    start: NonNegativeInt,
    end: NonNegativeInt,
  }),
}).annotate({ identifier: "ToolStateError" })
export type ToolStateError = Types.DeepMutable<Schema.Schema.Type<typeof ToolStateError>>

export const ToolState = Schema.Union([
  ToolStatePending,
  ToolStateRunning,
  ToolStateCompleted,
  ToolStateError,
]).annotate({
  discriminator: "status",
  identifier: "ToolState",
})
export type ToolState = ToolStatePending | ToolStateRunning | ToolStateCompleted | ToolStateError

export const ToolPart = Schema.Struct({
  ...partBase,
  type: Schema.Literal("tool"),
  callID: Schema.String,
  tool: Schema.String,
  state: ToolState,
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Any)),
}).annotate({ identifier: "ToolPart" })
export type ToolPart = Omit<Types.DeepMutable<Schema.Schema.Type<typeof ToolPart>>, "state"> & {
  state: ToolState
}

const messageBase = {
  id: MessageID,
  sessionID: partBase.sessionID,
}

/**
 * origami_change: a message MIRRORED from another harness rather than produced
 * by a turn of this engine — today only a Claude Code passthrough turn, copied
 * in so History, the Labyrinth and the usage tables (all of which read engine
 * truth) stop showing an empty chat.
 *
 * DECLARED rather than carried as an excess property. The HTTP API encodes its
 * answers THROUGH this schema, and an effect Struct drops every key it does not
 * declare — so an undeclared stamp survives the SQLite round trip and then
 * vanishes on the way to `sdk.session.messages`, which is exactly where the
 * pricing guard reads it.
 *
 * Absent on every engine-written message; readers must treat "no source" as
 * "this engine ran it".
 */
const foreignSource = {
  /** WHICH harness produced it, e.g. `claude-code`. */
  source: Schema.optional(Schema.String),
  /** That harness's OWN id for the message. The only thing it is ever compared
   *  against, and the whole idempotency guard: a re-sync of the same transcript
   *  must not double it. */
  sourceMessageID: Schema.optional(Schema.String),
}

export const User = Schema.Struct({
  ...messageBase,
  role: Schema.Literal("user"),
  time: Schema.Struct({
    created: Timestamp,
  }),
  format: Schema.optional(Format),
  summary: Schema.optional(
    Schema.Struct({
      title: Schema.optional(Schema.String),
      body: Schema.optional(Schema.String),
      diffs: Schema.Array(FileDiff.Info),
    }),
  ),
  agent: Schema.String,
  model: Schema.Struct({
    providerID: Provider.ID,
    modelID: Model.ID,
    variant: Schema.optional(Schema.String),
  }),
  system: Schema.optional(Schema.String),
  tools: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)),
  temperature: Schema.optional(Schema.Finite),
  topP: Schema.optional(Schema.Finite),
  /** A per-turn context-window override (t-lmqe0g), carried the same way as
   *  temperature/topP: set once by task.ts from the sub-agent model override's
   *  stored context length, read fresh at turn time to replace this turn's
   *  resolved model's `limit.context` for compaction/overflow math. */
  contextOverride: Schema.optional(Schema.Finite),
  ...foreignSource,
}).annotate({ identifier: "UserMessage" })
export type User = Types.DeepMutable<Schema.Schema.Type<typeof User>>

export const Part = Schema.Union([
  TextPart,
  SubtaskPart,
  ReasoningPart,
  FilePart,
  ToolPart,
  StepStartPart,
  StepFinishPart,
  SnapshotPart,
  PatchPart,
  AgentPart,
  RetryPart,
  CompactionPart,
]).annotate({ discriminator: "type", identifier: "Part" })
export type Part =
  | TextPart
  | SubtaskPart
  | ReasoningPart
  | FilePart
  | ToolPart
  | StepStartPart
  | StepFinishPart
  | SnapshotPart
  | PatchPart
  | AgentPart
  | RetryPart
  | CompactionPart

const AssistantErrorSchema = Schema.Union([
  AuthError.EffectSchema,
  namedError("UnknownError", { message: Schema.String, ref: Schema.optional(Schema.String) }).EffectSchema,
  OutputLengthError.EffectSchema,
  AbortedError.EffectSchema,
  StructuredOutputError.EffectSchema,
  ContextOverflowError.EffectSchema,
  ContentFilterError.EffectSchema,
  APIError.EffectSchema,
]).annotate({ discriminator: "name" })
type AssistantError = Schema.Schema.Type<typeof AssistantErrorSchema>

export const TextPartInput = Schema.Struct({
  id: Schema.optional(PartID),
  type: Schema.Literal("text"),
  text: Schema.String,
  synthetic: Schema.optional(Schema.Boolean),
  ignored: Schema.optional(Schema.Boolean),
  time: Schema.optional(
    Schema.Struct({
      start: NonNegativeInt,
      end: Schema.optional(NonNegativeInt),
    }),
  ),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Any)),
}).annotate({ identifier: "TextPartInput" })
export type TextPartInput = Types.DeepMutable<Schema.Schema.Type<typeof TextPartInput>>

export const FilePartInput = Schema.Struct({
  id: Schema.optional(PartID),
  type: Schema.Literal("file"),
  mime: Schema.String,
  filename: Schema.optional(Schema.String),
  url: Schema.String,
  source: Schema.optional(FilePartSource),
}).annotate({ identifier: "FilePartInput" })
export type FilePartInput = Types.DeepMutable<Schema.Schema.Type<typeof FilePartInput>>

export const AgentPartInput = Schema.Struct({
  id: Schema.optional(PartID),
  type: Schema.Literal("agent"),
  name: Schema.String,
  source: Schema.optional(
    Schema.Struct({
      value: Schema.String,
      start: NonNegativeInt,
      end: NonNegativeInt,
    }),
  ),
}).annotate({ identifier: "AgentPartInput" })
export type AgentPartInput = Types.DeepMutable<Schema.Schema.Type<typeof AgentPartInput>>

export const SubtaskPartInput = Schema.Struct({
  id: Schema.optional(PartID),
  type: Schema.Literal("subtask"),
  prompt: Schema.String,
  description: Schema.String,
  agent: Schema.String,
  model: Schema.optional(
    Schema.Struct({
      providerID: Provider.ID,
      modelID: Model.ID,
    }),
  ),
  command: Schema.optional(Schema.String),
}).annotate({ identifier: "SubtaskPartInput" })
export type SubtaskPartInput = Types.DeepMutable<Schema.Schema.Type<typeof SubtaskPartInput>>

export const Assistant = Schema.Struct({
  ...messageBase,
  role: Schema.Literal("assistant"),
  time: Schema.Struct({
    created: NonNegativeInt,
    completed: Schema.optional(NonNegativeInt),
  }),
  error: Schema.optional(AssistantErrorSchema),
  parentID: MessageID,
  modelID: Model.ID,
  providerID: Provider.ID,
  mode: Schema.String,
  agent: Schema.String,
  path: Schema.Struct({
    cwd: Schema.String,
    root: Schema.String,
  }),
  summary: Schema.optional(Schema.Boolean),
  cost: Schema.Finite,
  tokens: Schema.Struct({
    total: Schema.optional(Schema.Finite),
    input: Schema.Finite,
    output: Schema.Finite,
    reasoning: Schema.Finite,
    cache: Schema.Struct({
      read: Schema.Finite,
      write: Schema.Finite,
    }),
  }),
  structured: Schema.optional(Schema.Any),
  variant: Schema.optional(Schema.String),
  finish: Schema.optional(Schema.String),
  ...foreignSource,
}).annotate({ identifier: "AssistantMessage" })
export type Assistant = Omit<Types.DeepMutable<Schema.Schema.Type<typeof Assistant>>, "error"> & {
  error?: AssistantError
}

export const Info = Schema.Union([User, Assistant]).annotate({ discriminator: "role", identifier: "Message" })
export type Info = User | Assistant

export const WithParts = Schema.Struct({
  info: Info,
  parts: Schema.Array(Part),
})
export type WithParts = {
  info: Info
  parts: Part[]
}

const options = {
  durable: {
    aggregate: "sessionID",
    version: 1,
  },
} as const

const SessionSummary = Schema.Struct({
  additions: Schema.Finite,
  deletions: Schema.Finite,
  files: Schema.Finite,
  diffs: optional(Schema.Array(FileDiff.Info)),
})

const SessionTokens = Schema.Struct({
  input: Schema.Finite,
  output: Schema.Finite,
  reasoning: Schema.Finite,
  cache: Schema.Struct({
    read: Schema.Finite,
    write: Schema.Finite,
  }),
})

const SessionShare = Schema.Struct({
  url: Schema.String,
})

const SessionRevert = Schema.Struct({
  messageID: MessageID,
  partID: optional(PartID),
  snapshot: optional(Schema.String),
  diff: optional(Schema.String),
})

const SessionModel = Schema.Struct({
  id: Model.ID,
  providerID: Provider.ID,
  variant: optional(Schema.String),
})

export const SessionInfo = Schema.Struct({
  id: SessionID,
  slug: Schema.String,
  projectID: Project.ID,
  workspaceID: optional(WorkspaceID),
  directory: Schema.String,
  path: optional(Schema.String),
  parentID: optional(SessionID),
  /** t-uhxos2. The chat this one was FORKED from, and the fork point: the source's
   *  sub-agents created before `time` are in this chat's copied history. Absent = not a
   *  fork, or a fork made before this field existed. */
  fork: optional(Schema.Struct({ sessionID: SessionID, time: NonNegativeInt })),
  summary: optional(SessionSummary),
  cost: optional(Schema.Finite),
  tokens: optional(SessionTokens),
  share: optional(SessionShare),
  title: Schema.String,
  agent: optional(Schema.String),
  model: optional(SessionModel),
  version: Schema.String,
  metadata: optional(Schema.Record(Schema.String, Schema.Any)),
  time: Schema.Struct({
    created: NonNegativeInt,
    updated: NonNegativeInt,
    compacting: optional(NonNegativeInt),
    archived: optional(Schema.Finite),
  }),
  permission: optional(PermissionV1.Ruleset),
  revert: optional(SessionRevert),
}).annotate({ identifier: "Session" })
export type SessionInfo = typeof SessionInfo.Type

const events = {
  Created: define({
    type: "session.created",
    ...options,
    schema: {
      sessionID: SessionID,
      info: SessionInfo,
    },
  }),
  Updated: define({
    type: "session.updated",
    ...options,
    schema: {
      sessionID: SessionID,
      info: SessionInfo,
    },
  }),
  Deleted: define({
    type: "session.deleted",
    ...options,
    schema: {
      sessionID: SessionID,
      info: SessionInfo,
    },
  }),
  MessageUpdated: define({
    type: "message.updated",
    ...options,
    schema: {
      sessionID: SessionID,
      info: Info,
    },
  }),
  MessageRemoved: define({
    type: "message.removed",
    ...options,
    schema: {
      sessionID: SessionID,
      messageID: MessageID,
    },
  }),
  PartUpdated: define({
    type: "message.part.updated",
    ...options,
    schema: {
      sessionID: SessionID,
      part: Part,
      time: Schema.Finite,
    },
  }),
  PartRemoved: define({
    type: "message.part.removed",
    ...options,
    schema: {
      sessionID: SessionID,
      messageID: MessageID,
      partID: PartID,
    },
  }),
}

export const PartDelta = define({
  type: "message.part.delta",
  schema: {
    sessionID: SessionID,
    messageID: MessageID,
    partID: PartID,
    field: Schema.String,
    delta: Schema.String,
  },
})

export const Diff = define({
  type: "session.diff",
  schema: {
    sessionID: SessionID,
    diff: Schema.Array(FileDiff.Info),
  },
})

export const Error = define({
  type: "session.error",
  schema: {
    sessionID: Schema.optional(SessionID),
    error: Assistant.fields.error,
  },
})

export const Event = {
  ...events,
  PartDelta,
  Diff,
  Error,
  Definitions: inventory(
    events.Created,
    events.Updated,
    events.Deleted,
    events.MessageUpdated,
    events.MessageRemoved,
    events.PartUpdated,
    events.PartRemoved,
    PartDelta,
    Diff,
    Error,
  ),
}
