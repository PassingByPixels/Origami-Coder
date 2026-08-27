import { ListToolsResultSchema, ToolSchema } from "@modelcontextprotocol/core"
import { Client } from "@modelcontextprotocol/client"
import type { CacheMode, Tool as MCPToolDef } from "@modelcontextprotocol/client"
import { dynamicTool, jsonSchema, type JSONSchema7, type Tool } from "ai"
import { Effect } from "effect"

const DEFAULT_TIMEOUT = 30_000

/**
 * Page cap for a server whose `nextCursor` never converges. Also handed to the
 * SDK as `ClientOptions.listMaxPages`, because the SDK now walks the pages for
 * us on the auto-aggregate path and its own default (64) is far tighter than
 * the limit this codebase has always used.
 */
export const MAX_LIST_PAGES = 1_000

/**
 * How a list call should treat the SEP-2549 response cache.
 *
 * The 2026-07-28 list results carry `ttlMs` and `cacheScope`, and the SDK client
 * honours them — but ONLY on the no-cursor auto-aggregate path. Passing an
 * explicit `cursor` selects the per-page path, which neither reads nor writes
 * the cache. That is why the list helpers below no longer hand-paginate.
 *
 * - `use` (default) serves a still-fresh entry with no round trip.
 * - `refresh` always fetches and re-stores. Used by the `list_changed` refetch.
 *   The SDK does evict on that notification, but it does so fire-and-forget
 *   (`_onnotification`: `this._cache.evict(method)`, result discarded) before
 *   dispatching to our handler. With the default in-process store that
 *   completes synchronously; with any store whose `evict` returns a real
 *   promise, the refetch could read the entry the notification just condemned.
 *   `refresh` makes the refetch's freshness independent of that ordering.
 */
export type ListCacheMode = CacheMode

const TolerantListToolsResultSchema = ListToolsResultSchema.extend({
  tools: ToolSchema.omit({ outputSchema: true }).array(),
})

export async function paginate<T, R extends { nextCursor?: string }>(
  list: (cursor?: string) => Promise<R>,
  items: (result: R) => T[],
) {
  const result: T[] = []
  const cursors = new Set<string>()
  let cursor: string | undefined

  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const page = await list(cursor)
    result.push(...items(page))
    if (page.nextCursor === undefined) return result
    if (cursors.has(page.nextCursor)) throw new Error(`MCP list returned duplicate cursor: ${page.nextCursor}`)
    cursors.add(page.nextCursor)
    cursor = page.nextCursor
  }

  throw new Error(`MCP list exceeded ${MAX_LIST_PAGES} pages`)
}

export function defs(client: Client, timeout?: number, cacheMode?: ListCacheMode) {
  return listTools(client, timeout ?? DEFAULT_TIMEOUT, cacheMode).pipe(Effect.catch(() => Effect.void))
}

export function convertTool(mcpTool: MCPToolDef, client: Client, timeout?: number): Tool {
  const inputSchema: JSONSchema7 = {
    ...(mcpTool.inputSchema as JSONSchema7),
    type: "object",
    properties: (mcpTool.inputSchema.properties ?? {}) as JSONSchema7["properties"],
    additionalProperties: false,
  }

  return dynamicTool({
    description: mcpTool.description ?? "",
    inputSchema: jsonSchema(inputSchema),
    execute: async (args: unknown, options) => {
      const result = await client.callTool(
        {
          name: mcpTool.name,
          arguments: (args || {}) as Record<string, unknown>,
        },
        {
          resetTimeoutOnProgress: true,
          signal: options.abortSignal,
          timeout,
          // The MCP SDK only sends a progress token when this hook is present, enabling timeout resets.
          onprogress: () => {},
        },
      )
      if (result.isError)
        throw new Error(
          result.content
            .flatMap((item) => (item.type === "text" ? [item.text] : []))
            .filter((text) => text.trim())
            .join("\n\n") || "MCP tool returned an error",
        )
      if (result.content.length > 0 || result.structuredContent === undefined || result.structuredContent === null)
        return result
      return {
        ...result,
        content: [{ type: "text" as const, text: JSON.stringify(result.structuredContent) }],
      }
    },
  })
}

export function fetch<T extends { name: string }>(
  clientName: string,
  client: Client,
  list: (client: Client) => Promise<T[]>,
  label: string,
  key?: (item: T) => string,
) {
  return Effect.tryPromise({
    try: () => list(client),
    catch: (error) => error,
  }).pipe(
    Effect.tapError((error) =>
      Effect.logWarning(`failed to get ${label}`, {
        clientName,
        error: error instanceof Error ? error.message : String(error),
      }),
    ),
    Effect.map((items) => {
      const sanitizedClient = sanitize(clientName)
      // Escape both the separator and escape marker so `server:uri` keys remain unambiguous.
      const resourceClient = clientName.replaceAll("%", "%25").replaceAll(":", "%3A")
      return Object.fromEntries(
        items.map((item) => [
          key ? resourceClient + ":" + key(item) : sanitizedClient + ":" + sanitize(item.name),
          { ...item, client: clientName },
        ]),
      )
    }),
    Effect.orElseSucceed(() => undefined),
  )
}

export const sanitize = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "_")

export const toolName = (clientName: string, name: string) => sanitize(clientName) + "_" + sanitize(name)

export function prompts(client: Client, timeout?: number, cacheMode?: ListCacheMode) {
  if (!client.getServerCapabilities()?.prompts) return Promise.resolve([])
  return client.listPrompts(undefined, { timeout, cacheMode }).then((result) => result.prompts)
}

export function resources(client: Client, timeout?: number, cacheMode?: ListCacheMode) {
  if (!client.getServerCapabilities()?.resources) return Promise.resolve([])
  return client.listResources(undefined, { timeout, cacheMode }).then((result) => result.resources)
}

export function resourceTemplates(client: Client, timeout?: number, cacheMode?: ListCacheMode) {
  if (!client.getServerCapabilities()?.resources) return Promise.resolve([])
  return client.listResourceTemplates(undefined, { timeout, cacheMode }).then((result) => result.resourceTemplates)
}

function listTools(client: Client, timeout: number, cacheMode?: ListCacheMode) {
  return Effect.tryPromise({
    try: async () => {
      try {
        return (await client.listTools(undefined, { timeout, cacheMode })).tools
      } catch (error) {
        if (!(error instanceof Error) || !isOutputSchemaValidationError(error)) throw error
        // A tool whose `outputSchema` the validator cannot resolve fails the
        // typed path for the WHOLE list. Retry through the raw request with
        // `outputSchema` dropped. That path is neither cacheable nor
        // auto-aggregating, so pagination is ours again here — and the list of
        // a server we could not validate never reaches the cache, which is the
        // safe direction.
        return paginate(
          (cursor) =>
            client.request(
              { method: "tools/list", params: cursor === undefined ? {} : { cursor } },
              TolerantListToolsResultSchema,
              { timeout },
            ),
          (result) => result.tools,
        )
      }
    },
    catch: (error) => (error instanceof Error ? error : new Error(String(error))),
  })
}

function isOutputSchemaValidationError(error: Error) {
  return /can't resolve reference|resolves to more than one schema|outputSchema|schema.*reference|reference.*schema/i.test(
    error.message,
  )
}

export * as McpCatalog from "./catalog"
