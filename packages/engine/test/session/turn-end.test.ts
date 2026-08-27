// The `origami/turnEnd` wire contract, asserted against the CLIENT that has to
// decode it.
//
// The client half was built first and shipped dark. If either end moves - a
// renamed method, a camelCased payload key, a new taxonomy label on one side
// only - the notification silently stops rendering, which is the exact class of
// bug the client's own comments call "the F4 blind instrument": a budget-walled
// failure that looks like healthy progress because nothing arrived.
//
// So this reads the real client source rather than a copy of it. A test that
// restated the shape from memory would agree with itself forever.
import { describe, expect, it } from "bun:test"
import path from "path"
import { STOP_REASONS, TURN_END_METHOD, turnEndPayload } from "@/session/turn-end"

const vscode = (...parts: string[]) => path.join(import.meta.dir, "..", "..", "..", "vscode", ...parts)

const read = async (file: string) => {
  const handle = Bun.file(file)
  if (!(await handle.exists())) throw new Error(`the turnEnd mirror needs ${file}; it was not found`)
  return handle.text()
}

describe("origami/turnEnd wire contract", () => {
  it("emits the one snake_case key the client decodes, and nothing else", () => {
    // packages/vscode/src/acpClient.ts:1294-1310 —
    //   case 'origami/turnEnd': ... this.handlers.onTurnEnd?.({ stopReason: String(p.stop_reason ?? '') })
    // A camelCase `stopReason` on the wire would decode to the empty string,
    // which the client maps to the `unknown` verdict rather than an error, so
    // the drift would be invisible in the UI. Hence: exact keys.
    expect(turnEndPayload("success")).toEqual({ stop_reason: "success" })
    expect(Object.keys(turnEndPayload("error_max_turns"))).toEqual(["stop_reason"])
  })

  it("uses the method name the client switches on", async () => {
    // The client strips ONE leading underscore before switching, so both
    // spellings decode; what must not drift is the name after the prefix.
    const source = await read(vscode("src", "acpClient.ts"))
    expect(source).toContain("case 'origami/turnEnd'")
    expect(TURN_END_METHOD.replace(/^_/, "")).toBe("origami/turnEnd")
  })

  it("reads `stop_reason` off the params in the client, not some other key", async () => {
    const source = await read(vscode("src", "acpClient.ts"))
    expect(source).toContain("p.stop_reason")
  })

  it("carries exactly the taxonomy the client renders a verdict for", async () => {
    // packages/vscode/webview/dashboard/panes/turnVerdict.ts `verdictForStopReason`.
    // Any label the engine emits that is NOT in that switch falls to `default`
    // and renders as `unknown` — an honest failure, but a silent one, so the
    // engine must never be able to invent one by accident.
    const source = await read(vscode("webview", "dashboard", "panes", "turnVerdict.ts"))
    // Scoped to `verdictForStopReason` alone: the file holds a SECOND switch
    // (`verdictLabel`) over the verdict KINDS, and folding the two together
    // would make this pass on a mixture of the two vocabularies.
    const start = source.indexOf("export function verdictForStopReason")
    const end = source.indexOf("export function verdictLabel")
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const cases = [...source.slice(start, end).matchAll(/case '([a-z_]+)':/g)].map((match) => match[1]!)
    expect(new Set(cases)).toEqual(new Set(STOP_REASONS))
  })

  it("keeps `success` the only verified-done label", async () => {
    const source = await read(vscode("webview", "dashboard", "panes", "turnVerdict.ts"))
    // The line that makes `success` mean done. If the client ever moves that
    // meaning to another label, goal mode's MET branch would be announcing a
    // verdict that no longer reads as done.
    expect(source).toMatch(/case 'success':\s*\r?\n\s*return \{ kind: 'done'/)
    expect(STOP_REASONS[0]).toBe("success")
  })
})
