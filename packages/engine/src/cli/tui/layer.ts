import { run as runTui, type TuiInput } from "@origami/tui"
import { Global } from "@origami/core/global"
import { AppNodeBuilder } from "@origami/core/effect/app-node-builder"
import { Effect } from "effect"

export function run(input: TuiInput) {
  return runTui(input).pipe(Effect.provide(AppNodeBuilder.build(Global.node)))
}
