// Subscription usage for an OAuth connection: the parsers and the two HTTP calls.
//
// WHY THESE FIXTURES ARE FRESH, NOT LIFTED. `chatgpt.com/backend-api/wham/usage`
// is a PRIVATE endpoint — OpenAI publishes no schema for it. The bodies below
// are written from the field names four independent sources agree on
// (Codex-LB's proxy docs, openai/codex's own `RateLimitSnapshot` after mapping,
// pi-codex-status, CodexBar) and NOT copied from any live response, so no
// account data is in this repo and nothing here needs the network.
//
// Grok's fixtures follow the same rule: the field NAMES are read verbatim from
// steipete/CodexBar's shipped Swift source for the same reason (xAI publishes
// no schema of its own for `cli-chat-proxy.grok.com`), the NUMBERS are invented.
//
// WHAT THESE TESTS ARE FOR. The whole risk of the feature is that a private,
// unversioned body changes shape and the fold starts rendering a confident
// wrong percentage. Every case below is therefore a MALFORMED or SHIFTED body
// asserting the same requirement: an unreadable answer degrades to
// `unavailable`, never to a number. The happy path is one test; the refusals
// are the rest.

import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import {
  ACPProviderUsage,
  fetchChatgptUsage,
  fetchGrokUsage,
  parseChatgptUsage,
  parseGrokUsage,
  usageGate,
  type FetchLike,
} from "@/acp/provider-usage"
import { Auth } from "@/auth"

/** 2026-08-15T10:00:00Z — a fixed clock so `resetsAt` maths is checkable. */
const NOW = 1_786_874_400_000

/** A body in the documented shape: a 5-hour lane and a weekly one. */
const fullBody = {
  plan_type: "plus",
  rate_limit: {
    allowed: true,
    limit_reached: false,
    primary_window: { used_percent: 12, limit_window_seconds: 18000, reset_after_seconds: 9000, reset_at: 1_786_883_400 },
    secondary_window: { used_percent: 47.5, limit_window_seconds: 604800, reset_after_seconds: 300000, reset_at: 1_787_174_400 },
  },
  credits: { has_credits: true, unlimited: false, balance: "12.34" },
}

const oauth = (over: Partial<Auth.Oauth> = {}): Auth.Oauth =>
  // Both secrets are distinctive strings on purpose: a 2-character refresh token
  // would make the "no token crosses back" assertion pass by accident.
  ({
    type: "oauth",
    access: "at-not-a-real-access-token",
    refresh: "rt-not-a-real-refresh-token",
    expires: NOW + 3_600_000,
    ...over,
  }) as Auth.Oauth

// GROK FIXTURES — field names read verbatim from steipete/CodexBar's shipped
// Swift source (Sources/CodexBarCore/Providers/Grok/GrokCreditsProxyFetcher.swift,
// main branch, read 2026-08-15), NOT copied from any live response: the numbers
// below are invented, the SHAPE is not.

/** 2026-09-01T00:00:00Z in epoch millis — `Date.parse`'s own answer, checked once. */
const SEPT_1_2026 = 1_788_220_800_000
/** 2026-09-05T00:00:00Z in epoch millis. */
const SEPT_5_2026 = 1_788_566_400_000

/** A body carrying both the plan percentage AND a usable on-demand ratio. */
const grokCreditsBody = {
  config: {
    creditUsagePercent: 34.5,
    currentPeriod: { end: "2026-09-01T00:00:00Z" },
    billingPeriodEnd: "2026-08-01T00:00:00Z",
    onDemandCap: { val: 500 },
    onDemandUsed: { val: 125 },
  },
}

/** A fetch that never touches the network. Records what it was asked for. */
const stubFetch = (
  response: { ok?: boolean; status?: number; json?: () => Promise<unknown> },
  seen?: { url?: string; headers?: Record<string, string> },
): FetchLike =>
  async (url, init) => {
    if (seen) {
      seen.url = url
      seen.headers = init.headers
    }
    return {
      ok: response.ok ?? true,
      status: response.status ?? 200,
      json: response.json ?? (async () => fullBody),
    }
  }

describe("parseChatgptUsage — a documented body becomes windows", () => {
  test("both lanes are read, labelled by their length, and the plan comes through", () => {
    const result = parseChatgptUsage(fullBody, NOW)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("unreachable")
    expect(result.plan).toBe("plus")
    expect(result.windows).toEqual([
      { label: "5-hour", usedPercent: 12, resetsAt: 1_786_883_400_000 },
      { label: "Weekly", usedPercent: 47.5, resetsAt: 1_787_174_400_000 },
    ])
  })

  test("reset_at in SECONDS becomes epoch MILLIS — the units the webview renders", () => {
    // The whole point of the seconds/millis guard: 1_786_883_400 is 2026, not 1970.
    const result = parseChatgptUsage(fullBody, NOW)
    if (!result.ok) throw new Error("unreachable")
    expect(result.windows[0]!.resetsAt).toBe(1_786_883_400 * 1000)
    expect(new Date(result.windows[0]!.resetsAt!).getUTCFullYear()).toBe(2026)
  })

  test("a body already in MILLIS is not multiplied again", () => {
    const result = parseChatgptUsage(
      { rate_limit: { primary_window: { used_percent: 5, limit_window_seconds: 18000, reset_at: 1_786_883_400_000 } } },
      NOW,
    )
    if (!result.ok) throw new Error("unreachable")
    expect(result.windows[0]!.resetsAt).toBe(1_786_883_400_000)
  })

  test("no reset_at falls back to reset_after_seconds measured from now", () => {
    const result = parseChatgptUsage(
      { rate_limit: { primary_window: { used_percent: 5, limit_window_seconds: 18000, reset_after_seconds: 600 } } },
      NOW,
    )
    if (!result.ok) throw new Error("unreachable")
    expect(result.windows[0]!.resetsAt).toBe(NOW + 600_000)
  })

  test("neither reset field leaves resetsAt absent rather than inventing one", () => {
    const result = parseChatgptUsage({ rate_limit: { primary_window: { used_percent: 5 } } }, NOW)
    if (!result.ok) throw new Error("unreachable")
    expect(result.windows[0]!.resetsAt).toBeUndefined()
    // With no window length there is no length to name it by — the positional
    // fallback is used rather than a guessed "5-hour".
    expect(result.windows[0]!.label).toBe("Session")
  })

  test("a lane with no used_percent is DROPPED, not rendered as 0%", () => {
    // Reporting 0% for a field the body omitted reads as "plenty left" — the
    // exact wrong answer to give someone who is about to be cut off.
    const result = parseChatgptUsage(
      {
        rate_limit: {
          primary_window: { limit_window_seconds: 18000, reset_at: 1_786_883_400 },
          secondary_window: { used_percent: 90, limit_window_seconds: 604800 },
        },
      },
      NOW,
    )
    if (!result.ok) throw new Error("unreachable")
    expect(result.windows).toHaveLength(1)
    expect(result.windows[0]!.label).toBe("Weekly")
  })

  test("an over-100 percentage is clamped so a progress bar cannot overflow its track", () => {
    const result = parseChatgptUsage({ rate_limit: { primary_window: { used_percent: 103 } } }, NOW)
    if (!result.ok) throw new Error("unreachable")
    expect(result.windows[0]!.usedPercent).toBe(100)
  })
})

describe("parseChatgptUsage — an unreadable body degrades to unavailable, never to a number", () => {
  const unreadable: Array<[string, unknown]> = [
    ["null", null],
    ["an array", [{ used_percent: 50 }]],
    ["a string", "rate limited"],
    ["an empty object", {}],
    ["rate_limit present but empty", { rate_limit: {} }],
    ["windows renamed (a shape change we did not follow)", { rate_limit: { five_hour_limit: { used_percent: 12 } } }],
    ["used_percent as a string", { rate_limit: { primary_window: { used_percent: "12" } } }],
    ["used_percent NaN", { rate_limit: { primary_window: { used_percent: Number.NaN } } }],
    ["an error envelope instead of usage", { detail: "Unauthorized" }],
  ]
  for (const [name, body] of unreadable) {
    test(name, () => {
      const result = parseChatgptUsage(body, NOW)
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error("unreachable")
      expect(result.unavailable.length).toBeGreaterThan(0)
      // The reason is shown verbatim in a fold — it must not carry a stack.
      expect(result.unavailable).not.toContain("at ")
    })
  }
})

describe("parseGrokUsage — a credits body becomes windows", () => {
  test("creditUsagePercent wins over the on-demand ratio, and a usable ratio still gets its own row", () => {
    const result = parseGrokUsage(grokCreditsBody, NOW)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("unreachable")
    expect(result.windows).toEqual([
      { label: "Credits", usedPercent: 34.5, resetsAt: SEPT_1_2026 },
      { label: "On-demand", usedPercent: 25, resetsAt: SEPT_1_2026 },
    ])
  })

  test("currentPeriod.end wins over billingPeriodEnd when both are present", () => {
    const result = parseGrokUsage(grokCreditsBody, NOW)
    if (!result.ok) throw new Error("unreachable")
    // grokCreditsBody's billingPeriodEnd is a full month earlier — if this were
    // used by mistake, resetsAt would not equal SEPT_1_2026.
    expect(result.windows[0]!.resetsAt).toBe(SEPT_1_2026)
  })

  test("billingPeriodEnd is used when currentPeriod is absent", () => {
    const result = parseGrokUsage({ config: { creditUsagePercent: 10, billingPeriodEnd: "2026-09-05T00:00:00Z" } }, NOW)
    if (!result.ok) throw new Error("unreachable")
    expect(result.windows[0]!.resetsAt).toBe(SEPT_5_2026)
  })

  test("no on-demand fields present — only the Credits window, no second row", () => {
    const result = parseGrokUsage({ config: { creditUsagePercent: 10 } }, NOW)
    if (!result.ok) throw new Error("unreachable")
    expect(result.windows).toHaveLength(1)
    expect(result.windows[0]!.resetsAt).toBeUndefined()
  })

  test("an onDemandCap of 0 does not divide by zero, and the second row is skipped", () => {
    const result = parseGrokUsage({ config: { creditUsagePercent: 10, onDemandCap: { val: 0 }, onDemandUsed: { val: 5 } } }, NOW)
    if (!result.ok) throw new Error("unreachable")
    expect(result.windows).toHaveLength(1)
  })

  test("when creditUsagePercent is absent, the on-demand ratio becomes the PRIMARY window — not a duplicated second row", () => {
    const result = parseGrokUsage(
      { config: { onDemandCap: { val: 200 }, onDemandUsed: { val: 50 }, currentPeriod: { end: "2026-09-01T00:00:00Z" } } },
      NOW,
    )
    if (!result.ok) throw new Error("unreachable")
    expect(result.windows).toEqual([{ label: "Credits", usedPercent: 25, resetsAt: SEPT_1_2026 }])
  })

  test("neither figure present but a period end DID parse: reported as 0% used, not unavailable", () => {
    // This is the one branch in the source that is not an error path — a
    // current period with nothing spent yet is real data, not a missing body.
    const result = parseGrokUsage({ config: { currentPeriod: { end: "2026-09-01T00:00:00Z" } } }, NOW)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("unreachable")
    expect(result.windows).toEqual([{ label: "Credits", usedPercent: 0, resetsAt: SEPT_1_2026 }])
  })

  test("an over-100 percentage is clamped so a progress bar cannot overflow its track", () => {
    const result = parseGrokUsage({ config: { creditUsagePercent: 150 } }, NOW)
    if (!result.ok) throw new Error("unreachable")
    expect(result.windows[0]!.usedPercent).toBe(100)
  })

  test("a negative percentage is clamped up to 0", () => {
    const result = parseGrokUsage({ config: { creditUsagePercent: -5 } }, NOW)
    if (!result.ok) throw new Error("unreachable")
    expect(result.windows[0]!.usedPercent).toBe(0)
  })
})

describe("parseGrokUsage — an unreadable body degrades to unavailable, never to a number", () => {
  const unreadable: Array<[string, unknown]> = [
    ["null", null],
    ["an array", [{ creditUsagePercent: 50 }]],
    ["a string", "insufficient credits"],
    ["an empty object", {}],
    ["config missing entirely", { other: 1 }],
    ["config present but empty — no percent, no ratio, no period", { config: {} }],
    ["onDemandCap present but zero, nothing else parseable", { config: { onDemandCap: { val: 0 }, onDemandUsed: { val: 5 } } }],
    ["onDemandCap present but onDemandUsed missing, nothing else parseable", { config: { onDemandCap: { val: 100 } } }],
    ["creditUsagePercent as a string", { config: { creditUsagePercent: "34.5" } }],
    ["creditUsagePercent non-finite", { config: { creditUsagePercent: Number.POSITIVE_INFINITY } }],
    ["currentPeriod.end is not a parseable date, and nothing else parses", { config: { currentPeriod: { end: "not-a-date" } } }],
    ["an error envelope instead of credits", { error: "Authentication required" }],
  ]
  for (const [name, body] of unreadable) {
    test(name, () => {
      const result = parseGrokUsage(body, NOW)
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error("unreachable")
      expect(result.unavailable.length).toBeGreaterThan(0)
      expect(result.unavailable).not.toContain("at ")
    })
  }
})

/** Narrow a gate answer to its refusal, failing loudly if it let the call through. */
const refusalOf = (result: ReturnType<typeof usageGate>) => {
  if (!result || result.ok) throw new Error("expected usageGate to refuse, but it allowed the call")
  return result
}

describe("usageGate — which connections have a usage source at all", () => {
  test("a Grok OAuth credential is the ONLY combination that proceeds for xai", () => {
    // Same rule as openai: a usable OAuth credential is the sole path through.
    expect(usageGate("xai", oauth())).toBeUndefined()
  })

  test("an API-KEY credential on the xai id is refused as the wrong kind of account", () => {
    // plugin/xai.ts's own setup fold offers a separate "Grok (API)" API-key
    // entry — that connection is metered per token and has no credits window,
    // so "not signed in" would be a lie to someone who is, with a key.
    const result = refusalOf(usageGate("xai", { type: "api", key: "xai-not-a-real-key" } as Auth.Info))
    expect(result.unavailable).toContain("API key is metered")
    expect(result.unavailable).toContain("Grok")
  })

  test("no credential at all for xai is refused, and the name is Grok not the raw provider id", () => {
    expect(refusalOf(usageGate("xai", undefined)).unavailable).toContain("Grok")
  })

  test("an unknown provider is refused rather than sent to ChatGPT's endpoint", () => {
    // The guard that matters: nothing but `openai` may reach chatgpt.com. A
    // fall-through here would put an anthropic or lmstudio credential on a
    // request to OpenAI.
    for (const id of ["anthropic", "lmstudio", "openrouter", ""]) {
      expect(refusalOf(usageGate(id, oauth())).unavailable).toBeTruthy()
    }
  })

  test("an API-KEY credential on the openai id is refused as the wrong kind of account", () => {
    // Both connections share one provider id. A platform key is metered per
    // token and has no plan window, so "not signed in" would be a lie to someone
    // who is signed in — with a key.
    const result = refusalOf(usageGate("openai", { type: "api", key: "sk-not-a-real-key" } as Auth.Info))
    expect(result.unavailable).toContain("API key is metered")
  })

  test("no credential at all is refused", () => {
    expect(refusalOf(usageGate("openai", undefined)).unavailable).toBeTruthy()
  })

  test("an openai OAuth credential is the ONLY combination that proceeds", () => {
    expect(usageGate("openai", oauth())).toBeUndefined()
  })
})

describe("fetchChatgptUsage — the one call", () => {
  test("sends the bearer and the account id, exactly as codex.ts does on a chat request", async () => {
    const seen: { url?: string; headers?: Record<string, string> } = {}
    await fetchChatgptUsage(oauth({ accountId: "acct-123" }), NOW, stubFetch({}, seen))
    expect(seen.url).toBe("https://chatgpt.com/backend-api/wham/usage")
    expect(seen.headers?.["Authorization"]).toBe("Bearer at-not-a-real-access-token")
    expect(seen.headers?.["ChatGPT-Account-Id"]).toBe("acct-123")
  })

  test("omits the account header entirely when the credential carries no account id", async () => {
    const seen: { url?: string; headers?: Record<string, string> } = {}
    await fetchChatgptUsage(oauth(), NOW, stubFetch({}, seen))
    expect(seen.headers && "ChatGPT-Account-Id" in seen.headers).toBe(false)
  })

  test("an expired credential is reported as expired WITHOUT a call being made", async () => {
    // No refresh is possible from here (codex.ts keeps refreshAccessToken
    // private), so spending a request to earn a 401 would be pure noise.
    let called = false
    const result = await fetchChatgptUsage(oauth({ expires: NOW - 1 }), NOW, async () => {
      called = true
      throw new Error("must not be called")
    })
    expect(called).toBe(false)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("unreachable")
    expect(result.unavailable).toContain("expired")
  })

  test("401 and 403 say re-authorize; another status names itself", async () => {
    for (const status of [401, 403]) {
      const result = await fetchChatgptUsage(oauth(), NOW, stubFetch({ ok: false, status }))
      if (result.ok) throw new Error("unreachable")
      expect(result.unavailable).toContain("Re-authorize")
    }
    const server = await fetchChatgptUsage(oauth(), NOW, stubFetch({ ok: false, status: 503 }))
    if (server.ok) throw new Error("unreachable")
    expect(server.unavailable).toContain("503")
  })

  test("a thrown fetch (offline) is an unavailable line, not a crash", async () => {
    const result = await fetchChatgptUsage(oauth(), NOW, async () => {
      throw new Error("getaddrinfo ENOTFOUND chatgpt.com")
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("unreachable")
    // The DNS text must not reach the fold.
    expect(result.unavailable).not.toContain("ENOTFOUND")
  })

  test("a 200 with a non-JSON body is unavailable, not a throw", async () => {
    const result = await fetchChatgptUsage(
      oauth(),
      NOW,
      stubFetch({
        json: async () => {
          throw new SyntaxError("Unexpected token < in JSON at position 0")
        },
      }),
    )
    expect(result.ok).toBe(false)
  })

  test("NO TOKEN crosses back in the result, on any path", async () => {
    const results = [
      await fetchChatgptUsage(oauth({ accountId: "acct-123" }), NOW, stubFetch({})),
      await fetchChatgptUsage(oauth(), NOW, stubFetch({ ok: false, status: 401 })),
      await fetchChatgptUsage(oauth({ expires: NOW - 1 }), NOW, stubFetch({})),
    ]
    for (const result of results) {
      const serialised = JSON.stringify(result)
      expect(serialised).not.toContain("at-not-a-real-access-token")
      expect(serialised).not.toContain("rt-not-a-real-refresh-token")
    }
  })
})

describe("fetchGrokUsage — the one call", () => {
  test("sends the bearer and the xai-grok-cli auth header, exactly as the Grok CLI's own proxy request does", async () => {
    const seen: { url?: string; headers?: Record<string, string> } = {}
    await fetchGrokUsage(oauth(), NOW, stubFetch({ json: async () => grokCreditsBody }, seen))
    expect(seen.url).toBe("https://cli-chat-proxy.grok.com/v1/billing?format=credits")
    expect(seen.headers?.["Authorization"]).toBe("Bearer at-not-a-real-access-token")
    expect(seen.headers?.["x-xai-token-auth"]).toBe("xai-grok-cli")
    expect(seen.headers?.["Accept"]).toBe("application/json")
  })

  test("a 200 happy path returns the parsed windows", async () => {
    const result = await fetchGrokUsage(oauth(), NOW, stubFetch({ json: async () => grokCreditsBody }))
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("unreachable")
    expect(result.windows.map((w) => w.label)).toEqual(["Credits", "On-demand"])
  })

  test("an expired credential is reported as expired WITHOUT a call being made", async () => {
    let called = false
    const result = await fetchGrokUsage(oauth({ expires: NOW - 1 }), NOW, async () => {
      called = true
      throw new Error("must not be called")
    })
    expect(called).toBe(false)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("unreachable")
    expect(result.unavailable).toContain("expired")
  })

  test("403 says re-authorize; 404 names itself", async () => {
    const forbidden = await fetchGrokUsage(oauth(), NOW, stubFetch({ ok: false, status: 403 }))
    if (forbidden.ok) throw new Error("unreachable")
    expect(forbidden.unavailable).toContain("Re-authorize")
    const notFound = await fetchGrokUsage(oauth(), NOW, stubFetch({ ok: false, status: 404 }))
    if (notFound.ok) throw new Error("unreachable")
    expect(notFound.unavailable).toContain("404")
  })

  test("a thrown fetch (offline) is an unavailable line, not a crash", async () => {
    const result = await fetchGrokUsage(oauth(), NOW, async () => {
      throw new Error("getaddrinfo ENOTFOUND cli-chat-proxy.grok.com")
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("unreachable")
    expect(result.unavailable).not.toContain("ENOTFOUND")
  })

  test("a thrown fetch representing a client-side timeout is an unavailable line, not a crash", async () => {
    // fetchGrokUsage has no timeout logic of its own — a timeout is whatever the
    // injected fetchImpl throws, same as offline or DNS failure above. This case
    // exists to prove that path explicitly, not to add new handling for it.
    const result = await fetchGrokUsage(oauth(), NOW, async () => {
      throw new Error("The operation timed out.")
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("unreachable")
    expect(result.unavailable).not.toContain("timed out")
  })

  test("a 200 with a non-JSON body is unavailable, not a throw", async () => {
    const result = await fetchGrokUsage(
      oauth(),
      NOW,
      stubFetch({
        json: async () => {
          throw new SyntaxError("Unexpected token < in JSON at position 0")
        },
      }),
    )
    expect(result.ok).toBe(false)
  })

  test("NO TOKEN crosses back in the result, on any path", async () => {
    const results = [
      await fetchGrokUsage(oauth(), NOW, stubFetch({ json: async () => grokCreditsBody })),
      await fetchGrokUsage(oauth(), NOW, stubFetch({ ok: false, status: 401 })),
      await fetchGrokUsage(oauth({ expires: NOW - 1 }), NOW, stubFetch({})),
    ]
    for (const result of results) {
      const serialised = JSON.stringify(result)
      expect(serialised).not.toContain("at-not-a-real-access-token")
      expect(serialised).not.toContain("rt-not-a-real-refresh-token")
    }
  })
})

/**
 * The Effect itself, over a mocked credential store.
 *
 * `usage` needs only `Auth.Service` — no instance, no directory — so the whole
 * end-to-end path (read the credential, gate on it, make the one call) runs
 * under a single mock layer with the fetch seam injected.
 */
describe("ACPProviderUsage.usage — reading the stored credential", () => {
  const store = (data: Record<string, Auth.Info>) =>
    Layer.mock(Auth.Service)({
      all: () => Effect.succeed(data),
      get: (providerID: string) => Effect.succeed(data[providerID]),
      set: () => Effect.void,
      remove: () => Effect.void,
    })

  const run = <A>(data: Record<string, Auth.Info>, effect: Effect.Effect<A, never, Auth.Service>) =>
    Effect.runPromise(effect.pipe(Effect.provide(store(data))))

  test("an openai OAuth credential reaches the call, and the windows come back", async () => {
    const result = await run(
      { openai: oauth({ accountId: "acct-9" }) },
      ACPProviderUsage.usage("openai", stubFetch({}), NOW),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("unreachable")
    expect(result.windows.map((w) => w.label)).toEqual(["5-hour", "Weekly"])
  })

  test("a Grok OAuth credential reaches the call, and the windows come back", async () => {
    const result = await run(
      { xai: oauth() },
      ACPProviderUsage.usage("xai", stubFetch({ json: async () => grokCreditsBody }), NOW),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("unreachable")
    expect(result.windows.map((w) => w.label)).toEqual(["Credits", "On-demand"])
  })

  test("an xai API-key credential is refused BY NAME WITHOUT any call being made", async () => {
    let called = false
    const result = await run(
      { xai: { type: "api", key: "xai-not-a-real-key" } as Auth.Info },
      ACPProviderUsage.usage(
        "xai",
        async () => {
          called = true
          throw new Error("must not be called")
        },
        NOW,
      ),
    )
    expect(called).toBe(false)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("unreachable")
    expect(result.unavailable).toContain("Grok")
  })

  test("an empty credential store is a refusal, not a crash", async () => {
    const result = await run({}, ACPProviderUsage.usage("openai", stubFetch({}), NOW))
    expect(result.ok).toBe(false)
  })

  test("SECRETS IN THE STORE NEVER REACH THE RESULT", async () => {
    const result = await run(
      { openai: oauth(), other: { type: "api", key: "SECRET-KEY" } as Auth.Info },
      ACPProviderUsage.usage("openai", stubFetch({}), NOW),
    )
    const wire = JSON.stringify(result)
    expect(wire).not.toContain("at-not-a-real-access-token")
    expect(wire).not.toContain("SECRET-KEY")
  })
})
