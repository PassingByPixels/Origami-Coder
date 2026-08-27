// chatToolMeta.ts — the SHAPING leaves of a tool message: the wire's untyped
// `rawInput` / `rawOutput.metadata` / image blocks turned into the typed facts
// a card renders. Extracted from chatToolMsg.ts, which was ON its architecture
// cap when the `browser` tool's screenshots arrived; that file keeps the MERGE
// rules (which message an update lands on), this one keeps the field shapes.
//
// Every function here answers "is this fact really present?" and returns
// undefined when it is not — an absent field must stamp nothing, because a
// half-filled shape renders as a claim the engine never made.

export interface ToolShell {
  command?: string;
  explanation?: string;
  display?: string;
  cwd?: string;
  timeout?: number;
  /** Exit code from `rawOutput.metadata.exit`; null = killed (abort/timeout). */
  exit?: number | null;
  truncated?: boolean;
  outputPath?: string;
  background?: boolean;
  state?: 'foreground' | 'background' | 'promoted';
  jobId?: string;
  startedAt?: number;
  lastOutputAt?: number;
}
export interface ToolLines { start: number; end: number; }
/**
 * What the `browser` tool actually did, off its own metadata.
 *
 * `ok` is the ONLY status a card may read. The engine COMPLETES every browser
 * call — a refusal, an unreachable client and a loaded page all arrive with ACP
 * status `completed` — so the status cannot separate them, and the title is
 * prose that changes with the wording. `action` / `url` are the real target,
 * which is why a failure's title ("browser open: failed") must never be split
 * into a chip.
 */
export interface ToolBrowser { ok: boolean; action?: string; url?: string; }

export function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

export function isShellName(toolName: unknown): boolean {
  return toolName === 'bash' || toolName === 'shell';
}

/** Shape read's `rawOutputMeta.display` into the actual clamped line range —
 *  the ONLY shape carrying numeric lineStart/lineEnd (shell metadata never does). */
export function readLines(meta: unknown): ToolLines | undefined {
  if (!meta || typeof meta !== 'object') return undefined;
  const d = (meta as Record<string, unknown>).display;
  if (!d || typeof d !== 'object') return undefined;
  const r = d as Record<string, unknown>;
  if (typeof r.lineStart !== 'number' || typeof r.lineEnd !== 'number') return undefined;
  return { start: r.lineStart, end: r.lineEnd };
}

/** Shape bash `rawInput` into the IN facts. Non-shell tools return undefined. */
export function shellIn(toolName: unknown, rawInput: unknown): ToolShell | undefined {
  if (!isShellName(toolName) || !rawInput || typeof rawInput !== 'object') return undefined;
  const r = rawInput as Record<string, unknown>;
  return {
    command: str(r.command),
    explanation: str(r.explanation),
    display: str(r.shellDisplay),
    cwd: str(r.cwd) ?? str(r.workdir),
    timeout: typeof r.timeout === 'number' ? r.timeout : undefined,
  };
}

/** Shape `rawOutput.metadata` into the OUT facts. Only shell metadata carries
 *  an `exit` key (number, or null for a killed run) — other tools' metadata
 *  (read's display block etc.) shapes to undefined and stamps nothing. */
export function shellOut(meta: unknown): ToolShell | undefined {
  if (!meta || typeof meta !== 'object') return undefined;
  const m = meta as Record<string, unknown>;
  const state = m.state === 'foreground' || m.state === 'background' || m.state === 'promoted' ? m.state : undefined;
  if (typeof m.exit !== 'number' && m.exit !== null && !state) return undefined;
  return {
    ...(typeof m.exit === 'number' || m.exit === null ? { exit: m.exit as number | null } : {}),
    truncated: m.truncated === true,
    outputPath: str(m.outputPath),
    ...(m.background === true ? { background: true } : {}),
    ...(state ? { state } : {}),
    ...(str(m.jobId) ? { jobId: str(m.jobId) } : {}),
    ...(typeof m.startedAt === 'number' ? { startedAt: m.startedAt } : {}),
    ...(typeof m.lastOutputAt === 'number' ? { lastOutputAt: m.lastOutputAt } : {}),
  };
}

/** Shape the `browser` tool's `rawOutput.metadata` into its honest verdict.
 *  Gated on the tool NAME as well as the shape: `ok` is a common enough key
 *  that another tool's metadata could carry one meaning something else. */
export function browserOut(toolName: unknown, meta: unknown): ToolBrowser | undefined {
  if (toolName !== 'browser' || !meta || typeof meta !== 'object') return undefined;
  const m = meta as Record<string, unknown>;
  if (typeof m.ok !== 'boolean') return undefined;
  return { ok: m.ok, action: str(m.action), url: str(m.url) };
}

/** Screenshots off a tool result, already `data:` URIs (acpToolContent.ts made
 *  them from the ACP image blocks). Only real, non-empty strings survive: a
 *  blank src renders as a broken-image icon, which reads as a failed capture. */
export function toolImages(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const urls = raw.filter((v): v is string => typeof v === 'string' && v.startsWith('data:'));
  return urls.length ? urls : undefined;
}
