import type { Hooks, PluginInput } from "@origami/plugin"
import type { Model } from "@origami/sdk/v2"
import { InstallationVersion } from "@origami/core/installation/version"
import { iife } from "@/util/iife"
import { setTimeout as sleep } from "node:timers/promises"
import { CopilotModels } from "./models"
import { MessageV2 } from "@/session/message-v2"
import { ProviderReauth } from "@/provider/reauth"
import { applyCapabilityDefaults } from "../capabilityDefaults"

// VS Code's PUBLIC GitHub OAuth app id — the one every third-party Copilot tool
// signs in with. GitHub gates the Copilot CATALOG on the app id, not on the
// account: Origami Labs' own app was answered with seven legacy entries and every
// other model refused at inference. Device flow, `read:user`, tokens non-expiring.
const CLIENT_ID = "Iv1.b507a08c87ecfe98"

/** GitHub serves a DIFFERENT model catalog per integrator, and the integrator is
 *  named by these headers, not by the OAuth app alone. Without them the token
 *  above is read as `copilot-language-server`, whose catalog lacks the partner
 *  models and whose chat calls then refuse them. `vscode-chat` is what VS Code's
 *  chat sends with this same app id, so the list and the call agree. Sent on
 *  `/models` AND on every chat/responses/messages call, so the picker never
 *  offers a row the call will refuse. */
const INTEGRATION_HEADERS: Record<string, string> = {
  "Copilot-Integration-Id": "vscode-chat",
  "Editor-Version": "vscode/1.104.0",
  "Editor-Plugin-Version": "copilot-chat/0.31.0",
}
const API_VERSION = "2026-06-01"
const UTILITY_MODELS = ["gpt-5.4-nano", "gpt-4.1", "gpt-4o", "gpt-4o-mini"]
// Small safety buffer when polling, against clock skew / timer drift.
const OAUTH_POLLING_SAFETY_MARGIN_MS = 3000 // 3 seconds
function normalizeDomain(url: string) {
  return url.replace(/^https?:\/\//, "").replace(/\/$/, "")
}

function getUrls(domain: string) {
  return {
    DEVICE_CODE_URL: `https://${domain}/login/device/code`,
    ACCESS_TOKEN_URL: `https://${domain}/login/oauth/access_token`,
  }
}

function base(enterpriseUrl?: string) {
  return enterpriseUrl ? `https://copilot-api.${normalizeDomain(enterpriseUrl)}` : "https://api.githubcopilot.com"
}

/** `ORIGAMI_COPILOT_TOKEN_URL` overrides the exchange endpoint wholesale (a full
 *  URL, not a domain). The ONLY reason to set it is a test fixture standing in for
 *  GitHub's own `copilot_internal/v2/token`; it is never a user-facing setting. */
function tokenUrl(enterpriseUrl?: string) {
  const override = process.env["ORIGAMI_COPILOT_TOKEN_URL"]
  if (override) return override
  const domain = enterpriseUrl ? normalizeDomain(enterpriseUrl) : "github.com"
  return `https://api.${domain}/copilot_internal/v2/token`
}

/**
 * THE INTEGRATOR LIVES IN THE SESSION TOKEN, NOT IN THE CHAT HEADERS.
 *
 * Every real Copilot client trades the GitHub OAuth token for a short-lived
 * Copilot session token at `copilot_internal/v2/token`, and the integrator named
 * on THAT call is what the API later reports. Send the GitHub token straight to
 * the chat endpoint and the caller is classified by the OAuth app alone
 * (`copilot-language-server`); `Copilot-Integration-Id` on the chat call changes
 * nothing.
 *
 * The exchange runs on EVERY request, not only calls to GitHub's own hosts — an
 * enterprise proxy, a corporate gateway or a record-mode test proxy sits in front
 * of the real upstream — and always targets `tokenUrl()`, derived from the stored
 * auth, never from the request. Cached per (token URL, GitHub token) until a
 * minute before `expires_at`, one exchange in flight. A refused exchange falls
 * back to the GitHub token so a transient 5xx does not take the provider down.
 */
type SessionToken = { token: string; expiresAt: number }
const sessionTokens = new Map<string, Promise<SessionToken | undefined>>()
const SESSION_TOKEN_SKEW_MS = 60_000

async function sessionToken(githubToken: string, enterpriseUrl?: string): Promise<string> {
  const url = tokenUrl(enterpriseUrl)
  const key = `${url}\u0000${githubToken}`
  // Read the map synchronously and only await when an entry already exists:
  // awaiting an unconditional `get` defers to a microtask even on a miss, which
  // let two concurrent callers both observe a miss and defeat the single flight.
  const existing = sessionTokens.get(key)
  if (existing) {
    const cached = await existing
    if (cached && cached.expiresAt - Date.now() > SESSION_TOKEN_SKEW_MS) return cached.token
  }
  const exchange = (async (): Promise<SessionToken | undefined> => {
    try {
      const response = await fetch(url, {
        headers: {
          Accept: "application/json",
          Authorization: `token ${githubToken}`,
          "User-Agent": `origami/${InstallationVersion}`,
          ...INTEGRATION_HEADERS,
        },
        signal: AbortSignal.timeout(10_000),
      })
      if (!response.ok) return undefined
      const data = (await response.json()) as { token?: unknown; expires_at?: unknown }
      if (typeof data.token !== "string" || !data.token) return undefined
      const expiresAt = typeof data.expires_at === "number" ? data.expires_at * 1000 : Date.now() + 25 * 60_000
      return { token: data.token, expiresAt }
    } catch {
      return undefined
    }
  })()
  sessionTokens.set(key, exchange)
  const fresh = await exchange
  if (!fresh) sessionTokens.delete(key)
  return fresh?.token ?? githubToken
}

/** Test-only: drops every cached exchange so a case that swaps
 *  `ORIGAMI_COPILOT_TOKEN_URL` does not see a previous case's session token. */
export function resetSessionTokensForTests() {
  sessionTokens.clear()
}

// Check if a message is a synthetic user msg used to attach an image from a tool call
function imgMsg(msg: any): boolean {
  if (msg?.role !== "user") return false

  // Handle the 3 api formats

  const content = msg.content
  if (typeof content === "string") return content === MessageV2.SYNTHETIC_ATTACHMENT_PROMPT
  if (!Array.isArray(content)) return false
  return content.some(
    (part: any) =>
      (part?.type === "text" || part?.type === "input_text") && part.text === MessageV2.SYNTHETIC_ATTACHMENT_PROMPT,
  )
}

function fix(model: Model, url: string): Model {
  return {
    ...model,
    api: {
      ...model.api,
      url,
      npm: "@ai-sdk/github-copilot",
    },
  }
}

export async function CopilotAuthPlugin(input: PluginInput): Promise<Hooks> {
  const sdk = input.client
  let models: Record<string, Model> = {}
  return {
    /** The FLOOR for a Copilot id written into origami.json by hand — the one case
     *  the live `models` hook below cannot reach: it corrects rows the database
     *  already has, and a hand-typed id has neither entry nor declaration. GitHub's
     *  own answer still wins for every id it lists — see capabilityDefaults.ts. */
    async config(cfg) {
      applyCapabilityDefaults(cfg, "github-copilot")
    },
    provider: {
      id: "github-copilot",
      async models(provider, ctx) {
        if (ctx.auth?.type !== "oauth") {
          models = {}
          return Object.fromEntries(Object.entries(provider.models).map(([id, model]) => [id, fix(model, base())]))
        }

        const auth = ctx.auth
        const bearer = await sessionToken(auth.refresh, auth.enterpriseUrl)

        return CopilotModels.get(
          base(auth.enterpriseUrl),
          {
            ...(provider.options?.headers as Record<string, string> | undefined),
            Authorization: `Bearer ${bearer}`,
            "User-Agent": `origami/${InstallationVersion}`,
            "X-GitHub-Api-Version": API_VERSION,
            ...INTEGRATION_HEADERS,
          },
          provider.models,
        )
          .then((result) => {
            models = result.models
            return Object.fromEntries(
              Object.entries(result.models).filter(([, model]) => result.pickerEnabled.has(model.api.id)),
            )
          })
          .catch((error) => {
            models = {}
            return Object.fromEntries(
              Object.entries(provider.models).map(([id, model]) => [id, fix(model, base(auth.enterpriseUrl))]),
            )
          })
      },
    },
    auth: {
      provider: "github-copilot",
      async loader(getAuth) {
        const info = await getAuth()
        if (!info || info.type !== "oauth") return {}

        return {
          apiKey: "",
          async fetch(request: RequestInfo | URL, init?: RequestInit) {
            const info = await getAuth()
            if (info.type !== "oauth") return fetch(request, init)

            const url = request instanceof URL ? request.href : typeof request === "string" ? request : request.url
            const { isVision, isAgent } = iife(() => {
              try {
                const body = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body

                // Completions API
                if (body?.messages && url.includes("completions")) {
                  const last = body.messages[body.messages.length - 1]
                  return {
                    isVision: body.messages.some(
                      (msg: any) =>
                        Array.isArray(msg.content) && msg.content.some((part: any) => part.type === "image_url"),
                    ),
                    isAgent: last?.role !== "user" || imgMsg(last),
                  }
                }

                // Responses API
                if (body?.input) {
                  const last = body.input[body.input.length - 1]
                  return {
                    isVision: body.input.some(
                      (item: any) =>
                        Array.isArray(item?.content) && item.content.some((part: any) => part.type === "input_image"),
                    ),
                    isAgent: last?.role !== "user" || imgMsg(last),
                  }
                }

                // Messages API
                if (body?.messages) {
                  const last = body.messages[body.messages.length - 1]
                  const hasNonToolCalls =
                    Array.isArray(last?.content) && last.content.some((part: any) => part?.type !== "tool_result")
                  return {
                    isVision: body.messages.some(
                      (item: any) =>
                        Array.isArray(item?.content) &&
                        item.content.some(
                          (part: any) =>
                            part?.type === "image" ||
                            // images can be nested inside tool_result content
                            (part?.type === "tool_result" &&
                              Array.isArray(part?.content) &&
                              part.content.some((nested: any) => nested?.type === "image")),
                        ),
                    ),
                    isAgent: !(last?.role === "user" && hasNonToolCalls) || imgMsg(last),
                  }
                }
              } catch {}
              return { isVision: false, isAgent: false }
            })

            const bearer = await sessionToken(info.refresh, info.enterpriseUrl)
            const headers: Record<string, string> = {
              "x-initiator": isAgent ? "agent" : "user",
              ...(init?.headers as Record<string, string>),
              "User-Agent": `origami/${InstallationVersion}`,
              Authorization: `Bearer ${bearer}`,
              "Openai-Intent": "conversation-edits",
              ...INTEGRATION_HEADERS,
            }

            if (isVision) {
              headers["Copilot-Vision-Request"] = "true"
            }

            delete headers["x-api-key"]
            delete headers["authorization"]

            const response = await fetch(request, {
              ...init,
              headers,
            })

            // Copilot has no separate token-refresh call: the device-flow token is
            // used directly as the bearer and is non-expiring, so the inference call
            // is the only place GitHub says the grant is bad and a first refusal is
            // not a false positive. Read only status/statusText, never the body.
            if (response.ok) {
              ProviderReauth.clear("github-copilot")
            } else if (response.status === 401 || response.status === 403) {
              // Narrower than `ProviderReauth.markIfRefused`'s own set, which also
              // counts 400. That is right on a token-REFRESH response, where 400 is
              // OAuth's `invalid_grant`. Here it is the INFERENCE endpoint, where a
              // 400 is a malformed body and says nothing about the credential.
              ProviderReauth.markIfRefused(
                "github-copilot",
                response.status,
                `GitHub Copilot request failed (${response.status})${response.statusText ? `: ${response.statusText}` : ""}`,
              )
            }

            return response
          },
        }
      },
      methods: [
        {
          type: "oauth",
          label: "Login with GitHub Copilot",
          prompts: [
            {
              type: "select",
              key: "deploymentType",
              message: "Select GitHub deployment type",
              options: [
                {
                  label: "GitHub.com",
                  value: "github.com",
                  hint: "Public",
                },
                {
                  label: "GitHub Enterprise",
                  value: "enterprise",
                  hint: "Data residency or self-hosted",
                },
              ],
            },
            {
              type: "text",
              key: "enterpriseUrl",
              message: "Enter your GitHub Enterprise URL or domain",
              placeholder: "company.ghe.com or https://company.ghe.com",
              when: { key: "deploymentType", op: "eq", value: "enterprise" },
              validate: (value) => {
                if (!value) return "URL or domain is required"
                try {
                  const url = value.includes("://") ? new URL(value) : new URL(`https://${value}`)
                  if (!url.hostname) return "Please enter a valid URL or domain"
                  return undefined
                } catch {
                  return "Please enter a valid URL (e.g., company.ghe.com or https://company.ghe.com)"
                }
              },
            },
          ],
          async authorize(inputs = {}) {
            const deploymentType = inputs.deploymentType || "github.com"

            let domain = "github.com"

            if (deploymentType === "enterprise") {
              const enterpriseUrl = inputs.enterpriseUrl
              domain = normalizeDomain(enterpriseUrl!)
            }

            const urls = getUrls(domain)

            const deviceResponse = await fetch(urls.DEVICE_CODE_URL, {
              method: "POST",
              headers: {
                Accept: "application/json",
                "Content-Type": "application/json",
                "User-Agent": `origami/${InstallationVersion}`,
              },
              body: JSON.stringify({
                client_id: CLIENT_ID,
                scope: "read:user",
              }),
            })

            if (!deviceResponse.ok) {
              throw new Error("Failed to initiate device authorization")
            }

            const deviceData = (await deviceResponse.json()) as {
              verification_uri: string
              user_code: string
              device_code: string
              interval: number
            }

            return {
              url: deviceData.verification_uri,
              instructions: `Enter code: ${deviceData.user_code}`,
              method: "auto" as const,
              async callback() {
                while (true) {
                  const response = await fetch(urls.ACCESS_TOKEN_URL, {
                    method: "POST",
                    headers: {
                      Accept: "application/json",
                      "Content-Type": "application/json",
                      "User-Agent": `origami/${InstallationVersion}`,
                    },
                    body: JSON.stringify({
                      client_id: CLIENT_ID,
                      device_code: deviceData.device_code,
                      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
                    }),
                  })

                  if (!response.ok) return { type: "failed" as const }

                  const data = (await response.json()) as {
                    access_token?: string
                    error?: string
                    interval?: number
                  }

                  if (data.access_token) {
                    const result: {
                      type: "success"
                      refresh: string
                      access: string
                      expires: number
                      provider?: string
                      enterpriseUrl?: string
                    } = {
                      type: "success",
                      refresh: data.access_token,
                      access: data.access_token,
                      expires: 0,
                    }

                    if (deploymentType === "enterprise") {
                      result.enterpriseUrl = domain
                    }

                    return result
                  }

                  if (data.error === "authorization_pending") {
                    await sleep(deviceData.interval * 1000 + OAUTH_POLLING_SAFETY_MARGIN_MS)
                    continue
                  }

                  if (data.error === "slow_down") {
                    // Based on the RFC spec, we must add 5 seconds to our current polling interval.
                    // (See https://www.rfc-editor.org/rfc/rfc8628#section-3.5)
                    let newInterval = (deviceData.interval + 5) * 1000

                    // Prefer the server's own interval (seconds) when it sends one.
                    const serverInterval = data.interval
                    if (serverInterval && typeof serverInterval === "number" && serverInterval > 0) {
                      newInterval = serverInterval * 1000
                    }

                    await sleep(newInterval + OAUTH_POLLING_SAFETY_MARGIN_MS)
                    continue
                  }

                  if (data.error) return { type: "failed" as const }

                  await sleep(deviceData.interval * 1000 + OAUTH_POLLING_SAFETY_MARGIN_MS)
                  continue
                }
              },
            }
          },
        },
      ],
    },
    "chat.params": async (incoming, output) => {
      if (!incoming.model.providerID.includes("github-copilot")) return

      // Match github copilot cli, omit maxOutputTokens for gpt models
      if (incoming.model.api.id.includes("gpt")) {
        output.maxOutputTokens = undefined
      }

      // GitHub Copilot's /v1/messages shim rejects the GA `eager_input_streaming`
      // field on tool definitions ("Extra inputs are not permitted"). Opt out of
      // the @ai-sdk/anthropic default so it stops injecting the field.
      if (incoming.model.api.npm === "@ai-sdk/anthropic") {
        output.options.toolStreaming = false
      }
    },
    "experimental.provider.small_model": async (incoming, output) => {
      if (incoming.provider.id !== "github-copilot") return
      // GitHub exposes utility models for title generation without including them in the picker.
      output.model = UTILITY_MODELS.map((id) => models[id]).find((model) => model !== undefined)
    },
    "chat.headers": async (incoming, output) => {
      if (!incoming.model.providerID.includes("github-copilot")) return

      output.headers["X-GitHub-Api-Version"] = API_VERSION
      if (incoming.agent === "title") {
        output.headers["X-Interaction-Type"] = "agent-session-name-generation"
      }

      if (incoming.model.api.npm === "@ai-sdk/anthropic") {
        output.headers["anthropic-beta"] = "interleaved-thinking-2025-05-14"
      }

      const parts = await sdk.session
        .message({
          path: {
            id: incoming.message.sessionID,
            messageID: incoming.message.id,
          },
          query: {
            directory: input.directory,
          },
          throwOnError: true,
        })
        .catch(() => undefined)

      if (
        parts?.data.parts?.some(
          (part) =>
            part.type === "compaction" ||
            // Auto-compaction resumes via a synthetic user text part. Treat only
            // that marked followup as agent-initiated so manual prompts stay user-initiated.
            (part.type === "text" && part.synthetic && part.metadata?.compaction_continue === true),
        )
      ) {
        output.headers["x-initiator"] = "agent"
        return
      }

      const session = await sdk.session
        .get({
          path: {
            id: incoming.sessionID,
          },
          query: {
            directory: input.directory,
          },
          throwOnError: true,
        })
        .catch(() => undefined)
      if (!session || !session.data.parentID) return
      // mark subagent sessions as agent initiated matching standard that other copilot tools have
      output.headers["x-initiator"] = "agent"
    },
  }
}
