// globalConfig.ts — the extension's single answer to "where is the global
// origami config, and how do I read and write it".
//
// Everything here reproduces a defect from the connections adversarial review
// (2026-08-15) before it verifies the fix. The defects share one shape: the
// extension and the engine held different beliefs about the same file, and
// EVERY divergence was silent on both sides — the extension succeeded at
// writing, the engine succeeded at reading, and the user's setting simply had
// no effect. So these tests are written against the ENGINE's behaviour, not
// against this module's own assumptions, and two of them read the engine's
// source directly rather than trusting a comment.
//
// Real files on a real temp dir, deliberately: the atomicity and rotation
// properties are properties of the filesystem, and a mocked fs would assert
// that this module calls the functions it calls, which is not the requirement.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MAX_BACKUPS,
  backupConfig,
  globalConfigDir,
  globalConfigPath,
  hasJsonComments,
  parseJsonc,
  readConfigForWrite,
  readConfigObject,
  saveConfig,
  writeConfigAtomic,
} from '../../../src/dashboard/globalConfig';
import { globalAgentDir } from '../../../src/dashboard/agentManager/archetypes';

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const repoRoot = path.resolve(pkgRoot, '../..');

let tmp: string;
let savedXdg: string | undefined;

beforeEach(() => {
  savedXdg = process.env.XDG_CONFIG_HOME;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'origami-globalcfg-'));
});

afterEach(() => {
  if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = savedXdg;
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Finding 5 — the extension hardcoded ~/.config while the engine honours
// XDG_CONFIG_HOME (via xdg-basedir, packages/core/src/global.ts). A user with
// it set wrote a file the engine never reads: every Connections action a
// confident no-op, no error on either side, because both halves succeeded.
// ---------------------------------------------------------------------------
describe('globalConfigDir mirrors the engine config resolution', () => {
  it('uses XDG_CONFIG_HOME when set, else ~/.config, then /origami', () => {
    process.env.XDG_CONFIG_HOME = path.join('/custom', 'cfg');
    expect(globalConfigDir()).toBe(path.join('/custom', 'cfg', 'origami'));
    delete process.env.XDG_CONFIG_HOME;
    expect(globalConfigDir()).toBe(path.join(os.homedir(), '.config', 'origami'));
  });

  // The same expression already existed, correct, in agentManager/archetypes.ts
  // — 100 lines from the two hardcoded copies this module replaced. Calling
  // BOTH is the drift guard: if either resolution is edited alone, the agent
  // folder and the config file end up in different directories, and neither
  // one errors.
  it('lands in the same directory the archetype installer resolves', () => {
    process.env.XDG_CONFIG_HOME = path.join(tmp, 'xdg');
    expect(path.dirname(globalAgentDir())).toBe(globalConfigDir());
    delete process.env.XDG_CONFIG_HOME;
    expect(path.dirname(globalAgentDir())).toBe(globalConfigDir());
  });
});

// ---------------------------------------------------------------------------
// Finding 1 — the engine seeded origami.jsonc, which OUTRANKS origami.json in
// its own merge order, while all 7 extension writers only ever touch
// origami.json. An empty seed at the top of the merge shadowed every write the
// panel made, forever. The fix has two halves in two packages, so the guard
// reads the engine's source: a comment cannot keep them in step, and a
// re-flipped seed would be silent all over again.
// ---------------------------------------------------------------------------
describe('the extension and the engine agree on WHICH file is the global config', () => {
  it('the extension writes origami.json', () => {
    process.env.XDG_CONFIG_HOME = tmp;
    expect(globalConfigPath()).toBe(path.join(tmp, 'origami', 'origami.json'));
  });

  it('the engine seeds origami.json too, when no config file exists yet', () => {
    const engine = fs.readFileSync(
      path.join(repoRoot, 'packages/engine/src/config/config.ts'),
      'utf8',
    );
    const fn = /export function globalConfigFile\(\)\s*\{([\s\S]*?)\n\}/.exec(engine);
    expect(fn, 'globalConfigFile() not found in the engine source').toBeTruthy();
    // The fallback is the last `return` in the function — what it hands back
    // when none of the candidates exist, i.e. the file loadGlobal then seeds.
    const returns = [...fn![1].matchAll(/return ([^\n]+)/g)].map((m) => m[1]);
    const fallback = returns[returns.length - 1];
    expect(fallback, 'the engine must seed the file the extension writes').toContain('origami.json"');
    expect(fallback).not.toContain('origami.jsonc');
  });
});

// ---------------------------------------------------------------------------
// Finding 6 — the engine parses every config file, origami.json included, as
// JSONC. The extension used raw JSON.parse, so one `// note to self` blanked
// the whole provider grid and made all 7 writers claim the file was invalid.
// ---------------------------------------------------------------------------
describe('reading config text the way the engine reads it', () => {
  it('accepts line comments, block comments and trailing commas', () => {
    const text = `{
      // the second DGX box
      "model": "vllm/qwen",
      /* block
         comment */
      "provider": { "vllm": { "name": "Spark 2", } },
    }`;
    expect(parseJsonc(text)).toEqual({ model: 'vllm/qwen', provider: { vllm: { name: 'Spark 2' } } });
  });

  // The whole reason the scanner is string-aware. Every baseURL in a real
  // config contains `//`, so a naive comment strip would eat the second half
  // of every endpoint the user has configured.
  it('never mistakes a // inside a string for a comment', () => {
    const text = '{ "options": { "baseURL": "http://100.64.1.30:8000/v1" } }';
    expect(parseJsonc(text)).toEqual({ options: { baseURL: 'http://100.64.1.30:8000/v1' } });
    expect(hasJsonComments(text)).toBe(false);
  });

  it('handles an escaped quote before a // without losing the rest of the file', () => {
    const text = '{ "a": "say \\"hi\\" // not a comment", "b": 2 }';
    expect(parseJsonc(text)).toEqual({ a: 'say "hi" // not a comment', b: 2 });
    expect(hasJsonComments(text)).toBe(false);
  });

  it('reports comments when there really are some', () => {
    expect(hasJsonComments('{ "a": 1 } // trailing note')).toBe(true);
    expect(hasJsonComments('{ /* inline */ "a": 1 }')).toBe(true);
    expect(hasJsonComments('{ "a": 1 }')).toBe(false);
  });

  it('is still strict about genuinely malformed input', () => {
    expect(() => parseJsonc('{ "a": }')).toThrow();
  });

  it('readConfigObject returns null for an absent file, never an invented one', () => {
    expect(readConfigObject(path.join(tmp, 'nope.json'))).toBeNull();
  });
});

describe('reading config for a WRITE says what is actually wrong', () => {
  const file = () => path.join(tmp, 'origami.json');

  it('a commented file is refused as COMMENTED, not as invalid JSON', () => {
    fs.writeFileSync(file(), '{\n  // Spark 2 is the second DGX box\n  "model": "vllm/x"\n}', 'utf8');
    let message = '';
    try {
      readConfigForWrite(file());
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).toContain('comments');
    // The old message told the user to delete a file the engine reads happily.
    expect(message).not.toContain('not valid JSON');
  });

  it('a genuinely malformed file still says so', () => {
    fs.writeFileSync(file(), '{ not json', 'utf8');
    expect(() => readConfigForWrite(file())).toThrow(/not valid JSON/);
  });

  it('an absent file is null, so a writer can create one', () => {
    expect(readConfigForWrite(file())).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Finding 7 — all 7 writers used a plain truncating writeFileSync on the one
// file whose corruption takes the whole product down, while four OTHER
// extension writers already used tmp+rename.
// ---------------------------------------------------------------------------
describe('config writes are atomic', () => {
  it('leaves no temp file behind on success', () => {
    const file = path.join(tmp, 'origami.json');
    writeConfigAtomic(file, '{"model":"a/b"}\n');
    expect(fs.readFileSync(file, 'utf8')).toBe('{"model":"a/b"}\n');
    expect(fs.readdirSync(tmp).filter((f) => f.includes('.tmp-'))).toEqual([]);
  });

  // The property that matters, exercised rather than asserted about: the
  // destination is written ONLY by the rename. Occupying the temp path with a
  // directory makes the first step fail the way a crash would, and the
  // original must still be there afterwards. Under the old truncating write
  // there was no first step to fail — the file was already gone.
  it('a write that fails part-way leaves the previous config byte-identical', () => {
    const file = path.join(tmp, 'origami.json');
    const before = '{\n  "model": "vllm/keep-me"\n}\n';
    fs.writeFileSync(file, before, 'utf8');
    fs.mkdirSync(`${file}.tmp-${process.pid}`);
    expect(() => writeConfigAtomic(file, '{"model":"gone"}\n')).toThrow();
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });

  it('creates the config directory when it does not exist yet', () => {
    const file = path.join(tmp, 'fresh', 'origami', 'origami.json');
    writeConfigAtomic(file, '{}\n');
    expect(fs.existsSync(file)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Finding 8 — one .bak slot, overwritten by background probes. The owner's own
// machine carries nine HAND-NAMED backups beside it: they had already stopped
// trusting the mechanism and built their own history next to it.
// ---------------------------------------------------------------------------
describe('backups rotate instead of overwriting the one slot', () => {
  const file = () => path.join(tmp, 'origami.json');

  it('keeps the newest as .bak and ages the rest into .bak.1..4', () => {
    for (const n of ['v1', 'v2', 'v3']) backupConfig(file(), n);
    expect(fs.readFileSync(`${file()}.bak`, 'utf8')).toBe('v3');
    expect(fs.readFileSync(`${file()}.bak.1`, 'utf8')).toBe('v2');
    expect(fs.readFileSync(`${file()}.bak.2`, 'utf8')).toBe('v1');
  });

  it('never grows past MAX_BACKUPS files, so the oldest falls off the end', () => {
    for (let i = 1; i <= 9; i++) backupConfig(file(), `v${i}`);
    const backups = fs.readdirSync(tmp).filter((f) => f.includes('.bak'));
    expect(backups).toHaveLength(MAX_BACKUPS);
    expect(fs.readFileSync(`${file()}.bak`, 'utf8')).toBe('v9');
    expect(fs.readFileSync(`${file()}.bak.${MAX_BACKUPS - 1}`, 'utf8')).toBe(`v${9 - (MAX_BACKUPS - 1)}`);
    expect(fs.existsSync(`${file()}.bak.${MAX_BACKUPS}`)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Finding 2 (the validate-before-write half) — the engine discards a config
// file as a WHOLE when one nested field fails its schema, and swallows that
// into `{}` with a log line no UI reads. So persisting a bad field does not
// lose the field; it silently reverts the user to no configuration at all.
// ---------------------------------------------------------------------------
describe('a document the engine would reject is never persisted', () => {
  it('refuses the write and leaves the existing config untouched', () => {
    const file = path.join(tmp, 'origami.json');
    const before = '{\n  "model": "vllm/keep-me"\n}\n';
    fs.writeFileSync(file, before, 'utf8');
    // NaN is the live trigger: an unparseable OpenRouter price becomes NaN,
    // JSON.stringify writes it as null, and Schema.Finite rejects the file.
    const doc = { model: 'openrouter/x', provider: { openrouter: { models: { x: { cost: { input: Number.NaN, output: 1 } } } } } };
    expect(() => saveConfig(file, doc)).toThrow(/finite number/);
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });

  it('writes a valid document through', () => {
    const file = path.join(tmp, 'origami.json');
    saveConfig(file, { model: 'vllm/x', provider: { vllm: { models: { x: { limit: { context: 262144, output: 0 } } } } } });
    expect(readConfigObject(file)).toMatchObject({ model: 'vllm/x' });
  });
});
