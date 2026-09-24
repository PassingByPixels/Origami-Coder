import fs from "node:fs"
import path from "node:path"

/**
 * WHO TELLS A WINDOW THAT THE MAILBOX MOVED.
 *
 * `flock.json` is written by whichever engine holds the lease, and the FLO pane
 * is routinely served by a different one, so a process-local emitter on the
 * writing side reaches nobody. THE FILE IS THE CHANNEL: this watches it and
 * announces the change locally, and `acp/event.ts` turns that into the
 * {@link FLOCK_MAILBOX_METHOD} notification the pane already understands.
 *
 * TWO DETECTORS, and the poll is not a fallback that waits for the watch to fail:
 *  - `fs.watch` on the DIRECTORY, filtered to the one filename. On the file
 *    itself it would be WRONG rather than merely unreliable: every write in
 *    `store.ts` is a temp file plus a rename, so the inode a file watch holds is
 *    thrown away by the first write and the watch goes quiet with no error.
 *  - a poll on the file's FINGERPRINT (mtime, size, inode), armed always, for a
 *    network or virtualised filesystem where `fs.watch` silently reports nothing.
 *
 * Both feed one debounce and one fingerprint comparison: one write, one announce.
 */

/** The ext-notification method, declared here beside the change it announces.
 *  `acpClient.ts` strips one leading `_`, so this and `_origami/flockMailbox`
 *  both decode. */
export const FLOCK_MAILBOX_METHOD = "origami/flockMailbox"

/** How long after the first event the change is announced. A store write is
 *  temp-write, rename and on some platforms a directory mtime touch — three
 *  events for one logical change, and this is long enough to fold them into one. */
export const DEBOUNCE_MS = 150

/** How often the fingerprint is read when no event arrived. See the class comment. */
export const POLL_MS = 5_000

/** The filesystem and the clock, injected so a test drives both. */
export interface Deps {
  /** `fs.watch` on a directory. May throw; the caller degrades to the poll. */
  readonly watchDirectory: (directory: string, onEvent: (filename: string | null) => void) => { close(): void }
  /** A value that changes when the file changes, undefined when it is not there.
   *  Size and mtime alone miss a same-millisecond same-size rewrite, which is what
   *  two engines writing one small JSON file produce, so the inode is part of it. */
  readonly fingerprint: (file: string) => string | undefined
  readonly setTimer: (fn: () => void, ms: number) => unknown
  readonly clearTimer: (handle: unknown) => void
}

export const defaultDeps: Deps = {
  watchDirectory: (directory, onEvent) => fs.watch(directory, { persistent: false }, (_event, filename) => {
    onEvent(typeof filename === "string" ? filename : filename ? String(filename) : null)
  }),
  fingerprint: (file) => {
    try {
      const stat = fs.statSync(file)
      return `${stat.mtimeMs}:${stat.size}:${String(stat.ino)}`
    } catch {
      return undefined
    }
  },
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

export interface Options {
  /** The full path of `flock.json`. Its DIRECTORY is what is watched. */
  readonly file: string
  readonly onChange: () => void
  readonly deps?: Deps
  readonly debounceMs?: number
  readonly pollMs?: number
}

export interface Watcher {
  /** How the change is being detected, for `flock_diagnose`. */
  readonly kind: "watch+poll" | "poll"
  /** Why the watch is not running, when it is not. */
  readonly reason?: string
  stop(): void
}

/** Watch one `flock.json` and call `onChange` when its content moves. Never
 *  throws: a directory that cannot be watched degrades to the poll and says so on
 *  the handle, because refusing to start would take the whole flock down. */
export function start(options: Options): Watcher {
  const deps = options.deps ?? defaultDeps
  const debounceMs = options.debounceMs ?? DEBOUNCE_MS
  const pollMs = options.pollMs ?? POLL_MS
  const directory = path.dirname(options.file)
  const name = path.basename(options.file)

  let last = deps.fingerprint(options.file)
  let debounce: unknown = null
  let poll: unknown = null
  let stopped = false
  let handle: { close(): void } | undefined
  let reason: string | undefined

  const settle = (): void => {
    debounce = null
    if (stopped) return
    const next = deps.fingerprint(options.file)
    // A DELETE IS A CHANGE TOO — `undefined` is a value here, not a skip. An
    // engine watching a file the owner removed must stop reporting the old inbox.
    if (next === last) return
    last = next
    options.onChange()
  }

  const bump = (): void => {
    if (stopped || debounce !== null) return
    debounce = deps.setTimer(settle, debounceMs)
  }

  try {
    handle = deps.watchDirectory(directory, (filename) => {
      // A null filename is what a platform gives when it cannot say WHICH file
      // moved; it is treated as ours, or the whole watch is a no-op there.
      if (filename !== null && filename !== name) return
      bump()
    })
  } catch (error) {
    reason = error instanceof Error ? error.message : String(error)
  }

  const tick = (): void => {
    if (stopped) return
    // Straight through `settle`, not through `bump`: the poll IS the settled
    // state, and debouncing it would only delay it by another beat.
    settle()
    poll = deps.setTimer(tick, pollMs)
  }
  poll = deps.setTimer(tick, pollMs)

  return {
    kind: handle ? "watch+poll" : "poll",
    ...(reason ? { reason } : {}),
    stop: () => {
      stopped = true
      handle?.close()
      handle = undefined
      deps.clearTimer(debounce)
      deps.clearTimer(poll)
      debounce = poll = null
    },
  }
}

// ------------------------- the process-local channel -------------------------

export type Listener = () => void

/** Plain module state, for `session/turn-end.ts`'s reason: the watcher and the
 *  ACP shell that forwards its news both run in THIS process. */
const listeners = new Set<Listener>()

/** Register a sink. Returns the unsubscribe. */
export function onChanged(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Announce a change. Best-effort: a sink that throws must not stop the next one. */
export function announce(): void {
  for (const listener of [...listeners]) {
    try {
      listener()
    } catch {
      // A UI signal is never worth taking the watcher down for.
    }
  }
}

/** How many sinks are attached. For a test that asserts an unsubscribe landed. */
export function listenerCount(): number {
  return listeners.size
}

export * as FlockWatch from "./watch"
