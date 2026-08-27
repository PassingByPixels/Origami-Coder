// loopFormat — the Loops card's derived text. The rules worth pinning are the
// ones about ABSENCE: a loop with no armed timer, and a run record with only
// half of itself, must both produce nothing rather than a plausible value. A
// fabricated countdown on this surface is worse than a blank one, because the
// whole point of the card is telling you when unattended work next happens.

import { describe, it, expect } from 'vitest';
import { countdown, lastRunText, loopStateText, nextRunText } from '../panes/loopFormat';

const NOW = 1_700_000_000_000;

describe('countdown — at most two units, largest first', () => {
  it('seconds under a minute', () => {
    expect(countdown(45_000)).toBe('45s');
  });

  it('minutes and seconds', () => {
    expect(countdown(150_000)).toBe('2m 30s');
  });

  it('drops the smaller unit when it is zero rather than printing "2m 0s"', () => {
    expect(countdown(120_000)).toBe('2m');
    expect(countdown(3_600_000)).toBe('1h');
  });

  it('hours never show seconds — the third unit is noise at that scale', () => {
    expect(countdown(3_900_000)).toBe('1h 5m');
    expect(countdown(3_601_000)).toBe('1h');
  });

  it('a sub-second remainder rounds UP to 1s, never "0s"', () => {
    // "0s" reads as stopped. Something firing in 400ms has not stopped.
    expect(countdown(400)).toBe('1s');
    expect(countdown(0)).toBe('1s');
  });
});

describe('nextRunText — only ever describes a timer that is really armed', () => {
  it('an armed timer becomes a countdown', () => {
    expect(nextRunText(NOW + 90_000, NOW)).toBe('in 1m 30s');
  });

  it('NO armed timer yields empty — the caller says why, in words', () => {
    // This is the case the card must not fill in. Returning "in 2m" from the
    // interval here is exactly the drift the armed-timer source exists to stop.
    expect(nextRunText(null, NOW)).toBe('');
    expect(nextRunText(undefined, NOW)).toBe('');
  });

  it('a garbage instant is treated as absent, not printed', () => {
    expect(nextRunText(Number.NaN, NOW)).toBe('');
    expect(nextRunText(Number.POSITIVE_INFINITY, NOW)).toBe('');
  });

  it('an instant already past reads "due now", never a negative countdown', () => {
    // The timer fired and the callback has not been dispatched yet. "in -3s" is
    // the shape of a clock that has stopped being believed.
    expect(nextRunText(NOW - 3_000, NOW)).toBe('due now');
    expect(nextRunText(NOW, NOW)).toBe('due now');
  });
});

describe('lastRunText — both halves, or nothing', () => {
  it('renders a completed run as time + outcome', () => {
    expect(lastRunText(NOW - 12_000, 'ok', NOW)).toBe('12s ago · ok');
    expect(lastRunText(NOW - 65_000, 'failed', NOW)).toBe('1m 5s ago · failed');
  });

  it('a time with no outcome renders nothing', () => {
    expect(lastRunText(NOW - 12_000, null, NOW)).toBe('');
    expect(lastRunText(NOW - 12_000, undefined, NOW)).toBe('');
  });

  it('an outcome with no time renders nothing', () => {
    expect(lastRunText(null, 'ok', NOW)).toBe('');
    expect(lastRunText(undefined, 'failed', NOW)).toBe('');
  });

  it('a run stamped at (or after) now reads "just now", never a negative age', () => {
    expect(lastRunText(NOW, 'ok', NOW)).toBe('just now · ok');
    expect(lastRunText(NOW + 500, 'ok', NOW)).toBe('just now · ok');
  });
});

describe('loopStateText — the Loops/Crons boundary survives every branch', () => {
  it('a plain live loop says it dies with its chat', () => {
    expect(loopStateText(true, false, false)).toBe('Stops when this chat closes.');
  });

  it('a persistent live loop promises the CHAT closing, never the editor', () => {
    // Overpromising here is the exact confusion the pane's limit banner exists
    // to prevent: a persistent loop is still not a cron.
    const s = loopStateText(true, true, false);
    expect(s).toContain('close this chat');
    expect(s).not.toContain('VS Code');
  });

  it('a headless loop admits the chat is gone AND that it is still scheduled', () => {
    const s = loopStateText(true, true, true);
    expect(s).toContain('No chat open');
    expect(s).toContain('still scheduled');
  });

  it('a needs-attention persistent loop admits the recall FAILED and nothing is scheduled', () => {
    const s = loopStateText(false, true, false);
    expect(s).toContain('could not be reopened');
    expect(s).toContain('nothing is scheduled');
  });

  it('a needs-attention plain loop points at reopening the chat', () => {
    expect(loopStateText(false, false, false)).toContain('could not be restored');
  });
});
