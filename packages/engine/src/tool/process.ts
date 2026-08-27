import { Effect, Schema } from "effect"
import { AppProcess } from "@origami/core/process"
import { ChildProcess } from "effect/unstable/process"
import * as Tool from "./tool"
import DESCRIPTION from "./process.txt"

export const Parameters = Schema.Struct({
  kind: Schema.Literals(["processes", "ports"]).annotate({
    description: 'What to list: "processes" for running processes, "ports" for listening TCP sockets',
  }),
  filter: Schema.optional(Schema.String).annotate({
    description:
      "Case-insensitive substring filter. Matches the process name for kind=processes, or any part of the row (port number, pid, name) for kind=ports",
  }),
})

type Params = { kind: "processes" | "ports"; filter?: string }

export type Entry = { pid: string; name: string; address?: string }

// A busy desktop already runs ~500 processes, and rows are sorted by ascending pid,
// so a small cap would silently drop the most recently started ones - which is exactly
// what someone debugging a hung server is looking for. The Truncate service is the
// backstop for anything genuinely pathological.
const MAX_ROWS = 1000

/** Split one `tasklist /FO CSV` record, honouring the quoting it uses for names with commas. */
export function parseCsvRow(line: string): string[] {
  const fields: string[] = []
  let current = ""
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const char = line[i]
    if (char === '"') {
      if (quoted && line[i + 1] === '"') {
        current += '"'
        i++
        continue
      }
      quoted = !quoted
      continue
    }
    if (char === "," && !quoted) {
      fields.push(current)
      current = ""
      continue
    }
    current += char
  }
  fields.push(current)
  return fields
}

export function parseTasklist(text: string): Entry[] {
  return text.split(/\r?\n/).flatMap((line) => {
    if (!line.trim()) return []
    const fields = parseCsvRow(line)
    if (fields.length < 2) return []
    const pid = fields[1]!.trim()
    if (!/^\d+$/.test(pid)) return []
    return [{ pid, name: fields[0]!.trim() }]
  })
}

export function parsePs(text: string): Entry[] {
  return text.split(/\r?\n/).flatMap((line) => {
    const parts = line.trim().split(/\s+/)
    if (parts.length < 2) return []
    const pid = parts[0]!
    if (!/^\d+$/.test(pid)) return []
    return [{ pid, name: parts.slice(1).join(" ") }]
  })
}

/**
 * `netstat -ano -p TCP` rows are `Proto Local Foreign State PID`. The state word is
 * localised on non-English Windows, so a listening socket is identified by its
 * foreign address instead - only a listener has `0.0.0.0:0` / `[::]:0` there.
 */
export function parseNetstat(text: string): Entry[] {
  return text.split(/\r?\n/).flatMap((line) => {
    const parts = line.trim().split(/\s+/)
    if (parts.length !== 5) return []
    if (parts[0]!.toUpperCase() !== "TCP") return []
    if (!parts[2]!.endsWith(":0")) return []
    const pid = parts[4]!
    if (!/^\d+$/.test(pid)) return []
    return [{ pid, name: "", address: parts[1]! }]
  })
}

/**
 * `lsof -nP -iTCP -sTCP:LISTEN` rows are `COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME`,
 * where NAME itself is several tokens (`TCP 127.0.0.1:8787 (LISTEN)`) - the address is the
 * token that ends in a port.
 */
export function parseLsof(text: string): Entry[] {
  return text.split(/\r?\n/).flatMap((line) => {
    const parts = line.trim().split(/\s+/)
    if (parts.length < 9) return []
    const pid = parts[1]!
    if (!/^\d+$/.test(pid)) return []
    const address = parts.slice(8).findLast((part) => /:(\d+|\*)$/.test(part))
    if (!address) return []
    return [{ pid, name: parts[0]!, address }]
  })
}

export const ProcessTool = Tool.define(
  "process",
  Effect.gen(function* () {
    const proc = yield* AppProcess.Service

    const run = Effect.fn("ProcessTool.run")(function* (command: string, args: string[]) {
      const result = yield* proc
        .run(ChildProcess.make(command, args, { stdin: "ignore", stdout: "pipe", stderr: "pipe" }), {
          maxOutputBytes: 4 * 1024 * 1024,
        })
        .pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (!result || result.exitCode !== 0) return undefined
      return result.stdout.toString("utf8")
    })

    const processes = Effect.fn("ProcessTool.processes")(function* () {
      if (process.platform === "win32") {
        const text = yield* run("tasklist", ["/FO", "CSV", "/NH"])
        if (text === undefined) return undefined
        return parseTasklist(text)
      }
      const text = yield* run("ps", ["-eo", "pid=,comm="])
      if (text === undefined) return undefined
      return parsePs(text)
    })

    const ports = Effect.fn("ProcessTool.ports")(function* () {
      if (process.platform === "win32") {
        const text = yield* run("netstat", ["-ano", "-p", "TCP"])
        if (text === undefined) return undefined
        const rows = parseNetstat(text)
        const names = new Map((yield* processes())?.map((item) => [item.pid, item.name]) ?? [])
        return rows.map((row) => ({ ...row, name: names.get(row.pid) ?? "" }))
      }
      const lsof = yield* run("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN"])
      if (lsof !== undefined) return parseLsof(lsof)
      const ss = yield* run("ss", ["-ltnp"])
      if (ss === undefined) return undefined
      return ss.split(/\r?\n/).flatMap((line) => {
        const pid = line.match(/pid=(\d+)/)
        const name = line.match(/users:\(\("([^"]+)"/)
        const parts = line.trim().split(/\s+/)
        if (!pid || parts.length < 4) return []
        return [{ pid: pid[1]!, name: name?.[1] ?? "", address: parts[3]! }]
      })
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Params, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "process",
            patterns: [params.kind],
            always: ["*"],
            metadata: { kind: params.kind, filter: params.filter },
          })

          const entries = params.kind === "ports" ? yield* ports() : yield* processes()
          if (entries === undefined)
            throw new Error(
              `Unable to list ${params.kind} on this system: the underlying command is missing or failed.`,
            )

          const needle = params.filter?.toLowerCase()
          const rows = entries
            .filter((entry) => {
              if (!needle) return true
              const haystack =
                params.kind === "ports" ? `${entry.address ?? ""} ${entry.pid} ${entry.name}` : entry.name
              return haystack.toLowerCase().includes(needle)
            })
            .sort((a, b) => Number(a.pid) - Number(b.pid))

          const shown = rows.slice(0, MAX_ROWS)
          const lines = shown.map((entry) =>
            params.kind === "ports"
              ? `${entry.address}\t${entry.pid}\t${entry.name}`.trimEnd()
              : `${entry.pid}\t${entry.name}`,
          )
          if (rows.length > MAX_ROWS)
            lines.push(`(showing first ${MAX_ROWS} of ${rows.length} rows - narrow it with "filter")`)

          const label = params.kind === "ports" ? "listening TCP sockets" : "processes"
          const output = rows.length
            ? [params.kind === "ports" ? "ADDRESS\tPID\tNAME" : "PID\tNAME", ...lines].join("\n")
            : `No ${label} found${params.filter ? ` matching "${params.filter}"` : ""}.`

          return {
            title: params.filter ? `${params.kind} ${params.filter}` : params.kind,
            // NB: not `truncated` - Tool.wrap treats a defined `metadata.truncated`
            // as "this tool already truncated" and skips the output truncator.
            metadata: { kind: params.kind, count: rows.length, clipped: rows.length > MAX_ROWS },
            output,
          }
        }).pipe(Effect.orDie),
    }
  }),
)
