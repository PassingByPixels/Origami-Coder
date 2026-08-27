// browserCard.test.ts — the `browser` tool's card plus ToolCard's dispatch
// onto it. jsdom proves structure and the honest states, not looks — the
// visual verdict stays with UAT in a real VS Code window.
//
// The regressions each case exists to catch:
//   1. `browser` falling through to GenericCard, which cannot show a page;
//   2. a screenshot arriving and rendering as nothing but a sentence;
//   3. a refusal or an unreachable client rendering as an ordinary result;
//   4. a FAILED call carrying the header's green check, because the engine
//      completes it and only the metadata says otherwise;
//   5. a failure title's tail ("failed", "refused") rendering as a target chip.

import { render, screen } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import BrowserCard from './BrowserCard.svelte';
import ToolCard from '../ToolCard.svelte';

const SHOT = 'data:image/png;base64,iVBORw0KGgo=';

describe('BrowserCard — IN/OUT rails', () => {
  it('names the action and the target from the engine metadata', () => {
    render(BrowserCard, {
      result: 'Opened https://origami.gratis in the VS Code browser.',
      title: 'browser open: https://origami.gratis',
      status: 'completed',
      browser: { ok: true, action: 'open', url: 'https://origami.gratis' },
    });
    expect(screen.getByText('IN')).toBeInTheDocument();
    expect(screen.getByText('OUT')).toBeInTheDocument();
    expect(screen.getByText('open')).toBeInTheDocument();
    expect(screen.getByText('https://origami.gratis')).toBeInTheDocument();
    expect(screen.getByText('ok')).toBeInTheDocument();
  });

  it('renders a returned screenshot inline, at the data: URI it was given', () => {
    const { container } = render(BrowserCard, {
      result: 'Screenshot of https://a.test.',
      title: 'browser screenshot: https://a.test',
      status: 'completed',
      images: [SHOT],
      browser: { ok: true, action: 'screenshot', url: 'https://a.test' },
    });
    const img = screen.getByRole('img') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe(SHOT);
    expect(container.querySelector('.br-shots')?.textContent).toBe('screenshot');
  });

  it('counts several screenshots rather than claiming one', () => {
    const { container } = render(BrowserCard, {
      result: 'ok', title: 'browser screenshot', status: 'completed',
      images: [SHOT, 'data:image/png;base64,QUJD'],
      browser: { ok: true, action: 'screenshot' },
    });
    expect(screen.getAllByRole('img')).toHaveLength(2);
    expect(container.querySelector('.br-shots')?.textContent).toBe('2 screenshots');
  });

  it('reads red when the client could not be reached, though the call completed', () => {
    const result = 'The VS Code browser did not answer "screenshot" within 30s.';
    const { container } = render(BrowserCard, {
      result, title: 'browser screenshot: failed', status: 'completed',
      browser: { ok: false, action: 'screenshot' },
    });
    expect(container.querySelector('.br-fail')?.textContent).toBe('failed');
    expect(screen.queryByText('ok')).toBeNull();
    expect(container.querySelector('.br-error')).not.toBeNull();
  });

  it('reads red on an engine-side refusal', () => {
    render(BrowserCard, {
      result: 'Refused: click needs a selector: the CSS selector of the element to use.',
      title: 'browser click: refused',
      status: 'completed',
      browser: { ok: false, action: 'click' },
    });
    expect(screen.getByText('failed')).toBeInTheDocument();
  });

  // The two failure strings the old prose regexes did not match. Both begin with
  // neither `Refused:` nor `The VS Code browser `, so both used to read green.
  it.each([
    ['a text-only screenshot reply', '"browser_screenshot" returned no image data, only text: No page is open.'],
    ['an action the client does not know', 'Unknown browser action: "download".'],
  ])('reads red on %s, which no prose pattern caught', (_label, result) => {
    render(BrowserCard, {
      result, title: 'browser screenshot: failed', status: 'completed',
      browser: { ok: false, action: 'screenshot' },
    });
    expect(screen.getByText('failed')).toBeInTheDocument();
    expect(screen.queryByText('ok')).toBeNull();
  });

  it('reads red when the build published no browser tool', () => {
    render(BrowserCard, {
      result: 'This VS Code build published no browser tool that can "screenshot".',
      title: 'browser screenshot',
      status: 'completed',
      browser: { ok: false, action: 'screenshot' },
    });
    expect(screen.getByText('failed')).toBeInTheDocument();
  });

  it('shows no target chip for a failure, rather than a chip reading "failed"', () => {
    const { container } = render(BrowserCard, {
      result: 'The VS Code browser could not open and gave no reason.',
      title: 'browser open: failed',
      status: 'completed',
      browser: { ok: false, action: 'open' },
    });
    const chips = [...container.querySelectorAll('.br-chip')].map((c) => c.textContent);
    expect(chips).not.toContain('failed:');
    expect(chips.filter((c) => c === 'failed')).toHaveLength(1); // the OUT status chip only
    expect(container.querySelector('.br-chips')?.querySelectorAll('.br-chip')).toHaveLength(1);
  });

  it('keeps the target chip when the engine reports the page it reached', () => {
    render(BrowserCard, {
      result: 'The VS Code browser is now at https://b.test/page.',
      title: 'browser navigate: https://b.test/page',
      status: 'completed',
      browser: { ok: true, action: 'navigate', url: 'https://b.test/page' },
    });
    expect(screen.getByText('https://b.test/page')).toBeInTheDocument();
  });

  it('says it is still running instead of showing an empty result', () => {
    // The real pending frame carries the BARE tool name: the browser tool only
    // returns a title on completion, so acp/tool.ts falls back to the name. A
    // fixture titled 'browser open: https://a.test' here tested a wire shape
    // that never arrives, and hid what the card really shows before a result.
    const { container } = render(BrowserCard, { result: '', title: 'browser', status: 'in_progress' });
    expect(screen.getByText('running…')).toBeInTheDocument();
    expect(screen.getByText('no result yet')).toBeInTheDocument();
    // Neither metadata nor title names a target yet, so the card must claim
    // none rather than invent one: the action chip alone, and no target chip.
    expect(container.querySelector('.br-action')?.textContent).toBe('browser');
    expect(container.querySelectorAll('.br-row')[0].querySelectorAll('.br-chip')).toHaveLength(1);
  });
});

describe('ToolCard dispatch', () => {
  it('routes `browser` to BrowserCard even though its ACP kind is fetch', async () => {
    const { container } = render(ToolCard, {
      title: 'browser screenshot: https://a.test',
      kind: 'fetch',
      toolName: 'browser',
      status: 'completed',
      result: 'Screenshot of https://a.test.',
      images: [SHOT],
    });
    (container.querySelector('.tool-header') as HTMLButtonElement).click();
    await Promise.resolve();
    expect(container.querySelector('.br-card')).not.toBeNull();
    expect((container.querySelector('.br-shot') as HTMLImageElement).getAttribute('src')).toBe(SHOT);
  });

  it('leaves the plain fetch tool on the generic card', async () => {
    const { container } = render(ToolCard, {
      title: 'fetch https://a.test',
      kind: 'fetch',
      toolName: 'fetch',
      status: 'completed',
      result: 'page body',
    });
    (container.querySelector('.tool-header') as HTMLButtonElement).click();
    await Promise.resolve();
    expect(container.querySelector('.br-card')).toBeNull();
  });

  it('gives a browser call a body before any result lands', () => {
    // In-progress frames carry the bare tool name (acp/tool.ts title fallback).
    const { container } = render(ToolCard, {
      title: 'browser',
      kind: 'fetch',
      toolName: 'browser',
      status: 'in_progress',
    });
    expect(container.querySelector('.expand-arrow')).not.toBeNull();
  });
});

// The header icon is the ONLY status most of these cards ever show — nobody
// expands a card that already claims it worked. The engine completes a failed
// browser call, so `status` alone painted the green check on a page that never
// loaded; these pin the metadata flag as the decider, the bash exit precedent.
describe('ToolCard — honest browser status icon', () => {
  const failed = {
    title: 'browser open: failed',
    kind: 'fetch',
    toolName: 'browser',
    status: 'completed',
    result: 'The VS Code browser could not open and gave no reason.',
  };

  it('paints the red cross on a COMPLETED call the engine marked not ok', () => {
    const { container } = render(ToolCard, { ...failed, browser: { ok: false, action: 'open' } });
    expect(container.querySelector('.cross')).not.toBeNull();
    expect(container.querySelector('.check')).toBeNull();
  });

  it('keeps the green check for a call the engine marked ok', () => {
    const { container } = render(ToolCard, {
      title: 'browser open: https://a.test',
      kind: 'fetch',
      toolName: 'browser',
      status: 'completed',
      result: 'Opened https://a.test in the VS Code browser.',
      browser: { ok: true, action: 'open', url: 'https://a.test' },
    });
    expect(container.querySelector('.check')).not.toBeNull();
    expect(container.querySelector('.cross')).toBeNull();
  });

  it('does not read a NON-browser tool as failed on the same metadata shape', () => {
    // `ok` is a common metadata key; only the browser card's flag may flip this.
    const { container } = render(ToolCard, {
      title: 'fetch https://a.test',
      kind: 'fetch',
      toolName: 'fetch',
      status: 'completed',
      result: 'page body',
      browser: { ok: false },
    });
    expect(container.querySelector('.cross')).toBeNull();
  });

  it('still spins while the call is in flight, with no verdict yet', () => {
    const { container } = render(ToolCard, {
      title: 'browser', kind: 'fetch', toolName: 'browser', status: 'in_progress',
    });
    expect(container.querySelector('.spinner')).not.toBeNull();
    expect(container.querySelector('.cross')).toBeNull();
  });
});
