// "Save this map as a page" — the host half of the map screen's Export button.
// The webview half (does the click actually ask the host?) is in
// repoMapScreen.test.ts; this is the other side of that seam.
//
// The fixtures come from the module under test's real collaborator: what is
// asserted to be written is renderMapHtml's own output, not a string this test
// invented, so a renderer change cannot make this pass while the exported file
// says something else.

import { describe, expect, it, vi, beforeEach } from 'vitest';

const showSaveDialog = vi.fn();
const writeFile = vi.fn();
const showInformationMessage = vi.fn();
const showErrorMessage = vi.fn();

vi.mock('vscode', () => ({
  window: {
    showSaveDialog: (...a: unknown[]) => showSaveDialog(...a),
    showInformationMessage: (...a: unknown[]) => showInformationMessage(...a),
    showErrorMessage: (...a: unknown[]) => showErrorMessage(...a),
  },
  workspace: { fs: { writeFile: (...a: unknown[]) => writeFile(...a) } },
  Uri: { file: (p: string) => ({ fsPath: p }) },
}));

const { saveMapHtml } = await import('../../../src/dashboard/agentManager/mapExport');
const { renderMapHtml } = await import('../../../src/dashboard/agentManager/mapHtml');
const MAP = {
  version: 2 as const,
  name: 'demo',
  summary: 'a fixture app',
  nodes: [{ id: 'a', name: 'Alpha', pillar: 1, kind: 'entrypoint', summary: 's' }],
  edges: [],
  flows: [],
  keyFiles: [],
  conventions: [],
};

beforeEach(() => {
  showSaveDialog.mockReset();
  writeFile.mockReset();
  showInformationMessage.mockReset();
  showErrorMessage.mockReset();
});

describe('saveMapHtml', () => {
  it('writes EXACTLY the artifact renderMapHtml produces, to the picked file', async () => {
    showSaveDialog.mockResolvedValue({ fsPath: 'C:/tmp/map-demo.html' });
    await saveMapHtml(MAP, 'demo');
    expect(writeFile).toHaveBeenCalledTimes(1);
    const [uri, bytes] = writeFile.mock.calls[0];
    expect((uri as { fsPath: string }).fsPath).toBe('C:/tmp/map-demo.html');
    expect(Buffer.from(bytes as Uint8Array).toString('utf8')).toBe(renderMapHtml(MAP));
    expect(showInformationMessage).toHaveBeenCalledTimes(1);
  });

  it('suggests a name that does NOT start with "origami"', async () => {
    // A file whose final segment starts with that word matches Origami Folio's
    // file:// intercept, and Folio hijacks the page into its Studio as "not a
    // deck" — the same trap the Labyrinth export documents.
    showSaveDialog.mockResolvedValue(undefined);
    await saveMapHtml(MAP, 'Origami Folio');
    const suggested = String(showSaveDialog.mock.calls[0][0].defaultUri.fsPath);
    expect(suggested.startsWith('origami')).toBe(false);
    expect(suggested).toMatch(/^map-origami-folio-[\d-]+\.html$/);
  });

  it('writes NOTHING when the user cancels the dialog', async () => {
    showSaveDialog.mockResolvedValue(undefined);
    await saveMapHtml(MAP, 'demo');
    expect(writeFile).not.toHaveBeenCalled();
    expect(showInformationMessage).not.toHaveBeenCalled();
  });

  it('reports a failed write instead of throwing into the message handler', async () => {
    // It is called from a webview message listener with `void`, so an unhandled
    // rejection here would be a silent no-op with no feedback at all.
    showSaveDialog.mockResolvedValue({ fsPath: 'C:/tmp/x.html' });
    writeFile.mockRejectedValue(new Error('disk is full'));
    await expect(saveMapHtml(MAP, 'demo')).resolves.toBeUndefined();
    expect(showErrorMessage).toHaveBeenCalledWith('Export failed: disk is full');
  });
});
