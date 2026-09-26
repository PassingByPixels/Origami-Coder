import { Effect } from "effect"
import { effectCmd } from "../effect-cmd"
import { AgentSideConnection, ndJsonStream } from "@agentclientprotocol/sdk"
import { ServerAuth } from "@/server/auth"
import { createOrigamiClient } from "@origami/sdk/v2"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
import { ACPProfile } from "@/acp/profile"
import { ElasticSpare } from "@/elastic/spare"

/**
 * origami_change (t-xsufpe): the env the `acp` command runs under. Native plan
 * mode: the ACP shell is an interactive client (it can answer the plan_exit
 * question via requestPermission - see acp/question.ts). Set through
 * `effectCmd`'s `env`, before the runtime reads `RuntimeFlags`: set inside the
 * handler, both flags kept their defaults (client "cli", plan mode off), so the
 * plan agent had no plan_exit tool and no plan-file brief.
 */
export const ACP_ENV = {
  ORIGAMI_CLIENT: "acp",
  ORIGAMI_EXPERIMENTAL_PLAN_MODE: "true",
} as const

export const AcpCommand = effectCmd({
  command: "acp",
  env: ACP_ENV,
  describe: "start ACP (Agent Client Protocol) server",
  // origami_change (t-w2u2ki): a warm spare boots no instance at start; its first
  // session boots one against the disk as it is then (elastic/spare.ts).
  instance: () => !ElasticSpare.isSpare(),
  builder: (yargs) => {
    return withNetworkOptions(yargs).option("cwd", {
      describe: "working directory",
      type: "string",
      default: process.cwd(),
    })
  },
  handler: Effect.fn("Cli.acp")(function* (args) {
    const { Server } = yield* Effect.promise(() => import("@/server/server"))
    const { ACP } = yield* Effect.promise(() => import("@/acp/agent"))
    ACPProfile.mark("cli.acp.handler")
    const opts = yield* resolveNetworkOptions(args)
    const server = yield* Effect.promise(() => ACPProfile.measure("cli.acp.server.listen", () => Server.listen(opts)))

    const sdk = createOrigamiClient({
      baseUrl: `http://${server.hostname}:${server.port}`,
      headers: ServerAuth.headers(),
    })

    // origami_change-start (t-kgu05m): publish this engine's heartbeat so peer
    // sessions can find it. This is the only place that knows the loopback base
    // — the port is chosen at listen time and told to nobody else.
    const { AgentBroker } = yield* Effect.promise(() => import("@/origami/agent-broker"))
    let broker: { stop: () => Promise<void> } | undefined
    // origami_change-end

    // The flock's relay sockets, held for the life of this engine. It is idle
    // unless this box has a `flock.json` with friends in it AND a Front Desk
    // model set, and `ORIGAMI_DISABLE_FLOCK=1` turns it off outright.
    // The same loopback base the broker publishes: the engine that wins the
    // flock lease records it there, so a second window's engine can forward its
    // questions to this one over `POST /flock/ask`.
    const { FlockBoot } = yield* Effect.promise(() => import("@/flock/boot"))
    let flock: { stop: () => void } | undefined
    const { AgentMailbox } = yield* Effect.promise(() => import("@/origami/agent-mailbox"))
    const startPeers = () => {
      broker = AgentBroker.start({ httpBase: `http://${server.hostname}:${server.port}`, cwd: args.cwd })
      flock = FlockBoot.start({ cwd: args.cwd, httpBase: `http://${server.hostname}:${server.port}` })
      // origami_change (t-wdybz9): delete kept mail no chat will read (a chat
      // closed while parked; see AgentMailbox.MAIL_TTL_MS). Never rejects.
      void AgentMailbox.sweep()
    }
    // origami_change-start (t-w2u2ki): a warm spare is no peer and no Flock
    // engine until a chat adopts it. Adoption first drops what the spare cached
    // before it (instances a `session/list` probe booted, the global config
    // `resolveNetworkOptions` read at start), so the chat reads the disk as a
    // fresh engine would.
    if (ElasticSpare.isSpare()) {
      const [{ AppRuntime }, { InstanceStore }, { Config }, { ElasticIdle }, { ElasticState }] = yield* Effect.promise(
        () =>
          Promise.all([
            import("@/effect/app-runtime"),
            import("@/project/instance-store"),
            import("@/config/config"),
            import("@/elastic/idle"),
            import("@/elastic/state"),
          ]),
      )
      ElasticSpare.hold({
        peerName: AgentBroker.displayName(args.cwd),
        // origami_change (t-y4x518): the spare waits at the idle class (IDLE +
        // EcoQoS); the chat's work must not run throttled while the extension's
        // own `_elastic_class active` is still on its way.
        lift: () => {
          if (ElasticState.requestedClass() !== "active") ElasticIdle.setClass("active")
        },
        onAdopt: async (report) => {
          // origami_change (t-wdybz9): bounded on its own, so a finalizer that
          // never ends still lets the peer broker and Flock start.
          // origami_change (t-xnvp72): each part's time goes into the adoption
          // report; the disposal's to its real end, also past the limit.
          const started = performance.now()
          const disposal = AppRuntime.runPromise(
            Effect.gen(function* () {
              yield* InstanceStore.Service.use((store) => store.disposeAll())
              yield* Config.Service.use((config) => config.invalidate())
            }),
          )
          const ended = () => {
            report.disposeMs = Math.round(performance.now() - started)
          }
          disposal.then(ended, ended)
          try {
            report.disposeLimitHit = await ElasticSpare.bounded(
              disposal,
              ElasticSpare.ADOPT_LIMIT_MS - 500,
              "pre-adoption instance disposal",
            )
          } finally {
            const peers = performance.now()
            startPeers()
            report.peersMs = Math.round(performance.now() - peers)
          }
        },
      })
    } else startPeers()
    // origami_change-end

    const input = new WritableStream<Uint8Array>({
      write(chunk) {
        return new Promise<void>((resolve, reject) => {
          process.stdout.write(chunk, (err) => {
            if (err) {
              reject(err)
            } else {
              resolve()
            }
          })
        })
      },
    })
    const output = new ReadableStream<Uint8Array>({
      start(controller) {
        process.stdin.on("data", (chunk: Buffer) => {
          controller.enqueue(new Uint8Array(chunk))
        })
        process.stdin.on("end", () => controller.close())
        process.stdin.on("error", (err) => controller.error(err))
      },
    })

    const stream = ndJsonStream(input, output)
    const agent = ACP.init({ sdk })

    new AgentSideConnection((conn) => {
      ACPProfile.mark("cli.acp.connection.create")
      return agent.create(conn)
    }, stream)

    yield* Effect.logInfo("setup connection")
    process.stdin.resume()
    yield* Effect.promise(
      () =>
        new Promise<void>((resolve, reject) => {
          process.stdin.on("end", () => resolve())
          process.stdin.on("error", reject)
        }),
    )
    // origami_change (t-kgu05m): drop the heartbeat on a clean exit. An unclean
    // one leaves the file behind, which is why readers age entries out.
    flock?.stop()
    if (broker) yield* Effect.promise(() => broker!.stop())
  }),
})
