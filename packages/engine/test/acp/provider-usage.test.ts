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
  fetchGoUsage,
  fetchGrokUsage,
  parseChatgptUsage,
  parseGoUsage,
  parseGrokUsage,
  usageGate,
  type FetchLike,
} from "@/acp/provider-usage"
import { Auth } from "@/auth"
import { Config } from "@/config/config"

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

// OPENCODE GO FIXTURES — the field names and the three lane keys are read from
// the upstream route that serves this body (anomalyco/opencode,
// packages/console/app/src/routes/zen/go/v1/usage.ts, commit 2b8a5969) and were
// confirmed against ONE live 200 on 2026-08-28. The percentages and the
// timestamps below are invented; the SHAPE is not, and no account data is here.

/** 2026-08-28T14:26:47Z in epoch millis — `Date.parse`'s own answer. */
const GO_ROLLING_RESET = 1_787_927_207_000
/** 2026-08-31T00:00:00Z in epoch millis. */
const GO_WEEKLY_RESET = 1_788_134_400_000
/** 2026-09-21T07:47:07Z in epoch millis. */
const GO_MONTHLY_RESET = 1_789_976_827_000

/** All three lanes, in the order the endpoint serves them. */
const goUsageBody = {
  usage: {
    rolling: { status: "ok", percent: 30, resetsAt: "2026-08-28T14:26:47.000Z" },
    weekly: { status: "ok", percent: 12, resetsAt: "2026-08-31T00:00:00.000Z" },
    monthly: { status: "ok", percent: 6, resetsAt: "2026-09-21T07:47:07.000Z" },
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
    // Weekly FIRST — the pill renders only windows[0], and the weekly cap is
    // the budget a user actually manages (same rule as the GO lanes).
    expect(result.windows).toEqual([
      { label: "Weekly", usedPercent: 47.5, resetsAt: 1_787_174_400_000 },
      { label: "5-hour", usedPercent: 12, resetsAt: 1_786_883_400_000 },
    ])
  })

  test("reset_at in SECONDS becomes epoch MILLIS — the units the webview renders", () => {
    // The whole point of the seconds/millis guard: 1_787_174_400 is 2026, not 1970.
    const result = parseChatgptUsage(fullBody, NOW)
    if (!result.ok) throw new Error("unreachable")
    expect(result.windows[0]!.resetsAt).toBe(1_787_174_400 * 1000)
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

describe("parseGoUsage — the three subscription lanes", () => {
  test("all three lanes are read, IN ORDER, with the labels the pill renders", () => {
    // The order is the requirement, not an incidental: the model-bar pill shows
    // only the FIRST line, and the WEEKLY cap is the budget a user manages.
    const result = parseGoUsage(goUsageBody)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("unreachable")
    expect(result.plan).toBe("go")
    expect(result.windows).toEqual([
      { label: "Weekly", usedPercent: 12, resetsAt: GO_WEEKLY_RESET },
      { label: "5-hour", usedPercent: 30, resetsAt: GO_ROLLING_RESET },
      { label: "Monthly", usedPercent: 6, resetsAt: GO_MONTHLY_RESET },
    ])
  })

  test("resetsAt is ABSOLUTE — `now` is never added to it", () => {
    // The ChatGPT lane adds `reset_after_seconds` to now. Doing that here would
    // push a reset 56 years out and the line would read "resets in 20000d".
    const result = parseGoUsage(goUsageBody)
    if (!result.ok) throw new Error("unreachable")
    expect(result.windows[0]!.resetsAt).toBe(Date.parse("2026-08-31T00:00:00.000Z"))
    expect(new Date(result.windows[0]!.resetsAt!).getUTCFullYear()).toBe(2026)
  })

  test("a rate-limited lane is a 100% lane, not an error", () => {
    // `status` is not rendered: at the point it flips to "rate-limited" the
    // percentage already says the same thing, in the vocabulary the row uses.
    const result = parseGoUsage({
      usage: { rolling: { status: "rate-limited", percent: 100, resetsAt: "2026-08-31T00:00:00.000Z" } },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("unreachable")
    expect(result.windows).toEqual([{ label: "5-hour", usedPercent: 100, resetsAt: GO_WEEKLY_RESET }])
  })

  test("a lane the body omits is skipped, and the ones present keep their order", () => {
    const result = parseGoUsage({
      usage: { monthly: { status: "ok", percent: 6 }, rolling: { status: "ok", percent: 30 } },
    })
    if (!result.ok) throw new Error("unreachable")
    expect(result.windows.map((w) => w.label)).toEqual(["5-hour", "Monthly"])
  })

  test("a lane with no percent is DROPPED, not rendered as 0%", () => {
    const result = parseGoUsage({
      usage: { rolling: { status: "ok", resetsAt: "2026-08-31T00:00:00.000Z" }, weekly: { status: "ok", percent: 12 } },
    })
    if (!result.ok) throw new Error("unreachable")
    expect(result.windows).toHaveLength(1)
    expect(result.windows[0]!.label).toBe("Weekly")
  })

  test("an unparseable resetsAt leaves the lane WITHOUT a reset rather than dropping it", () => {
    const result = parseGoUsage({ usage: { rolling: { status: "ok", percent: 30, resetsAt: "not-a-date" } } })
    if (!result.ok) throw new Error("unreachable")
    expect(result.windows).toEqual([{ label: "5-hour", usedPercent: 30 }])
  })

  test("an over-100 percentage is clamped so a progress bar cannot overflow its track", () => {
    const result = parseGoUsage({ usage: { rolling: { percent: 140 } } })
    if (!result.ok) throw new Error("unreachable")
    expect(result.windows[0]!.usedPercent).toBe(100)
  })

  test("a FRESH subscription reports 0 on every lane, and every lane is kept", () => {
    // The reason `percent === undefined` and `percent === 0` must not collapse
    // into one check: a plan nobody has spent against yet reports three zeroes,
    // and dropping them would tell a working subscription it has no quota
    // window at all — on the first day it is used.
    const result = parseGoUsage({
      usage: {
        rolling: { status: "ok", percent: 0, resetsAt: "2026-08-31T00:00:00.000Z" },
        weekly: { status: "ok", percent: 0 },
        monthly: { status: "ok", percent: 0 },
      },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("unreachable")
    expect(result.windows).toHaveLength(3)
    expect(result.windows.map((w) => w.usedPercent)).toEqual([0, 0, 0])
  })

  test("a negative percentage is clamped up to 0", () => {
    const result = parseGoUsage({ usage: { rolling: { percent: -3 } } })
    if (!result.ok) throw new Error("unreachable")
    expect(result.windows[0]!.usedPercent).toBe(0)
  })
})

describe("parseGoUsage — an unreadable body degrades to unavailable, never to a number", () => {
  const unreadable: Array<[string, unknown]> = [
    ["null", null],
    ["an array", [{ percent: 50 }]],
    // A 404 on opencode.ai answers an HTML page, which is why a non-object body
    // has to be a refusal and not a throw.
    ["an HTML error page", "<!DOCTYPE html><html><body>Not found</body></html>"],
    ["an empty object", {}],
    ["usage present but empty", { usage: {} }],
    ["lanes renamed (a shape change we did not follow)", { usage: { five_hour: { percent: 30 } } }],
    ["the lanes hoisted to the top level", { rolling: { percent: 30 } }],
    ["percent as a string", { usage: { rolling: { percent: "30" } } }],
    ["percent NaN", { usage: { rolling: { percent: Number.NaN } } }],
    ["an auth error envelope instead of usage", { type: "AuthError", message: "Invalid API key" }],
  ]
  for (const [name, body] of unreadable) {
    test(name, () => {
      const result = parseGoUsage(body)
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error("unreachable")
      expect(result.unavailable.length).toBeGreaterThan(0)
      // The reason is shown verbatim in the pill's tooltip — no stack.
      expect(result.unavailable).not.toContain("at ")
    })
  }
})

describe("fetchGoUsage — the one call", () => {
  test("sends the key as a BEARER, which is the only header this endpoint accepts", async () => {
    // Measured against the live endpoint on 2026-08-28: `x-api-key` — the
    // header the GO chat path uses — answers 401 here, `Bearer` answers 200.
    const seen: { url?: string; headers?: Record<string, string> } = {}
    await fetchGoUsage("sk-not-a-real-go-key", stubFetch({ json: async () => goUsageBody }, seen))
    expect(seen.url).toBe("https://opencode.ai/zen/go/v1/usage")
    expect(seen.headers?.["Authorization"]).toBe("Bearer sk-not-a-real-go-key")
    expect(seen.headers?.["Accept"]).toBe("application/json")
    expect(seen.headers && "x-api-key" in seen.headers).toBe(false)
  })

  test("a 200 happy path returns all three windows", async () => {
    const result = await fetchGoUsage("sk-not-a-real-go-key", stubFetch({ json: async () => goUsageBody }))
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("unreachable")
    expect(result.windows.map((w) => w.label)).toEqual(["Weekly", "5-hour", "Monthly"])
  })

  test("403 names the missing SUBSCRIPTION; 401 names the KEY — they are different problems", async () => {
    // Upstream answers 403 EntitlementError for a valid key on an account with
    // no Go plan. Telling that user to check their key sends them to fix
    // something that is already correct.
    const noPlan = await fetchGoUsage("k", stubFetch({ ok: false, status: 403 }))
    if (noPlan.ok) throw new Error("unreachable")
    expect(noPlan.unavailable).toContain("subscription")
    const badKey = await fetchGoUsage("k", stubFetch({ ok: false, status: 401 }))
    if (badKey.ok) throw new Error("unreachable")
    expect(badKey.unavailable).toContain("key")
    expect(badKey.unavailable).not.toContain("subscription")
  })

  test("another status names itself rather than guessing a cause", async () => {
    const result = await fetchGoUsage("k", stubFetch({ ok: false, status: 502 }))
    if (result.ok) throw new Error("unreachable")
    expect(result.unavailable).toContain("502")
  })

  test("a non-200 is NOT parsed as JSON — the status decides first", async () => {
    // A 404 on this host serves HTML. Reading the body before the status would
    // throw inside json() on the very path that has to degrade quietly.
    let parsed = false
    const result = await fetchGoUsage("k", async () => ({
      ok: false,
      status: 404,
      json: async () => {
        parsed = true
        throw new SyntaxError("Unexpected token < in JSON at position 0")
      },
    }))
    expect(parsed).toBe(false)
    expect(result.ok).toBe(false)
  })

  test("a 200 with a non-JSON body is unavailable, not a throw", async () => {
    const result = await fetchGoUsage(
      "k",
      stubFetch({
        json: async () => {
          throw new SyntaxError("Unexpected token < in JSON at position 0")
        },
      }),
    )
    expect(result.ok).toBe(false)
  })

  test("a thrown fetch (offline) is an unavailable line, not a crash", async () => {
    const result = await fetchGoUsage("k", async () => {
      throw new Error("getaddrinfo ENOTFOUND opencode.ai")
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("unreachable")
    expect(result.unavailable).not.toContain("ENOTFOUND")
  })

  test("THE KEY never crosses back in the result, on any path", async () => {
    const results = [
      await fetchGoUsage("sk-not-a-real-go-key", stubFetch({ json: async () => goUsageBody })),
      await fetchGoUsage("sk-not-a-real-go-key", stubFetch({ ok: false, status: 401 })),
      await fetchGoUsage("sk-not-a-real-go-key", stubFetch({ ok: false, status: 403 })),
      await fetchGoUsage("sk-not-a-real-go-key", async () => {
        throw new Error("offline")
      }),
    ]
    for (const result of results) {
      expect(JSON.stringify(result)).not.toContain("sk-not-a-real-go-key")
    }
  })
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

  // OpenCode GO is the one subscription sold behind an API KEY, so it is the one
  // provider whose gate must NOT apply the two rules above.
  test("opencode-go proceeds on a CONFIG key alone, with nothing in the credential store", () => {
    expect(usageGate("opencode-go", undefined, "sk-not-a-real-go-key")).toBeUndefined()
  })

  test("opencode-go is NEVER told its key is metered per token — that refusal is false for a flat-rate plan", () => {
    // The regression this pins: GO's key IS the subscription, so the openai/xai
    // wording ("An API key is metered per token and has no plan window") would
    // be a confident lie about the account the user is actually looking at.
    const refusal = refusalOf(usageGate("opencode-go", { type: "api", key: "sk-go" } as Auth.Info, undefined))
    expect(refusal.unavailable).not.toContain("metered")
    expect(refusal.unavailable).toContain("OpenCode Go")
  })

  test("opencode-go with no key anywhere is refused WITHOUT a call being possible", () => {
    expect(refusalOf(usageGate("opencode-go", undefined, undefined)).unavailable).toBeTruthy()
    expect(refusalOf(usageGate("opencode-go", undefined, "")).unavailable).toBeTruthy()
  })

  test("OpenCode ZEN (`opencode`) is still refused — it is metered and has no usage endpoint", () => {
    // `/zen/v1` serves no usage route; only `/zen/go/v1` does. A fall-through
    // here would put a Zen key on a request for a subscription it has not got.
    expect(refusalOf(usageGate("opencode", undefined, "sk-zen")).unavailable).toContain("opencode")
    expect(refusalOf(usageGate("opencode", { type: "api", key: "sk-zen" } as Auth.Info, "sk-zen")).unavailable).toBeTruthy()
  })

  test("a GO key does not unlock any OTHER api-key provider", () => {
    // The third argument is GO's key and must be inert everywhere else: an
    // anthropic or openrouter key must not become a usage source by passing it.
    for (const id of ["anthropic", "openrouter", "lmstudio"]) {
      expect(refusalOf(usageGate(id, { type: "api", key: "k" } as Auth.Info, "sk-go")).unavailable).toBeTruthy()
    }
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
 * The Effect itself, over a mocked credential store and a mocked global config.
 *
 * `usage` needs `Auth.Service` and `Config.Service` — no instance, no directory
 * — so the whole end-to-end path (read the credential, resolve GO's key, gate,
 * make the one call) runs under two mock layers with the fetch seam injected.
 *
 * Only `getGlobal` is mocked, and that is the point: `Config.get()` reads
 * through `InstanceState`, which would DIE on the bare fiber this ext method
 * runs on. A mock that answered `get` would hide that.
 */
describe("ACPProviderUsage.usage — reading the stored credential", () => {
  const store = (data: Record<string, Auth.Info>) =>
    Layer.mock(Auth.Service)({
      all: () => Effect.succeed(data),
      get: (providerID: string) => Effect.succeed(data[providerID]),
      set: () => Effect.void,
      remove: () => Effect.void,
    })

  /** The GLOBAL origami.json, as `Config.getGlobal()` answers it. */
  const config = (cfg: Record<string, unknown> = {}) =>
    Layer.mock(Config.Service)({ getGlobal: () => Effect.succeed(cfg as never) })

  const run = <A>(
    data: Record<string, Auth.Info>,
    effect: Effect.Effect<A, never, Auth.Service | Config.Service>,
    cfg: Record<string, unknown> = {},
  ) => Effect.runPromise(effect.pipe(Effect.provide(Layer.mergeAll(store(data), config(cfg)))))

  /** A global config with a GO key in it, the way the shell writes one. */
  const goConfig = (apiKey: string) => ({ provider: { "opencode-go": { options: { apiKey } } } })

  test("an openai OAuth credential reaches the call, and the windows come back", async () => {
    const result = await run(
      { openai: oauth({ accountId: "acct-9" }) },
      ACPProviderUsage.usage("openai", stubFetch({}), NOW),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("unreachable")
    expect(result.windows.map((w) => w.label)).toEqual(["Weekly", "5-hour"])
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

  test("opencode-go reads its key from the GLOBAL CONFIG, not the credential store", async () => {
    // The whole reason this provider needed its own lane: the shell writes the
    // GO key to provider["opencode-go"].options.apiKey and never to auth.json,
    // so an Auth-only read would refuse a subscription that is fully connected.
    const seen: { url?: string; headers?: Record<string, string> } = {}
    const result = await run(
      {},
      ACPProviderUsage.usage("opencode-go", stubFetch({ json: async () => goUsageBody }, seen), NOW),
      goConfig("sk-not-a-real-go-key"),
    )
    expect(seen.url).toBe("https://opencode.ai/zen/go/v1/usage")
    expect(seen.headers?.["Authorization"]).toBe("Bearer sk-not-a-real-go-key")
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("unreachable")
    expect(result.plan).toBe("go")
    expect(result.windows.map((w) => w.label)).toEqual(["Weekly", "5-hour", "Monthly"])
  })

  test("an `api` credential is the FALLBACK when the config carries no GO key", async () => {
    // `origami providers login` stores a key in auth.json and never touches the
    // config file. Both ways of connecting GO must read the same subscription.
    const seen: { url?: string; headers?: Record<string, string> } = {}
    const result = await run(
      { "opencode-go": { type: "api", key: "sk-from-auth-json" } as Auth.Info },
      ACPProviderUsage.usage("opencode-go", stubFetch({ json: async () => goUsageBody }, seen), NOW),
    )
    expect(seen.headers?.["Authorization"]).toBe("Bearer sk-from-auth-json")
    expect(result.ok).toBe(true)
  })

  test("the CONFIG key wins over a stale `api` credential on the same id", async () => {
    const seen: { url?: string; headers?: Record<string, string> } = {}
    await run(
      { "opencode-go": { type: "api", key: "sk-stale" } as Auth.Info },
      ACPProviderUsage.usage("opencode-go", stubFetch({ json: async () => goUsageBody }, seen), NOW),
      goConfig("sk-current"),
    )
    expect(seen.headers?.["Authorization"]).toBe("Bearer sk-current")
  })

  test("opencode-go with no key anywhere is refused WITHOUT any call being made", async () => {
    let called = false
    const result = await run({}, ACPProviderUsage.usage("opencode-go", async () => {
      called = true
      throw new Error("must not be called")
    }, NOW))
    expect(called).toBe(false)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("unreachable")
    expect(result.unavailable).toContain("OpenCode Go")
  })

  test("OpenCode ZEN is refused even when a GO key sits in the same config", async () => {
    // `opencode` and `opencode-go` are different providers on the same host.
    // Zen is metered per token and `/zen/v1` serves no usage route at all.
    let called = false
    const result = await run(
      { opencode: { type: "api", key: "sk-zen" } as Auth.Info },
      ACPProviderUsage.usage("opencode", async () => {
        called = true
        throw new Error("must not be called")
      }, NOW),
      goConfig("sk-not-a-real-go-key"),
    )
    expect(called).toBe(false)
    expect(result.ok).toBe(false)
  })

  test("THE GO KEY NEVER REACHES THE RESULT, on the happy path or a refusal", async () => {
    const results = [
      await run({}, ACPProviderUsage.usage("opencode-go", stubFetch({ json: async () => goUsageBody }), NOW), goConfig("sk-not-a-real-go-key")),
      await run({}, ACPProviderUsage.usage("opencode-go", stubFetch({ ok: false, status: 403 }), NOW), goConfig("sk-not-a-real-go-key")),
    ]
    for (const result of results) {
      expect(JSON.stringify(result)).not.toContain("sk-not-a-real-go-key")
    }
  })
})
