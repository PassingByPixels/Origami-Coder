// composerDropIntake.ts (t-z69b8m) — the composer's drop overlay state and the
// drop payload rules. Its own module because InputBar.svelte is at its cap.
//
// WHY THE OVERLAY STUCK. The overlay was a pure dragenter/dragleave depth
// counter with one reset: a `drop` on the composer itself. Every drag that
// ended any other way left the depth above zero, and nothing ever brought it
// down again:
//   - VS Code puts its own editor-drop overlay ("Hold Shift to drop into
//     editor") over the webview iframe. The iframe got the `dragenter` and
//     then no more events at all: no `dragleave`, no `drop`.
//   - An OS drag cancelled or dropped outside the webview. `dragend` goes to
//     the SOURCE document only, never to this one.
//   - A drop anywhere else in the webview (the transcript) went to ChatPane,
//     never to the composer box that counted the enter.
// The fix covers the class, not one path: window `drop`/`dragend`/`blur` reset
// at once, a `mousemove` (never fired while a drag runs) resets, and a
// watchdog resets when no drag event has arrived for DRAG_IDLE_MS. Chromium
// fires `dragover` about every 50 ms while the pointer is over the target,
// even when the pointer does not move, so a live drag keeps it alive.
//
// WHY EXPLORER DROPS NEVER ATTACHED. A VS Code explorer drag carries URIs,
// not bytes (the webview has no fs), and the old triage only put the path in
// the text. The URIs now go to the host (`readDroppedFiles`), which reads them
// and answers `droppedFiles` with the bytes; the composer turns those into
// File objects and runs its normal image / text intake.

export const DRAG_IDLE_MS = 1000;
/** VS Code's own uri-list type, then the standard one. Same format (RFC 2483). */
const URI_LIST_TYPES = ['application/vnd.code.uri-list', 'text/uri-list'];

export type DragKind = 'enter' | 'leave' | 'over' | 'drop';

export function createDragState(onChange: (dropping: boolean) => void, win: Window = window) {
  let depth = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const set = (next: number) => {
    const was = depth > 0;
    depth = next;
    if (was !== depth > 0) onChange(depth > 0);
    clearTimeout(timer);
    if (depth > 0) timer = setTimeout(reset, DRAG_IDLE_MS);
  };
  const reset = () => set(0);
  const resets = ['dragend', 'drop', 'blur', 'mousemove'] as const;
  // Capture phase: the composer's own drop handler stops propagation.
  for (const t of resets) win.addEventListener(t, reset, true);
  return {
    event(kind: DragKind) {
      if (kind === 'enter') set(depth + 1);
      else if (kind === 'leave') set(Math.max(0, depth - 1));
      else if (kind === 'over') { if (depth > 0) set(depth); }
      else set(0);
    },
    destroy() {
      clearTimeout(timer);
      for (const t of resets) win.removeEventListener(t, reset, true);
    },
  };
}

export type DropPlan = { kind: 'files'; files: File[] } | { kind: 'uris'; uris: string[] } | { kind: 'none' };

function uriLines(raw: string): string[] {
  return raw.split(/\r\n|\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
}

/** URIs first: a VS-Code-internal drag can carry `files` too, and the host
 *  read gives the real file. `resourceurls` is the workbench's JSON array. */
export function planDrop(dt: DataTransfer): DropPlan {
  for (const t of URI_LIST_TYPES) {
    const uris = uriLines(dt.getData(t) || '');
    if (uris.length) return { kind: 'uris', uris };
  }
  try {
    const arr: unknown = JSON.parse(dt.getData('resourceurls') || '[]');
    const uris = Array.isArray(arr) ? arr.filter((u): u is string => typeof u === 'string' && !!u) : [];
    if (uris.length) return { kind: 'uris', uris };
  } catch { /* not JSON: ignore */ }
  const files = Array.from((dt.files ?? []) as ArrayLike<File>);
  return files.length ? { kind: 'files', files } : { kind: 'none' };
}

/** URIs the host can read. A web link stays text only. */
export const hostReadable = (uris: string[]) => uris.filter((u) => !/^https?:/i.test(u));

/** The host's `droppedFiles.files` rows as File objects. Bad rows are skipped. */
export function filesFromHost(rows: unknown): File[] {
  if (!Array.isArray(rows)) return [];
  const out: File[] = [];
  for (const r of rows as Array<Record<string, unknown> | null>) {
    if (!r || typeof r.name !== 'string' || typeof r.base64 !== 'string') continue;
    const bin = atob(r.base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    out.push(new File([bytes], r.name, { type: typeof r.mime === 'string' ? r.mime : '' }));
  }
  return out;
}

let seq = 0;
export const nextDropId = () => `drop-${Date.now().toString(36)}-${seq++}`;
