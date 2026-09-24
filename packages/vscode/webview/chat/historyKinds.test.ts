// historyKinds.test.ts — the History popup now lists two kinds of past chat.
// These are the four decisions that follow (t-463pb6): which rows the toggle
// removes, which rows get a mark, which message a pick sends, and what the
// toggle remembers.
//
// The pick is the one worth reading twice. An Origami row and a Claude row look
// identical in the list and mean completely different things to the host: one
// reloads an engine transcript, the other spawns a CLI child with `--resume` in
// a specific directory. Sending the wrong one is silent — the user gets a chat.
import { describe, expect, it } from 'vitest';
import {
  CLAUDE_MARK, claudeShownIn, filterHistory, fmtHistoryDate, historyDropdownRows,
  historyPickMessage, isClaudeRow, withClaudeShown, type HistoryItem,
} from './historyKinds';

const origami: HistoryItem = { sessionId: 'o1', title: 'Parser rewrite', folder: 'origami', updatedAt: '2026-09-08T09:00:00.000Z' };
const claude: HistoryItem = {
  sessionId: 'c1', title: 'Terrain shader', folder: 'aetheron', updatedAt: '2026-09-09T09:00:00.000Z',
  kind: 'claude', cwd: 'C:\\ws\\aetheron', turns: 12, tokensIn: 10, tokensOut: 4, cacheRead: 30, cacheWrite: 10,
};
const ITEMS = [origami, claude];

describe('the toggle hides Claude rows and only Claude rows', () => {
  it('keeps everything when it is on', () => {
    expect(filterHistory(ITEMS, '', true).map((h) => h.sessionId)).toEqual(['o1', 'c1']);
  });

  it('drops the Claude row when it is off, and never an Origami one', () => {
    expect(filterHistory(ITEMS, '', false).map((h) => h.sessionId)).toEqual(['o1']);
  });

  it('treats a row with no kind as Origami — a host that predates this still lists', () => {
    expect(filterHistory([{ ...origami, kind: undefined }], '', false)).toHaveLength(1);
    expect(isClaudeRow({ ...origami, kind: undefined })).toBe(false);
  });

  it('still searches title and folder, on both kinds, with the toggle on', () => {
    expect(filterHistory(ITEMS, 'aetheron', true).map((h) => h.sessionId)).toEqual(['c1']);
    expect(filterHistory(ITEMS, 'PARSER', true).map((h) => h.sessionId)).toEqual(['o1']);
  });

  it('does not resurrect a hidden Claude row because the search matches it', () => {
    expect(filterHistory(ITEMS, 'terrain', false)).toEqual([]);
  });
});

describe('the mark', () => {
  it('goes on Claude rows only, and is the CC the connections row already uses', () => {
    const rows = historyDropdownRows(ITEMS);

    expect(CLAUDE_MARK).toBe('CC');
    expect(rows[0].mark).toBeUndefined();
    expect(rows[1].mark).toBe('CC');
    expect(rows[1].markTitle).toContain('12 replies');
  });

  it('carries the folder and the date through as the second line', () => {
    const [row] = historyDropdownRows([origami]);

    expect(row.id).toBe('o1');
    expect(row.title).toBe('Parser rewrite');
    expect(row.meta).toContain('origami');
    expect(row.meta).toContain(fmtHistoryDate(origami.updatedAt));
  });

  it('leaves the date out rather than printing Invalid Date', () => {
    expect(fmtHistoryDate('')).toBe('');
    expect(fmtHistoryDate('not a date')).toBe('');
  });
});

describe('what a pick posts', () => {
  it('recalls an Origami row through the engine', () => {
    expect(historyPickMessage(ITEMS, 'o1')).toEqual({ type: 'recallSession', sessionId: 'o1' });
  });

  it('opens a Claude row as a passthrough that resumes it IN ITS OWN FOLDER', () => {
    expect(historyPickMessage(ITEMS, 'c1')).toEqual({
      type: 'openClaudeHistory', claudeSessionId: 'c1', cwd: 'C:\\ws\\aetheron', title: 'Terrain shader',
    });
  });

  it('falls back to a recall for an id it has never seen', () => {
    expect(historyPickMessage(ITEMS, 'ghost')).toEqual({ type: 'recallSession', sessionId: 'ghost' });
  });

  it('will not send a resume with no folder to resume in', () => {
    expect(historyPickMessage([{ ...claude, cwd: undefined }], 'c1')).toEqual({ type: 'recallSession', sessionId: 'c1' });
  });
});

describe('what the toggle remembers', () => {
  it('is shown by default, including on a webview with no saved state at all', () => {
    expect(claudeShownIn(undefined)).toBe(true);
    expect(claudeShownIn(null)).toBe(true);
    expect(claudeShownIn({})).toBe(true);
  });

  it('round-trips OFF, and keeps every other key in the shared state blob', () => {
    const saved = withClaudeShown({ frontDesk: { collapsed: true } }, false);

    expect(claudeShownIn(saved)).toBe(false);
    expect(saved.frontDesk).toEqual({ collapsed: true });
    expect(claudeShownIn(withClaudeShown(saved, true))).toBe(true);
  });
});
