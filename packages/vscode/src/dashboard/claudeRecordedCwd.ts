// claudeRecordedCwd.ts — WHERE a transcript says it ran, read safely.
//
// A LEAF, not part of claudeProjects.ts, for two reasons. It is the only
// answer to a different question — that file decides WHICH directory belongs
// to a workspace, this one only reads a field out of a file — and claudeProjects
// .ts is at its architecture cap.
//
// THE READ IS THE WHOLE POINT. The field sits a few records into a file that
// can be 257 MB, so it is read in chunks with a budget, and through a
// StringDecoder: a 64 KB read lands mid-character often enough on a transcript
// full of em dashes, and a split code point would corrupt the very path this is
// about to compare. A blind `buffer.toString()` over a fixed prefix got both
// halves wrong — it split characters, and a first record larger than the prefix
// hid every record behind it.
import * as fs from 'fs';
import { StringDecoder } from 'string_decoder';

/** Records parsed while looking for a `cwd`. The first line of a real file is
 *  often a summary record that has none, so this is not 1; it is small because
 *  a wrong answer here costs a tie-break, not a row. */
const CWD_RECORD_LIMIT = 20;
/** Bytes read while looking for that record. Deliberately larger than one
 *  record: a single record can be hundreds of KB (a pasted file, a big tool
 *  result), and a budget a FIRST record can exhaust answers '' for a directory
 *  that states its cwd on line two. It stays a budget, not a whole-file read. */
const CWD_BYTE_LIMIT = 1024 * 1024;
/** Transcripts asked, newest first, before a directory is called silent: the
 *  newest can be a session that never recorded a cwd, and one file's silence
 *  is not the directory's answer. */
const CWD_FILE_LIMIT = 3;
/** Read size for the chunked pass. Matches claudeHistory.ts's reader. */
const CHUNK = 64 * 1024;

/**
 * The first records of a transcript, within a record count and a byte budget.
 * Never throws: an unopenable or unreadable file is an empty list, and a read
 * that failed part-way still answers with what it had already parsed.
 *
 * A record too long for the budget costs only itself — the pass steps over it
 * and keeps reading, rather than answering nothing for the whole file.
 */
export async function readFirstRecords(
  file: string,
  opts: { maxBytes: number; maxRecords: number },
): Promise<Array<Record<string, unknown>>> {
  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(file, 'r');
  } catch {
    return [];
  }
  const out: Array<Record<string, unknown>> = [];
  const decoder = new StringDecoder('utf8');
  const buffer = Buffer.allocUnsafe(CHUNK);
  let rest = '';
  let read = 0;
  try {
    while (out.length < opts.maxRecords && read < opts.maxBytes) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(CHUNK, opts.maxBytes - read), null);
      if (bytesRead === 0) {
        take(out, rest + decoder.end(), opts.maxRecords);
        break;
      }
      read += bytesRead;
      rest += decoder.write(buffer.subarray(0, bytesRead));
      const lines = rest.split('\n');
      rest = lines.pop() ?? '';
      for (const line of lines) take(out, line, opts.maxRecords);
    }
  } catch {
    /* a read that failed part-way still answers with what it already parsed */
  } finally {
    await handle.close().catch(() => undefined);
  }
  return out;
}

function take(out: Array<Record<string, unknown>>, line: string, maxRecords: number): void {
  const trimmed = line.trim();
  if (!trimmed || out.length >= maxRecords) return;
  try {
    out.push(JSON.parse(trimmed) as Record<string, unknown>);
  } catch { /* a torn last line, or a record shape this build does not know */ }
}

/** The `cwd` these transcripts report, newest first, or '' when none says.
 *  Takes the list a directory listing already produced — it never lists one. */
export async function recordedCwd(files: readonly { path: string }[]): Promise<string> {
  for (const file of files.slice(0, CWD_FILE_LIMIT)) {
    const records = await readFirstRecords(file.path, { maxBytes: CWD_BYTE_LIMIT, maxRecords: CWD_RECORD_LIMIT });
    for (const rec of records) {
      if (typeof rec.cwd === 'string' && rec.cwd) return rec.cwd;
    }
  }
  return '';
}
