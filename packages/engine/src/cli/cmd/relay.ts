import { cmd } from "./cmd"
import { DEFAULT_MAX_CONNECTIONS, startRelay } from "@/relay/server"
import { DEFAULT_BULK_MB_PER_MINUTE } from "@/relay/limits"
import { RING_MAX_AGE_MS } from "@/relay/ring"

export const RelayCommand = cmd({
  command: "relay",
  describe: "starts the origami remote rendezvous relay",
  builder: (yargs) =>
    yargs
      .option("port", {
        type: "number",
        describe: "port to listen on (0 picks a free port)",
        default: 8787,
      })
      .option("hostname", {
        type: "string",
        describe: "hostname to bind",
        default: "127.0.0.1",
      })
      .option("tls-cert", {
        type: "string",
        describe: "path to a TLS certificate (PEM); requires --tls-key",
      })
      .option("tls-key", {
        type: "string",
        describe: "path to a TLS private key (PEM); requires --tls-cert",
      })
      .option("app-dir", {
        type: "string",
        describe: "directory served at /app/* (the phone shell)",
      })
      .option("daily-budget-mb", {
        type: "number",
        describe: "global traffic budget per UTC day; new rendezvous ids are refused past it",
      })
      .option("max-connections", {
        type: "number",
        describe: "ceiling on live websockets; further connections get HTTP 503",
        default: DEFAULT_MAX_CONNECTIONS,
      })
      .option("metrics-port", {
        type: "number",
        describe:
          "serve counters as JSON at /metrics on this port, bound to 127.0.0.1 (off when unset)",
      })
      .option("ring-seconds", {
        type: "number",
        describe:
          "seconds of replay ring kept per pairing, for a socket reconnecting with ?after=; 0 replays nothing",
        default: RING_MAX_AGE_MS / 1000,
      })
      .option("bulk-rid-mb-per-minute", {
        type: "number",
        describe:
          "bulk lane (?lane=bulk) token-bucket capacity, MB per rolling 60s per bulk rid; own namespace, no ring",
        default: DEFAULT_BULK_MB_PER_MINUTE,
      }),
  async handler(args) {
    const relay = await startRelay({
      port: args.port,
      hostname: args.hostname,
      tlsCert: args["tls-cert"],
      tlsKey: args["tls-key"],
      appDir: args["app-dir"],
      dailyBudgetMb: args["daily-budget-mb"],
      maxConnections: args["max-connections"],
      metricsPort: args["metrics-port"],
      ringMaxAgeMs: args["ring-seconds"] * 1000,
      bulkRidMbPerMinute: args["bulk-rid-mb-per-minute"],
    })
    const tls = args["tls-cert"] && args["tls-key"] ? "on" : "off"
    // The metrics port is named so an operator can see from the journal whether
    // the counter surface came up, and on which port. It carries no rid, like
    // every other line this relay writes.
    const metrics = relay.metricsPort === undefined ? "off" : `127.0.0.1:${relay.metricsPort}`
    console.log(
      `origami relay listening on ${relay.hostname}:${relay.port} (tls ${tls}, app-dir ${args["app-dir"] ?? "none"}, metrics ${metrics}, ring ${args["ring-seconds"]} s)`,
    )
    await new Promise<void>((resolve) => {
      const shutdown = () => {
        void relay.stop().then(resolve)
      }
      process.once("SIGINT", shutdown)
      process.once("SIGTERM", shutdown)
    })
  },
})
