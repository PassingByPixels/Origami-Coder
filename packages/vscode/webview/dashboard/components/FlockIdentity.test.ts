// FlockIdentity — the owner's own mark is the one THEY picked, and the handle
// under it does not follow their name.
//
// Two claims, and both are about a thing that used to be fixed and is not any
// more. The avatar was the crane, unconditionally; it is now whichever sigil
// the owner chose, because every contact sees it and a tile that drew the
// default whatever was stored would leave a person unable to tell whether their
// pick had saved. And the second line was `name@`, composed from the display
// name; the handle was minted once and never moves, so composing it from an
// editable field would show a string nobody stored.
//
// The pane-level test (flockPane.test.ts) drives Save and the picker. This file
// pins the two things the tile alone decides.

import { describe, expect, it, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import FlockIdentity from './FlockIdentity.svelte';
import type { FlockIdentityRow } from '../panes/flockTypes';

afterEach(() => cleanup());

const IDENTITY: FlockIdentityRow = {
  handle: 'jane@QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU2Nzg5',
  handleShort: 'jane@QUJDREVG',
  name: 'jane',
  fingerprint: 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU2Nzg5',
  signPublicKey: 'sign-pub',
  boxPublicKey: 'box-pub',
};

const mount = (identity: FlockIdentityRow) =>
  render(FlockIdentity, { props: { identity, oncopy: () => {}, onidentity: () => {} } });

describe('FlockIdentity — the avatar is the owner’s own sigil', () => {
  it('draws the icon the engine sent, and carries no initials text', () => {
    const { container } = mount({ ...IDENTITY, icon: 'wolf' });
    const avatar = container.querySelector('.fk-avatar.big')!;

    // A drawn glyph in the shared 64-unit viewBox, not a two-letter hash.
    const svg = avatar.querySelector('svg[viewBox="0 0 64 64"]');
    expect(svg).not.toBeNull();
    expect(svg!.getAttribute('aria-hidden')).toBe('true');
    expect(avatar.textContent).toBe('');

    // The picked option in the row below is the SAME id, so the tile cannot
    // show one mark and have another selected.
    const checked = Array.from(container.querySelectorAll('[role="radio"]')).filter(
      (b) => b.getAttribute('aria-checked') === 'true',
    );
    expect(checked.map((b) => b.getAttribute('aria-label'))).toEqual(['wolf']);
  });

  it('falls back to the brand mark when the engine sent no icon at all', () => {
    // Not hypothetical: the extension and the engine ship separately, so a row
    // with no icon is every row an engine built before the field.
    const { container } = mount(IDENTITY);
    expect(container.querySelector('.fk-avatar.big svg')).not.toBeNull();
    const checked = Array.from(container.querySelectorAll('[role="radio"]')).filter(
      (b) => b.getAttribute('aria-checked') === 'true',
    );
    expect(checked.map((b) => b.getAttribute('aria-label'))).toEqual(['crane']);
  });

  it('shows the HANDLE’s own label, not the display name plus an @', () => {
    // A renamed owner: the name moved, the handle did not. Composing `name@`
    // here would print "Jane Doe@", which no contact ever stored.
    const { container } = mount({ ...IDENTITY, name: 'Jane Doe' });

    expect((container.querySelector('input[aria-label="Your display name"]') as HTMLInputElement).value).toBe(
      'Jane Doe',
    );
    expect(container.querySelector('.fk-mono')!.textContent!.trim()).toBe('jane@QUJDREVG…');
    expect(container.querySelector('.fk-fp')!.textContent).toBe(IDENTITY.fingerprint);
  });
});
