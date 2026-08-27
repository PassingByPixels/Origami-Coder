// Subprocess integration tests for `origami run` (non-interactive mode).
// These exercise the real CLI binary against a TestLLMServer running in the
// same process. See `test/lib/cli-process.ts` for the harness — each test uses
// `origami.run(message, opts?)` to spawn `bun src/index.ts run ...` with
// `ORIGAMI_CONFIG_CONTENT` providing the test provider config inline.
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { reply } from "../../lib/llm-server"
import { cliIt } from "../../lib/cli-process"

describe("origami run (non-interactive subprocess)", () => {
  // Happy path: prompt completes, output reaches stdout, process exits 0.
  // If this fails, all the others likely will too — debug here first.
  cliIt.concurrent(
    "exits 0 and writes the response to stdout on a successful prompt",
    ({ llm, origami }) =>
      Effect.gen(function* () {
        yield* llm.text("hello from the test llm")
        const result = yield* origami.run("say hi")
        origami.expectExit(result, 0)
        expect(result.stdout).toBe("hello from the test llm\n")
      }),
    60_000,
  )

  cliIt.concurrent(
    "prints each completed text part in order around a tool continuation",
    ({ llm, origami }) =>
      Effect.gen(function* () {
        yield* llm.push(
          reply().text("  before tool  ").tool("bash", {
            explanation: "Print deterministic output",
            command: "printf tool-output",
            description: "Print deterministic output",
          }),
        )
        yield* llm.text("  after tool  ")

        const result = yield* origami.run("use a tool", {
          extraArgs: ["--dangerously-skip-permissions"],
        })

        origami.expectExit(result, 0)
        expect(result.stdout).toBe("before tool\nafter tool\n")
      }),
    60_000,
  )

  cliIt.concurrent(
    "prints reasoning before text only with --thinking",
    ({ llm, origami }) =>
      Effect.gen(function* () {
        yield* llm.reason("  considering  ", { text: "  answer  " })
        const thinking = yield* origami.run("think", { extraArgs: ["--thinking"] })
        origami.expectExit(thinking, 0)
        expect(thinking.stdout).toBe("Thinking: considering\nanswer\n")

        yield* llm.reason("hidden", { text: "visible" })
        const plain = yield* origami.run("think again")
        origami.expectExit(plain, 0)
        expect(plain.stdout).toBe("visible\n")
      }),
    60_000,
  )

  // Regression for #27371: an unknown model used to hang the process forever
  // waiting on a session.status === idle event that never arrived. The fix
  // makes the SDK call surface an error promptly so the process exits nonzero.
  // We assert nonzero exit AND wall-clock under the harness timeout — a hang
  // would expire the timeout and produce a different (signal-killed) failure.
  cliIt.concurrent(
    "exits nonzero promptly when the model is unknown (regression for #27371)",
    ({ origami }) =>
      Effect.gen(function* () {
        const result = yield* origami.run("say hi", {
          model: "test/nonexistent-model",
          timeoutMs: 15_000,
        })
        expect(result.exitCode).not.toBe(0)
        expect(result.durationMs).toBeLessThan(15_000)
      }),
    30_000,
  )

  // The test provider's SSE error item reaches the engine as a stream with no
  // named finish. This USED to end the turn silently (partial output, exit 0,
  // no explanation) — the exact dishonest-terminal-state the 0.4.38 review
  // closed. The contract now: partial output is preserved FIRST, the bounded
  // stream-drop retry says so in the transcript, the run recovers, and the
  // provider's own error text still never leaks to stderr. Byte-exact stdout
  // was retired because notice lines are attempt-count-dependent.
  //
  // It is the REDO half of the unknown-finish split, and what puts it there is
  // that `llm.fail` emits only a role delta before the body dies — the failing
  // ATTEMPT commits no prose, so there is nothing to carry forward. (The
  // "partial response" below belongs to the earlier, cleanly finished tool
  // step.) The other half — prose plus an unreadable stop reason, which
  // CONTINUES instead of redoing — is pinned in `test/session/prompt.test.ts`,
  // so do not add text to the failing reply here expecting this to still hold.
  cliIt.concurrent(
    "unknown stream finish keeps partial output, says so, and recovers to exit 0",
    ({ llm, origami }) =>
      Effect.gen(function* () {
        yield* llm.push(
          reply().text("partial response").tool("bash", {
            explanation: "Print deterministic output",
            command: "printf tool",
            description: "Print deterministic output",
          }),
        )
        yield* llm.fail("upstream provider exploded mid-stream")
        const result = yield* origami.run("trigger midstream error", { timeoutMs: 30_000 })
        expect(result.exitCode).toBe(0)
        expect(result.stdout.startsWith("partial response\n")).toBe(true)
        expect(result.stdout).toContain("Stream dropped")
        expect(result.stdout).toContain("no finish reason")
        expect(result.stderr).not.toContain("upstream provider exploded mid-stream")
      }),
    60_000,
  )

  // --format json puts one JSON object per line on stdout for each emitted
  // event. Consumers (CI scripts, tooling) parse this stream. Asserts the
  // shape so a future event-emit change has to update this expectation.
  cliIt.concurrent(
    "--format json emits parseable line-delimited JSON to stdout",
    ({ llm, origami }) =>
      Effect.gen(function* () {
        yield* llm.text("structured output")
        const result = yield* origami.run("say hi", { format: "json" })
        origami.expectExit(result, 0)

        const events = origami.parseJsonEvents(result.stdout)
        expect(events.length).toBeGreaterThan(0)
        for (const evt of events) {
          expect(typeof evt.type).toBe("string")
          expect(typeof evt.sessionID).toBe("string")
        }
        expect(events.map((event) => event.type)).toEqual(["step_start", "text", "step_finish"])
        expect(events.map(({ timestamp: _, sessionID: __, ...event }) => event)).toEqual([
          { type: "step_start", part: expect.objectContaining({ type: "step-start" }) },
          {
            type: "text",
            part: expect.objectContaining({ type: "text", text: "structured output" }),
          },
          { type: "step_finish", part: expect.objectContaining({ type: "step-finish" }) },
        ])
        expect(result.stdout.endsWith("\n")).toBe(true)
        expect(
          result.stdout
            .split("\n")
            .slice(0, -1)
            .every((line) => line.length > 0),
        ).toBe(true)
      }),
    60_000,
  )

  cliIt.concurrent(
    "--format json emits a pure error record for a rejected prompt request",
    ({ origami }) =>
      Effect.gen(function* () {
        const result = yield* origami.run("use an unknown model", {
          model: "test/nonexistent-model",
          format: "json",
        })

        expect(result.exitCode).not.toBe(0)
        const events = origami.parseJsonEvents(result.stdout)
        expect(events.map((event) => event.type)).toEqual(["error"])
        expect(events[0]).toEqual({
          type: "error",
          timestamp: expect.any(Number),
          sessionID: expect.any(String),
          error: expect.any(Object),
        })
        expect(result.stdout.split("\n").filter(Boolean)).toHaveLength(1)
      }),
    30_000,
  )

  cliIt.concurrent(
    "--format json preserves reasoning, tool, and continuation ordering",
    ({ llm, origami }) =>
      Effect.gen(function* () {
        yield* llm.push(
          reply().reason("reasoning").text("before").tool("bash", {
            explanation: "Print deterministic output",
            command: "printf tool",
            description: "Print deterministic output",
          }),
        )
        yield* llm.text("after")

        const result = yield* origami.run("exercise json records", {
          format: "json",
          extraArgs: ["--thinking", "--dangerously-skip-permissions"],
        })

        expect(result.exitCode).toBe(0)
        const events = origami.parseJsonEvents(result.stdout)
        expect(events.map((event) => event.type)).toEqual([
          "step_start",
          "reasoning",
          "text",
          "tool_use",
          "step_finish",
          "step_start",
          "text",
          "step_finish",
        ])
        expect(events.find((event) => event.type === "reasoning")?.part).toEqual(
          expect.objectContaining({ type: "reasoning", text: "reasoning" }),
        )
        expect(events.find((event) => event.type === "tool_use")?.part).toEqual(
          expect.objectContaining({
            type: "tool",
            tool: "bash",
            state: expect.objectContaining({ status: "completed" }),
          }),
        )
        expect(
          result.stdout
            .split("\n")
            .slice(0, -1)
            .every((line) => line.startsWith("{")),
        ).toBe(true)
      }),
    60_000,
  )

  cliIt.concurrent(
    "--format json records partial output and the retry notice for an unknown stream finish",
    ({ llm, origami }) =>
      Effect.gen(function* () {
        yield* llm.push(
          reply().text("partial json").tool("bash", {
            explanation: "Print deterministic output",
            command: "printf tool",
            description: "Print deterministic output",
          }),
        )
        yield* llm.fail("provider failed")
        const result = yield* origami.run("fail after output", { format: "json" })

        const events = origami.parseJsonEvents(result.stdout)
        expect(result.exitCode).toBe(0)
        // The first step is untouched by the retry machinery — pin it exactly.
        expect(events.slice(0, 4).map((event) => event.type)).toEqual([
          "step_start",
          "text",
          "tool_use",
          "step_finish",
        ])
        expect(events[1]?.part).toEqual(expect.objectContaining({ type: "text", text: "partial json" }))
        // The failed step retries a bounded number of times, and each retry
        // writes a "Stream dropped" notice text event — the tail's exact event
        // count depends on how many attempts the stub burns, so assert the
        // SHAPE: at least one notice reached the JSON stream, and the run
        // still ends on a step_finish rather than an error event.
        //
        // Still the REDO half of the unknown-finish split: `llm.fail` emits a
        // role delta and nothing else, so the failing attempt commits no prose
        // and has nothing worth continuing from.
        const noticeTexts = events.filter(
          (event) =>
            event.type === "text" &&
            typeof (event.part as { text?: string })?.text === "string" &&
            (event.part as { text: string }).text.startsWith("Stream dropped"),
        )
        expect(noticeTexts.length).toBeGreaterThan(0)
        expect(events.at(-1)?.type).toBe("step_finish")
      }),
    60_000,
  )

  cliIt.concurrent(
    "rejects requested permissions by default and allows them with the dangerous flag",
    ({ home, llm, origami }) =>
      Effect.gen(function* () {
        yield* llm.tool("bash", {
          explanation: "Remove a test file",
          command: "rm -f denied-file",
          description: "Remove a test file",
        })
        yield* llm.text("continued after rejection")
        const denied = yield* origami.run("request permission", { permission: { bash: "ask" } })
        origami.expectExit(denied, 0)
        expect(denied.stderr).toContain("permission requested: bash")
        expect(denied.stdout).toBe("")

        yield* llm.reset
        yield* llm.tool("bash", {
          explanation: "Remove a test file",
          command: "rm -f allowed-file",
          description: "Remove a test file",
        })
        yield* llm.text("continued after approval")
        const allowed = yield* origami.run("request permission", {
          permission: { bash: "ask" },
          extraArgs: ["--dangerously-skip-permissions"],
        })
        origami.expectExit(allowed, 0)
        expect(allowed.stderr).not.toContain("permission requested: bash")
        expect(allowed.stdout).toContain("continued after approval")

        yield* llm.reset
        yield* llm.tool("bash", {
          explanation: "Create a denied marker",
          command: "touch explicitly-denied",
          description: "Create a denied marker",
        })
        yield* llm.text("continued after explicit denial")
        const explicitlyDenied = yield* origami.run("request denied permission", {
          permission: { bash: "deny" },
          extraArgs: ["--dangerously-skip-permissions"],
        })
        origami.expectExit(explicitlyDenied, 0)
        expect(explicitlyDenied.stdout).toContain("continued after explicit denial")
        expect(yield* Effect.promise(() => Bun.file(`${home}/explicitly-denied`).exists())).toBe(false)
      }),
    60_000,
  )

  cliIt.live(
    "attach mode sends client-local file contents without a shared path",
    ({ home, llm, origami }) =>
      Effect.gen(function* () {
        const source = `${home}/client-only.txt`
        const sentinel = "client-only attachment sentinel"
        yield* Effect.promise(() => Bun.write(source, sentinel))
        yield* llm.text("attachment received")
        const server = yield* origami.serve()

        const result = yield* origami.run("read the attachment", {
          extraArgs: ["--attach", server.url, `--file=${source}`, "--"],
        })

        origami.expectExit(result, 0)
        const input = JSON.stringify(yield* llm.inputs)
        expect(input).toContain(sentinel)
        expect(input).not.toContain(`file://${source}`)
      }),
    60_000,
  )

  cliIt.concurrent(
    "attach mode rejects local directories before prompt admission",
    ({ home, origami }) =>
      Effect.gen(function* () {
        const result = yield* origami.run("read the directory", {
          extraArgs: ["--attach", "http://127.0.0.1:1", `--file=${home}`, "--"],
        })

        expect(result.exitCode).not.toBe(0)
        expect(result.stderr).toContain("Cannot attach local directory without a shared filesystem")
      }),
    30_000,
  )

  cliIt.live(
    "SIGINT interrupts an active non-interactive run without leaking the process",
    ({ llm, origami }) =>
      Effect.gen(function* () {
        yield* llm.hang
        const run = yield* origami.startRun("wait forever")
        yield* llm.wait(1)
        run.interrupt()
        const result = yield* run.result

        expect(result.exitCode).not.toBe(0)
        expect(result.durationMs).toBeLessThan(30_000)
      }),
    30_000,
  )
})
