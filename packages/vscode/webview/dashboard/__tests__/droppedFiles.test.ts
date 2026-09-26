// t-z69b8m: the host reads the files a VS Code explorer drop names.
import { describe, expect, it } from 'vitest';
import { readDroppedFiles, MAX_DROP_BYTES, type DropFs } from '../../../src/dashboard/droppedFiles';

function fakeFs(entries: Record<string, Uint8Array | 'dir'>): DropFs {
  return {
    fileSize: async (u) => { const e = entries[u]; return e === undefined || e === 'dir' ? null : e.length; },
    read: async (u) => { const e = entries[u]; if (!e || e === 'dir') throw new Error('ENOENT'); return e; },
  };
}
const b64 = (s: string) => Buffer.from(s).toString('base64');

describe('readDroppedFiles', () => {
  it('a text file comes back as text/plain bytes with its decoded base name', async () => {
    const r = await readDroppedFiles(['file:///c%3A/w/my%20file.ts'], fakeFs({ 'file:///c%3A/w/my%20file.ts': new TextEncoder().encode('export {}') }));
    expect(r).toEqual({ files: [{ name: 'my file.ts', mime: 'text/plain', base64: b64('export {}') }], skipped: [] });
  });

  it('an image keeps its image MIME so the composer takes the image path', async () => {
    const r = await readDroppedFiles(['file:///C:/a/shot.PNG'], fakeFs({ 'file:///C:/a/shot.PNG': new Uint8Array([137, 80]) }));
    expect(r.files[0].mime).toBe('image/png');
  });

  it('a folder, a missing file and an oversize file are skipped by name, the good one still read', async () => {
    const big = { length: MAX_DROP_BYTES + 1 } as unknown as Uint8Array;
    const r = await readDroppedFiles(
      ['file:///d/folder', 'file:///d/gone.txt', 'file:///d/big.log', 'file:///d/ok.md'],
      fakeFs({ 'file:///d/folder': 'dir', 'file:///d/big.log': big, 'file:///d/ok.md': new TextEncoder().encode('hi') }),
    );
    expect(r.files.map((f) => f.name)).toEqual(['ok.md']);
    expect(r.skipped).toEqual(['folder', 'gone.txt', 'big.log']);
  });

  it('a malformed payload answers empty, never throws', async () => {
    expect(await readDroppedFiles('nope', fakeFs({}))).toEqual({ files: [], skipped: [] });
    expect(await readDroppedFiles([1, null, ''], fakeFs({}))).toEqual({ files: [], skipped: [] });
  });
});
