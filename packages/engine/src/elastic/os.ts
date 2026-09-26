export * as ElasticOs from "./os"

import type { ElasticClass } from "./state"

/**
 * THE OS HALF OF THE ELASTIC CLASS (t-w2qlop): the engine lowers its OWN
 * priority, and pushes its OWN working set out, reversibly and without a helper.
 *
 * Windows (kernel32 through `bun:ffi`):
 *  - priority class: active NORMAL, background BELOW_NORMAL, idle IDLE.
 *  - EcoQoS (`SetProcessInformation(ProcessPowerThrottling)` with the
 *    EXECUTION_SPEED bit) ON for idle only. Every other class hands the choice
 *    back to the system (control mask 0), which is the state a process starts in.
 *  - trim: `K32EmptyWorkingSet` on the current process, then on every
 *    descendant process (MCP / LSP servers and their children), found with a
 *    Toolhelp snapshot so no service has to hand its pids over.
 * macOS (libSystem): `setpriority(PRIO_DARWIN_PROCESS, 0, PRIO_DARWIN_BG)` for
 *  idle and `0` to clear it. Unlike `nice`, it needs no root to undo. Background
 *  stays at normal on macOS: PRIO_DARWIN_BG also throttles disk and network
 *  I/O, which is too much for a chat that is only hidden. No trim on macOS.
 * Anything else: no call, and the result says so.
 *
 * NOTHING HERE MAY THROW. Every OS call is wrapped; a failure comes back in the
 * result as `error`, and the engine carries on at whatever class it had.
 *
 * CHILDREN FOLLOW THE ENGINE. Every apply sets the same priority on every
 * descendant process (MCP / LSP servers, shells, git), found from the OS
 * process tree, not from the services: a child started while the chat was
 * hidden inherits BELOW_NORMAL / IDLE on Windows, and without this it would stay
 * low after the chat is on screen again. EcoQoS stays on the engine only: a
 * child's own work (an MCP call) runs inside a turn, and the engine is never at
 * EcoQoS during a turn, so throttling the children's execution speed would slow
 * nothing that matters and risk a tool call being slowed when it does run. The
 * TRIM covers the children too. A process tree registered with `excludeTree`
 * (the WebMCP browser: detached, the owner's window) is left alone by both.
 *
 * origami_change (t-wdybz9): a CHILD IS PROVED, NOT ASSUMED. Windows keeps a
 * dead parent's pid in th32ParentProcessID and reuses pids, so an unrelated
 * process can name the engine's pid as its parent. An edge counts only when the
 * child was created after its parent (the check psutil and Process Explorer
 * use), and every act re-checks the creation time on the handle it acts
 * through, so a pid that changed owner after the walk is skipped. The walk is
 * the expensive part (a full Toolhelp snapshot, 11-25 ms measured): `apply`
 * can leave it out, and `applyChildren` runs it on its own, so the class
 * listener inside a session status write stays cheap (elastic/idle.ts).
 */

export type Priority = "normal" | "below-normal" | "idle" | "background" | "unsupported"

export interface ApplyResult {
  /** The priority the process has now, read back where the OS allows it. */
  readonly priority: Priority
  /** Whether EcoQoS (Windows power throttling of execution speed) is on now. */
  readonly ecoqos: boolean
  /** How many child processes were given the same priority. Absent when the
   *  engine has none. A child that exited mid-walk is not counted and is not an
   *  error. */
  readonly childrenSet?: number
  /** Set when an OS call failed. The engine keeps running either way. */
  readonly error?: string
}

// ------------------------------------------------------- excluded trees ---

const excluded = new Set<number>()

/** Leave this process and everything below it out of priority changes and
 *  trims. For a process the engine starts but does not own the life of - the
 *  WebMCP browser is detached and is a window the owner may be using. */
export function excludeTree(pid: number | undefined): void {
  if (typeof pid === "number" && pid > 0) excluded.add(pid)
}

/** Test seam. */
export function clearExcluded(): void {
  excluded.clear()
}

export interface TrimResult {
  readonly trimmed: boolean
  readonly reason?: string
  readonly workingSetBefore?: number
  readonly workingSetAfter?: number
  /** How many child processes (MCP / LSP servers, their own children) were
   *  trimmed with the engine. */
  readonly childrenTrimmed?: number
}

export interface Os {
  /** Set the class on this process and, unless `children` is false, on every
   *  descendant too (then `childrenSet` counts them). */
  apply(cls: ElasticClass, options?: { children?: boolean }): ApplyResult
  /** The descendant half of `apply` alone. How many were set, or undefined
   *  when there are none. Optional: an OS (or a fake) without it has none. */
  applyChildren?(cls: ElasticClass): number | undefined
  trim(): TrimResult
}

// ---------------------------------------------------------------- Windows ---

const NORMAL_PRIORITY_CLASS = 0x20
const IDLE_PRIORITY_CLASS = 0x40
const BELOW_NORMAL_PRIORITY_CLASS = 0x4000
/** `PROCESS_INFORMATION_CLASS.ProcessPowerThrottling`. */
const PROCESS_POWER_THROTTLING = 4
const PROCESS_POWER_THROTTLING_CURRENT_VERSION = 1
const PROCESS_POWER_THROTTLING_EXECUTION_SPEED = 0x1
/** `GetCurrentProcess()` is this constant pseudo-handle; passing it as a 64-bit
 *  integer avoids a pointer round trip through a JS number. */
const CURRENT_PROCESS = -1n

const WIN_CLASS: Record<ElasticClass, number> = {
  active: NORMAL_PRIORITY_CLASS,
  background: BELOW_NORMAL_PRIORITY_CLASS,
  idle: IDLE_PRIORITY_CLASS,
}

function priorityOf(value: number): Priority | undefined {
  if (value === NORMAL_PRIORITY_CLASS) return "normal"
  if (value === BELOW_NORMAL_PRIORITY_CLASS) return "below-normal"
  if (value === IDLE_PRIORITY_CLASS) return "idle"
  return undefined
}

/** The five kernel32 operations this module uses, as plain calls. The real
 *  one is `bun:ffi`; a test hands in a fake to drive every branch. */
export interface WinApi {
  setPriorityClass(value: number): boolean
  getPriorityClass(): number
  /** EcoQoS on (true) or back to the system's choice (false). */
  setThrottle(on: boolean): boolean
  /** EcoQoS as the OS reports it, or undefined when it cannot say. */
  getThrottle(): boolean | undefined
  emptyWorkingSet(): boolean
  /** The live process table as pid -> parent pid. */
  parents(): Map<number, number>
  /** A process's creation time (FILETIME ticks), or undefined when it cannot
   *  be opened. Together with the pid it names one process for its whole life. */
  createdAt(pid: number): bigint | undefined
  /** Trim one other process. False when it cannot be opened or trimmed, or,
   *  with `createdAt`, when the pid now belongs to another process. */
  emptyWorkingSetOf(pid: number, createdAt?: bigint): boolean
  /** Set one other process's priority class. False when it cannot be opened,
   *  or, with `createdAt`, when the pid now belongs to another process. */
  setPriorityClassOf(pid: number, value: number, createdAt?: bigint): boolean
}

/** The real kernel32 calls. Exported for the Windows-only test that checks the
 *  identity pin against the OS itself. */
export function kernel32(): WinApi {
  // Required here, not imported at the top: `bun:ffi` must not load on a
  // platform (or in a test) that never makes an OS call.
  const { dlopen, ptr } = require("bun:ffi") as typeof import("bun:ffi")
  const lib = dlopen("kernel32.dll", {
    SetPriorityClass: { args: ["i64", "u32"], returns: "i32" },
    GetPriorityClass: { args: ["i64"], returns: "u32" },
    SetProcessInformation: { args: ["i64", "i32", "ptr", "u32"], returns: "i32" },
    GetProcessInformation: { args: ["i64", "i32", "ptr", "u32"], returns: "i32" },
    K32EmptyWorkingSet: { args: ["i64"], returns: "i32" },
    CreateToolhelp32Snapshot: { args: ["u32", "u32"], returns: "i64" },
    Process32FirstW: { args: ["i64", "ptr"], returns: "i32" },
    Process32NextW: { args: ["i64", "ptr"], returns: "i32" },
    OpenProcess: { args: ["u32", "i32", "u32"], returns: "i64" },
    CloseHandle: { args: ["i64"], returns: "i32" },
    GetProcessTimes: { args: ["i64", "ptr", "ptr", "ptr", "ptr"], returns: "i32" },
  }).symbols
  /** Creation time of the process behind `handle`, as FILETIME ticks. */
  const created = (handle: bigint | number): bigint | undefined => {
    const times = new BigUint64Array(4) // creation, exit, kernel, user
    const at = (index: number) => ptr(times, index * 8)
    if (lib.GetProcessTimes(handle, at(0), at(1), at(2), at(3)) === 0) return undefined
    return times[0]!
  }
  /** Open `pid` with `rights` (+ query), check it is still the process created
   *  at `expected` when one is given, then act on that same handle. */
  const withProcess = (
    pid: number,
    rights: number,
    expected: bigint | undefined,
    act: (h: bigint | number) => boolean,
  ) => {
    const handle = lib.OpenProcess(rights | PROCESS_QUERY_LIMITED_INFORMATION, 0, pid)
    if (BigInt(handle) === 0n) return false
    try {
      if (expected !== undefined && created(handle) !== expected) return false
      return act(handle)
    } finally {
      lib.CloseHandle(handle)
    }
  }
  return {
    setPriorityClass: (value) => lib.SetPriorityClass(CURRENT_PROCESS, value) !== 0,
    getPriorityClass: () => lib.GetPriorityClass(CURRENT_PROCESS),
    setThrottle: (on) => {
      // PROCESS_POWER_THROTTLING_STATE { Version, ControlMask, StateMask }.
      const bit = on ? PROCESS_POWER_THROTTLING_EXECUTION_SPEED : 0
      const state = new Uint32Array([PROCESS_POWER_THROTTLING_CURRENT_VERSION, bit, bit])
      return lib.SetProcessInformation(CURRENT_PROCESS, PROCESS_POWER_THROTTLING, ptr(state), state.byteLength) !== 0
    },
    getThrottle: () => {
      const state = new Uint32Array([PROCESS_POWER_THROTTLING_CURRENT_VERSION, 0, 0])
      if (lib.GetProcessInformation(CURRENT_PROCESS, PROCESS_POWER_THROTTLING, ptr(state), state.byteLength) === 0)
        return undefined
      const bit = PROCESS_POWER_THROTTLING_EXECUTION_SPEED
      return (state[1]! & bit) !== 0 && (state[2]! & bit) !== 0
    },
    emptyWorkingSet: () => lib.K32EmptyWorkingSet(CURRENT_PROCESS) !== 0,
    parents: () => {
      const parents = new Map<number, number>()
      const snapshot = lib.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
      if (BigInt(snapshot) === INVALID_HANDLE) return parents
      try {
        // PROCESSENTRY32W (x64): dwSize at 0, th32ProcessID at 8,
        // th32ParentProcessID at 32; 568 bytes with its WCHAR[260] name.
        const entry = new Uint32Array(PROCESSENTRY32W_SIZE / 4)
        entry[0] = PROCESSENTRY32W_SIZE
        for (let ok = lib.Process32FirstW(snapshot, ptr(entry)); ok !== 0; ok = lib.Process32NextW(snapshot, ptr(entry)))
          parents.set(entry[2]!, entry[8]!)
      } finally {
        lib.CloseHandle(snapshot)
      }
      return parents
    },
    createdAt: (pid) => {
      if (pid === process.pid) return created(CURRENT_PROCESS)
      const handle = lib.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid)
      if (BigInt(handle) === 0n) return undefined
      try {
        return created(handle)
      } finally {
        lib.CloseHandle(handle)
      }
    },
    emptyWorkingSetOf: (pid, expected) =>
      withProcess(pid, PROCESS_SET_QUOTA, expected, (handle) => lib.K32EmptyWorkingSet(handle) !== 0),
    setPriorityClassOf: (pid, value, expected) =>
      withProcess(pid, PROCESS_SET_INFORMATION, expected, (handle) => lib.SetPriorityClass(handle, value) !== 0),
  }
}

/** Run `act` on every PROVED descendant of this process that is not excluded
 *  (see the header: created after its parent), with the creation time the walk
 *  saw, so the act can refuse a pid that changed owner since. Returns how many
 *  succeeded, or undefined when there are none (or no process list). A child
 *  that exits mid-walk, or throws, is skipped: it is not the engine's failure. */
function eachChild(
  lib: Pick<WinApi, "parents" | "createdAt">,
  act: (pid: number, createdAt: bigint | undefined) => boolean,
): number | undefined {
  const born = new Map<number, bigint | undefined>()
  const createdAt = (pid: number) => {
    if (!born.has(pid)) {
      let value: bigint | undefined
      try {
        value = lib.createdAt(pid)
      } catch {
        value = undefined
      }
      born.set(pid, value)
    }
    return born.get(pid)
  }
  let pids: number[]
  try {
    pids = descendantsOf(process.pid, lib.parents(), excluded, createdAt)
  } catch {
    return undefined
  }
  if (pids.length === 0) return undefined
  let done = 0
  for (const pid of pids) {
    try {
      if (act(pid, born.get(pid))) done++
    } catch {
      // One child that vanished must not stop the others.
    }
  }
  return done
}

const TH32CS_SNAPPROCESS = 0x2
const INVALID_HANDLE = -1n
const PROCESSENTRY32W_SIZE = 568
const PROCESS_SET_QUOTA = 0x0100
const PROCESS_SET_INFORMATION = 0x0200
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000

/** The pids below `root` in a pid -> parent map, leaving out every excluded
 *  pid AND its subtree. A visited set guards against a parent loop, which a
 *  recycled pid can produce in a snapshot. With `createdAt`, an edge counts
 *  only when both creation times are known and the child's is not earlier
 *  than its parent's: a process that names a reused pid as its parent is not
 *  that pid's child. */
export function descendantsOf(
  root: number,
  parents: ReadonlyMap<number, number>,
  skip: ReadonlySet<number> = excluded,
  createdAt?: (pid: number) => bigint | undefined,
): number[] {
  const children = new Map<number, number[]>()
  for (const [pid, parent] of parents) {
    if (pid === parent) continue
    const list = children.get(parent) ?? []
    list.push(pid)
    children.set(parent, list)
  }
  const out: number[] = []
  const seen = new Set<number>([root])
  const queue = (children.get(root) ?? []).map((pid) => [pid, root] as const)
  const proved = (pid: number, parent: number) => {
    if (!createdAt) return true
    const child = createdAt(pid)
    const born = createdAt(parent)
    return child !== undefined && born !== undefined && child >= born
  }
  while (queue.length) {
    const [pid, parent] = queue.shift()!
    if (seen.has(pid) || skip.has(pid)) continue
    if (!proved(pid, parent)) continue
    seen.add(pid)
    out.push(pid)
    queue.push(...(children.get(pid) ?? []).map((child) => [child, pid] as const))
  }
  return out
}

export function windows(
  options: { load?: () => WinApi; workingSet?: () => number } = {},
): Os {
  const loader = options.load ?? kernel32
  const workingSet = options.workingSet ?? (() => process.memoryUsage.rss())
  let api: WinApi | undefined
  let loadError: string | undefined
  const load = (): WinApi | undefined => {
    if (api || loadError) return api
    try {
      api = loader()
    } catch (error) {
      loadError = `kernel32 could not be loaded: ${message(error)}`
    }
    return api
  }
  const applyChildren = (cls: ElasticClass): number | undefined => {
    const lib = load()
    if (!lib) return undefined
    return eachChild(lib, (pid, createdAt) => lib.setPriorityClassOf(pid, WIN_CLASS[cls], createdAt))
  }
  return {
    applyChildren,
    apply(cls, options) {
      const lib = load()
      if (!lib) return { priority: "unsupported", ecoqos: false, error: loadError }
      const errors: string[] = []
      try {
        if (!lib.setPriorityClass(WIN_CLASS[cls])) errors.push("SetPriorityClass failed")
      } catch (error) {
        errors.push(`SetPriorityClass threw: ${message(error)}`)
      }
      try {
        if (!lib.setThrottle(cls === "idle")) errors.push("SetProcessInformation(ProcessPowerThrottling) failed")
      } catch (error) {
        errors.push(`SetProcessInformation threw: ${message(error)}`)
      }
      let priority: Priority | undefined
      let ecoqos: boolean | undefined
      try {
        priority = priorityOf(lib.getPriorityClass())
        ecoqos = lib.getThrottle()
      } catch (error) {
        errors.push(`read-back threw: ${message(error)}`)
      }
      const childrenSet = options?.children === false ? undefined : applyChildren(cls)
      // What the OS reports wins; the requested value stands in only when it
      // cannot be read.
      return {
        priority: priority ?? priorityOf(WIN_CLASS[cls])!,
        ecoqos: ecoqos ?? cls === "idle",
        ...(childrenSet === undefined ? {} : { childrenSet }),
        ...(errors.length ? { error: errors.join("; ") } : {}),
      }
    },
    trim() {
      const lib = load()
      if (!lib) return { trimmed: false, reason: loadError }
      const before = safe(workingSet)
      let ok = false
      try {
        ok = lib.emptyWorkingSet()
      } catch (error) {
        return { trimmed: false, reason: `K32EmptyWorkingSet threw: ${message(error)}`, ...sizes(before) }
      }
      if (!ok) return { trimmed: false, reason: "K32EmptyWorkingSet failed", ...sizes(before) }
      const after = safe(workingSet)
      // The children too (lead, measure_cheap_checks.md): each MCP / LSP server
      // holds 25-28 MB private. A child that cannot be opened is skipped; it is
      // not the engine's failure.
      const childrenTrimmed = eachChild(lib, (pid, createdAt) => lib.emptyWorkingSetOf(pid, createdAt)) ?? 0
      return { trimmed: true, ...sizes(before, after), childrenTrimmed }
    },
  }
}

// ------------------------------------------------------------------ macOS ---

const PRIO_DARWIN_PROCESS = 4
const PRIO_DARWIN_BG = 0x1000

export type SetPriority = (which: number, who: number, prio: number) => number

/** The two libSystem calls: `setpriority`, and the direct children of a pid
 *  (`proc_listchildpids`, libproc). */
export interface DarwinApi {
  setpriority: SetPriority
  childPids(pid: number): number[]
}

function libSystem(): DarwinApi {
  const { dlopen, ptr } = require("bun:ffi") as typeof import("bun:ffi")
  const lib = dlopen("/usr/lib/libSystem.B.dylib", {
    setpriority: { args: ["i32", "u32", "i32"], returns: "i32" },
    proc_listchildpids: { args: ["i32", "ptr", "i32"], returns: "i32" },
  })
  return {
    setpriority: (which, who, prio) => lib.symbols.setpriority(which, who, prio),
    childPids: (pid) => {
      const buffer = new Int32Array(1024)
      // Returns the NUMBER of pids written (libproc), or <= 0 on error.
      const count = lib.symbols.proc_listchildpids(pid, ptr(buffer), buffer.byteLength)
      return count > 0 ? [...buffer.subarray(0, Math.min(count, buffer.length))].filter((child) => child > 0) : []
    },
  }
}

export function darwin(options: { load?: () => DarwinApi | SetPriority } = {}): Os {
  const loader = options.load ?? libSystem
  let api: DarwinApi | undefined
  let setpriority: SetPriority | undefined
  let loadError: string | undefined
  const load = () => {
    if (setpriority || loadError) return setpriority
    try {
      const loaded = loader()
      api = typeof loaded === "function" ? { setpriority: loaded, childPids: () => [] } : loaded
      setpriority = api.setpriority
    } catch (error) {
      loadError = `libSystem could not be loaded: ${message(error)}`
    }
    return setpriority
  }
  const applyChildren = (cls: ElasticClass): number | undefined =>
    load() ? darwinChildren(api!, cls === "idle" ? PRIO_DARWIN_BG : 0) : undefined
  return {
    applyChildren,
    apply(cls, options) {
      const call = load()
      if (!call) return { priority: "unsupported", ecoqos: false, error: loadError }
      const background = cls === "idle"
      try {
        if (call(PRIO_DARWIN_PROCESS, 0, background ? PRIO_DARWIN_BG : 0) !== 0) {
          return { priority: "normal", ecoqos: false, error: "setpriority(PRIO_DARWIN_PROCESS) failed" }
        }
      } catch (error) {
        return { priority: "normal", ecoqos: false, error: `setpriority threw: ${message(error)}` }
      }
      // PRIO_DARWIN_BG is per process (a child started later is not covered
      // by the parent's state being changed), so the children get the same call.
      const childrenSet = options?.children === false ? undefined : applyChildren(cls)
      return {
        priority: background ? "background" : "normal",
        ecoqos: false,
        ...(childrenSet === undefined ? {} : { childrenSet }),
      }
    },
    trim: () => ({ trimmed: false, reason: "unsupported-platform" }),
  }
}

function darwinChildren(api: DarwinApi, prio: number): number | undefined {
  const parents = new Map<number, number>()
  try {
    const queue = [process.pid]
    while (queue.length && parents.size < 4096) {
      const parent = queue.shift()!
      for (const child of api.childPids(parent)) {
        if (parents.has(child) || child === process.pid) continue
        parents.set(child, parent)
        queue.push(child)
      }
    }
  } catch {
    return undefined
  }
  const pids = descendantsOf(process.pid, parents)
  if (pids.length === 0) return undefined
  let done = 0
  for (const pid of pids) {
    try {
      if (api.setpriority(PRIO_DARWIN_PROCESS, pid, prio) === 0) done++
    } catch {
      // A child that exited mid-walk.
    }
  }
  return done
}

// ------------------------------------------------------------------- other ---

export const unsupported: Os = {
  apply: () => ({ priority: "unsupported", ecoqos: false }),
  trim: () => ({ trimmed: false, reason: "unsupported-platform" }),
}

export function forPlatform(platform: NodeJS.Platform = process.platform): Os {
  if (platform === "win32") return windows()
  if (platform === "darwin") return darwin()
  return unsupported
}

// ------------------------------------------------------------------ seam ---

let current: Os | undefined

/** The OS the engine acts on. Built on first use. */
export function get(): Os {
  current ??= forPlatform()
  return current
}

/** Test seam: a fake OS, or `undefined` to go back to the real one. */
export function setForTest(os: Os | undefined): void {
  current = os
}

function safe(read: () => number): number | undefined {
  try {
    const value = read()
    return Number.isFinite(value) ? value : undefined
  } catch {
    return undefined
  }
}

function sizes(before?: number, after?: number) {
  return {
    ...(before === undefined ? {} : { workingSetBefore: before }),
    ...(after === undefined ? {} : { workingSetAfter: after }),
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
