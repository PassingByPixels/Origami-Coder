import { describe, expect, it } from 'vitest';
import { collabShortName } from './collabNames';

describe('collabShortName', () => {
  it('takes the text before " - " when the displayName is authored that way', () => {
    expect(collabShortName('collab-crane', "Crane - the collab's builder: reviews every diff")).toBe('Crane');
  });

  it('falls back to the slug (minus collab-, capitalised) when there is no separator', () => {
    expect(collabShortName('collab-heron', 'Heron')).toBe('Heron');
    expect(collabShortName('collab-heron', undefined)).toBe('Heron');
  });

  it('a slug with no collab- prefix is still capitalised', () => {
    expect(collabShortName('architect', 'architect')).toBe('Architect');
  });

  it('trims whitespace around the separated name', () => {
    expect(collabShortName('collab-crane', '  Crane   -   blurb')).toBe('Crane');
  });

  it('a separator at position 0 is not a name — falls back to the slug', () => {
    expect(collabShortName('collab-crane', ' - no name before this')).toBe('Crane');
  });

  it('an empty or missing displayName falls back to the slug', () => {
    expect(collabShortName('collab-falcon', '')).toBe('Falcon');
    expect(collabShortName('collab-falcon')).toBe('Falcon');
  });
});
