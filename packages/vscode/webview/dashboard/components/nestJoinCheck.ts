// nestJoinCheck.ts — the Accept step's shape on the webview side (t-sj32zl).
// A leaf beside nestsStatus.ts, which sits at its cap.
//
// MIRROR of the host's JoinCheck (src/remote/groupHandshake.ts): a webview file
// cannot import from src/ (rootDir), so the shape is written here. The drift
// guard is nestsSecurity.test.ts, which reads both files.

export interface JoinCheck {
  side: 'inviter' | 'joiner';
  /** The JOINING desk's name, on both sides: the owner checks it matches. */
  name: string;
  code: string;
}

/** Anything off the wire is untrusted: a malformed check is no check. */
export function readJoinCheck(raw: unknown): JoinCheck | null {
  const c = raw as { side?: unknown; name?: unknown; code?: unknown } | null;
  if (!c || (c.side !== 'inviter' && c.side !== 'joiner')) return null;
  if (typeof c.name !== 'string' || typeof c.code !== 'string' || !/^\d{3} \d{3}$/.test(c.code)) return null;
  return { side: c.side, name: c.name, code: c.code };
}
