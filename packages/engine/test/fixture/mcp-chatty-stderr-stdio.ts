import { StdioServerTransport } from "@modelcontextprotocol/server/stdio"
import { Server } from "@modelcontextprotocol/server"

// A chatty MCP server (the Python MCP SDK logs every CallToolRequest at INFO
// to stderr; see engine finding 10). This fixture writes far more than a
// pipe's OS buffer (about 64 KB on both Windows and POSIX) to stderr, waiting
// on `drain` whenever a write reports backpressure, BEFORE it ever answers
// `tools/list`. If the connecting engine does not read this fixture's stderr,
// `drain` never fires, the loop below never finishes, and the connection
// never completes -- reproducing "tools hang while the pane shows connected."
const CHATTY_BYTES = 256 * 1024
const CHUNK = `${"x".repeat(4096)}\n`

async function writeChatty() {
  let written = 0
  while (written < CHATTY_BYTES) {
    const ok = process.stderr.write(CHUNK)
    written += CHUNK.length
    if (!ok) await new Promise<void>((resolve) => process.stderr.once("drain", resolve))
  }
}

await writeChatty()

const server = new Server({ name: "mcp-chatty-stderr", version: "1.0.0" }, { capabilities: { tools: {} } })

server.setRequestHandler("tools/list", () =>
  Promise.resolve({
    tools: [{ name: "ping", description: "ok", inputSchema: { type: "object", properties: {} } }],
  }),
)

await server.connect(new StdioServerTransport())
