// t-w2qlop: the REAL kernel32 calls, on this test process, on Windows only.
//
// The priority is read back through `os.getPriority`, which is libuv's own
// OpenProcess + GetPriorityClass - a second path to the same OS state, so the
// assertion is not the module agreeing with itself. EcoQoS has no such second
// path in Node; it is read back with GetProcessInformation, a separate call
// from the SetProcessInformation that wrote it. The process is put back to
// NORMAL in `finally`, whatever happens.
import { afterEach, describe, expect, test } from "bun:test"
import nodeOs from "node:os"
import { ElasticOs } from "@/elastic/os"
import { ElasticIdle } from "@/elastic/idle"
import { ElasticState } from "@/elastic/state"

afterEach(() => ElasticOs.clearExcluded?.())

// libuv's mapping of the Windows priority classes onto nice-style numbers.
const UV_PRIORITY = { normal: 0, "below-normal": 10, idle: 19 } as const

describe.skipIf(process.platform !== "win32")("elastic OS calls on Windows (real kernel32)", () => {
  test("idle sets IDLE + EcoQoS, background BELOW_NORMAL without EcoQoS, active puts NORMAL back", () => {
    const os = ElasticOs.windows()
    try {
      const idle = os.apply("idle")
      expect(idle).toEqual({ priority: "idle", ecoqos: true })
      expect(nodeOs.getPriority(process.pid)).toBe(UV_PRIORITY.idle)

      const background = os.apply("background")
      expect(background).toEqual({ priority: "below-normal", ecoqos: false })
      expect(nodeOs.getPriority(process.pid)).toBe(UV_PRIORITY["below-normal"])
    } finally {
      expect(os.apply("active")).toEqual({ priority: "normal", ecoqos: false })
      expect(nodeOs.getPriority(process.pid)).toBe(UV_PRIORITY.normal)
    }
  })

  test("a child follows the engine: lowered when it goes background, raised when it is active again", async () => {
    const os = ElasticOs.windows()
    const spawnIdle = () =>
      Bun.spawn([process.execPath, "-e", "setInterval(()=>{},1e6)"], { stdout: "ignore", stderr: "ignore" })
    const before = spawnIdle()
    let during: ReturnType<typeof spawnIdle> | undefined
    try {
      expect(nodeOs.getPriority(before.pid)).toBe(UV_PRIORITY.normal)
      expect(os.apply("background").childrenSet).toBeGreaterThanOrEqual(1)
      // An already-running child is lowered with the engine.
      expect(nodeOs.getPriority(before.pid)).toBe(UV_PRIORITY["below-normal"])
      // A child started while the engine is background inherits it (Windows rule).
      during = spawnIdle()
      await Bun.sleep(200)
      expect(nodeOs.getPriority(during.pid)).toBe(UV_PRIORITY["below-normal"])
      // On screen again: both are raised with the engine.
      os.apply("active")
      expect(nodeOs.getPriority(before.pid)).toBe(UV_PRIORITY.normal)
      expect(nodeOs.getPriority(during.pid)).toBe(UV_PRIORITY.normal)
    } finally {
      os.apply("active")
      before.kill()
      during?.kill()
    }
  }, 30_000)

  test("an excluded tree (the WebMCP browser) keeps its priority", async () => {
    const os = ElasticOs.windows()
    const browser = Bun.spawn([process.execPath, "-e", "setInterval(()=>{},1e6)"], { stdout: "ignore", stderr: "ignore" })
    try {
      ElasticOs.excludeTree(browser.pid)
      os.apply("background")
      expect(nodeOs.getPriority(browser.pid)).toBe(UV_PRIORITY.normal)
    } finally {
      os.apply("active")
      browser.kill()
    }
  }, 30_000)

  test("trim pushes the working set out: the resident size drops by most of what was touched", () => {
    // Touch ~64 MB so there is something resident to push out.
    const block = new Uint8Array(64 * 1024 * 1024)
    for (let i = 0; i < block.length; i += 4096) block[i] = 1
    const result = ElasticOs.windows().trim()
    expect(result.trimmed).toBe(true)
    expect(result.workingSetBefore).toBeGreaterThan(64 * 1024 * 1024)
    expect(result.workingSetAfter!).toBeLessThan(result.workingSetBefore! / 2)
    // Still usable: a trimmed page comes back on the next touch.
    expect(block[4096]).toBe(1)
  })

  test("trim reaches the engine's child processes too, found by the process tree", async () => {
    // A child that touches ~48 MB and waits, like an idle MCP server.
    const child = Bun.spawn(
      [process.execPath, "-e", "const b=new Uint8Array(48*1024*1024);for(let i=0;i<b.length;i+=4096)b[i]=1;setInterval(()=>{},1e6)"],
      { stdout: "ignore", stderr: "ignore" },
    )
    try {
      const workingSet = () =>
        Number(
          Bun.spawnSync(["powershell", "-NoProfile", "-Command", `(Get-Process -Id ${child.pid}).WorkingSet64`])
            .stdout.toString()
            .trim(),
        )
      for (let i = 0; i < 50 && workingSet() < 48 * 1024 * 1024; i++) await Bun.sleep(100)
      const before = workingSet()
      const result = ElasticOs.windows().trim()
      // Read by PowerShell, not by the module: an independent view of the child.
      const after = workingSet()
      expect(result.childrenTrimmed).toBeGreaterThanOrEqual(1)
      expect(before).toBeGreaterThan(48 * 1024 * 1024)
      expect(after).toBeLessThan(before / 4)
    } finally {
      child.kill()
    }
  }, 30_000)
})

// The same code paths with a FAKE kernel32 / libSystem, on every platform: the
// class-to-constant mapping and every failure branch, which the real OS will
// not produce on demand.
describe("elastic OS calls with a fake FFI", () => {
  function fakeKernel(over: Partial<ElasticOs.WinApi> = {}) {
    const calls: string[] = []
    let priority = 0x20
    let throttle = false
    const api: ElasticOs.WinApi = {
      setPriorityClass: (value) => {
        calls.push(`SetPriorityClass(0x${value.toString(16)})`)
        priority = value
        return true
      },
      getPriorityClass: () => priority,
      setThrottle: (on) => {
        calls.push(`SetProcessInformation(EXECUTION_SPEED=${on})`)
        throttle = on
        return true
      },
      getThrottle: () => throttle,
      emptyWorkingSet: () => {
        calls.push("K32EmptyWorkingSet")
        return true
      },
      createdAt: () => 1n,
      parents: () => new Map(),
      emptyWorkingSetOf: () => true,
      setPriorityClassOf: () => true,
      ...over,
    }
    return { api, calls }
  }

  test("each class sends the documented priority class, and EcoQoS only for idle", () => {
    const fake = fakeKernel()
    const os = ElasticOs.windows({ load: () => fake.api })
    expect(os.apply("idle")).toEqual({ priority: "idle", ecoqos: true })
    expect(os.apply("background")).toEqual({ priority: "below-normal", ecoqos: false })
    expect(os.apply("active")).toEqual({ priority: "normal", ecoqos: false })
    expect(fake.calls).toEqual([
      "SetPriorityClass(0x40)",
      "SetProcessInformation(EXECUTION_SPEED=true)",
      "SetPriorityClass(0x4000)",
      "SetProcessInformation(EXECUTION_SPEED=false)",
      "SetPriorityClass(0x20)",
      "SetProcessInformation(EXECUTION_SPEED=false)",
    ])
  })

  test("a refused call is reported and the read-back says what the OS really has", () => {
    const fake = fakeKernel({ setPriorityClass: () => false })
    expect(ElasticOs.windows({ load: () => fake.api }).apply("idle")).toEqual({
      priority: "normal",
      ecoqos: true,
      error: "SetPriorityClass failed",
    })
  })

  test("a throwing call, a missing DLL and a failed trim are results, never exceptions", () => {
    const throwing = fakeKernel({
      setThrottle: () => {
        throw new Error("bad struct")
      },
    })
    expect(ElasticOs.windows({ load: () => throwing.api }).apply("idle").error).toBe(
      "SetProcessInformation threw: bad struct",
    )
    const missing = ElasticOs.windows({
      load: () => {
        throw new Error("dlopen failed")
      },
    })
    expect(missing.apply("idle")).toEqual({
      priority: "unsupported",
      ecoqos: false,
      error: "kernel32 could not be loaded: dlopen failed",
    })
    expect(missing.trim()).toEqual({ trimmed: false, reason: "kernel32 could not be loaded: dlopen failed" })
    const refused = fakeKernel({ emptyWorkingSet: () => false })
    expect(ElasticOs.windows({ load: () => refused.api, workingSet: () => 900 }).trim()).toEqual({
      trimmed: false,
      reason: "K32EmptyWorkingSet failed",
      workingSetBefore: 900,
    })
  })

  test("macOS: PRIO_DARWIN_BG on for idle only, cleared for the others, and a failure is reported", () => {
    const calls: number[][] = []
    const os = ElasticOs.darwin({
      load: () => (which, who, prio) => {
        calls.push([which, who, prio])
        return 0
      },
    })
    expect(os.apply("idle")).toEqual({ priority: "background", ecoqos: false })
    expect(os.apply("background")).toEqual({ priority: "normal", ecoqos: false })
    expect(os.apply("active")).toEqual({ priority: "normal", ecoqos: false })
    // PRIO_DARWIN_PROCESS = 4, who = 0 (self), PRIO_DARWIN_BG = 0x1000.
    expect(calls).toEqual([
      [4, 0, 0x1000],
      [4, 0, 0],
      [4, 0, 0],
    ])
    expect(os.trim()).toEqual({ trimmed: false, reason: "unsupported-platform" })
    const failing = ElasticOs.darwin({ load: () => () => -1 })
    expect(failing.apply("idle").error).toBe("setpriority(PRIO_DARWIN_PROCESS) failed")
  })

  test("macOS: PRIO_DARWIN_BG is per process, so every descendant gets the same call both ways", () => {
    const calls: number[][] = []
    const tree = new Map<number, number[]>([
      [process.pid, [7, 20]],
      [7, [9]],
      [20, [21]],
    ])
    const os = ElasticOs.darwin({
      load: () => ({
        setpriority: (which, who, prio) => {
          calls.push([which, who, prio])
          return 0
        },
        childPids: (pid) => tree.get(pid) ?? [],
      }),
    })
    ElasticOs.excludeTree(20)
    expect(os.apply("idle")).toEqual({ priority: "background", ecoqos: false, childrenSet: 2 })
    expect(os.apply("active")).toEqual({ priority: "normal", ecoqos: false, childrenSet: 2 })
    expect(calls).toEqual([
      [4, 0, 0x1000],
      [4, 7, 0x1000],
      [4, 9, 0x1000],
      [4, 0, 0],
      [4, 7, 0],
      [4, 9, 0],
    ])
  })
})

describe("the process tree walk", () => {
  test("every descendant, not the root, not a stranger, and a parent loop does not hang", () => {
    const parents = new Map([
      [10, 1], // the root's child
      [11, 10], // a grandchild (the node under an npx shim)
      [12, 10],
      [20, 2], // another process tree
      [30, 31], // a loop from recycled pids
      [31, 30],
      [1, 0],
    ])
    expect(ElasticOs.descendantsOf(1, parents).sort()).toEqual([10, 11, 12])
    expect(ElasticOs.descendantsOf(30, parents)).toEqual([31])
  })

  test("with a fake kernel32, every child is trimmed and one that fails is skipped", () => {
    const trimmed: number[] = []
    const os = ElasticOs.windows({
      load: () => ({
        setPriorityClass: () => true,
        getPriorityClass: () => 0x20,
        setThrottle: () => true,
        getThrottle: () => false,
        emptyWorkingSet: () => true,
        createdAt: () => 1n,
        parents: () => new Map([[7, process.pid], [8, process.pid], [9, 7]]),
        setPriorityClassOf: () => true,
        emptyWorkingSetOf: (pid) => {
          if (pid === 8) throw new Error("gone")
          trimmed.push(pid)
          return true
        },
      }),
      workingSet: () => 100,
    })
    expect(os.trim()).toEqual({ trimmed: true, workingSetBefore: 100, workingSetAfter: 100, childrenTrimmed: 2 })
    expect(trimmed).toEqual([7, 9])
  })

  test("children follow the engine's priority class both ways; EcoQoS stays on the engine; an excluded tree is untouched", () => {
    const children = new Map<number, number>()
    let throttleCalls = 0
    const os = ElasticOs.windows({
      load: () => ({
        setPriorityClass: () => true,
        getPriorityClass: () => 0x20,
        setThrottle: () => {
          throttleCalls++
          return true
        },
        getThrottle: () => false,
        emptyWorkingSet: () => true,
        // 7 an MCP server, 9 its node child, 20 the WebMCP browser, 21 its renderer,
        // 30 a process of someone else.
        createdAt: () => 1n,
        parents: () =>
          new Map([
            [7, process.pid],
            [9, 7],
            [20, process.pid],
            [21, 20],
            [30, 1],
          ]),
        setPriorityClassOf: (pid, value) => {
          children.set(pid, value)
          return true
        },
        emptyWorkingSetOf: () => true,
      }),
    })
    ElasticOs.excludeTree(20)

    expect(os.apply("background").childrenSet).toBe(2)
    expect(Object.fromEntries(children)).toEqual({ 7: 0x4000, 9: 0x4000 })
    expect(os.apply("idle").childrenSet).toBe(2)
    expect(Object.fromEntries(children)).toEqual({ 7: 0x40, 9: 0x40 })
    // Back on screen: a child started while hidden is raised with the engine.
    expect(os.apply("active").childrenSet).toBe(2)
    expect(Object.fromEntries(children)).toEqual({ 7: 0x20, 9: 0x20 })
    // One EcoQoS call per apply, and it is the engine's own.
    expect(throttleCalls).toBe(3)
  })

  test("a child that cannot be opened is not counted and is not an error", () => {
    const os = ElasticOs.windows({
      load: () => ({
        setPriorityClass: () => true,
        getPriorityClass: () => 0x4000,
        setThrottle: () => true,
        getThrottle: () => false,
        emptyWorkingSet: () => true,
        createdAt: () => 1n,
        parents: () => new Map([[7, process.pid], [8, process.pid]]),
        setPriorityClassOf: (pid) => {
          if (pid === 8) throw new Error("exited")
          return true
        },
        emptyWorkingSetOf: () => true,
      }),
    })
    expect(os.apply("background")).toEqual({ priority: "below-normal", ecoqos: false, childrenSet: 1 })
  })

  // t-wdybz9 (review finding 4): Windows keeps a dead parent's pid in
  // th32ParentProcessID and gives that pid to new processes. A process whose
  // parent died before the engine was born is not the engine's child, even when
  // the engine got that pid. The creation time is what tells them apart.
  test("a process older than the engine is never its child, whatever parent pid it records", () => {
    const touched: number[] = []
    const trimmed: number[] = []
    const born = new Map<number, bigint>([
      [process.pid, 1000n],
      [40, 500n], // an orphan whose dead parent had the engine's pid
      [41, 600n], // its own child
      [7, 1100n], // a real child (an MCP server)
      [9, 1200n], // its child
    ])
    const os = ElasticOs.windows({
      load: () => ({
        setPriorityClass: () => true,
        getPriorityClass: () => 0x4000,
        setThrottle: () => true,
        getThrottle: () => false,
        emptyWorkingSet: () => true,
        createdAt: (pid) => born.get(pid),
        parents: () =>
          new Map([
            [40, process.pid],
            [41, 40],
            [7, process.pid],
            [9, 7],
            [8, process.pid], // cannot be opened: no creation time, so not trusted
          ]),
        setPriorityClassOf: (pid) => (touched.push(pid), true),
        emptyWorkingSetOf: (pid) => (trimmed.push(pid), true),
      }),
      workingSet: () => 1,
    })
    expect(os.apply("idle").childrenSet).toBe(2)
    expect(touched.toSorted()).toEqual([7, 9])
    expect(os.trim().childrenTrimmed).toBe(2)
    expect(trimmed.toSorted()).toEqual([7, 9])
  })
})

describe.skipIf(process.platform !== "win32")("the child walk on the real kernel32", () => {
  test("a child is acted on only while it is still the process the walk saw (pid + creation time)", async () => {
    const api = ElasticOs.kernel32()
    const child = Bun.spawn([process.execPath, "-e", "setInterval(()=>{},1e6)"], { stdout: "ignore", stderr: "ignore" })
    try {
      const created = api.createdAt(child.pid)
      expect(typeof created).toBe("bigint")
      expect(created! >= api.createdAt(process.pid)!).toBe(true)
      // A pid now held by a different process has a different creation time.
      expect(api.setPriorityClassOf(child.pid, 0x4000, created! + 1n)).toBe(false)
      expect(nodeOs.getPriority(child.pid)).toBe(UV_PRIORITY.normal)
      expect(api.setPriorityClassOf(child.pid, 0x4000, created!)).toBe(true)
      expect(nodeOs.getPriority(child.pid)).toBe(UV_PRIORITY["below-normal"])
      expect(api.emptyWorkingSetOf(child.pid, created! + 1n)).toBe(false)
    } finally {
      child.kill()
    }
  }, 30_000)
})

// t-wdybz9 (review finding 11): a status write (turn start / end) changes the
// effective class, and the class listener used to walk the whole process table
// inside that write (11-25 ms per call measured on Windows). The engine's own
// priority still moves at once; the child walk runs later, once per burst.
describe("the class-change path", () => {
  afterEach(() => {
    ElasticState.resetForTest()
    ElasticIdle.resetForTest()
    ElasticOs.setForTest(undefined)
  })

  test("a class change does not wait for the child walk, and the walk follows once with the last class", async () => {
    const own: number[] = []
    const children: Array<[number, number]> = []
    let walks = 0
    ElasticOs.setForTest(
      ElasticOs.windows({
        load: () => ({
          setPriorityClass: (value) => (own.push(value), true),
          getPriorityClass: () => own.at(-1) ?? 0x20,
          setThrottle: () => true,
          getThrottle: () => false,
          emptyWorkingSet: () => true,
          createdAt: () => 1n,
          parents: () => {
            walks++
            const until = performance.now() + 30 // what a real Toolhelp snapshot costs here
            while (performance.now() < until) {}
            return new Map([[7, process.pid]])
          },
          setPriorityClassOf: (pid, value) => (children.push([pid, value]), true),
          emptyWorkingSetOf: () => true,
        }),
      }),
    )
    ElasticIdle.install()

    const started = performance.now()
    ElasticState.request("background")
    ElasticState.request("idle")
    const took = performance.now() - started

    expect(took).toBeLessThan(5)
    expect(own).toEqual([0x4000, 0x40])
    expect(walks).toBe(0)
    await Bun.sleep(ElasticIdle.CHILD_WALK_DELAY_MS + 200)
    expect(walks).toBe(1)
    expect(children).toEqual([[7, 0x40]])
  })

  test("the `_elastic_class` answer still counts the children it set", () => {
    ElasticOs.setForTest(
      ElasticOs.windows({
        load: () => ({
          setPriorityClass: () => true,
          getPriorityClass: () => 0x4000,
          setThrottle: () => true,
          getThrottle: () => false,
          emptyWorkingSet: () => true,
          createdAt: () => 1n,
          parents: () => new Map([[7, process.pid]]),
          setPriorityClassOf: () => true,
          emptyWorkingSetOf: () => true,
        }),
      }),
    )
    expect(ElasticIdle.setClass("background")).toEqual({
      class: "background",
      priority: "below-normal",
      ecoqos: false,
      childrenSet: 1,
    })
  })
})

describe("elastic OS calls elsewhere", () => {
  test("a platform with no support answers without an OS call and without an error", () => {
    const os = ElasticOs.forPlatform("linux")
    expect(os.apply("idle")).toEqual({ priority: "unsupported", ecoqos: false })
    expect(os.trim()).toEqual({ trimmed: false, reason: "unsupported-platform" })
  })
})
