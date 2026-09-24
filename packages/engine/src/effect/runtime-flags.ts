import { Config, ConfigProvider, Context, Effect, Layer, Option } from "effect"
import { ConfigService } from "@/effect/config-service"

const bool = (name: string) => Config.boolean(name).pipe(Config.withDefault(false))
// FORK STRIP: default-true variant so opt-out flags (e.g. LSP-server GitHub
// download) are OFF by default without a phone-home unless explicitly re-enabled.
// t-fijeld. `Config.boolean` accepts only the exact lower-case words, and
// `withDefault` rescues a MISSING value, not an unparsable one - so `FALSE`,
// `False`, ` false ` or an empty string failed the whole flags read. This is
// the variable a user types by hand (ORIGAMI_EXPERIMENTAL_SIDE_QUESTS=false),
// so it is read as text: trimmed, case-folded, and anything that is not a
// known word keeps the default.
const FALSE_WORDS: ReadonlySet<string> = new Set(["false", "no", "off", "0", "n"])
const boolTrue = (name: string) =>
  Config.string(name).pipe(
    Config.map((value) => !FALSE_WORDS.has(value.trim().toLowerCase())),
    Config.orElse(() => Config.succeed(true)),
  )
const positiveInteger = (name: string) =>
  Config.number(name).pipe(
    Config.map((value) => (Number.isInteger(value) && value > 0 ? value : undefined)),
    Config.orElse(() => Config.succeed(undefined)),
  )
const experimental = bool("ORIGAMI_EXPERIMENTAL")
const enabledByExperimental = (name: string) =>
  Config.all({ experimental, enabled: Config.boolean(name).pipe(Config.option) }).pipe(
    Config.map((flags) => Option.getOrElse(flags.enabled, () => flags.experimental)),
  )

export class Service extends ConfigService.Service<Service>()("@origami/RuntimeFlags", {
  autoShare: bool("ORIGAMI_AUTO_SHARE"),
  pure: bool("ORIGAMI_PURE"),
  disableDefaultPlugins: bool("ORIGAMI_DISABLE_DEFAULT_PLUGINS"),
  disableEmbeddedWebUi: bool("ORIGAMI_DISABLE_EMBEDDED_WEB_UI"),
  disableExternalSkills: bool("ORIGAMI_DISABLE_EXTERNAL_SKILLS"),
  // Kill switch for tool-result aging (session/tool-aging.ts), which is ON by
  // default. Set it and the outgoing array carries every stored tool result in
  // full again — the feature only ever rewrote the wire, so nothing has to be
  // restored.
  disableToolAging: bool("ORIGAMI_DISABLE_TOOL_AGING"),
  disableLspDownload: boolTrue("ORIGAMI_DISABLE_LSP_DOWNLOAD"),
  disableClaudeCodePrompt: Config.all({
    broad: bool("ORIGAMI_DISABLE_CLAUDE_CODE"),
    direct: bool("ORIGAMI_DISABLE_CLAUDE_CODE_PROMPT"),
  }).pipe(Config.map((flags) => flags.broad || flags.direct)),
  // Origami does NOT inherit the user's global ~/.claude/skills by default. A
  // rebranded, standalone product shouldn't silently vacuum up a personal Claude
  // Code skillset (e.g. private working-discipline skills surfacing in Tsuru's
  // slash menu). ~/.origami/skills and project-local skills still load. Re-enable
  // the ~/.claude scan with ORIGAMI_DISABLE_CLAUDE_CODE_SKILLS=false.
  disableClaudeCodeSkills: Config.all({
    broad: bool("ORIGAMI_DISABLE_CLAUDE_CODE"),
    direct: boolTrue("ORIGAMI_DISABLE_CLAUDE_CODE_SKILLS"),
  }).pipe(Config.map((flags) => flags.broad || flags.direct)),
  enableExa: Config.all({
    experimental,
    enabled: bool("ORIGAMI_ENABLE_EXA"),
    legacy: bool("ORIGAMI_EXPERIMENTAL_EXA"),
  }).pipe(Config.map((flags) => flags.experimental || flags.enabled || flags.legacy)),
  enableParallel: Config.all({
    enabled: bool("ORIGAMI_ENABLE_PARALLEL"),
    legacy: bool("ORIGAMI_EXPERIMENTAL_PARALLEL"),
  }).pipe(Config.map((flags) => flags.enabled || flags.legacy)),
  enableExperimentalModels: bool("ORIGAMI_ENABLE_EXPERIMENTAL_MODELS"),
  enableQuestionTool: bool("ORIGAMI_ENABLE_QUESTION_TOOL"),
  experimentalReferences: enabledByExperimental("ORIGAMI_EXPERIMENTAL_REFERENCES"),
  experimentalBackgroundSubagents: enabledByExperimental("ORIGAMI_EXPERIMENTAL_BACKGROUND_SUBAGENTS"),
  // t-f89g49, default-ON since t-ffjau8. The `side_quest` tool and its drawer.
  // ON with nothing set: a model that cannot find the tool improvises a
  // sub-agent named "Sidequest: ..." instead, which is the opposite of the
  // feature. The controls that matter - one call per turn, five open per chat,
  // the duplicate check - are code in tool/side-quest.ts, not this switch.
  // `ORIGAMI_EXPERIMENTAL_SIDE_QUESTS=false` is the explicit OFF and takes the
  // tool out of the catalog entirely.
  experimentalSideQuests: boolTrue("ORIGAMI_EXPERIMENTAL_SIDE_QUESTS"),
  experimentalLspTy: bool("ORIGAMI_EXPERIMENTAL_LSP_TY"),
  experimentalLspTool: enabledByExperimental("ORIGAMI_EXPERIMENTAL_LSP_TOOL"),
  experimentalOxfmt: enabledByExperimental("ORIGAMI_EXPERIMENTAL_OXFMT"),
  experimentalPlanMode: enabledByExperimental("ORIGAMI_EXPERIMENTAL_PLAN_MODE"),
  experimentalCodeMode: enabledByExperimental("ORIGAMI_EXPERIMENTAL_CODE_MODE"),
  experimentalEventSystem: enabledByExperimental("ORIGAMI_EXPERIMENTAL_EVENT_SYSTEM"),
  experimentalWorkspaces: enabledByExperimental("ORIGAMI_EXPERIMENTAL_WORKSPACES"),
  experimentalIconDiscovery: enabledByExperimental("ORIGAMI_EXPERIMENTAL_ICON_DISCOVERY"),
  outputTokenMax: positiveInteger("ORIGAMI_EXPERIMENTAL_OUTPUT_TOKEN_MAX"),
  bashDefaultTimeoutMs: positiveInteger("ORIGAMI_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS"),
  // Silence window before a FOREGROUND shell call is treated as hung. Total
  // elapsed time alone cannot tell a build apart from a dev server that printed
  // its banner and then waited forever; this can.
  bashIdleTimeoutMs: positiveInteger("ORIGAMI_EXPERIMENTAL_BASH_IDLE_TIMEOUT_MS"),
  // Wall-clock ceiling on ONE background job before the registry cancels it.
  // SHELL jobs only - tool/shell.ts is its single reader.
  backgroundJobMaxDurationMs: positiveInteger("ORIGAMI_EXPERIMENTAL_BACKGROUND_JOB_MAX_MS"),
  // t-d935qk. Wall-clock ceiling on ONE sub-agent (`task`) job, read by
  // tool/task.ts and defaulted there to 4 h. Separate from the shell flag
  // above on purpose: a review agent reading a repository is not a build, and
  // the owner's 8 h shell setting did nothing for sub-agents because nothing
  // on the task path ever read it.
  //
  // MIRROR: the VS Code extension writes this exact name into the engine's
  // environment at spawn (packages/vscode/src/engineEnv.ts). Rename here and
  // the setting stops arriving - change both or neither.
  subagentMaxDurationMs: positiveInteger("ORIGAMI_SUBAGENT_MAX_MS"),
  experimentalNativeLlm: bool("ORIGAMI_EXPERIMENTAL_NATIVE_LLM"),
  // Which provider families run on the native LLM runtime, overriding the
  // per-family defaults in session/llm/native-route.ts: a comma list of
  // families, "all", or "none". Empty = the defaults. The experimental flag
  // above is the legacy spelling of "all" and still wins.
  nativeLlmFamilies: Config.string("ORIGAMI_NATIVE_LLM_FAMILIES").pipe(Config.withDefault("")),
  // t-tija5f. Claude through the owner's Claude subscription, with the installed
  // `claude` CLI as the model client (provider/claude-subscription.ts). OFF by
  // default and deliberately NOT under the ORIGAMI_EXPERIMENTAL umbrella: it
  // carries an account-risk disclosure the extension shows before it sets this.
  //
  // MIRROR: the VS Code extension writes this exact name from the setting
  // `origami.experimentalClaudeSubscription` (packages/vscode/src/claudeSubscriptionFlag.ts).
  experimentalClaudeSubscription: bool("ORIGAMI_EXPERIMENTAL_CLAUDE_SUBSCRIPTION"),
  experimentalWebSockets: bool("ORIGAMI_EXPERIMENTAL_WEBSOCKETS"),
  // Hard OFF for the OpenAI WebSocket transport, which pre-release channels
  // turn on by default. The LLM parity harness sets it: its record/replay
  // proxy speaks HTTP only, and a WebSocket upgrade against it fails the turn.
  disableWebSockets: bool("ORIGAMI_DISABLE_WEBSOCKETS"),
  client: Config.string("ORIGAMI_CLIENT").pipe(Config.withDefault("cli")),
  // origami_change-start (t-53vyxf): the two switches the validation panel flips
  // per run, so three request shapes can be compared without a rebuild.
  //
  // WHICH SHAPE THE TRAILING LANE SENDS (session/prompt.ts). A STRING and not a
  // boolean because there are three shapes, not two, and the panel names them:
  // "on-change" (shipped, t-46a74d), "every-step" (the pre-0.4.127 shape) and
  // "every-step-continue". An unrecognised value falls back to the default and
  // says so once at WARN - `SessionPrompt.trailingContextMode` decides that, so
  // the parse is a pure function a test can read.
  trailingContext: Config.string("ORIGAMI_TRAILING_CONTEXT").pipe(Config.withDefault("")),
  // "off" silences the OpenAI continuation nudge (session/continue-nudge.ts) for
  // the run, so a panel run measures the PROMPT SHAPE alone and not the shape
  // plus the guard that also answers a stop. Any other value leaves it on.
  continueNudge: Config.string("ORIGAMI_CONTINUE_NUDGE").pipe(Config.withDefault("")),
  // origami_change-end
}) {}

export type Info = Context.Service.Shape<typeof Service>

const emptyConfigLayer = Service.layer.pipe(
  Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
  Layer.orDie,
)

export const layer = (overrides: Partial<Info> = {}) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const flags = yield* Service
      return Service.of({ ...flags, ...overrides })
    }),
  ).pipe(Layer.provide(emptyConfigLayer))

export const node = LayerNode.make({ service: Service, layer: Service.layer.pipe(Layer.orDie), deps: [] })

export * as RuntimeFlags from "./runtime-flags"
import { LayerNode } from "@origami/core/effect/layer-node"
