// claudeCodeFakeChild.ts — a scripted stand-in for the `claude` child process.
//
// Shared by the driver tests and the seam tests, because both need to answer
// the same question: given these bytes on stdout, what did we write back on
// stdin? A real child cannot answer it repeatably (or cheaply — every run is a
// paid turn on the user's subscription).
//
// Not a *.test.ts, so vitest does not collect it as a suite.

import type { ChildHandle } from '../../../src/claudeCode/driver';

export class FakeChild implements ChildHandle {
  pid = 4242;
  written: string[] = [];
  killed = 0;
  private listeners = new Map<string, Array<(...a: never[]) => void>>();
  private outListeners: Array<(c: string) => void> = [];
  private errListeners: Array<(c: string) => void> = [];
  stdout = { on: (_e: string, l: (c: string) => void) => { this.outListeners.push(l); }, setEncoding: () => {} };
  stderr = { on: (_e: string, l: (c: string) => void) => { this.errListeners.push(l); }, setEncoding: () => {} };
  stdin = { write: (d: string) => { this.written.push(d); return true; }, end: () => {}, on: () => {} };

  on(event: string, listener: (...a: never[]) => void): unknown {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
    return this;
  }
  kill(): boolean { this.killed++; this.emitExit(0, null); return true; }
  /** Push stdout bytes — a chunk, not necessarily a whole line. */
  say(chunk: string): void { for (const l of this.outListeners) l(chunk); }
  err(chunk: string): void { for (const l of this.errListeners) l(chunk); }
  emitExit(code: number | null, signal: string | null): void {
    for (const l of this.listeners.get('exit') ?? []) (l as (c: number | null, s: string | null) => void)(code, signal);
  }
  /** The frames we wrote back, decoded. */
  frames(): Array<Record<string, unknown>> { return this.written.map((w) => JSON.parse(w) as Record<string, unknown>); }
}

/**
 * A `can_use_tool` control_request, in the CLI's shape.
 *
 * NOT captured from a live run: both smokes on this machine were pre-approved
 * by the user's own settings (a 784-entry `permissions.allow` plus
 * `additionalDirectories`), so the CLI executed the tool without asking —
 * exactly as a terminal session would have. The frame is therefore built from
 * the contract (monocode's verified reader, and the answer frame the spike
 * script wrote), in ONE place, so the day it is captured there is a single
 * line to correct.
 */
export function canUseTool(requestId: string, toolName: string, input: Record<string, unknown>): string {
  return JSON.stringify({
    type: 'control_request', request_id: requestId,
    request: { subtype: 'can_use_tool', tool_name: toolName, input },
  });
}
