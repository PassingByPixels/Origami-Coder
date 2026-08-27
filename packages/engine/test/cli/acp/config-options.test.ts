import { describe, expect } from "bun:test"
import type { SetSessionConfigOptionResponse } from "@agentclientprotocol/sdk"
import { Effect } from "effect"
import { cliIt } from "../../lib/cli-process"
import { expectOk, flattenSelectOptions, selectConfigOption } from "./acp-test-client"
import {
  createAcpClient,
  expectAlternateValue,
  expectSelectOption,
  initialize,
  newSession,
  verifierConfig,
} from "./helpers"

describe("origami acp config option subprocess", () => {
  cliIt.live(
    'model option is listed with category "model"',
    ({ home, llm, origami }) =>
      Effect.gen(function* () {
        const acp = yield* createAcpClient(
          { origami },
          { ORIGAMI_CONFIG_CONTENT: JSON.stringify(verifierConfig(llm.url)) },
        )
        yield* initialize(acp)
        const model = expectSelectOption((yield* newSession(acp, home)).configOptions, "model")

        expect(model.category).toBe("model")
        expect(model.currentValue).toBe("test/test-model")
        expect(flattenSelectOptions(model).length).toBeGreaterThanOrEqual(2)
      }),
    60_000,
  )

  cliIt.live(
    "model switch updates currentValue",
    ({ home, llm, origami }) =>
      Effect.gen(function* () {
        const acp = yield* createAcpClient(
          { origami },
          { ORIGAMI_CONFIG_CONTENT: JSON.stringify(verifierConfig(llm.url)) },
        )
        yield* initialize(acp)
        const session = yield* newSession(acp, home)
        const model = expectSelectOption(session.configOptions, "model")
        const nextModel = flattenSelectOptions(model).find((option) => option.value === "test/second-model")?.value
        expect(nextModel).toBe("test/second-model")

        const updated = expectOk(
          yield* acp.request<SetSessionConfigOptionResponse>("session/set_config_option", {
            sessionId: session.sessionId,
            configId: "model",
            value: nextModel,
          }),
        )

        expect(selectConfigOption(updated.configOptions, "model")?.currentValue).toBe(nextModel)
      }),
    60_000,
  )

  cliIt.live(
    'effort option is listed with category "thought_level" when selected model supports variants',
    ({ home, llm, origami }) =>
      Effect.gen(function* () {
        const acp = yield* createAcpClient(
          { origami },
          { ORIGAMI_CONFIG_CONTENT: JSON.stringify(verifierConfig(llm.url)) },
        )
        yield* initialize(acp)
        const effort = expectSelectOption((yield* newSession(acp, home)).configOptions, "effort")

        expect(effort.category).toBe("thought_level")
        expect(effort.currentValue).toBe("low")
        expect(flattenSelectOptions(effort).map((option) => option.value)).toEqual(["low", "high"])
      }),
    60_000,
  )

  // The auto-approve preset, over the real wire. A client seeds its approve
  // control from this, so the value vocabulary has to be exactly what
  // set_config_option takes back, and it has to survive an unrelated refresh.
  cliIt.live(
    "permission option is listed, switches, and survives an unrelated config change",
    ({ home, llm, origami }) =>
      Effect.gen(function* () {
        const acp = yield* createAcpClient(
          { origami },
          { ORIGAMI_CONFIG_CONTENT: JSON.stringify(verifierConfig(llm.url)) },
        )
        yield* initialize(acp)
        const session = yield* newSession(acp, home)
        const permission = expectSelectOption(session.configOptions, "permission")

        expect(permission.category).toBe("_permission")
        expect(permission.currentValue).toBe("default")
        expect(flattenSelectOptions(permission).map((option) => option.value)).toEqual([
          "default",
          "auto",
          "bypass",
        ])

        const raised = expectOk(
          yield* acp.request<SetSessionConfigOptionResponse>("session/set_config_option", {
            sessionId: session.sessionId,
            configId: "permission",
            value: "bypass",
          }),
        )
        expect(selectConfigOption(raised.configOptions, "permission")?.currentValue).toBe("bypass")

        // Switching something else must not blank it - and this leg also proves
        // the preset's row write went through the REAL engine, not a stub.
        const unrelated = expectOk(
          yield* acp.request<SetSessionConfigOptionResponse>("session/set_config_option", {
            sessionId: session.sessionId,
            configId: "effort",
            value: "high",
          }),
        )
        expect(selectConfigOption(unrelated.configOptions, "permission")?.currentValue).toBe("bypass")
      }),
    60_000,
  )

  cliIt.live(
    "effort switch updates currentValue",
    ({ home, llm, origami }) =>
      Effect.gen(function* () {
        const acp = yield* createAcpClient(
          { origami },
          { ORIGAMI_CONFIG_CONTENT: JSON.stringify(verifierConfig(llm.url)) },
        )
        yield* initialize(acp)
        const session = yield* newSession(acp, home)
        const nextEffort = expectAlternateValue(expectSelectOption(session.configOptions, "effort"))

        const updated = expectOk(
          yield* acp.request<SetSessionConfigOptionResponse>("session/set_config_option", {
            sessionId: session.sessionId,
            configId: "effort",
            value: nextEffort,
          }),
        )

        expect(selectConfigOption(updated.configOptions, "effort")?.currentValue).toBe(nextEffort)
      }),
    60_000,
  )
})
