import { Effect } from "effect"
import { effectCmd } from "../effect-cmd"
import { AgentSideConnection, ndJsonStream } from "@agentclientprotocol/sdk"
import { ServerAuth } from "@/server/auth"
import { createOrigamiClient } from "@origami/sdk/v2"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
import { ACPProfile } from "@/acp/profile"

export const AcpCommand = effectCmd({
  command: "acp",
  describe: "start ACP (Agent Client Protocol) server",
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
    process.env.ORIGAMI_CLIENT = "acp"
    // Native plan mode: the ACP shell is an interactive client (it can answer
    // the plan_exit question via requestPermission — see acp/question.ts), so
    // enable plan mode for it the same way ORIGAMI_CLIENT is set, before the
    // RuntimeFlags layer reads env on first server use.
    process.env.ORIGAMI_EXPERIMENTAL_PLAN_MODE = "true"
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
    const broker = AgentBroker.start({ httpBase: `http://${server.hostname}:${server.port}`, cwd: args.cwd })
    // origami_change-end

    // The flock's relay sockets, held for the life of this engine. It is idle
    // unless this box has a `flock.json` with friends in it AND a Front Desk
    // model set, and `ORIGAMI_DISABLE_FLOCK=1` turns it off outright.
    // The same loopback base the broker publishes: the engine that wins the
    // flock lease records it there, so a second window's engine can forward its
    // questions to this one over `POST /flock/ask`.
    const { FlockBoot } = yield* Effect.promise(() => import("@/flock/boot"))
    const flock = FlockBoot.start({ cwd: args.cwd, httpBase: `http://${server.hostname}:${server.port}` })

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
    flock.stop()
    yield* Effect.promise(() => broker.stop())
  }),
})
