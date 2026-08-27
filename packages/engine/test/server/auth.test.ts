import { afterEach, describe, expect, test } from "bun:test"
import { Option, Redacted } from "effect"
import { Flag } from "@origami/core/flag/flag"
import { ServerAuth } from "../../src/server/auth"

const original = {
  ORIGAMI_SERVER_PASSWORD: Flag.ORIGAMI_SERVER_PASSWORD,
  ORIGAMI_SERVER_USERNAME: Flag.ORIGAMI_SERVER_USERNAME,
}

afterEach(() => {
  Flag.ORIGAMI_SERVER_PASSWORD = original.ORIGAMI_SERVER_PASSWORD
  Flag.ORIGAMI_SERVER_USERNAME = original.ORIGAMI_SERVER_USERNAME
})

describe("ServerAuth", () => {
  test("does not emit auth headers without a password", () => {
    Flag.ORIGAMI_SERVER_PASSWORD = undefined
    Flag.ORIGAMI_SERVER_USERNAME = "alice"

    expect(ServerAuth.header()).toBeUndefined()
    expect(ServerAuth.headers()).toBeUndefined()
  })

  test("defaults to the origami username", () => {
    Flag.ORIGAMI_SERVER_PASSWORD = "secret"
    Flag.ORIGAMI_SERVER_USERNAME = undefined

    expect(ServerAuth.headers()).toEqual({
      Authorization: `Basic ${Buffer.from("origami:secret").toString("base64")}`,
    })
  })

  test("uses the configured username", () => {
    Flag.ORIGAMI_SERVER_PASSWORD = "secret"
    Flag.ORIGAMI_SERVER_USERNAME = "alice"

    expect(ServerAuth.headers()).toEqual({
      Authorization: `Basic ${Buffer.from("alice:secret").toString("base64")}`,
    })
  })

  test("prefers explicit credentials", () => {
    Flag.ORIGAMI_SERVER_PASSWORD = "secret"
    Flag.ORIGAMI_SERVER_USERNAME = "alice"

    expect(ServerAuth.headers({ password: "cli-secret", username: "bob" })).toEqual({
      Authorization: `Basic ${Buffer.from("bob:cli-secret").toString("base64")}`,
    })
  })

  test("validates decoded credentials against effect config", () => {
    const config = { password: Option.some("secret"), username: "alice" }

    expect(ServerAuth.required(config)).toBe(true)
    expect(ServerAuth.authorized({ username: "alice", password: Redacted.make("secret") }, config)).toBe(true)
    expect(ServerAuth.authorized({ username: "origami", password: Redacted.make("secret") }, config)).toBe(false)
  })
})
