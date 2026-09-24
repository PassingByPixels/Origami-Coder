// changelogActivate.test.ts — maybeShowChangelog and previewWhatsNew
// (src/dashboard/changelogActivate.ts, t-obg1yz, t-v5r1fd), driven against a faked
// `vscode` module and a fake globalState-shaped marker, plus a REAL CHANGELOG.md and
// notes folder written to a temp dir (never the repo's own files). Proves the wiring:
// only a PUBLIC release opens the panel, once, with one summary of everything since
// the last public version the user saw; a dev build shows nothing; the preview command
// shows the pending release and records nothing.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const { fake } = vi.hoisted(() => ({
  fake: {
    panelsCreated: [] as Array<{ title: string; html: string }>,
    infoMessages: [] as string[],
  },
}));

vi.mock('vscode', () => ({
  window: {
    createWebviewPanel: (_id: string, title: string) => {
      const panel = {
        webview: {
          html: '',
          cspSource: 'vscode-resource:',
          asWebviewUri: (u: unknown) => ({ toString: () => `webview://${String(u)}` }),
          onDidReceiveMessage: () => {},
        },
        onDidDispose: () => {},
        reveal: () => {},
        dispose: () => {},
      };
      Object.defineProperty(panel.webview, 'html', {
        get() { return this._html ?? ''; },
        set(v: string) { this._html = v; fake.panelsCreated.push({ title, html: v }); },
      });
      return panel;
    },
    showInformationMessage: (m: string) => { fake.infoMessages.push(m); },
  },
  Uri: {
    joinPath: (...parts: unknown[]) => parts.map(String).join('/'),
    file: (p: string) => `file://${p}`,
  },
  ViewColumn: { Active: -1 },
}));

import type {
  maybeShowChangelog as MaybeShowChangelog,
  previewWhatsNew as PreviewWhatsNew,
  ChangelogMarker,
} from '../../../src/dashboard/changelogActivate';

// changelogPanel.ts tracks its one open panel in MODULE-LEVEL state (by design: a
// second activation while the popup is still open should reveal it, not stack a
// duplicate — see its header). That state only ever resets in production when VS
// Code disposes the panel. The fake webview panel above never fires that callback,
// so each test needs its OWN fresh module instance, not the real dispose lifecycle.
let maybeShowChangelog: typeof MaybeShowChangelog;
let previewWhatsNew: typeof PreviewWhatsNew;
beforeEach(async () => {
  vi.resetModules();
  ({ maybeShowChangelog, previewWhatsNew } = await import('../../../src/dashboard/changelogActivate'));
});

function makeFakeMarker(initial?: string): ChangelogMarker & { seen: (string | undefined)[] } {
  let value = initial;
  const seen: (string | undefined)[] = [];
  return {
    get: () => value,
    set: (v: string) => { value = v; seen.push(v); },
    seen,
  };
}

function makeContext(version: string, changelogPath: string) {
  return {
    extensionPath: path.dirname(changelogPath),
    extensionUri: 'file:///ext',
    extension: { packageJSON: { version } },
  } as unknown as { extensionPath: string; extensionUri: string; extension: { packageJSON: { version: string } } };
}

describe('maybeShowChangelog', () => {
  let dir: string;
  let changelogPath: string;
  let notesDir: string;
  const publicReleases = ['0.4.150', '0.4.151'];

  beforeEach(() => {
    fake.panelsCreated = [];
    fake.infoMessages = [];
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'origami-changelog-'));
    changelogPath = path.join(dir, 'CHANGELOG.md');
    notesDir = path.join(dir, 'whats-new'); // absent unless a test writes a note
    fs.writeFileSync(changelogPath, '## 0.4.151\n\n- New popup feature.\n\n## 0.4.150\n\n- Older.\n', 'utf8');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a fresh install (no prior seen version) on a public release shows the panel once and records the marker', () => {
    const marker = makeFakeMarker(undefined);
    const ctx = makeContext('0.4.151', changelogPath);
    maybeShowChangelog(ctx as never, { marker, changelogPath, notesDir, publicReleases });
    expect(fake.panelsCreated).toHaveLength(1);
    expect(fake.panelsCreated[0].html).toContain('New popup feature.');
    expect(fake.panelsCreated[0].html).not.toContain('Older.'); // a new user gets this release only
    expect(marker.seen).toEqual(['0.4.151']);
  });

  it('renders plain themed markdown: h2 title, no custom pill wrapper class', () => {
    const marker = makeFakeMarker(undefined);
    fs.writeFileSync(
      changelogPath,
      '## 0.4.151\n\n### A group\n\n- An item with `a code span`.\n',
      'utf8',
    );
    const ctx = makeContext('0.4.151', changelogPath);
    maybeShowChangelog(ctx as never, { marker, changelogPath, notesDir, publicReleases });
    const html = fake.panelsCreated[0].html;
    expect(html).toContain('<h2>');
    expect(html).toContain('<h3>A group</h3>');
    expect(html).not.toMatch(/class="changelog-pill/);
    expect(html).toMatch(/<article class="changelog-body">/); // plain article, not a boxed div
    // The shared theme pins html/body to the viewport with overflow hidden; this
    // page must override it or the section is cut off (owner, 0.4.154).
    expect(html).toMatch(/html, body \{[^}]*overflow-y: auto/);
    expect(html).toContain('<code>a code span</code>');
  });

  it('an update to a NEW public version shows the panel again', () => {
    const marker = makeFakeMarker('0.4.150');
    const ctx = makeContext('0.4.151', changelogPath);
    maybeShowChangelog(ctx as never, { marker, changelogPath, notesDir, publicReleases });
    expect(fake.panelsCreated).toHaveLength(1);
    expect(marker.seen).toEqual(['0.4.151']);
  });

  it('a reload on the SAME version shows nothing — the popup is once per version', () => {
    const marker = makeFakeMarker('0.4.151');
    const ctx = makeContext('0.4.151', changelogPath);
    maybeShowChangelog(ctx as never, { marker, changelogPath, notesDir, publicReleases });
    expect(fake.panelsCreated).toHaveLength(0);
    expect(marker.seen).toEqual([]); // unchanged — never rewritten for a version already seen
  });

  it('the marker persists across repeated activations on the same version (simulated reloads)', () => {
    const marker = makeFakeMarker(undefined);
    const ctx = makeContext('0.4.151', changelogPath);
    maybeShowChangelog(ctx as never, { marker, changelogPath, notesDir, publicReleases }); // first activation: shows
    maybeShowChangelog(ctx as never, { marker, changelogPath, notesDir, publicReleases }); // reload
    maybeShowChangelog(ctx as never, { marker, changelogPath, notesDir, publicReleases }); // another reload
    expect(fake.panelsCreated).toHaveLength(1);
    expect(marker.seen).toEqual(['0.4.151']);
  });

  it('a missing CHANGELOG.md records the marker but shows no panel, and never throws', () => {
    const marker = makeFakeMarker(undefined);
    const missing = path.join(dir, 'does-not-exist.md');
    const ctx = makeContext('0.4.151', missing);
    expect(() => maybeShowChangelog(ctx as never, { marker, changelogPath: missing, notesDir, publicReleases })).not.toThrow();
    expect(fake.panelsCreated).toHaveLength(0);
    expect(marker.seen).toEqual(['0.4.151']);
  });

  // ---- t-v5r1fd: public-release gating and one summary since the last public version ----

  it('a dev build (version not marked public) shows nothing and leaves the marker alone', () => {
    fs.writeFileSync(changelogPath, '## 0.4.173\n\n- Dev work.\n\n## 0.4.155\n\n- Public.\n', 'utf8');
    const marker = makeFakeMarker('0.4.155');
    const ctx = makeContext('0.4.173', changelogPath);
    maybeShowChangelog(ctx as never, { marker, changelogPath, notesDir, publicReleases: ['0.4.155'] });
    expect(fake.panelsCreated).toHaveLength(0);
    // Untouched, so the user still gets everything since 0.4.155 when the next public release lands.
    expect(marker.seen).toEqual([]);
  });

  it('a public release shows ONE summary of every version since the last public one the user saw', () => {
    fs.writeFileSync(
      changelogPath,
      [
        '## 0.4.157', '', '### Nests', '', '- Nest item from 157.', '',
        '## 0.4.156', '', '### Nests', '', '- Nest item from 156.', '', '### Chat', '', '- Chat item from 156.', '',
        '## 0.4.155', '', '- Already seen in 155.', '',
      ].join('\n'),
      'utf8',
    );
    const marker = makeFakeMarker('0.4.155');
    const ctx = makeContext('0.4.157', changelogPath);
    maybeShowChangelog(ctx as never, { marker, changelogPath, notesDir, publicReleases: ['0.4.155', '0.4.157'] });
    expect(fake.panelsCreated).toHaveLength(1);
    const html = fake.panelsCreated[0].html;
    expect(html).toContain('Nest item from 157.');
    expect(html).toContain('Nest item from 156.'); // the dev build in between is included
    expect(html).toContain('Chat item from 156.');
    expect(html).not.toContain('Already seen in 155.');
    expect(html.match(/<h3>Nests<\/h3>/g)).toHaveLength(1); // one group, not a stack of sections
    expect(html).not.toMatch(/<h2>0\.4\.156<\/h2>/);
    expect(marker.seen).toEqual(['0.4.157']);
  });

  it('a curated note for the release is shown instead of the raw changelog sections', () => {
    fs.mkdirSync(notesDir);
    fs.writeFileSync(path.join(notesDir, '0.4.151.md'), '## What is new since 0.4.150\n\nCurated summary text.\n', 'utf8');
    const marker = makeFakeMarker('0.4.150');
    const ctx = makeContext('0.4.151', changelogPath);
    maybeShowChangelog(ctx as never, { marker, changelogPath, notesDir, publicReleases });
    const html = fake.panelsCreated[0].html;
    expect(html).toContain('Curated summary text.');
    expect(html).not.toContain('New popup feature.');
  });

  it('a rollback to an OLDER public release shows nothing', () => {
    const marker = makeFakeMarker('0.4.151');
    const ctx = makeContext('0.4.150', changelogPath);
    maybeShowChangelog(ctx as never, { marker, changelogPath, notesDir, publicReleases });
    expect(fake.panelsCreated).toHaveLength(0);
    expect(marker.seen).toEqual([]);
  });

  it('a screenshot slot with no image is left out of the real pop-up', () => {
    fs.mkdirSync(notesDir);
    fs.writeFileSync(path.join(notesDir, '0.4.151.md'), '## New\n\nText.\n\n{{shot:missing-shot|What the shot shows}}\n', 'utf8');
    const ctx = makeContext('0.4.151', changelogPath);
    maybeShowChangelog(ctx as never, { marker: makeFakeMarker('0.4.150'), changelogPath, notesDir, publicReleases });
    const html = fake.panelsCreated[0].html;
    expect(html).not.toContain('missing-shot');
    expect(html).not.toContain('{{shot:');
  });
});

describe('previewWhatsNew (the owner command)', () => {
  let dir: string;
  let changelogPath: string;
  let notesDir: string;

  beforeEach(() => {
    fake.panelsCreated = [];
    fake.infoMessages = [];
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'origami-changelog-'));
    changelogPath = path.join(dir, 'CHANGELOG.md');
    notesDir = path.join(dir, 'whats-new');
    fs.writeFileSync(
      changelogPath,
      '## 0.4.174\n\n### Chat\n\n- Pending 174.\n\n## 0.4.160\n\n### Chat\n\n- Dev 160.\n\n## 0.4.155\n\n- Public 155.\n',
      'utf8',
    );
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('on a dev build shows what users will get since the last public release, and records nothing', () => {
    const marker = makeFakeMarker('0.4.160');
    const ctx = makeContext('0.4.174', changelogPath);
    previewWhatsNew(ctx as never, { marker, changelogPath, notesDir, publicReleases: ['0.4.155'] });
    expect(fake.panelsCreated).toHaveLength(1);
    const html = fake.panelsCreated[0].html;
    expect(html).toContain('Pending 174.');
    expect(html).toContain('Dev 160.'); // counted from 0.4.155, not from this box's own marker
    expect(html).not.toContain('Public 155.');
    expect(marker.seen).toEqual([]);
  });

  it('shows a marked placeholder for a screenshot the owner has not added yet', () => {
    fs.mkdirSync(notesDir);
    fs.writeFileSync(path.join(notesDir, '0.4.174.md'), '## New\n\n{{shot:nest-tab|The Nest tab}}\n', 'utf8');
    const ctx = makeContext('0.4.174', changelogPath);
    previewWhatsNew(ctx as never, { marker: makeFakeMarker(), changelogPath, notesDir, publicReleases: ['0.4.155'] });
    const html = fake.panelsCreated[0].html;
    expect(html).toContain('wn-shot-missing');
    expect(html).toContain('shots/nest-tab.png');
    expect(html).toContain('The Nest tab');
  });

  it('says so, and opens nothing, when there is no text for the version', () => {
    fs.writeFileSync(changelogPath, '## 0.4.155\n\n- Public 155.\n', 'utf8');
    const ctx = makeContext('0.4.174', changelogPath);
    previewWhatsNew(ctx as never, { marker: makeFakeMarker(), changelogPath, notesDir, publicReleases: ['0.4.155'] });
    expect(fake.panelsCreated).toHaveLength(0);
    expect(fake.infoMessages.join(' ')).toMatch(/0\.4\.174/);
  });
});
