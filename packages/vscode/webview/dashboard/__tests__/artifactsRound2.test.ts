// t-s49986 — artifacts round 2, the extension half.
//
// 1. An `origami://artifact/<id>?v=<n>` link in the chat is a CARD (title,
//    v<n>, Open), in an agent message and under an artifact tool card, and its
//    Open travels the pane's own path: the host's artifact_open, then the
//    integrated browser.
// 2. The first version of a new artifact opens itself ONCE, in the chat that
//    published it, and never for a later version, another chat or a restore.
//
// The tool result text below is the engine's shape (packages/engine
// test/tool/artifact.test.ts asserts the same `Link:` line from the real tool).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import MessageRow from '../components/MessageRow.svelte';
import ToolCard from '../components/ToolCard.svelte';
import { findArtifactLinks, parseArtifactHref } from '../components/artifactLink';
import {
  ARTIFACTS_PANE_MESSAGE_TYPES, handleArtifactsPaneMessage, resetArtifactsSeen, type ArtifactsPaneHost,
} from '../../../src/dashboard/artifactsPane';
import { autoOpenArtifact, resetArtifactAutoOpen } from '../../../src/dashboard/artifactAutoOpen';
import { artifactsChangedFrom } from '../../../src/dashboard/artifactAcp';

const ID = 'art_4f1c09aa2b7e5d3c8e901234';
const posts = () =>
  globalThis.__vscodeApiMock.postMessage.mock.calls.map((c: unknown[]) => c[0]) as Array<Record<string, unknown>>;

beforeEach(() => globalThis.__vscodeApiMock.postMessage.mockClear());
afterEach(cleanup);

/** A host whose engine answers artifact_open with a url, and records what was
 *  asked and what the browser was told to open. */
function host() {
  const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  const opened: string[] = [];
  const h: ArtifactsPaneHost = {
    client: {
      extMethod: async (method, params) => {
        calls.push({ method, params });
        return { url: `http://127.0.0.1:4096/artifact/tok_v${String(params?.version)}/index.html` };
      },
    },
    post: () => {},
    openUrl: (url) => { opened.push(url); },
  };
  return { h, calls, opened };
}

describe('the link', () => {
  it('reads id, version and the Markdown label; one card per version', () => {
    const text = `Done: [Q3 report](origami://artifact/${ID}?v=2). Also origami://artifact/${ID}?v=2 and origami://artifact/${ID}?v=1`;
    expect(findArtifactLinks(text)).toEqual([
      { artifactId: ID, version: 2, title: 'Q3 report' },
      { artifactId: ID, version: 1 },
    ]);
  });

  it('refuses what is not a version link', () => {
    for (const bad of [
      `origami://artifact/${ID}`, `origami://artifact/${ID}?v=0`, `origami://artifact/${ID}?v=`,
      `origami://artifact/a b?v=1`, `https://artifact/${ID}?v=1`, `origami://artifact/${ID}?v=1x`,
    ]) {
      expect(parseArtifactHref(bad), bad).toBeUndefined();
    }
    expect(findArtifactLinks(`origami://artifact/${ID}?v=`)).toEqual([]);
  });
});

describe('the card in an agent message', () => {
  it('shows title, v<n> and Open; Open posts the pane\'s artifactOpen for that version', async () => {
    const { container } = render(MessageRow, {
      kind: 'agent', label: 'Coder', text: `Published it: [Q3 report](origami://artifact/${ID}?v=2)`,
    });
    const card = container.querySelector('.ac-card') as HTMLElement | null;
    expect(card, 'an artifact link must draw a card').not.toBeNull();
    expect(card!.querySelector('.ac-title')!.textContent).toBe('Q3 report');
    expect(card!.querySelector('.ac-ver')!.textContent).toBe('v2');
    // The origami:// address is never handed to a browser as an ordinary link.
    expect(container.querySelector('a[href^="origami:"]')).toBeNull();

    await fireEvent.click(card!.querySelector('button.ac-open')!);
    expect(posts()).toEqual([{ type: 'artifactOpen', artifactId: ID, version: 2 }]);
  });

  it('the inline link opens the same artifact', async () => {
    const { container } = render(MessageRow, {
      kind: 'agent', label: 'Coder', text: `See [the page](origami://artifact/${ID}?v=3).`,
    });
    const link = container.querySelector('a.artifact-link') as HTMLElement | null;
    expect(link).not.toBeNull();
    await fireEvent.click(link!);
    expect(posts()).toEqual([{ type: 'artifactOpen', artifactId: ID, version: 3 }]);
  });

  it('a user message quoting a link draws no card', () => {
    const { container } = render(MessageRow, {
      kind: 'user', label: 'You', text: `open origami://artifact/${ID}?v=1`,
    });
    expect(container.querySelector('.ac-card')).toBeNull();
  });
});

describe('the card under an artifact tool card', () => {
  const RESULT = [
    `Published "Q3 report" as artifact ${ID}, version 1.`,
    'Content token: tok_abc',
    'Files (1):',
    '- index.html (120 bytes, text/html)',
    '',
    `Link: [Q3 report](origami://artifact/${ID}?v=1)`,
  ].join('\n');

  it('a finished artifact_publish shows the card on the collapsed card, and Open posts artifactOpen', async () => {
    const { container } = render(ToolCard, {
      title: 'Published v1', kind: 'other', toolName: 'artifact_publish', status: 'completed', result: RESULT,
    });
    expect(container.querySelector('.tool-result'), 'the card starts collapsed').toBeNull();
    const card = container.querySelector('.ac-card') as HTMLElement | null;
    expect(card).not.toBeNull();
    expect(card!.querySelector('.ac-title')!.textContent).toBe('Q3 report');
    await fireEvent.click(card!.querySelector('button.ac-open')!);
    expect(posts()).toEqual([{ type: 'artifactOpen', artifactId: ID, version: 1 }]);
    // Open did not also fold the tool card open.
    expect(container.querySelector('.tool-result')).toBeNull();
  });

  it('another tool whose output happens to hold a link draws no card', () => {
    const { container } = render(ToolCard, {
      title: 'read notes.md', kind: 'read', toolName: 'read', status: 'completed', result: RESULT,
    });
    expect(container.querySelector('.ac-card')).toBeNull();
  });

  it('a publish still running draws no card yet', () => {
    const { container } = render(ToolCard, {
      title: 'artifact_publish', kind: 'other', toolName: 'artifact_publish', status: 'in_progress', result: RESULT,
    });
    expect(container.querySelector('.ac-card')).toBeNull();
  });
});

describe('Open from the card reaches the integrated browser the way the pane does', () => {
  beforeEach(() => resetArtifactsSeen());

  it('the host routes the card\'s message to artifact_open and opens the url it returns', async () => {
    const { h, calls, opened } = host();
    const message = { type: 'artifactOpen', artifactId: ID, version: 2 };
    expect(ARTIFACTS_PANE_MESSAGE_TYPES.has(message.type)).toBe(true);
    await handleArtifactsPaneMessage(h, message);
    expect(calls).toEqual([{ method: 'artifact_open', params: { artifactId: ID, version: 2 } }]);
    expect(opened).toEqual(['http://127.0.0.1:4096/artifact/tok_v2/index.html']);
  });
});

describe('auto-open of a new artifact', () => {
  beforeEach(() => { resetArtifactAutoOpen(); resetArtifactsSeen(); });
  const mine = (sid: string) => sid === 'ses_mine';
  const push = (p: Record<string, unknown>) => artifactsChangedFrom(p);

  it('v1 published by this chat opens once; the replayed push opens nothing', async () => {
    const { h, opened } = host();
    const wire = { artifactId: ID, version: 1, kind: 'published', sessionID: 'ses_mine' };
    expect(await autoOpenArtifact(h, push(wire), mine)).toBe(true);
    expect(await autoOpenArtifact(h, push(wire), mine)).toBe(false);
    expect(opened).toEqual(['http://127.0.0.1:4096/artifact/tok_v1/index.html']);
  });

  it('a later version, a restore, another chat or a push with no session opens nothing', async () => {
    const { h, opened, calls } = host();
    for (const wire of [
      { artifactId: ID, version: 2, kind: 'published', sessionID: 'ses_mine' },
      { artifactId: ID, version: 1, kind: 'restored', sessionID: 'ses_mine' },
      { artifactId: ID, version: 1, kind: 'published', sessionID: 'ses_other' },
      { artifactId: ID, version: 1, kind: 'published' },
    ]) {
      expect(await autoOpenArtifact(h, push(wire), mine), JSON.stringify(wire)).toBe(false);
    }
    expect(calls).toEqual([]);
    expect(opened).toEqual([]);
  });

  it('two new artifacts each open once', async () => {
    const { h, opened } = host();
    await autoOpenArtifact(h, push({ artifactId: 'art_a', version: 1, kind: 'published', sessionID: 'ses_mine' }), mine);
    await autoOpenArtifact(h, push({ artifactId: 'art_b', version: 1, kind: 'published', sessionID: 'ses_mine' }), mine);
    expect(opened).toHaveLength(2);
  });
});
