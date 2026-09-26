// origami_change (t-xsufpe): the acp engine must run with plan mode ON and
// client "acp" in RuntimeFlags. Before the fix the command wrote both vars
// inside its handler, after AppRuntime had already read env, so the plan agent
// got no plan_exit tool and no plan-file brief (owner UAT 0.4.178).
// Own file on purpose: AppRuntime reads RuntimeFlags once per process.
import { expect, test } from "bun:test"
import { Effect } from "effect"
import { effectCmd } from "@/cli/effect-cmd"
import { ACP_ENV } from "@/cli/cmd/acp"
import { RuntimeFlags } from "@/effect/runtime-flags"

test("the acp env reaches RuntimeFlags: plan mode on, client acp", async () => {
  delete process.env.ORIGAMI_EXPERIMENTAL_PLAN_MODE
  delete process.env.ORIGAMI_EXPERIMENTAL
  delete process.env.ORIGAMI_CLIENT
  let seen: { plan: boolean; client: string } | undefined
  const cmd = effectCmd({
    command: "probe",
    describe: false,
    instance: false,
    env: ACP_ENV,
    handler: () =>
      Effect.gen(function* () {
        const flags = yield* RuntimeFlags.Service
        seen = { plan: flags.experimentalPlanMode, client: flags.client }
      }),
  })
  await (cmd.handler as (args: object) => Promise<void>)({})
  expect(seen).toEqual({ plan: true, client: "acp" })
})
