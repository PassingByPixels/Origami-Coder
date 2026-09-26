// The engine child's stderr, forwarded to the extension host log. Extracted from acpClient.ts
// (at its cap) when t-w2txb2 added the park/restore pair there; the body is unchanged.

/** Forward piped stderr to the extension host log, per line so multi-line panics are not truncated. */
export function forwardStderr(stderr: NodeJS.ReadableStream | null, log: (line: string) => void = (line) => console.error(line)): void {
  if (!stderr) return;
  stderr.setEncoding('utf8');
  let buf = '';
  stderr.on('data', (chunk: string) => {
    buf += chunk;
    let nl = buf.indexOf('\n');
    while (nl !== -1) {
      const line = buf.slice(0, nl).trimEnd();
      if (line.length > 0) {
        log(`[origami-acp] ${line}`);
      }
      buf = buf.slice(nl + 1);
      nl = buf.indexOf('\n');
    }
  });
  stderr.on('end', () => {
    if (buf.trim().length > 0) {
      log(`[origami-acp] ${buf.trim()}`);
    }
  });
}
