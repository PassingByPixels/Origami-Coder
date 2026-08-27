import { describe, expect, test } from "bun:test"
import {
  backgroundLaunch,
  createBackgroundTracker,
  describeOutstanding,
  observeIdle,
} from "@/cli/cmd/run/background.wait"

const RUN = "ses_run"
const CHILD = "ses_bg_child"

function taskPart(input: { status: string; metadata: Record<string, unknown>; title?: string }) {
  return {
    type: "tool",
    tool: "task",
    state: { status: input.status, title: input.title, metadata: input.metadata },
  }
}

describe("backgroundLaunch", () => {
  test("recognises a completed background task by its jobId", () => {
    const launch = backgroundLaunch(
      taskPart({ status: "completed", title: "write bg proof", metadata: { background: true, jobId: CHILD } }),
    )
    expect(launch).toEqual({ sessionID: CHILD, description: "write bg proof" })
  })

  test("recognises a running background task by its sessionId", () => {
    const launch = backgroundLaunch(
      taskPart({ status: "running", metadata: { background: true, sessionId: CHILD } }),
    )
    expect(launch?.sessionID).toBe(CHILD)
  })

  test("a FOREGROUND task is not a detached launch", () => {
    expect(backgroundLaunch(taskPart({ status: "completed", metadata: { sessionId: CHILD } }))).toBeUndefined()
  })

  test("non-task tools and text parts are ignored", () => {
    expect(
      backgroundLaunch({ type: "tool", tool: "write", state: { metadata: { background: true, jobId: CHILD } } }),
    ).toBeUndefined()
    expect(backgroundLaunch({ type: "text" })).toBeUndefined()
  })
})

describe("observeIdle", () => {
  // The bug this guards: `origami run` broke its event loop the moment the RUN
  // session went idle. A background subagent is detached, so that happens while the
  // child is still working - the process exited and the child was aborted mid-turn
  // with nothing written. Asserting the FIRST run-idle does not stop the run is the
  // whole point; asserting the tracker's internals would pass against the old code.
  test("does not stop at the first run-session idle while a child is outstanding", () => {
    const tracker = createBackgroundTracker()
    tracker.track({ sessionID: CHILD, description: "write bg proof" })

    expect(observeIdle(tracker, { idleSessionID: RUN, runSessionID: RUN })).toBe("continue")
    expect(tracker.size()).toBe(1)
  })

  test("stops only once the detached child has settled and the run is idle again", () => {
    const tracker = createBackgroundTracker()
    tracker.track({ sessionID: CHILD, description: "write bg proof" })

    expect(observeIdle(tracker, { idleSessionID: RUN, runSessionID: RUN })).toBe("continue")
    // Child finishes. Its own idle must not end the run either - the result is still
    // being injected into the parent as a fresh turn.
    expect(observeIdle(tracker, { idleSessionID: CHILD, runSessionID: RUN })).toBe("continue")
    expect(tracker.size()).toBe(0)
    // Parent's injected turn finishes.
    expect(observeIdle(tracker, { idleSessionID: RUN, runSessionID: RUN })).toBe("stop")
  })

  test("waits for every child when several were launched", () => {
    const tracker = createBackgroundTracker()
    tracker.track({ sessionID: "ses_a", description: "a" })
    tracker.track({ sessionID: "ses_b", description: "b" })

    expect(observeIdle(tracker, { idleSessionID: "ses_a", runSessionID: RUN })).toBe("continue")
    expect(observeIdle(tracker, { idleSessionID: RUN, runSessionID: RUN })).toBe("continue")
    expect(observeIdle(tracker, { idleSessionID: "ses_b", runSessionID: RUN })).toBe("continue")
    expect(observeIdle(tracker, { idleSessionID: RUN, runSessionID: RUN })).toBe("stop")
  })

  test("a plain run with no background children stops at its first idle", () => {
    const tracker = createBackgroundTracker()
    expect(observeIdle(tracker, { idleSessionID: RUN, runSessionID: RUN })).toBe("stop")
  })

  test("an unrelated session going idle never stops the run", () => {
    const tracker = createBackgroundTracker()
    expect(observeIdle(tracker, { idleSessionID: "ses_stranger", runSessionID: RUN })).toBe("continue")
  })

  test("tracking the same child twice does not double-count it", () => {
    const tracker = createBackgroundTracker()
    tracker.track({ sessionID: CHILD, description: "running" })
    tracker.track({ sessionID: CHILD, description: "completed" })
    expect(tracker.size()).toBe(1)
  })
})

describe("describeOutstanding", () => {
  test("names what is still running so the give-up path is never silent", () => {
    const tracker = createBackgroundTracker()
    tracker.track({ sessionID: CHILD, description: "write bg proof" })
    expect(describeOutstanding(tracker)).toBe(`write bg proof (${CHILD})`)
  })
})
