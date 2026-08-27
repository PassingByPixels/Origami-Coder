import { Config } from "@/config/config"
import { Provider } from "@/provider/provider"
import * as InstanceState from "@/effect/instance-state"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { markInstanceForDisposal } from "../lifecycle"

export const configHandlers = HttpApiBuilder.group(InstanceHttpApi, "config", (handlers) =>
  Effect.gen(function* () {
    const providerSvc = yield* Provider.Service
    const configSvc = yield* Config.Service

    const get = Effect.fn("ConfigHttpApi.get")(function* () {
      return yield* configSvc.get()
    })

    const update = Effect.fn("ConfigHttpApi.update")(function* (ctx) {
      yield* configSvc.update(ctx.payload)
      yield* markInstanceForDisposal(yield* InstanceState.context)
      return ctx.payload
    })

    const providers = Effect.fn("ConfigHttpApi.providers")(function* () {
      const providers = yield* providerSvc.list()
      return {
        providers: Object.values(providers).map(Provider.toPublicInfo),
        default: Provider.defaultModelIDs(providers),
      }
    })

    // Force a re-read of config from disk: bust the process-wide global config
    // cache (the shell writes the GLOBAL origami.json directly, which nothing
    // else invalidates), then dispose this directory's instance so the next
    // provider.list()/config.get() rebuilds from the fresh file. Disposal runs
    // after the response, so by the time the caller's next request lands the
    // instance is gone and rebuilds clean.
    const refresh = Effect.fn("ConfigHttpApi.refresh")(function* () {
      yield* configSvc.invalidate()
      yield* markInstanceForDisposal(yield* InstanceState.context)
      return true
    })

    return handlers
      .handle("get", get)
      .handle("update", update)
      .handle("providers", providers)
      .handle("refresh", refresh)
  }),
)
