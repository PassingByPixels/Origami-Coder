// origami_change: leaf module. Built-in plugin modules take `define` from here, not
// from ./internal. ./internal imports every built-in plugin (./provider builds its
// array at load time), so a value import of ./internal from a plugin module is a cycle:
// when that plugin module loads first, ./provider reads its export before it exists
// ("Cannot access 'XAIPlugin' before initialization"). Keep this file free of runtime imports.
import type { PluginContext } from "@origami/plugin/v2/effect"
import type { Effect, Scope } from "effect"

export interface Plugin<R = never> {
  readonly id: string
  readonly effect: (context: PluginContext) => Effect.Effect<void, never, R | Scope.Scope>
}

export function define<R>(plugin: Plugin<R>) {
  return plugin
}
