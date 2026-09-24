/**
 * Where a KEYED parity provider gets its key from.
 *
 * The point of the auth.json route is that a live key never has to be put in
 * the environment for a record run. These cases prove the precedence and, just
 * as importantly, that a shape the engine would not accept is refused HERE
 * rather than sent to a real endpoint.
 *
 * Every path used is inside the per-run sandbox `test/preload.ts` builds
 * (`Global.Path.data` resolves under a temp XDG_DATA_HOME); the owner's real
 * `~/.local/share/origami/auth.json` is never read or written by this file.
 */

import { Global } from "@origami/core/global"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { LLMParityScenarios, type ParityProvider } from "./llm-parity/scenarios"

const SANDBOX = path.join(Global.Path.data, "parity-key-fixtures")
const fixture = (name: string) => path.join(SANDBOX, name)

const KEYED: ParityProvider = {
  id: "fixture-provider",
  npm: "@ai-sdk/openai-compatible",
  family: "openai-compatible",
  realBaseURL: "https://example.invalid/v1",
  auth: "key",
  keyEnv: "PARITY_KEY_FIXTURE",
  modelID: "fixture-model",
  model: { name: "fixture-model" },
}
const KEYLESS: ParityProvider = { ...KEYED, id: "fixture-local", auth: undefined, keyEnv: undefined }

const write = (name: string, body: unknown) =>
  fs.writeFile(fixture(name), typeof body === "string" ? body : JSON.stringify(body), { mode: 0o600 })

beforeAll(async () => {
  await fs.mkdir(SANDBOX, { recursive: true })
  await write("api.json", { "fixture-provider": { type: "api", key: "fixture-key-from-file" } })
  await write("origami.json", { provider: { "fixture-provider": { options: { apiKey: "fixture-key-from-config" } } } })
  await write("oauth.json", {
    "fixture-provider": { type: "oauth", refresh: "r", access: "a", expires: 1 },
  })
  // The engine's Auth.Info union has no entry without a `type`, and `api`
  // requires `key`. Both must be refused, not coerced.
  await write("malformed.json", { "fixture-provider": { key: "no-type-field" } })
  await write("not-json.json", "{ this is not json")
  await write("other-provider.json", { somebody_else: { type: "api", key: "not-ours" } })
})

afterAll(async () => {
  await fs.rm(SANDBOX, { recursive: true, force: true })
})

describe("parity record key sourcing", () => {
  test("takes the api key from the provider's entry in the auth file", () => {
    expect(LLMParityScenarios.recordKey(KEYED, fixture("api.json"))).toBe("fixture-key-from-file")
  })

  test("the env var wins over the auth file", () => {
    process.env["PARITY_KEY_FIXTURE"] = "fixture-key-from-env"
    try {
      expect(LLMParityScenarios.recordKey(KEYED, fixture("api.json"))).toBe("fixture-key-from-env")
    } finally {
      delete process.env["PARITY_KEY_FIXTURE"]
    }
  })

  test("refuses an entry that is not an api credential, and reports it as blocked", () => {
    for (const file of ["oauth.json", "malformed.json", "other-provider.json"]) {
      expect(LLMParityScenarios.recordKey(KEYED, fixture(file))).toBeUndefined()
    }
    const blocker = LLMParityScenarios.recordBlocker(KEYED, fixture("oauth.json"))
    expect(blocker).toContain("PARITY_KEY_FIXTURE")
    expect(blocker).toContain("PARITY_AUTH_FILE")
  })

  test("a missing or unreadable auth file is an absent key, not a throw", () => {
    expect(LLMParityScenarios.recordKey(KEYED, fixture("does-not-exist.json"))).toBeUndefined()
    expect(LLMParityScenarios.recordKey(KEYED, fixture("not-json.json"))).toBeUndefined()
    expect(LLMParityScenarios.recordKey(KEYED, undefined)).toBeUndefined()
    // A directory, not a file: readFileSync throws EISDIR on every platform.
    expect(LLMParityScenarios.recordKey(KEYED, SANDBOX)).toBeUndefined()
  })

  test("a keyless provider takes no key from the auth file even when one is there", () => {
    expect(LLMParityScenarios.recordKey({ ...KEYLESS, id: "fixture-provider" }, fixture("api.json"))).toBeUndefined()
    expect(LLMParityScenarios.recordBlocker(KEYLESS, undefined)).toBeUndefined()
  })

  test("authFileKey reads the entry named by the provider id, not the first one", () => {
    expect(LLMParityScenarios.authFileKey("fixture-provider", fixture("api.json"))).toBe("fixture-key-from-file")
    expect(LLMParityScenarios.authFileKey("somebody_else", fixture("api.json"))).toBeUndefined()
    expect(LLMParityScenarios.authFileKey("somebody_else", fixture("other-provider.json"))).toBe("not-ours")
  })
})

describe("PARITY_CONFIG_FILE (origami.json) as the third key source", () => {
  test("provider.<id>.options.apiKey is used when env and auth file have nothing", () => {
    delete process.env["PARITY_KEY_FIXTURE"]
    expect(LLMParityScenarios.recordKey(KEYED, undefined, fixture("origami.json"))).toBe("fixture-key-from-config")
    expect(LLMParityScenarios.recordKey(KEYED, fixture("missing.json"), fixture("origami.json"))).toBe(
      "fixture-key-from-config",
    )
  })

  test("the auth file wins over the config file; the env var wins over both", () => {
    delete process.env["PARITY_KEY_FIXTURE"]
    expect(LLMParityScenarios.recordKey(KEYED, fixture("api.json"), fixture("origami.json"))).toBe("fixture-key-from-file")
    process.env["PARITY_KEY_FIXTURE"] = "fixture-key-from-env"
    expect(LLMParityScenarios.recordKey(KEYED, fixture("api.json"), fixture("origami.json"))).toBe("fixture-key-from-env")
    delete process.env["PARITY_KEY_FIXTURE"]
  })

  test("a config without that provider, or without a string apiKey, is no key", () => {
    expect(LLMParityScenarios.configFileKey("other-provider", fixture("origami.json"))).toBeUndefined()
    expect(LLMParityScenarios.configFileKey("fixture-provider", fixture("missing.json"))).toBeUndefined()
    expect(LLMParityScenarios.recordBlocker(KEYED, undefined, fixture("missing.json"))).toContain("PARITY_CONFIG_FILE")
    expect(LLMParityScenarios.recordBlocker(KEYED, undefined, fixture("origami.json"))).toBeUndefined()
    expect(LLMParityScenarios.recordKey(KEYLESS, undefined, fixture("origami.json"))).toBeUndefined()
  })
})
