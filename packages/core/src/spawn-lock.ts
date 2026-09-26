// origami_change (t-x0lim2): one lock around process starts, shared by the main
// thread and every Worker that starts processes.
//
// On Windows a new process gets every inheritable handle of its parent process
// (CreateProcess with bInheritHandles). A process start (libuv uv_spawn, under
// Bun.spawn and node:child_process) makes the child's ends of its stdio pipes
// inheritable, starts the child, and closes them, all inside the start call.
// Each JS thread has its own event loop and starts processes on its own. When a
// Worker and the main thread start processes at the same moment, each child can
// take the other child's pipe ends and keep them for its whole life. The other
// child's output then does not close when that child exits: the R4 hang
// (debug_r4_hang.md, a git on the snapshot Worker held by an MCP server) and
// its reverse (a long git on the Worker holds a shell or ripgrep child's
// output). With this lock no two process starts in this process overlap.
//
// How: the main thread arms the lock when it starts the first Worker that
// starts processes (`share`), and gives the Worker the same buffer (`adopt`).
// From then on `Bun.spawn` and `Bun.spawnSync` on both threads take the lock;
// node:child_process and cross-spawn start processes through them. A start
// that finds the lock taken waits until it is free. `when` starts a process
// without holding the thread while it waits (the main thread's
// CrossSpawnSpawner). The lock is held for the start call only (spawnSync: the
// whole call). Before the first such Worker, nothing changes.
//
// Not covered: `Bun.$` (the shell starts processes in native code, not through
// Bun.spawn). The engine gives it only to plugins.
//
// POSIX: pipes are created close-on-exec and a child keeps only the fds it is
// given, so the class does not exist there; everything here is a no-op.

/** Index of the owner cell (0 = free, else the holder's tag). */
const OWNER = 0
/** Index of the acquire counter: a holder that did not change in STALE_MS is dead. */
const GEN = 1
/** Index of the tag counter; each thread takes its own tag from it. */
const TAGS = 2
const FREE = 0
/**
 * A thread that stops inside its hold (a Worker terminated there) must not stop
 * every later start. A start takes some ms, and up to hundreds of ms on a busy
 * machine; a hold this long is treated as dead and taken over.
 */
const STALE_MS = 5_000

const enabled = process.platform === "win32" && typeof Bun !== "undefined" && typeof SharedArrayBuffer === "function"

let cells: Int32Array | undefined
let tag = FREE
/** Nested holds on this thread: `when` holds, and the Bun.spawn it calls holds again. */
let depth = 0

const take = () => {
  if (Atomics.compareExchange(cells!, OWNER, FREE, tag) !== FREE) return false
  Atomics.add(cells!, GEN, 1)
  return true
}

/** The holder has held the lock for STALE_MS without a change: take it over. */
const takeOver = (owner: number, gen: number) => {
  if (Atomics.load(cells!, GEN) !== gen) return false
  if (Atomics.compareExchange(cells!, OWNER, owner, tag) !== owner) return false
  Atomics.add(cells!, GEN, 1)
  return true
}

const release = () => {
  depth -= 1
  if (depth > 0) return
  // Only if it is still ours: a hold that was taken over belongs to another thread.
  Atomics.compareExchange(cells!, OWNER, tag, FREE)
  Atomics.notify(cells!, OWNER)
}

/** Waits on the holder: the holder seen, and since when. */
const watch = () => {
  let owner = FREE
  let gen = 0
  let since = 0
  return {
    /** Remaining ms to wait on `owner`, or 0 when the lock was taken now. */
    next: (): { owner: number; wait: number } | undefined => {
      if (take()) return undefined
      const now = Atomics.load(cells!, OWNER)
      if (now === FREE) return { owner: now, wait: 0 }
      const current = Atomics.load(cells!, GEN)
      if (now !== owner || current !== gen) {
        owner = now
        gen = current
        since = performance.now()
      }
      const left = STALE_MS - (performance.now() - since)
      if (left <= 0 && takeOver(owner, gen)) return undefined
      return { owner, wait: Math.max(left, 1) }
    },
  }
}

const run = <T>(fn: () => T): T => {
  depth += 1
  try {
    return fn()
  } finally {
    release()
  }
}

/** Run `fn` with the lock held; waits (holding this thread) while another thread holds it. */
export const hold = <T>(fn: () => T): T => {
  if (!cells) return fn()
  if (depth > 0) return run(fn)
  const waiter = watch()
  for (let state = waiter.next(); state; state = waiter.next()) {
    if (state.wait > 0) Atomics.wait(cells, OWNER, state.owner, state.wait)
  }
  return run(fn)
}

/** Starts on this thread that wait for the lock, first come first served. */
const queue: Array<{ fn: () => void; cancelled: boolean }> = []
let waiter: ReturnType<typeof watch> | undefined

// Runs the queue while it is not empty; there is at most one pump at a time.
const pump = (): void => {
  while (queue[0]?.cancelled) queue.shift()
  const head = queue[0]
  if (!head) {
    waiter = undefined
    return
  }
  waiter ??= watch()
  for (let state = waiter.next(); state; state = waiter.next()) {
    if (state.wait === 0) continue
    const result = Atomics.waitAsync(cells!, OWNER, state.owner, state.wait)
    if (result.async) {
      void result.value.then(pump)
      return
    }
  }
  queue.shift()
  waiter = undefined
  try {
    run(head.fn)
  } finally {
    // One start per loop turn. Starts that queued up while a Worker held the
    // lock must not all run in the turn it is released: each start holds the
    // thread for some ms (up to hundreds on a busy machine).
    if (queue.length > 0) setImmediate(pump)
  }
}

/**
 * Run `fn` with the lock held: now when it is free and no start waits, else
 * in turn once the lock is free, without holding this thread meanwhile.
 * Returns a cancel for a run that has not started yet. `fn` must not throw: a
 * late run has no caller.
 */
export const when = (fn: () => void): (() => void) => {
  if (!cells || depth > 0) {
    hold(fn)
    return () => {}
  }
  if (queue.length === 0 && take()) {
    run(fn)
    return () => {}
  }
  const entry = { fn, cancelled: false }
  queue.push(entry)
  if (queue.length === 1) pump()
  return () => {
    entry.cancelled = true
  }
}

const install = () => {
  const bun = Bun as unknown as Record<"spawn" | "spawnSync", (...args: unknown[]) => unknown>
  for (const name of ["spawn", "spawnSync"] as const) {
    const start = bun[name]!
    bun[name] = (...args: unknown[]) => hold(() => start.apply(Bun, args))
  }
}

/**
 * Main thread: arm the lock (once) and return its buffer for a Worker that
 * starts processes (undefined where the lock is not needed).
 */
export const share = (): SharedArrayBuffer | undefined => {
  if (!enabled) return undefined
  if (!cells) {
    cells = new Int32Array(new SharedArrayBuffer(3 * Int32Array.BYTES_PER_ELEMENT))
    tag = Atomics.add(cells, TAGS, 1) + 1
    install()
  }
  return cells.buffer as SharedArrayBuffer
}

/** Worker: use the main thread's lock for every process this thread starts. */
export const adopt = (buffer: SharedArrayBuffer | undefined) => {
  if (!enabled || !buffer || cells) return
  cells = new Int32Array(buffer)
  tag = Atomics.add(cells, TAGS, 1) + 1
  install()
}

export * as SpawnLock from "./spawn-lock"
