// engineLog.test.ts — t-x3a89j: the Retry card's "Open engine log" opens the file every engine writes
// (@origami/core Global.Path.log = <xdg data>/origami/log, logging.ts `origami.log`). The bugs caught: a path that
// ignores XDG_DATA_HOME (an isolated or relocated store opens the wrong log); a missing file opened as an empty
// editor instead of saying where the log would be.
import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { engineDescribe, engineLogPath, openEngineLog } from '../../../src/dashboard/engineLog';

describe('engineLogPath', () => {
  it('is <XDG_DATA_HOME>/origami/log/origami.log when set, else ~/.local/share (xdg-basedir, all platforms)', () => {
    expect(engineLogPath({ XDG_DATA_HOME: path.join('D:', 'xdg') }, 'C:/Users/u')).toBe(path.join('D:', 'xdg', 'origami', 'log', 'origami.log'));
    expect(engineLogPath({}, path.join('C:', 'Users', 'u'))).toBe(path.join('C:', 'Users', 'u', '.local', 'share', 'origami', 'log', 'origami.log'));
  });
});

describe('openEngineLog', () => {
  it('opens the file when it exists', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-log-'));
    const file = path.join(dir, 'origami.log');
    fs.writeFileSync(file, 'x\n');
    const open = vi.fn(async () => undefined);
    const info = vi.fn();
    await openEngineLog({ open, info }, file);
    expect(open).toHaveBeenCalledWith(file);
    expect(info).not.toHaveBeenCalled();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('says where the log would be when there is none, and opens nothing', async () => {
    const file = path.join(os.tmpdir(), 'no-such-dir-x3a89j', 'origami.log');
    const open = vi.fn(async () => undefined);
    const info = vi.fn();
    await openEngineLog({ open, info }, file);
    expect(open).not.toHaveBeenCalled();
    expect(info.mock.calls[0]![0]).toContain(file);
  });
});

describe('engineDescribe (the Copy details lines)', () => {
  it('names the chat, its engine session and the log path', () => {
    expect(engineDescribe('chat 3', 'ses_abc', '/l/origami.log')).toEqual(['chat 3 · engine session ses_abc', 'Engine log: /l/origami.log']);
    expect(engineDescribe('chat 3', null, '/l/origami.log')[0]).toBe('chat 3 · engine session (none yet)');
  });
});
