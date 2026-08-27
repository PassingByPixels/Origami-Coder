import { StdioServerTransport } from "@modelcontextprotocol/server/stdio"
import { Server } from "@modelcontextprotocol/server"

// A prompt-serving MCP server that is DELIBERATELY slow to come up, so a test
// can observe the window between "the command list answered" and "this server's
// prompts arrived". The delay is before `connect`, which is where a real
// git-resolving or package-fetching server spends its seconds.
const delay = Number(process.env["MCP_SLOW_PROMPT_DELAY_MS"] ?? "0")
if (delay > 0) await Bun.sleep(delay)

const server = new Server({ name: "mcp-slow-prompt-stdio", version: "1.0.0" }, { capabilities: { prompts: {} } })

server.setRequestHandler("prompts/list", () =>
  Promise.resolve({ prompts: [{ name: "review", description: "slow server prompt" }] }),
)

server.setRequestHandler("prompts/get", () =>
  Promise.resolve({ messages: [{ role: "user", content: { type: "text", text: "review the diff" } }] }),
)

await server.connect(new StdioServerTransport())
