import { describe, expect, test } from "bun:test"
import { PermissionV1 } from "@origami/core/v1/permission"
import { Permission } from "@/permission"
import { PermissionPresets } from "@/permission/presets"

/**
 * The `build` agent's own defaults, in the shape `Permission.fromConfig` gives
 * them (agent/agent.ts): a blanket `*` allow with a handful of explicit `ask`
 * exceptions. external_directory is one of the only classes that asks at all
 * under this agent, which is why a preset that never reached the session
 * ruleset showed up as "YOLO still asks about Downloads" and nothing else.
 */
const agentDefaults = Permission.fromConfig({
  "*": "allow",
  doom_loop: "ask",
  external_directory: { "*": "ask" },
})

const evaluate = (permission: string, pattern: string, mode: string | undefined) =>
  Permission.evaluate(permission, pattern, agentDefaults, PermissionPresets.rules(mode)).action

describe("permission preset rules", () => {
  test("bypass writes the wildcard allow, auto writes the edit allow, default writes nothing", () => {
    expect(PermissionPresets.rules("bypass")).toEqual([{ permission: "*", pattern: "*", action: "allow" }])
    expect(PermissionPresets.rules("auto")).toEqual([{ permission: "edit", pattern: "*", action: "allow" }])
    expect(PermissionPresets.rules("default")).toEqual([])
    expect(PermissionPresets.rules(undefined)).toEqual([])
  })

  // The reported symptom, as an assertion: a session sitting on the bypass
  // ruleset must not ask about a directory outside the project, and the same
  // session on `default` must.
  test("a stored bypass ruleset answers an external_directory ask with allow", () => {
    expect(evaluate("external_directory", "C:\\Users\\User\\Downloads\\*", "bypass")).toBe("allow")
    expect(evaluate("external_directory", "C:\\Users\\User\\Downloads\\*", "default")).toBe("ask")
    // ...and it covers the other classes this agent still asks about.
    expect(evaluate("doom_loop", "*", "bypass")).toBe("allow")
  })

  test("auto covers edits but leaves the external-directory gate asking", () => {
    expect(evaluate("edit", "src/index.ts", "auto")).toBe("allow")
    expect(evaluate("external_directory", "C:\\Users\\User\\Downloads\\*", "auto")).toBe("ask")
  })
})

describe("permission preset recognition", () => {
  test("names the preset a stored ruleset was written by", () => {
    expect(PermissionPresets.modeFor(PermissionPresets.rules("bypass"))).toBe("bypass")
    expect(PermissionPresets.modeFor(PermissionPresets.rules("auto"))).toBe("auto")
  })

  test("answers undefined when no preset wrote the ruleset", () => {
    expect(PermissionPresets.modeFor(undefined)).toBeUndefined()
    expect(PermissionPresets.modeFor([])).toBeUndefined()
    // An ordinary configured allow is not a preset: a chat carrying one must
    // still report `default`, or a reload would claim a grant nobody pressed.
    const configured: PermissionV1.Ruleset = [{ permission: "bash", pattern: "git status", action: "allow" }]
    expect(PermissionPresets.modeFor(configured)).toBeUndefined()
  })

  test("names the preset even when the row also carries a configured rule", () => {
    // The state a row is actually left in: the chat's own configured allow, kept,
    // plus the preset the user picked. Missing the preset here would reopen the
    // chat on `default` and clear the grant on its next prompt.
    const row: PermissionV1.Ruleset = [
      { permission: "bash", pattern: "git status", action: "allow" },
      ...PermissionPresets.rules("bypass"),
    ]
    expect(PermissionPresets.modeFor(row)).toBe("bypass")
  })

  test("refuses to name a mode for a ruleset that is more than one preset", () => {
    // Two preset keys at once is not a preset this UI can express, and guessing
    // one would silently downgrade or upgrade the chat on its next prompt.
    const mixed: PermissionV1.Ruleset = [
      ...PermissionPresets.rules("bypass"),
      ...PermissionPresets.rules("auto"),
    ]
    expect(PermissionPresets.modeFor(mixed)).toBeUndefined()
  })
})
