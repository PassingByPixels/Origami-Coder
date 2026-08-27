// CronsPane — the view for scheduled runs that fire with VS Code CLOSED.
// The behaviours pinned here are the ones whose absence would mislead someone
// about what a cron does: that it is NOT a Loop, that it runs unattended and
// auto-approved, that drift is reported in both directions, and that an
// unsupported platform says so instead of pretending to have scheduled work.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import { tick } from 'svelte';
import CronsPane from '../panes/CronsPane.svelte';

const posts = () => globalThis.__vscodeApiMock.postMessage.mock.calls.map((c: unknown[]) => c[0]) as Array<Record<string, unknown>>;
const flat = (s: string | null) => (s ?? '').replace(/\s+/g, ' ');

const row = (over: Record<string, unknown> = {}) => ({
  id: 'c1', name: 'nightly triage', prompt: 'triage the backlog',
  scheduleLabel: 'daily at 09:30', enabled: true, taskName: '\\Origami\\c1',
  logPath: '.origami\\cron-logs\\c1.log', scriptPath: '.origami\\crons\\c1.cmd',
  nextRunAt: '2026-07-30T09:30:00.000Z',
  lastOutputAt: null, runs: 0, runsExact: true, lastOutcome: null, lastExitCode: null,
  schedule: { kind: 'daily', time: '09:30' }, ...over,
});

function cronsData(over: Record<string, unknown> = {}): void {
  window.dispatchEvent(new MessageEvent('message', {
    data: {
      type: 'cronsData', crons: [], invalid: [],
      drift: { missingRegistration: [], strayRegistration: [] },
      backendAvailable: true, ...over,
    },
  }));
}

beforeEach(() => { globalThis.__vscodeApiMock.postMessage.mockClear(); });
afterEach(() => cleanup());

describe('CronsPane — asks the host for real data on mount', () => {
  it('posts listCrons (the DashboardPanel wire)', () => {
    render(CronsPane);
    expect(posts()).toContainEqual({ type: 'listCrons' });
  });

  it('PULLS the model catalog too, instead of waiting to be handed it', () => {
    // `modelOptions` / `providerStatus` are broadcasts, not state. Whichever
    // one fired before this pane mounted is gone, and the cron form now has a
    // REQUIRED model field it could not satisfy from an empty picker — so the
    // pane has to ask, the way CollabAgentsPane does.
    render(CronsPane);
    expect(posts()).toContainEqual({ type: 'requestModels' });
    expect(posts()).toContainEqual({ type: 'requestProviderStatus' });
  });
});

describe('CronsPane — a new cron must name its model', () => {
  const models = () =>
    window.dispatchEvent(new MessageEvent('message', {
      data: {
        type: 'modelOptions',
        options: [
          { value: 'anthropic/claude-sonnet-4', name: 'Claude Sonnet 4' },
          { value: 'openai/gpt-5-mini', name: 'GPT-5 mini' },
        ],
      },
    }));
  const openForm = async (container: HTMLElement) => {
    await fireEvent.click(container.querySelector('.crons-new') as HTMLButtonElement);
    await tick();
  };

  it('opens with the model UNSET, Create disabled, and says why in words', async () => {
    const { container } = render(CronsPane);
    cronsData();
    models();
    await tick();
    await openForm(container);

    const save = container.querySelector('.cf-save') as HTMLButtonElement;
    expect(save.disabled, 'a cron could be created with no model').toBe(true);
    // The warning has to NAME the consequence. "Required" alone reads as a
    // form nag; the point is that the alternative is not a default.
    const warn = flat(container.querySelector('.crt-warn')!.textContent);
    expect(warn).toMatch(/last on this machine/i);
  });

  it('picking a model enables Create and sends that exact id in the draft', async () => {
    const { container } = render(CronsPane);
    cronsData();
    models();
    await tick();
    await openForm(container);

    // Open the combobox, then choose the second model by its pretty name.
    await fireEvent.click(container.querySelector('.ams-trigger') as HTMLButtonElement);
    await tick();
    const group = Array.from(document.querySelectorAll('.ams-group')).find(
      (g) => g.textContent!.includes('openai'),
    ) as HTMLButtonElement;
    await fireEvent.click(group);
    await tick();
    const opt = Array.from(document.querySelectorAll('.ams-opt')).find(
      (o) => o.textContent!.trim() === 'GPT-5 mini',
    ) as HTMLButtonElement;
    await fireEvent.click(opt);
    await tick();

    expect(container.querySelector('.crt-warn'), 'the warning outlived the fix').toBeNull();
    const save = container.querySelector('.cf-save') as HTMLButtonElement;
    expect(save.disabled).toBe(false);

    globalThis.__vscodeApiMock.postMessage.mockClear();
    await fireEvent.click(save);
    const draft = posts().find((p) => p.type === 'createCron')!.draft as Record<string, unknown>;
    expect(draft.model).toBe('openai/gpt-5-mini');
  });

  it('an EXISTING cron with no model renders the resolution, never a blank cell', async () => {
    // The legacy row. Blank would read as "nothing special about this one",
    // which is the opposite of true.
    const { container } = render(CronsPane);
    cronsData({ crons: [row({ model: undefined })] });
    await tick();

    const meta = container.querySelector('.job-meta')!;
    expect(flat(meta.textContent)).toMatch(/no model pinned/i);
    expect(meta.classList.contains('unpinned')).toBe(true);
  });

  it('...and a cron that HAS one just shows it, with no warning attached', async () => {
    const { container } = render(CronsPane);
    cronsData({ crons: [row({ model: 'anthropic/claude-sonnet-4' })] });
    await tick();

    const meta = container.querySelector('.job-meta')!;
    expect(flat(meta.textContent)).toContain('anthropic/claude-sonnet-4');
    expect(flat(meta.textContent)).not.toMatch(/no model pinned/i);
    expect(meta.classList.contains('unpinned')).toBe(false);
  });
});

describe('CronsPane — says plainly what a cron IS', () => {
  it('states that a cron fires with VS Code closed — the whole difference from a Loop', async () => {
    const { container } = render(CronsPane);
    cronsData();
    await tick();
    expect(flat(container.textContent)).toContain('with VS Code closed');
    expect(flat(container.textContent)).toContain('.origami/crons.json');
  });

  it('states that crons run unattended and auto-approved, as standing fact', async () => {
    // Passing chose full auto-approve knowingly. The pane must not hide that,
    // and must not turn it into a confirm dialog on every edit either.
    const { container } = render(CronsPane);
    cronsData({ crons: [row()] });
    await tick();
    const banner = container.querySelector('.cron-unattended');
    expect(banner).not.toBeNull();
    expect(flat(banner!.textContent)).toContain('unattended and auto-approved');
    expect(flat(banner!.textContent)).toContain('--auto');
  });

  it('the empty state explains the schedule-with-editor-closed idea rather than being blank', async () => {
    const { container } = render(CronsPane);
    cronsData();
    await tick();
    expect(container.querySelectorAll('.cron-card')).toHaveLength(0);
    expect(flat(container.querySelector('.crons-empty')!.textContent)).toContain('even when VS Code is closed');
  });
});

describe('CronsPane — a cron row shows what it will do and when', () => {
  it('renders name, schedule, the log path and its never-run state', async () => {
    const { container } = render(CronsPane);
    cronsData({ crons: [row()] });
    await tick();
    const text = flat(container.textContent);
    expect(text).toContain('nightly triage');
    expect(text).toContain('daily at 09:30');
    expect(text).toContain('.origami\\cron-logs\\c1.log');
    expect(text).toContain('NEVER RUN');
  });

  it('the prompt is NOT on screen until the row is expanded — prose would wreck the table', async () => {
    const { container } = render(CronsPane);
    cronsData({ crons: [row()] });
    await tick();
    expect(flat(container.textContent)).not.toContain('triage the backlog');
  });

  it('an interval cron with no known next run says "unknown", never a fabricated time', async () => {
    const { container } = render(CronsPane);
    cronsData({ crons: [row({ nextRunAt: null, scheduleLabel: 'every 4 hours' })] });
    await tick();
    expect(flat(container.textContent)).toContain('unknown');
  });

  it('a disabled cron is marked, shows NO next run, and its Run is not clickable', async () => {
    const { container } = render(CronsPane);
    cronsData({ crons: [row({ enabled: false })] });
    await tick();
    expect(flat(container.textContent)).toContain('DISABLED');
    // A disabled cron must not advertise a next run — it is not going to happen.
    const cells = Array.from(container.querySelectorAll('td')).map((td) => flat(td.textContent));
    expect(cells.some((c) => /today|tomorrow|unknown/.test(c))).toBe(false);
    const runNow = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Run') as HTMLButtonElement;
    expect(runNow.disabled).toBe(true);
  });

  it('the row controls post the right wire messages with the row id', async () => {
    const { container } = render(CronsPane);
    cronsData({ crons: [row()] });
    await tick();
    const click = async (label: string) => {
      const b = Array.from(container.querySelectorAll('button')).find((x) => x.textContent?.trim() === label)!;
      await fireEvent.click(b);
    };
    await click('Run');
    await click('Log');
    await click('Disable');
    await click('Delete');
    expect(posts()).toContainEqual({ type: 'runCronNow', id: 'c1' });
    expect(posts()).toContainEqual({ type: 'openCronLog', id: 'c1' });
    expect(posts()).toContainEqual({ type: 'setCronEnabled', id: 'c1', enabled: false });
    expect(posts()).toContainEqual({ type: 'deleteCron', id: 'c1' });
  });

  it('a disabled row offers Enable, and asks to be enabled', async () => {
    const { container } = render(CronsPane);
    cronsData({ crons: [row({ enabled: false })] });
    await tick();
    const b = Array.from(container.querySelectorAll('button')).find((x) => x.textContent?.trim() === 'Enable')!;
    await fireEvent.click(b);
    expect(posts()).toContainEqual({ type: 'setCronEnabled', id: 'c1', enabled: true });
  });
});

describe('CronsPane — the filter box', () => {
  const three = [
    row({ id: 'c1', name: 'nightly triage', prompt: 'triage the backlog' }),
    row({ id: 'c2', name: 'weekly digest', prompt: 'summarise the week' }),
    row({ id: 'c3', name: 'hourly ping', prompt: 'check the deploy', model: 'laguna-s' }),
  ];
  const type = async (container: HTMLElement, value: string) => {
    await fireEvent.input(container.querySelector('.crons-filter')!, { target: { value } });
    await tick();
  };

  it('narrows the table to matching rows', async () => {
    const { container } = render(CronsPane);
    cronsData({ crons: three });
    await tick();
    expect(container.querySelectorAll('.cron-row')).toHaveLength(3);
    await type(container, 'weekly');
    expect(container.querySelectorAll('.cron-row')).toHaveLength(1);
    expect(flat(container.textContent)).toContain('weekly digest');
  });

  it('matches on the PROMPT and the MODEL, not just the name', async () => {
    const { container } = render(CronsPane);
    cronsData({ crons: three });
    await tick();
    await type(container, 'deploy');
    expect(container.querySelectorAll('.cron-row')).toHaveLength(1);
    await type(container, 'laguna');
    expect(container.querySelectorAll('.cron-row')).toHaveLength(1);
  });

  it('a filter matching nothing says so — and does NOT claim there are no crons', async () => {
    // The exact bug class: "No crons yet" printed over three live scheduled
    // tasks, because the pane conflated an empty list with an empty result.
    const { container } = render(CronsPane);
    cronsData({ crons: three });
    await tick();
    await type(container, 'zzzz');
    const text = flat(container.querySelector('.crons-empty')!.textContent);
    expect(text).toContain('No cron matches');
    expect(text).toContain('3 crons exist');
    expect(text).not.toContain('No crons yet');
  });

  it('genuinely having no crons still says "No crons yet", not "no matches"', async () => {
    const { container } = render(CronsPane);
    cronsData({ crons: [] });
    await tick();
    const text = flat(container.querySelector('.crons-empty')!.textContent);
    expect(text).toContain('No crons yet');
    expect(text).not.toContain('No cron matches');
  });

  it('clearing the filter from the empty state brings every row back', async () => {
    const { container } = render(CronsPane);
    cronsData({ crons: three });
    await tick();
    await type(container, 'zzzz');
    await fireEvent.click(container.querySelector('.crons-clear')!);
    await tick();
    expect(container.querySelectorAll('.cron-row')).toHaveLength(3);
  });

  it('the count reads shown/total while filtering, so a hidden row is never a lost row', async () => {
    const { container } = render(CronsPane);
    cronsData({ crons: three });
    await tick();
    await type(container, 'weekly');
    expect(flat(container.querySelector('.crons-count')!.textContent)).toBe('1/3');
  });
});

describe('CronsPane — runs and last outcome come from the log', () => {
  it('shows the run count and the last run with its outcome', async () => {
    const { container } = render(CronsPane);
    cronsData({ crons: [row({ runs: 12, runsExact: true, lastOutcome: 'ok', lastOutputAt: Date.now() })] });
    await tick();
    const text = flat(container.textContent);
    expect(text).toContain('today');
    expect(text).toContain('· ok');
    expect(text).toContain('OK');
    expect(flat(container.querySelector('.num.mono')!.textContent)).toBe('12');
  });

  it('a failed row carries the exit code as an italic note in the JOB cell', async () => {
    const { container } = render(CronsPane);
    cronsData({ crons: [row({ runs: 3, lastOutcome: 'failed', lastExitCode: 9, lastOutputAt: Date.now() })] });
    await tick();
    expect(flat(container.textContent)).toContain('FAILED');
    expect(flat(container.querySelector('.job-note')!.textContent)).toContain('exited 9');
  });

  it('a tail-read count is rendered as a floor ("12+"), never as an exact total', async () => {
    const { container } = render(CronsPane);
    cronsData({ crons: [row({ runs: 12, runsExact: false, lastOutcome: 'ok', lastOutputAt: Date.now() })] });
    await tick();
    expect(flat(container.querySelector('.num.mono')!.textContent)).toBe('12+');
  });

  it('a started-but-never-ended run reads RUNNING, not OK and not FAILED', async () => {
    const { container } = render(CronsPane);
    cronsData({ crons: [row({ runs: 1, lastOutcome: 'incomplete', lastOutputAt: Date.now() })] });
    await tick();
    const text = flat(container.textContent);
    expect(text).toContain('RUNNING');
    expect(text).toContain('no end record');
  });
});

describe('CronsPane — drift is shown in BOTH directions', () => {
  it('reports a cron that will NOT fire (in the file, not registered)', async () => {
    const { container } = render(CronsPane);
    cronsData({
      crons: [row()],
      drift: { missingRegistration: [{ id: 'c1', name: 'nightly triage', taskName: '\\Origami\\c1' }], strayRegistration: [] },
    });
    await tick();
    const text = flat(container.querySelector('.cron-drift')!.textContent);
    expect(text).toContain('NOT registered');
    expect(text).toContain('will not fire');
  });

  it('reports a task that WILL fire despite not being an enabled cron here', async () => {
    const { container } = render(CronsPane);
    cronsData({
      drift: { missingRegistration: [], strayRegistration: [{ taskName: '\\Origami\\ghost', reason: 'unknown' }] },
    });
    await tick();
    const text = flat(container.querySelector('.cron-drift')!.textContent);
    expect(text).toContain('\\Origami\\ghost');
    expect(text).toContain('WILL still fire');
  });

  it('says drift is UNKNOWN when the scheduler could not be queried — never implies "all clean"', async () => {
    const { container } = render(CronsPane);
    cronsData({ drift: { missingRegistration: [], strayRegistration: [], error: 'schtasks not found' } });
    await tick();
    expect(flat(container.querySelector('.cron-drift')!.textContent)).toContain('drift is unknown');
  });

  it('shows no drift banner at all when file and scheduler agree', async () => {
    const { container } = render(CronsPane);
    cronsData({ crons: [row()] });
    await tick();
    expect(container.querySelector('.cron-drift')).toBeNull();
  });
});

describe('CronsPane — an unsupported platform refuses honestly', () => {
  it('shows the reason and disables cron creation entirely', async () => {
    const { container } = render(CronsPane);
    cronsData({ backendAvailable: false, backendReason: 'OS-level crons are Windows-only for now (this is darwin).' });
    await tick();
    expect(flat(container.querySelector('.cron-blocked')!.textContent)).toContain('Windows-only');
    const newBtn = container.querySelector('.crons-new') as HTMLButtonElement;
    expect(newBtn.disabled).toBe(true);
  });
});

describe('CronsPane — a malformed crons.json entry is surfaced, not swallowed', () => {
  it('shows the reason the entry could not be read', async () => {
    const { container } = render(CronsPane);
    cronsData({ invalid: [{ reason: 'cron c2: every 24 hours cannot be scheduled' }] });
    await tick();
    expect(flat(container.textContent)).toContain('every 24 hours cannot be scheduled');
  });
});

describe('CronsPane — the create form', () => {
  it('posts createCron with the built schedule', async () => {
    const { container } = render(CronsPane);
    cronsData();
    await tick();
    await fireEvent.click(container.querySelector('.crons-new')!);
    await tick();

    const inputs = container.querySelectorAll('.cron-form input, .cron-form textarea');
    await fireEvent.input(inputs[0], { target: { value: 'my cron' } });
    await fireEvent.input(inputs[1], { target: { value: 'do the thing' } });
    await fireEvent.click(Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Create')!);

    const created = posts().find((p) => p.type === 'createCron');
    expect(created).toBeDefined();
    expect(created!.draft).toMatchObject({ name: 'my cron', prompt: 'do the thing', schedule: { kind: 'daily' } });
  });

  it('a REFUSED create keeps the form open and shows the reason verbatim', async () => {
    // The refusal is the feature — an untranslatable schedule must be visible,
    // not swallowed into a closed form that looks like it worked.
    const { container } = render(CronsPane);
    cronsData();
    await tick();
    await fireEvent.click(container.querySelector('.crons-new')!);
    await tick();

    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'cronOpResult', ok: false, error: 'every 24 hours cannot be scheduled — use a daily schedule' },
    }));
    await tick();

    expect(container.querySelector('.cron-form')).not.toBeNull();
    expect(flat(container.querySelector('.cf-error')!.textContent)).toContain('every 24 hours cannot be scheduled');
  });

  it('a successful op closes the form and re-reads the list', async () => {
    const { container } = render(CronsPane);
    cronsData();
    await tick();
    await fireEvent.click(container.querySelector('.crons-new')!);
    await tick();
    globalThis.__vscodeApiMock.postMessage.mockClear();

    window.dispatchEvent(new MessageEvent('message', { data: { type: 'cronOpResult', ok: true } }));
    await tick();

    expect(container.querySelector('.cron-form')).toBeNull();
    expect(posts()).toContainEqual({ type: 'listCrons' });
  });

  it('editing an existing cron pre-fills the form and posts updateCron with its id', async () => {
    const { container } = render(CronsPane);
    cronsData({ crons: [row()] });
    await tick();
    await fireEvent.click(Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Edit')!);
    await tick();

    const nameInput = container.querySelector('.cron-form input') as HTMLInputElement;
    expect(nameInput.value).toBe('nightly triage');

    await fireEvent.click(Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Save')!);
    const updated = posts().find((p) => p.type === 'updateCron');
    expect(updated).toBeDefined();
    expect(updated!.id).toBe('c1');
  });
});

// The prompt used to be reachable only by opening the Edit form, which put the
// answer to "what does this job do?" behind a mutation screen. These pin the
// disclosure that replaced it — including the two ways a row expander goes
// wrong: firing from an action button, and widening the table it lives in.
describe('CronsPane — a row discloses what its job DOES', () => {
  const btn = (c: HTMLElement) => c.querySelector<HTMLButtonElement>('.job-toggle')!;
  const act = (c: HTMLElement, text: string) =>
    Array.from(c.querySelectorAll('button')).find((b) => b.textContent?.trim() === text)!;

  it('starts collapsed and says so to a screen reader', async () => {
    const { container } = render(CronsPane);
    cronsData({ crons: [row()] });
    await tick();
    expect(btn(container).getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('.cron-detail-row')).toBeNull();
  });

  it('expanding reveals the FULL prompt plus what the row cannot fit', async () => {
    const { container } = render(CronsPane);
    cronsData({ workspace: 'C:\\Repos\\origami', crons: [row({ agent: 'scout', model: 'vllm/laguna' })] });
    await tick();
    await fireEvent.click(btn(container));
    await tick();

    const detail = container.querySelector('.cron-detail-row')!;
    const text = flat(detail.textContent);
    expect(flat(container.querySelector('.cd-prompt')!.textContent)).toBe('triage the backlog');
    expect(text).toContain('scout');
    expect(text).toContain('vllm/laguna');
    expect(text).toContain('C:\\Repos\\origami');
    expect(text).toContain('\\Origami\\c1');
    expect(text).toContain('.origami\\crons\\c1.cmd');
    expect(btn(container).getAttribute('aria-expanded')).toBe('true');
  });

  it('never invents a command line it has not seen — it names the launcher instead', async () => {
    // The origami binary is resolved at registration time and this webview has
    // never seen it. A plausible `origami run …` here would be a guess printed
    // as the thing running unattended, auto-approved, at 3am.
    const { container } = render(CronsPane);
    cronsData({ crons: [row()] });
    await tick();
    await fireEvent.click(btn(container));
    await tick();
    const text = flat(container.querySelector('.cron-detail-row')!.textContent);
    expect(text).toContain('launcher script holds the exact command line');
    expect(text).not.toMatch(/origami(\.exe)?" run/);
  });

  it('an absent agent/model is stated as the engine default, not left blank', async () => {
    const { container } = render(CronsPane);
    cronsData({ crons: [row({ agent: undefined, model: undefined })] });
    await tick();
    await fireEvent.click(btn(container));
    await tick();
    expect(flat(container.querySelector('.cron-detail-row')!.textContent)).toContain('engine default');
  });

  it('collapses again on a second click', async () => {
    const { container } = render(CronsPane);
    cronsData({ crons: [row()] });
    await tick();
    await fireEvent.click(btn(container));
    await tick();
    await fireEvent.click(btn(container));
    await tick();
    expect(container.querySelector('.cron-detail-row')).toBeNull();
    expect(btn(container).getAttribute('aria-expanded')).toBe('false');
  });

  it('NO row action toggles the expander — Delete must never be a disclosure', async () => {
    // The bug this exists to catch is a click handler moving up onto the <tr>.
    // It would make every action button expand the row as a side effect, and
    // the one where that matters is the destructive one.
    const { container } = render(CronsPane);
    cronsData({ crons: [row()] });
    await tick();
    for (const label of ['Run', 'Log', 'Disable', 'Edit', 'Delete']) {
      await fireEvent.click(act(container, label));
      await tick();
      expect(container.querySelector('.cron-detail-row'), `${label} expanded the row`).toBeNull();
      expect(btn(container).getAttribute('aria-expanded'), `${label} flipped aria-expanded`).toBe('false');
    }
  });

  it('expanding re-reads nothing — no listCrons, no scheduler round trip', async () => {
    // Everything on the panel is already in the row the table was handed. A
    // refresh per expand would re-read every cron's log to open one of them.
    const { container } = render(CronsPane);
    cronsData({ crons: [row(), row({ id: 'c2', name: 'weekly sweep' })] });
    await tick();
    globalThis.__vscodeApiMock.postMessage.mockClear();
    await fireEvent.click(container.querySelectorAll<HTMLButtonElement>('.job-toggle')[1]);
    await tick();
    expect(posts()).toEqual([]);
  });

  it('rows expand independently — opening one does not close the other', async () => {
    const { container } = render(CronsPane);
    cronsData({ crons: [row(), row({ id: 'c2', name: 'weekly sweep', prompt: 'sweep the inbox' })] });
    await tick();
    const toggles = container.querySelectorAll<HTMLButtonElement>('.job-toggle');
    await fireEvent.click(toggles[0]);
    await fireEvent.click(toggles[1]);
    await tick();
    expect(container.querySelectorAll('.cron-detail-row')).toHaveLength(2);
  });

  it('focus stays on the control that was pressed', async () => {
    const { container } = render(CronsPane);
    cronsData({ crons: [row()] });
    await tick();
    btn(container).focus();
    await fireEvent.click(btn(container));
    await tick();
    expect(document.activeElement).toBe(btn(container));
  });

  it('a huge single-token prompt is CONTAINED, never given its own columns', async () => {
    // The containment contract: the detail is one cell spanning the existing
    // columns. Detail in extra <td>s adds columns, and a 4000-character token
    // in one of them re-flows the widths of every other row on the board.
    const monster = 'x'.repeat(4000);
    const { container } = render(CronsPane);
    cronsData({ crons: [row({ prompt: monster })] });
    await tick();
    await fireEvent.click(btn(container));
    await tick();

    const headers = container.querySelectorAll('thead th').length;
    const detailCells = container.querySelectorAll('.cron-detail-row > td');
    expect(detailCells).toHaveLength(1);
    expect(detailCells[0].getAttribute('colspan')).toBe(String(headers));
    // Contained, not truncated — you must still be able to read all of it.
    expect(container.querySelector('.cd-prompt')!.textContent).toBe(monster);
    // Every data row still has exactly the header's column count.
    for (const tr of container.querySelectorAll('tbody tr:not(.cron-detail-row)')) {
      expect(tr.querySelectorAll('td')).toHaveLength(headers);
    }
  });
});
