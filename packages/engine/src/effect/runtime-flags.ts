import { Config, ConfigProvider, Context, Effect, Layer, Option } from "effect"
import { ConfigService } from "@/effect/config-service"

const bool = (name: string) => Config.boolean(name).pipe(Config.withDefault(false))
// FORK STRIP: default-true variant so opt-out flags (e.g. LSP-server GitHub
// download) are OFF by default without a phone-home unless explicitly re-enabled.
const boolTrue = (name: string) => Config.boolean(name).pipe(Config.withDefault(true))
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
  backgroundJobMaxDurationMs: positiveInteger("ORIGAMI_EXPERIMENTAL_BACKGROUND_JOB_MAX_MS"),
  experimentalNativeLlm: bool("ORIGAMI_EXPERIMENTAL_NATIVE_LLM"),
  experimentalWebSockets: bool("ORIGAMI_EXPERIMENTAL_WEBSOCKETS"),
  client: Config.string("ORIGAMI_CLIENT").pipe(Config.withDefault("cli")),
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
