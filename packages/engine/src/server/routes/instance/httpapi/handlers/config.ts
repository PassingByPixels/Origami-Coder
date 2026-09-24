import { Config } from "@/config/config"
import { Provider } from "@/provider/provider"
import { ProviderCatalogCache } from "@/provider/catalog-cache"
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

    const build = Effect.fn("ConfigHttpApi.providers.build")(function* () {
      const providers = yield* providerSvc.list()
      return {
        providers: Object.values(providers).map(Provider.toPublicInfo),
        default: Provider.defaultModelIDs(providers),
      }
    })

    // origami_change-start (t-hca1vv): answer from the cross-process catalog cache.
    //
    // This route is what `session/new` waits on (ACP `acp.directory.provider.list`),
    // and building the catalog cost ~100 ms per configured provider in EVERY engine
    // process - i.e. in every new chat. The build is a pure function of the inputs
    // `ProviderCatalogCache.key` hashes, so a hit is not "probably still right", it is
    // the same answer.
    //
    // The secret strip runs on BOTH paths. A hit and a miss must not differ in shape.
    //
    // On a hit the real catalog is still built, but AFTER the chat is interactive:
    // the first prompt needs it anyway, and rebuilding it refreshes the cache for the
    // next process (live model discovery is the one input the key cannot see). The
    // delay is deliberate - the build is largely synchronous module loading, so doing
    // it immediately would stall the very `session/new` this cache exists to speed up.
    const providers = Effect.fn("ConfigHttpApi.providers")(function* () {
      const directory = yield* InstanceState.directory
      const cacheKey = ProviderCatalogCache.key({ directory, config: yield* configSvc.get() })
      const cached = ProviderCatalogCache.read(cacheKey)
      if (cached) {
        yield* build().pipe(
          Effect.delay("5 seconds"),
          Effect.tap((fresh) => Effect.sync(() => ProviderCatalogCache.write(cacheKey, fresh))),
          Effect.ignore,
          Effect.forkDetach,
        )
        return cached
      }
      const fresh = yield* build()
      ProviderCatalogCache.write(cacheKey, fresh)
      return ProviderCatalogCache.withoutSecrets(fresh)
    })
    // origami_change-end

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
