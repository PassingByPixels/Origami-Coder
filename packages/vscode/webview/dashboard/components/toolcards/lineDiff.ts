// lineDiff.ts — t-yyz5yk (Round 8, "Inside each element": Edit). A line diff
// of the edit's before/after region, so the split view can ALIGN unchanged
// lines instead of pairing line i with line i (which showed every line after
// an insertion as changed), and so the row can say "+6 −2".
//
// Plain LCS over lines. An edit region is small (the replaced text, not the
// file), so the O(n·m) table is fine; above LIMIT cells it falls back to
// "all removed, all added", which is still true, only less aligned.

export type DiffOp = { t: 'eq'; a: string; b: string; ai: number; bi: number } | { t: 'del'; a: string; ai: number } | { t: 'add'; b: string; bi: number };

const LIMIT = 250_000;

function lines(text: string): string[] {
  return text.length ? text.split('\n') : [];
}

export function lineDiff(oldText: string, newText: string): DiffOp[] {
  const a = lines(oldText);
  const b = lines(newText);
  const n = a.length;
  const m = b.length;
  if (n * m > LIMIT) {
    return [...a.map((x, i) => ({ t: 'del' as const, a: x, ai: i })), ...b.map((y, j) => ({ t: 'add' as const, b: y, bi: j }))];
  }
  // lcs[i][j] = LCS length of a[i..] and b[j..].
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push({ t: 'eq', a: a[i], b: b[j], ai: i, bi: j }); i++; j++; }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) { ops.push({ t: 'del', a: a[i], ai: i }); i++; }
    else { ops.push({ t: 'add', b: b[j], bi: j }); j++; }
  }
  for (; i < n; i++) ops.push({ t: 'del', a: a[i], ai: i });
  for (; j < m; j++) ops.push({ t: 'add', b: b[j], bi: j });
  return ops;
}

export function diffStat(ops: DiffOp[]): { add: number; del: number } {
  let add = 0;
  let del = 0;
  for (const o of ops) { if (o.t === 'add') add++; else if (o.t === 'del') del++; }
  return { add, del };
}

/** One row of the split view. A null side is the hatched filler. Line numbers
 *  are 1-based within the edited region (the diff block carries no offset
 *  into the file). */
export interface SplitRow { left: { n: number; text: string; del: boolean } | null; right: { n: number; text: string; add: boolean } | null; }

export function splitRows(ops: DiffOp[]): SplitRow[] {
  const rows: SplitRow[] = [];
  let k = 0;
  while (k < ops.length) {
    const o = ops[k];
    if (o.t === 'eq') {
      rows.push({ left: { n: o.ai + 1, text: o.a, del: false }, right: { n: o.bi + 1, text: o.b, add: false } });
      k++;
      continue;
    }
    // A run of dels and adds: pair them side by side, filler for the rest.
    const dels: Extract<DiffOp, { t: 'del' }>[] = [];
    const adds: Extract<DiffOp, { t: 'add' }>[] = [];
    while (k < ops.length && ops[k].t !== 'eq') {
      const x = ops[k];
      if (x.t === 'del') dels.push(x); else if (x.t === 'add') adds.push(x);
      k++;
    }
    for (let r = 0; r < Math.max(dels.length, adds.length); r++) {
      const d = dels[r];
      const a = adds[r];
      rows.push({
        left: d ? { n: d.ai + 1, text: d.a, del: true } : null,
        right: a ? { n: a.bi + 1, text: a.b, add: true } : null,
      });
    }
  }
  return rows;
}

/** The five ratio blocks after "+a −d" on the row (Round 8 Edit). */
export function ratioBlocks(add: number, del: number): ('a' | 'd')[] {
  const total = add + del;
  if (total === 0) return [];
  const a = Math.round((add / total) * 5);
  return Array.from({ length: 5 }, (_, i) => (i < a ? 'a' : 'd'));
}
