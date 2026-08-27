export * from "./client.js"
export * from "./server.js"

import { createOrigamiClient } from "./client.js"
import { createOrigamiServer } from "./server.js"
import type { ServerOptions } from "./server.js"

export async function createOrigami(options?: ServerOptions) {
  const server = await createOrigamiServer({
    ...options,
  })

  const client = createOrigamiClient({
    baseUrl: server.url,
  })

  return {
    client,
    server,
  }
}
