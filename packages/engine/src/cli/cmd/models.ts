import { EOL } from "os"
import { Effect } from "effect"
import { ModelsDev } from "@origami/core/models-dev"
import { effectCmd, fail } from "../effect-cmd"
import { UI } from "../ui"
import { ProviderV2 } from "@origami/core/provider"

// The OpenCode Zen gateway ships two catalog entries, `opencode` (Zen) and
// `opencode-go` (Go), so one prefix test covers both. Exported for test: the
// listing order is observable behaviour, and the whole point of the prefix is
// that it matches the ids the shipped catalog actually serves.
export const ZEN_PROVIDER_PREFIX = "opencode"

export function sortProviderIDs(ids: string[]) {
  return [...ids].sort((a, b) => {
    const aIsZen = a.startsWith(ZEN_PROVIDER_PREFIX)
    const bIsZen = b.startsWith(ZEN_PROVIDER_PREFIX)
    if (aIsZen && !bIsZen) return -1
    if (!aIsZen && bIsZen) return 1
    return a.localeCompare(b)
  })
}

export const ModelsCommand = effectCmd({
  command: "models [provider]",
  describe: "list all available models",
  builder: (yargs) =>
    yargs
      .positional("provider", {
        describe: "provider ID to filter models by",
        type: "string",
        array: false,
      })
      .option("verbose", {
        describe: "use more verbose model output (includes metadata like costs)",
        type: "boolean",
      })
      .option("refresh", {
        describe: "refresh the models cache from models.dev",
        type: "boolean",
      }),
  handler: Effect.fn("Cli.models")(function* (args) {
    const { Provider } = yield* Effect.promise(() => import("@/provider/provider"))
    if (args.refresh) {
      yield* ModelsDev.Service.use((s) => s.refresh(true))
      UI.println(UI.Style.TEXT_SUCCESS_BOLD + "Models cache refreshed" + UI.Style.TEXT_NORMAL)
    }

    const provider = yield* Provider.Service
    const providers = yield* provider.list()

    const print = (providerID: ProviderV2.ID, verbose?: boolean) => {
      const p = providers[providerID]
      const sorted = Object.entries(p.models).sort(([a], [b]) => a.localeCompare(b))
      for (const [modelID, model] of sorted) {
        process.stdout.write(`${providerID}/${modelID}`)
        process.stdout.write(EOL)
        if (verbose) {
          process.stdout.write(JSON.stringify(model, null, 2))
          process.stdout.write(EOL)
        }
      }
    }

    if (args.provider) {
      const providerID = ProviderV2.ID.make(args.provider)
      if (!providers[providerID]) return yield* fail(`Provider not found: ${args.provider}`)
      print(providerID, args.verbose)
      return
    }

    const ids = sortProviderIDs(Object.keys(providers))

    for (const providerID of ids) print(ProviderV2.ID.make(providerID), args.verbose)
  }),
})
