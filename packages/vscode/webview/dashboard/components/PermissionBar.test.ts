// Tweak 1 (display seam) — the permission bar renders the literal command block
// and de-dupes target vs command: the workdir-less fallback (and the
// external_directory ask, whose only path-ish key IS `command`) sets target ===
// command, and the bar must then show the command block ONLY, never the same
// string twice. When target and command differ, both render.
import { fireEvent, render } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import PermissionBar from './PermissionBar.svelte';

const OPTS = [
  { optionId: 'once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
];

describe('PermissionBar — command block + target de-dupe', () => {
  it('renders the literal command verbatim in the command block', () => {
    const { container } = render(PermissionBar, {
      props: { title: 'bash', options: OPTS, command: 'rm -rf ./build', onChoice: () => {} },
    });
    expect(container.querySelector('pre.perm-command')?.textContent).toBe('rm -rf ./build');
  });

  it('suppresses the target row when target === command (no double render)', () => {
    const { container } = render(PermissionBar, {
      props: { title: 'external_directory', options: OPTS, target: 'ls /etc', command: 'ls /etc', onChoice: () => {} },
    });
    expect(container.querySelector('.perm-target')).toBeNull();
    expect(container.querySelector('pre.perm-command')?.textContent).toBe('ls /etc');
  });

  it('renders both when target (workdir) differs from the command', () => {
    const { container } = render(PermissionBar, {
      props: { title: 'bash', options: OPTS, target: 'C:/work/repo', command: 'npm test', onChoice: () => {} },
    });
    expect(container.querySelector('.perm-target')?.textContent).toBe('C:/work/repo');
    expect(container.querySelector('pre.perm-command')?.textContent).toBe('npm test');
  });
});

// --- M4.4. Two controls land on this bar, and each is gated on WHICH KIND of
// ask it is (permissionOptions.isQuestionShaped): free text answers a QUESTION,
// yolo answers a CONSENT ask. Putting either on the other would be the bug.
const QUESTION_OPTS = [
  { optionId: 'a', name: 'Rewrite the parser', kind: 'allow_once' },
  { optionId: 'b', name: 'Patch the caller', kind: 'allow_once' },
  { optionId: 'other', name: 'Other', kind: 'allow_once' },
];
const CONSENT_OPTS = [
  { optionId: 'once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
  { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
];
const btn = (c: HTMLElement, label: string) =>
  Array.from(c.querySelectorAll('button')).find((b) => b.textContent?.trim() === label)!;

describe('PermissionBar — a question can be answered in your own words', () => {
  it('picking Other opens a text box instead of resolving the ask', async () => {
    const choices: unknown[][] = [];
    const { container } = render(PermissionBar, {
      props: { title: 'Which fix?', options: QUESTION_OPTS, onChoice: (...a: unknown[]) => choices.push(a) },
    });
    await fireEvent.click(btn(container, 'Other'));
    expect(container.querySelector('textarea.pte-input')).not.toBeNull();
    // Nothing is answered until the user actually sends something.
    expect(choices).toEqual([]);
  });

  it('sending the text resolves with the Other option AND the answer', async () => {
    const choices: unknown[][] = [];
    const { container } = render(PermissionBar, {
      props: { title: 'Which fix?', options: QUESTION_OPTS, onChoice: (...a: unknown[]) => choices.push(a) },
    });
    await fireEvent.click(btn(container, 'Other'));
    await fireEvent.input(container.querySelector('textarea.pte-input')!, { target: { value: '  neither, revert it  ' } });
    await fireEvent.click(btn(container, 'Send answer'));
    // Slot 2 is reviseText (the plan path) and stays undefined; slot 3 is the
    // answer, trimmed. Asserted positionally because the caller reads them so.
    expect(choices).toEqual([['other', undefined, 'neither, revert it']]);
  });

  it('will not send an empty answer', async () => {
    const choices: unknown[][] = [];
    const { container } = render(PermissionBar, {
      props: { title: 'Which fix?', options: QUESTION_OPTS, onChoice: (...a: unknown[]) => choices.push(a) },
    });
    await fireEvent.click(btn(container, 'Other'));
    await fireEvent.input(container.querySelector('textarea.pte-input')!, { target: { value: '   ' } });
    expect((btn(container, 'Send answer') as HTMLButtonElement).disabled).toBe(true);
    await fireEvent.click(btn(container, 'Send answer'));
    expect(choices).toEqual([]);
  });

  it('Back returns to the options without answering', async () => {
    const choices: unknown[][] = [];
    const { container } = render(PermissionBar, {
      props: { title: 'Which fix?', options: QUESTION_OPTS, onChoice: (...a: unknown[]) => choices.push(a) },
    });
    await fireEvent.click(btn(container, 'Other'));
    await fireEvent.click(btn(container, 'Back'));
    expect(container.querySelector('textarea.pte-input')).toBeNull();
    expect(btn(container, 'Rewrite the parser')).toBeDefined();
    expect(choices).toEqual([]);
  });

  it('an ordinary option on the same question still resolves immediately', async () => {
    const choices: unknown[][] = [];
    const { container } = render(PermissionBar, {
      props: { title: 'Which fix?', options: QUESTION_OPTS, onChoice: (...a: unknown[]) => choices.push(a) },
    });
    await fireEvent.click(btn(container, 'Patch the caller'));
    expect(choices).toEqual([['b']]);
  });

  // THE defensive requirement: the engine half of this ships on its own lane.
  it('an engine that sends NO Other option leaves the bar exactly as it was', async () => {
    const choices: unknown[][] = [];
    const { container } = render(PermissionBar, {
      props: { title: 'Which fix?', options: QUESTION_OPTS.slice(0, 2), onChoice: (...a: unknown[]) => choices.push(a) },
    });
    expect(container.querySelectorAll('.permission-buttons button')).toHaveLength(2);
    await fireEvent.click(btn(container, 'Rewrite the parser'));
    expect(choices).toEqual([['a']]);
  });

  it('a CONSENT ask with an option literally named Other still just resolves it', async () => {
    // Never a text box on a tool-approval bar.
    const choices: unknown[][] = [];
    const { container } = render(PermissionBar, {
      props: {
        title: 'bash',
        options: [...OPTS, { optionId: 'other', name: 'Other', kind: 'allow_always' }],
        onChoice: (...a: unknown[]) => choices.push(a),
      },
    });
    await fireEvent.click(btn(container, 'Other'));
    expect(container.querySelector('textarea.pte-input')).toBeNull();
    expect(choices).toEqual([['other']]);
  });
});

describe('PermissionBar — YOLO', () => {
  it('renders on a real consent ask, in the deny red', () => {
    const { container } = render(PermissionBar, {
      props: { title: 'bash', options: CONSENT_OPTS, onChoice: () => {}, onYolo: () => {} },
    });
    const yolo = container.querySelector('.perm-btn.yolo') as HTMLButtonElement;
    expect(yolo).not.toBeNull();
    // The red is what says "this is the dangerous one" — asserted as the class
    // the bar's own deny convention carries, not as a colour string.
    expect(yolo.classList.contains('deny')).toBe(true);
    expect(yolo.getAttribute('title')).toMatch(/without a prompt/i);
  });

  it('is ABSENT on a question — approving everything answers nothing there', () => {
    const { container } = render(PermissionBar, {
      props: { title: 'Which fix?', options: QUESTION_OPTS, onChoice: () => {}, onYolo: () => {} },
    });
    expect(container.querySelector('.perm-btn.yolo')).toBeNull();
  });

  it('is absent when no handler was given — a dead control is worse than none', () => {
    const { container } = render(PermissionBar, {
      props: { title: 'bash', options: CONSENT_OPTS, onChoice: () => {} },
    });
    expect(container.querySelector('.perm-btn.yolo')).toBeNull();
  });

  it('clicking it calls the handler and does NOT resolve the ask by itself', async () => {
    // The bar hands the whole decision up: the caller both flips the mode and
    // picks the allow option, so those two can never half-happen here.
    let yolos = 0;
    const choices: unknown[][] = [];
    const { container } = render(PermissionBar, {
      props: {
        title: 'bash', options: CONSENT_OPTS,
        onChoice: (...a: unknown[]) => choices.push(a),
        onYolo: () => { yolos++; },
      },
    });
    await fireEvent.click(container.querySelector('.perm-btn.yolo')!);
    expect(yolos).toBe(1);
    expect(choices).toEqual([]);
  });
});
