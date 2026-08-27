// cronCommand — the quoting primitives, the origami invocation and the
// schtasks argv. The launcher script that executes the invocation, and the
// /TR length limit that forced it to exist, are covered in cronLauncher.test.ts.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  batchBareText,
  batchPercent,
  cmdQuote,
  cronLogPath,
  cronScriptPath,
  parseQueriedTaskNames,
  promptHazard,
  runInvocation,
  schtasksCreateArgs,
  schtasksDeleteArgs,
  schtasksFolderQueryArgs,
  schtasksQueryAllArgs,
  schtasksRunArgs,
  taskNameFor,
} from '../../../src/dashboard/crons/cronCommand';

// This suite asserts the WINDOWS artifact set (schtasks names, .cmd paths)
// through the helpers' platform DEFAULTS — pin the platform so the same
// assertions hold when the suite runs on macOS. cronMac.test.ts covers darwin.
const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
beforeAll(() => { Object.defineProperty(process, 'platform', { value: 'win32' }); });
afterAll(() => { Object.defineProperty(process, 'platform', realPlatform); });

const BIN = 'C:\\Users\\dev\\.origami\\bin\\origami.exe';
const WS = 'C:\\Users\\dev\\Desktop\\my project';
const LOG = 'C:\\Users\\dev\\Desktop\\my project\\.origami\\cron-logs\\c123.log';
const base = { binary: BIN, name: 'nightly', workspace: WS, logPath: LOG };
const TR = '"C:\\ws\\.origami\\crons\\c123.cmd"';

describe('cronCommand — the schtasks argv, verbatim, per schedule shape', () => {
  it('DAILY', () => {
    expect(schtasksCreateArgs(taskNameFor('c123'), { kind: 'daily', time: '09:30' }, TR)).toEqual([
      '/Create', '/TN', '\\Origami\\c123', '/TR', TR, '/SC', 'DAILY', '/ST', '09:30', '/F',
    ]);
  });

  it('WEEKLY: day list and start time land in the right flags', () => {
    expect(schtasksCreateArgs(taskNameFor('c123'), { kind: 'weekly', days: ['MON', 'WED', 'FRI'], time: '07:15' }, TR)).toEqual([
      '/Create', '/TN', '\\Origami\\c123', '/TR', TR, '/SC', 'WEEKLY', '/D', 'MON,WED,FRI', '/ST', '07:15', '/F',
    ]);
  });

  it('HOURLY and MINUTE: the interval rides /MO, with no stray /ST', () => {
    expect(schtasksCreateArgs(taskNameFor('c9'), { kind: 'hourly', every: 4 }, TR)).toEqual([
      '/Create', '/TN', '\\Origami\\c9', '/TR', TR, '/SC', 'HOURLY', '/MO', '4', '/F',
    ]);
    expect(schtasksCreateArgs(taskNameFor('c9'), { kind: 'minutely', every: 15 }, TR)).toEqual([
      '/Create', '/TN', '\\Origami\\c9', '/TR', TR, '/SC', 'MINUTE', '/MO', '15', '/F',
    ]);
  });

  it('the task name is namespaced under a folder of ours, so nothing else is ever in scope', () => {
    expect(taskNameFor('c123')).toBe('\\Origami\\c123');
  });

  it('delete / query / run argv', () => {
    expect(schtasksDeleteArgs('\\Origami\\c123')).toEqual(['/Delete', '/TN', '\\Origami\\c123', '/F']);
    // The trailing separator is load-bearing; see schedulerBackend.test.ts.
    expect(schtasksFolderQueryArgs()).toEqual(['/Query', '/TN', '\\Origami\\', '/FO', 'CSV', '/NH']);
    expect(schtasksQueryAllArgs()).toEqual(['/Query', '/FO', 'CSV', '/NH']);
    expect(schtasksRunArgs('\\Origami\\c123')).toEqual(['/Run', '/TN', '\\Origami\\c123']);
  });
});

describe('cronCommand — the origami invocation', () => {
  it('carries --auto and --dir, with agent/model only when set', () => {
    expect(runInvocation({ ...base, prompt: 'go' })).toBe(`"${BIN}" run "go" --auto --dir "${WS}"`);
    expect(runInvocation({ ...base, prompt: 'go', agent: 'scout', model: 'anthropic/claude' })).toBe(
      `"${BIN}" run "go" --auto --dir "${WS}" --agent "scout" --model "anthropic/claude"`,
    );
  });

  it('a prompt with quotes keeps even quote parity, so nothing after it is swallowed', () => {
    for (const prompt of ['say "hello world" and wait', 'it\'s a "quote', 'a & b | c > d']) {
      const inv = runInvocation({ ...base, prompt });
      expect((inv.match(/"/g) ?? []).length % 2).toBe(0);
    }
  });

  it('embedded quotes are DOUBLED, never backslash-escaped', () => {
    expect(cmdQuote('say "hi"')).toBe('"say ""hi"""');
    expect(cmdQuote('say "hi"')).not.toContain('\\"');
    expect(runInvocation({ ...base, prompt: 'say "hi"' })).toContain('run "say ""hi"""');
  });

  it('metacharacters stay inside the quoted argument rather than becoming operators', () => {
    expect(runInvocation({ ...base, prompt: 'a & b | c > d' })).toBe(`"${BIN}" run "a & b | c > d" --auto --dir "${WS}"`);
  });
});

describe('cronCommand — batch escaping primitives', () => {
  it('batchPercent doubles every % (the batch-file escape for a literal one)', () => {
    expect(batchPercent('20% faster')).toBe('20%% faster');
    expect(batchPercent('%USERPROFILE%')).toBe('%%USERPROFILE%%');
    expect(batchPercent('no percents here')).toBe('no percents here');
  });

  it('batchBareText escapes operators AND doubles %, for unquoted echo text', () => {
    expect(batchBareText('build & deploy')).toBe('build ^& deploy');
    expect(batchBareText('a|b<c>d')).toBe('a^|b^<c^>d');
    expect(batchBareText('nightly (100%)')).toBe('nightly ^(100%%^)');
  });
});

describe('cronCommand — prompts that cannot survive a scheduled command are refused', () => {
  it('accepts ordinary prompts, including %, ! and quotes', () => {
    expect(promptHazard('make the build 20% faster')).toBeNull();
    expect(promptHazard('say "hi"')).toBeNull();
    expect(promptHazard('fix this bug! now')).toBeNull();
  });

  it('ACCEPTS %VAR% now — the launcher doubles it, so it reaches origami literally', () => {
    // This was refused under the inline command-line design, where cmd would
    // have expanded it before origami ever saw it. The batch launcher escapes
    // it instead, so keeping the refusal would make the message a lie.
    expect(promptHazard('summarise %USERPROFILE% please')).toBeNull();
  });

  it('refuses a line break — the invocation is one batch line and there is no escape', () => {
    expect(promptHazard('line one\nline two')).toMatch(/line break/);
    expect(promptHazard('line one\r\nline two')).toMatch(/line break/);
  });

  it('refuses an empty prompt', () => {
    expect(promptHazard('')).toMatch(/empty/);
    expect(promptHazard('   ')).toMatch(/empty/);
  });
});

describe('cronCommand — generated paths', () => {
  it('logs and launchers live in separate generated directories', () => {
    expect(cronLogPath('C:\\ws', 'c1').endsWith('c1.log')).toBe(true);
    expect(cronScriptPath('C:\\ws', 'c1').endsWith('c1.cmd')).toBe(true);
    expect(cronLogPath('C:\\ws', 'c1')).toContain('cron-logs');
    expect(cronScriptPath('C:\\ws', 'c1')).toContain('crons');
  });
});

describe('cronCommand — reading back what the OS reports', () => {
  it('keeps only tasks in our folder, so an unrelated task is never mistaken for ours', () => {
    const stdout = [
      '"\\Origami\\c123","29/07/2026 09:30:00","Ready"',
      '"\\Origami\\c456","N/A","Ready"',
      '"\\Microsoft\\Windows\\Defrag\\ScheduledDefrag","N/A","Ready"',
      '"\\NightlyMirrorSync","29/07/2026 22:00:00","Ready"',
    ].join('\r\n');
    expect(parseQueriedTaskNames(stdout)).toEqual(['\\Origami\\c123', '\\Origami\\c456']);
  });

  it('an empty or informational output yields no tasks rather than throwing', () => {
    expect(parseQueriedTaskNames('')).toEqual([]);
    expect(parseQueriedTaskNames('INFO: There are no scheduled tasks presently available at your access level.')).toEqual([]);
  });
});
