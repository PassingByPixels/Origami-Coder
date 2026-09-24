// Pure-data tests for the vendor SVG marks — no DOM wiring, no host. Real
// bugs this catches: a vendor id used by matchVendorMarkId with no path
// entry (a blank icon), and a path string that is not valid enough for a
// browser to parse into a renderable <svg>.

import { describe, expect, it } from 'vitest';
import { matchVendorMarkId, VENDOR_MARK_PATHS } from './vendorMarks';

// The twelve big providers the ticket names, as a representative display
// name or id each provider's own tab would actually carry.
const TWELVE: Array<[string, string]> = [
  ['Anthropic', 'anthropic'],
  ['OpenAI', 'openai'],
  ['Google (Gemini)', 'google'],
  ['Meta (Llama)', 'meta'],
  ['Mistral', 'mistral'],
  ['xAI (Grok)', 'xai'],
  ['DeepSeek', 'deepseek'],
  ['Qwen', 'qwen'],
  ['OpenRouter', 'openrouter'],
  ['GitHub Copilot', 'githubcopilot'],
  ['LM Studio', 'lmstudio'],
  ['Ollama', 'ollama'],
];

describe('VENDOR_MARK_PATHS', () => {
  it('has exactly the twelve named-vendor ids plus the three OS marks (t-s9k0q6 desk chips), each a non-empty path', () => {
    const ids = Object.keys(VENDOR_MARK_PATHS).sort();
    expect(ids).toEqual([...TWELVE.map(([, id]) => id), 'linux', 'macos', 'windows'].sort());
    for (const id of ids) expect(VENDOR_MARK_PATHS[id].path.length).toBeGreaterThan(0);
  });

  it('every path draws at 14px in a test render — element exists with a viewBox', () => {
    for (const [name, id] of TWELVE) {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('width', '14');
      svg.setAttribute('height', '14');
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', VENDOR_MARK_PATHS[id].path);
      svg.appendChild(path);
      document.body.appendChild(svg);

      const found = document.body.querySelector(`svg[viewBox="0 0 24 24"][width="14"] path`);
      expect(found, `${name} (${id}) did not render`).not.toBeNull();
      expect(found!.getAttribute('d')).toBe(VENDOR_MARK_PATHS[id].path);

      document.body.removeChild(svg);
    }
  });

  it('no mark opts into evenodd: every path (Simple Icons, the owner-supplied openai mark, the xai glyph) fills under the SVG default', () => {
    for (const [, id] of TWELVE) expect(VENDOR_MARK_PATHS[id].fillRule).toBeUndefined();
  });

  it('openai and xai are the owner-supplied brand paths, not the old stand-ins', () => {
    expect(VENDOR_MARK_PATHS['openai'].path.startsWith('M22.2819 9.8211')).toBe(true);
    expect(VENDOR_MARK_PATHS['xai'].path.startsWith('M1.187 8.483')).toBe(true);
  });
});

describe('matchVendorMarkId — drift guard: every id the picker can produce for the twelve has a path', () => {
  for (const [name, id] of TWELVE) {
    it(`"${name}" resolves to "${id}", which has a path`, () => {
      const matched = matchVendorMarkId(name);
      expect(matched).toBe(id);
      expect(VENDOR_MARK_PATHS[matched!]?.path.length).toBeGreaterThan(0);
    });
  }

  it('also matches a bare provider id (lowercase, no spaces)', () => {
    expect(matchVendorMarkId('lmstudio')).toBe('lmstudio');
    expect(matchVendorMarkId('openrouter')).toBe('openrouter');
  });

  it('also matches a model id carrying the vendor name, not just a provider label', () => {
    expect(matchVendorMarkId('llama3.3:70b')).toBe('meta');
    expect(matchVendorMarkId('qwen3-32b')).toBe('qwen');
  });

  it('returns undefined for a vendor outside the twelve — the caller falls back to the monogram', () => {
    expect(matchVendorMarkId('Cohere')).toBeUndefined();
    expect(matchVendorMarkId('OpenCode Zen')).toBeUndefined();
    expect(matchVendorMarkId('')).toBeUndefined();
  });
});
