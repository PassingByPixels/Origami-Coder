// browserSettings.test.ts — Settings › Browser, client side
// (webview/dashboard/components/BrowserSettings.svelte, three rows since
// t-s9jr6u moved it from Insights to the Settings view). Moved out of the
// sidebar's Connections block to Insights by t-qc1d69; born as t-ntmm93.
//
// These are WIRING guards, not echoes. Each one breaks on a specific regression:
//   1. The card not ASKING for the live value on mount, so it would show 1920x1080
//      while the settings held something else.
//   2. A typed size not reaching the host, so Settings would look editable and
//      persist nothing — the exact failure mode the ticket's second acceptance
//      item is about.
//   3. The Settings view losing a row. Each row owns its own wire end to end,
//      so a view rendering fewer than the table's seven is the bug.
//   4. The card reappearing in the sidebar — the exact regression t-qc1d69 fixes.
//
// jsdom has no layout engine and no <style> reaches this DOM, so nothing here
// asserts appearance. The card's look needs a human eye.

import { render, screen, fireEvent, waitFor } from '@testing-library/svelte';
import { describe, expect, it, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import BrowserSettings from '../components/BrowserSettings.svelte';
import SettingsPane from '../panes/SettingsPane.svelte';
import ChatView from '../../chat/ChatView.svelte';

type Posted = Record<string, unknown>;

/** The captured postMessage buffer the vitest setup installs. */
function posts(): Posted[] {
  return globalThis.__vscodeApiMock.postMessage.mock.calls.map((c) => c[0] as Posted);
}

function fromHost(data: Posted) {
  window.dispatchEvent(new MessageEvent('message', { data }));
}

beforeEach(() => {
  globalThis.__vscodeApiMock.postMessage.mockClear();
});

describe('BrowserSettings — the viewport default, persisted through the host', () => {
  it('asks the host for the live value on mount instead of assuming its own default', async () => {
    render(BrowserSettings);
    await waitFor(() => {
      expect(posts().some((m) => m.type === 'requestBrowserViewport')).toBe(true);
    });
  });

  it('shows 1920x1080 before the host answers — the documented default', () => {
    render(BrowserSettings);
    expect((screen.getByLabelText('Screenshot viewport width') as HTMLInputElement).value).toBe('1920');
    expect((screen.getByLabelText('Screenshot viewport height') as HTMLInputElement).value).toBe('1080');
  });

  it('adopts the host value, so a setting changed elsewhere shows here', async () => {
    render(BrowserSettings);
    fromHost({ type: 'browserViewportUpdate', width: 1280, height: 720, beside: false });
    await waitFor(() => {
      expect((screen.getByLabelText('Screenshot viewport width') as HTMLInputElement).value).toBe('1280');
    });
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
  });

  it('sends a typed size to the host, which is what makes it persist', async () => {
    render(BrowserSettings);
    const width = screen.getByLabelText('Screenshot viewport width');
    await fireEvent.input(width, { target: { value: '2560' } });
    await fireEvent.change(width);
    await waitFor(() => {
      const sent = posts().filter((m) => m.type === 'setBrowserViewport').at(-1);
      expect(sent).toMatchObject({ width: 2560, height: 1080 });
    });
  });

  it('Reset puts 1920x1080 back AND tells the host, not just the input', async () => {
    render(BrowserSettings);
    fromHost({ type: 'browserViewportUpdate', width: 800, height: 600, beside: true });
    await waitFor(() => {
      expect((screen.getByLabelText('Screenshot viewport width') as HTMLInputElement).value).toBe('800');
    });
    await fireEvent.click(screen.getByText('Reset'));
    await waitFor(() => {
      expect(posts().filter((m) => m.type === 'setBrowserViewport').at(-1)).toMatchObject({
        width: 1920,
        height: 1080,
      });
    });
  });

  it('the open-beside switch drives its own message', async () => {
    render(BrowserSettings);
    await fireEvent.click(screen.getByRole('switch'));
    await waitFor(() => {
      expect(posts().filter((m) => m.type === 'setBrowserOpenBeside').at(-1)).toMatchObject({ value: false });
    });
  });
});

describe('BrowserRevealRow — the reveal policy (t-qcwpyy)', () => {
  const PICKER = 'Bring the browser tab to the front';

  it('shows "first" before the host answers — the contributed default', () => {
    render(BrowserSettings);
    expect((screen.getByLabelText(PICKER) as HTMLSelectElement).value).toBe('first');
  });

  it('adopts the host value, so a policy set in VS Code Settings shows here', async () => {
    render(BrowserSettings);
    fromHost({ type: 'browserViewportUpdate', width: 1920, height: 1080, beside: true, reveal: 'never' });
    await waitFor(() => {
      expect((screen.getByLabelText(PICKER) as HTMLSelectElement).value).toBe('never');
    });
  });

  it('a chosen policy reaches the host, which is what makes it persist', async () => {
    render(BrowserSettings);
    const pick = screen.getByLabelText(PICKER);
    await fireEvent.change(pick, { target: { value: 'always' } });
    await waitFor(() => {
      expect(posts().filter((m) => m.type === 'setBrowserReveal').at(-1)).toMatchObject({ value: 'always' });
    });
  });

  it('offers exactly the three values src/browserReveal.ts defines — the MIRROR guard', () => {
    // A webview file cannot import a runtime value from src/ (rootDir), so the
    // policy list is written twice. This reads BOTH and fails on drift, the way
    // repoMapPillars.test.ts does for the pillars.
    const here = path.join(__dirname, '..');
    const row = readFileSync(path.join(here, 'components', 'BrowserRevealRow.svelte'), 'utf8');
    const host = readFileSync(path.join(here, '..', '..', 'src', 'browserReveal.ts'), 'utf8');
    const inRow = [...row.matchAll(/value: '([a-z]+)'/g)].map((m) => m[1]);
    const declared = /REVEAL_POLICIES: readonly RevealPolicy\[\] = \[([^\]]+)\]/.exec(host)?.[1] ?? '';
    const inHost = [...declared.matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
    expect(inHost.length).toBe(3);
    expect(inRow).toEqual(inHost);
  });
});

describe('SettingsPane — where the Browser rows live now (t-s9jr6u)', () => {
  it('renders the Browser rows beside the other moved settings, and no Storage', () => {
    render(SettingsPane);
    expect(screen.getByText('Keep the prompt cache warm')).toBeInTheDocument();
    expect(screen.getByLabelText('Screenshot viewport width')).toBeInTheDocument();
    expect(screen.getByText('Open beside the chat')).toBeInTheDocument();
    // Owner, round 6: storage lives in the Nests view only.
    expect(screen.queryByText('Session store')).toBeNull();
  });
});

describe('the sidebar no longer carries the Browser card (t-qc1d69)', () => {
  it('the plain sidebar shows the connections strip and the dock, with no Browser card between them', () => {
    render(ChatView);
    // ControlStrip's own surface is still there…
    expect(screen.getByText(/Add provider/)).toBeInTheDocument();
    // …but the viewport card that used to sit right below it inside
    // SettingsSection.svelte is gone. This is the test that must go RED if the
    // move is reverted (BrowserSettings mounted back into the sidebar).
    expect(screen.queryByLabelText('Screenshot viewport width')).toBeNull();
    expect(screen.queryByText('Open beside the chat')).toBeNull();
  });
});
