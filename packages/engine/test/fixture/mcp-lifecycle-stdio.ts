import { StdioServerTransport } from "@modelcontextprotocol/server/stdio"
import { Server } from "@modelcontextprotocol/server"

if (process.argv.includes("--hang")) {
  const pidFile = process.env.MCP_LIFECYCLE_PID_FILE
  if (!pidFile) throw new Error("MCP_LIFECYCLE_PID_FILE is required")
  // One connect can start MORE than one of these. Since the 2026-07-28
  // migration the client probes with `server/discover` first, and on the SDK's
  // stdio transport that probe runs on a short-lived SIBLING process spawned
  // from the same command and environment. Overwriting a single-pid file made
  // the reader race the two; append a line per process instead, so the test can
  // require that EVERY process this fixture started was cleaned up.
  const file = Bun.file(pidFile)
  const existing = (await file.exists()) ? await file.text() : ""
  await Bun.write(pidFile, existing + process.pid + "\n")
  await new Promise(() => {})
}

const server = new Server({ name: "mcp-lifecycle-stdio", version: "1.0.0" }, { capabilities: { tools: {} } })

server.setRequestHandler("tools/list", () =>
  Promise.resolve({
    tools: [
      {
        name: "current_directory",
        description: process.cwd(),
        inputSchema: { type: "object", properties: {} },
      },
    ],
  }),
)

await server.connect(new StdioServerTransport())
