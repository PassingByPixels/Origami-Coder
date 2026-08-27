// Agent Manager - archetypes.ts (S9/S11/S12) unit tests: the Folds archetype installer.
// A real temp dir stands in for the global agent dir (NEVER the user's ~/.config),
// with a mutable fake marker, so we can assert the write-if-missing + prior-versions
// upgrade contract on disk. Plus content sanity on the five shipped agent-definition
// files (architect/ask/debug/orchestrator + the S12 read-only scout subagent).

import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ensureArchetypes, globalAgentDir, ARCHETYPES, ARCHETYPES_V1, ARCHETYPES_V2 } from '../../../src/dashboard/agentManager/archetypes';

const tmp: string[] = [];
function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'archetypes-'));
  tmp.push(d);
  return d;
}
/** A marker whose `installed` bit is observable, matching the panel's globalState
 *  semantics: get() reports it, set() flips it to true (once). */
function fakeMarker(initial = false) {
  const state = { installed: initial, setCalls: 0 };
  return {
    marker: { get: () => state.installed, set: () => { state.installed = true; state.setCalls += 1; } },
    state,
  };
}
const BUILT_IN_IDS = ['build', 'plan', 'general', 'explore', 'compaction', 'title', 'summary'];

afterAll(() => { for (const d of tmp) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* temp */ } } });

describe('ensureArchetypes', () => {
  it('writes every archetype file when none exist, then records the install', () => {
    const dir = tmpDir();
    const { marker, state } = fakeMarker(false);
    ensureArchetypes({ marker, dir, log: () => {} });
    for (const a of ARCHETYPES) {
      const dest = path.join(dir, a.file);
      expect(fs.existsSync(dest)).toBe(true);
      expect(fs.readFileSync(dest, 'utf8')).toBe(a.content);
    }
    expect(state.installed).toBe(true);   // marker set after a successful pass
    expect(state.setCalls).toBe(1);
  });

  it('never overwrites an existing archetype - user edits win', () => {
    const dir = tmpDir();
    const edited = path.join(dir, 'architect.md');
    fs.writeFileSync(edited, 'MY OWN ARCHITECT PROMPT', 'utf8');
    const { marker } = fakeMarker(false);
    ensureArchetypes({ marker, dir, log: () => {} });
    // The pre-existing file is untouched; the other three are freshly written.
    expect(fs.readFileSync(edited, 'utf8')).toBe('MY OWN ARCHITECT PROMPT');
    for (const a of ARCHETYPES.filter((x) => x.file !== 'architect.md')) {
      expect(fs.existsSync(path.join(dir, a.file))).toBe(true);
    }
  });

  it('with the marker already set, writes nothing at all (a fresh dir stays empty)', () => {
    const dir = tmpDir();
    const { marker, state } = fakeMarker(true);
    ensureArchetypes({ marker, dir, log: () => {} });
    expect(fs.readdirSync(dir)).toEqual([]);
    expect(state.setCalls).toBe(0);       // no second set on a short-circuit
  });

  it('does not resurrect an archetype the user deleted after the marker was recorded', () => {
    const dir = tmpDir();
    const { marker } = fakeMarker(false);
    ensureArchetypes({ marker, dir, log: () => {} });          // first install sets the marker
    fs.rmSync(path.join(dir, 'ask.md'));                        // user deliberately removes one
    ensureArchetypes({ marker, dir, log: () => {} });          // next board boot
    expect(fs.existsSync(path.join(dir, 'ask.md'))).toBe(false); // stays gone (marker guards it)
  });

  it('is non-fatal: a write failure is logged, never thrown, and the marker is not set', () => {
    const { marker, state } = fakeMarker(false);
    const logged: string[] = [];
    // Point at a path that cannot be a directory (a regular file occupies it) so
    // mkdir/writeFile throws inside ensureArchetypes.
    const clash = path.join(tmpDir(), 'afile');
    fs.writeFileSync(clash, 'x', 'utf8');
    const dir = path.join(clash, 'agent'); // parent is a file -> mkdir throws
    expect(() => ensureArchetypes({ marker, dir, log: (m) => logged.push(m) })).not.toThrow();
    expect(logged.length).toBe(1);
    expect(state.installed).toBe(false);  // a failed pass leaves it retryable
  });
});

describe('globalAgentDir mirrors the engine config resolution', () => {
  it('uses XDG_CONFIG_HOME when set, else ~/.config, then /origami/agent', () => {
    const saved = process.env.XDG_CONFIG_HOME;
    try {
      process.env.XDG_CONFIG_HOME = path.join('/custom', 'cfg');
      expect(globalAgentDir()).toBe(path.join('/custom', 'cfg', 'origami', 'agent'));
      delete process.env.XDG_CONFIG_HOME;
      expect(globalAgentDir()).toBe(path.join(os.homedir(), '.config', 'origami', 'agent'));
    } finally {
      if (saved === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = saved;
    }
  });
});

describe('archetype content sanity', () => {
  const ids = ARCHETYPES.map((a) => a.file.replace(/\.md$/, ''));
  const byFile = (f: string) => ARCHETYPES.find((a) => a.file === f)!;

  it('ships exactly architect/ask/cartographer/debug/orchestrator/scout, none colliding with a built-in agent id', () => {
    expect([...ids].sort()).toEqual(['architect', 'ask', 'cartographer', 'debug', 'orchestrator', 'scout']);
    expect(ids.filter((id) => BUILT_IN_IDS.includes(id))).toEqual([]);
  });

  it('every archetype has a frontmatter description; the four picker archetypes are mode: all, scout is mode: subagent', () => {
    for (const a of ARCHETYPES) {
      const front = a.content.split('---')[1] ?? '';         // between the first pair of --- fences
      expect(front).toMatch(/^description:\s*"/m);
      expect(a.content.trimStart().startsWith('---')).toBe(true); // frontmatter leads the file
      // scout is a subagent (off the picker, a task target); the rest ride the roster.
      expect(front).toMatch(a.file === 'scout.md' ? /^mode:\s*subagent\s*$/m : /^mode:\s*all\s*$/m);
    }
  });

  it('scout is a read-only subagent: mode: subagent, "*": deny, bash: deny, and NO task grant (it cannot re-delegate)', () => {
    // The S12 laundering fix. scout is the ONLY delegate ask/architect can reach,
    // so it must itself be unable to run commands, edit, or delegate onward — else
    // the same launder-a-write-through-a-subagent hole reopens one level down.
    const c = byFile('scout.md').content;
    expect(c).toMatch(/^mode:\s*subagent\s*$/m);
    expect(c).toMatch(/\n\s*"\*":\s*deny/);   // deny-by-default
    expect(c).toMatch(/\n\s*bash:\s*deny/);   // no shell
    expect(c).toMatch(/\n\s*read:\s*allow/);  // recon keeps the read tools
    expect(c).not.toMatch(/\n\s*task:/);      // no task key at all -> engine adds task: deny
  });

  it('ask + architect are deny-by-default read-only: "*": deny AND bash: deny', () => {
    // Prompt-level "read-only" is permission-enforced. "*": deny flips the engine's
    // permissive base default; bash: deny closes the shell escape vector.
    for (const f of ['ask.md', 'architect.md']) {
      const c = byFile(f).content;
      expect(c).toMatch(/\n\s*"\*":\s*deny/);   // deny-by-default
      expect(c).toMatch(/\n\s*bash:\s*deny/);   // the escape-vector fix
    }
  });

  it('ask + architect delegate ONLY to scout — explore is denied (the S12 laundering fix)', () => {
    // The hole: a child subagent runs under ITS OWN ruleset, and built-in explore
    // has bash: allow, so an Ask run could launder a write/command through explore.
    // The task allowlist now permits scout and denies everything else, so explore
    // is unreachable and the sole delegate is the read-only scout.
    for (const f of ['ask.md', 'architect.md']) {
      const c = byFile(f).content;
      expect(c).toMatch(/task:\s*\n\s*"\*":\s*deny\s*\n\s*scout:\s*allow/); // deny-all, allow scout
      expect(c).not.toMatch(/explore:\s*allow/);                            // explore no longer granted
    }
  });

  it('architect edit is an md-only OBJECT allowlist (deny all, allow *.md and **/*.md)', () => {
    const c = byFile('architect.md').content;
    expect(c).toMatch(/edit:\s*\n\s*"\*":\s*deny\s*\n\s*"\*\.md":\s*allow\s*\n\s*"\*\*\/\*\.md":\s*allow/);
  });

  it('cartographer (S15) is deny-by-default, bash-denied, delegates ONLY to scout, and can edit ONLY the map dir', () => {
    // The cartographer reads the whole repo but writes exactly one artifact tree.
    // Its safety is permission-enforced, not prose: "*": deny flips the base default;
    // bash: deny closes the shell; the task allowlist confines delegation to the
    // read-only scout (never explore); the edit allowlist permits ONLY .origami/map/*
    // and .origami/map/** so it can write the map and nothing else on disk.
    const c = byFile('cartographer.md').content;
    expect(c).toMatch(/^mode:\s*all\s*$/m);
    expect(c).toMatch(/\n\s*"\*":\s*deny/);   // deny-by-default
    expect(c).toMatch(/\n\s*bash:\s*deny/);   // no shell (the tooling stamps builtAt via git, not the agent)
    expect(c).toMatch(/\n\s*read:\s*allow/);  // broad reading kept
    expect(c).toMatch(/task:\s*\n\s*"\*":\s*deny\s*\n\s*scout:\s*allow/); // scout-only delegation
    expect(c).not.toMatch(/explore:\s*allow/);
    expect(c).toMatch(/edit:\s*\n\s*"\*":\s*deny\s*\n\s*"\.origami\/map\/\*":\s*allow\s*\n\s*"\.origami\/map\/\*\*":\s*allow/);
  });

  it('cartographer embeds the map schema + a worked example + the leave-builtAt-out rule', () => {
    const c = byFile('cartographer.md').content;
    expect(c).toContain('.origami/map/map.json'); // names the single file it writes
    expect(c).toMatch(/"pillar"/);               // the schema is embedded (v2 pillar-based)
    expect(c).toMatch(/in shape:/);               // a primed worked example
    expect(c).toMatch(/builtAt/);                 // explicitly tells it to leave builtAt out
  });

  it('orchestrator denies edit AND bash (it delegates; no self-owned source mutation)', () => {
    // edit + bash are the only two permission keys guarding file writes (write/
    // edit/apply_patch all request "edit"; shell requests "bash"). Denying both
    // closes the escape vector: a prompt that claims "I don't edit" is now
    // permission-enforced, not just prose. bash: allow would reopen it.
    const c = byFile('orchestrator.md').content;
    expect(c).toMatch(/permission:\s*\n\s*edit:\s*deny/);
    expect(c).toMatch(/\n\s*bash:\s*deny/);
  });

  it('debug keeps NO permission block (its discipline stays prompt-level)', () => {
    expect(byFile('debug.md').content).not.toMatch(/permission:/);
  });

  it('architect/debug/orchestrator each carry one primed worked example', () => {
    for (const f of ['architect.md', 'debug.md', 'orchestrator.md']) {
      expect(byFile(f).content).toMatch(/in shape:/);
    }
  });
});

describe('ensureArchetypes upgrade to v3 (prior-versions model)', () => {
  const cur = (f: string) => ARCHETYPES.find((a) => a.file === f)!.content;

  it('overwrites a byte-identical v1 file with v3 (a pristine S9 install is upgraded)', () => {
    const dir = tmpDir();
    for (const a of ARCHETYPES_V1) fs.writeFileSync(path.join(dir, a.file), a.content, 'utf8');
    const { marker } = fakeMarker(false); // the v3 marker is unset
    ensureArchetypes({ marker, dir, log: () => {} });
    for (const a of ARCHETYPES) {
      expect(fs.readFileSync(path.join(dir, a.file), 'utf8')).toBe(a.content); // now v3
    }
  });

  it('overwrites a byte-identical v2 file with v3 (a pristine S11 install is upgraded)', () => {
    const dir = tmpDir();
    for (const a of ARCHETYPES_V2) fs.writeFileSync(path.join(dir, a.file), a.content, 'utf8');
    const { marker } = fakeMarker(false);
    ensureArchetypes({ marker, dir, log: () => {} });
    // architect + ask were reworded at v3 (explore -> scout), so a pristine v2 of
    // each is upgraded; debug/orchestrator re-ship byte-identical, still correct.
    expect(fs.readFileSync(path.join(dir, 'architect.md'), 'utf8')).toBe(cur('architect.md'));
    expect(fs.readFileSync(path.join(dir, 'ask.md'), 'utf8')).toBe(cur('ask.md'));
    expect(fs.readFileSync(path.join(dir, 'debug.md'), 'utf8')).toBe(cur('debug.md'));
  });

  it('writes the NEW scout.md when upgrading an older install that never had it', () => {
    const dir = tmpDir();
    for (const a of ARCHETYPES_V2) fs.writeFileSync(path.join(dir, a.file), a.content, 'utf8'); // v2 had no scout
    expect(fs.existsSync(path.join(dir, 'scout.md'))).toBe(false);
    ensureArchetypes({ marker: fakeMarker(false).marker, dir, log: () => {} });
    expect(fs.readFileSync(path.join(dir, 'scout.md'), 'utf8')).toBe(cur('scout.md')); // write-if-missing
  });

  it('reconciles a FOREIGN scout.md (an unrelated same-named agent) to the shipped read-only scout, and logs it', () => {
    // The S12 hole one level down: ask/architect grant `task: scout` by NAME, and
    // the engine resolves that name with no identity check. A bash-capable agent
    // parked at scout.md would silently reopen the laundering vector. scout is
    // engine-managed, so a non-shipped file there must be overwritten (not left,
    // which write-if-missing would have done) - and the overwrite must be signalled.
    const dir = tmpDir();
    const foreign = '---\nmode: subagent\npermission:\n  bash: allow\n  edit: allow\n---\nI can run commands and edit.\n';
    fs.writeFileSync(path.join(dir, 'scout.md'), foreign, 'utf8');
    const logged: string[] = [];
    ensureArchetypes({ marker: fakeMarker(false).marker, dir, log: (m) => logged.push(m) });
    expect(fs.readFileSync(path.join(dir, 'scout.md'), 'utf8')).toBe(cur('scout.md')); // reconciled to ours
    expect(cur('scout.md')).toMatch(/\n\s*bash:\s*deny/);                              // and that IS read-only
    expect(logged.some((m) => /scout\.md/.test(m))).toBe(true);                        // not silent
  });

  it('leaves a user-EDITED architect/ask/debug/orchestrator untouched (only scout is engine-managed)', () => {
    // The reconcile-a-foreign-file rule is scout-ONLY; the four picker archetypes
    // keep "user edits win", so a personal customization of them is never clobbered.
    const dir = tmpDir();
    for (const f of ['architect.md', 'ask.md', 'debug.md', 'orchestrator.md']) {
      fs.writeFileSync(path.join(dir, f), `MY OWN ${f}`, 'utf8');
    }
    ensureArchetypes({ marker: fakeMarker(false).marker, dir, log: () => {} });
    for (const f of ['architect.md', 'ask.md', 'debug.md', 'orchestrator.md']) {
      expect(fs.readFileSync(path.join(dir, f), 'utf8')).toBe(`MY OWN ${f}`);
    }
  });

  it('leaves a user-EDITED archetype untouched while upgrading a pristine sibling', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'architect.md'), 'MY OWN ARCHITECT PROMPT', 'utf8');
    const askV1 = ARCHETYPES_V1.find((a) => a.file === 'ask.md')!;
    fs.writeFileSync(path.join(dir, 'ask.md'), askV1.content, 'utf8');
    const { marker } = fakeMarker(false);
    ensureArchetypes({ marker, dir, log: () => {} });
    expect(fs.readFileSync(path.join(dir, 'architect.md'), 'utf8')).toBe('MY OWN ARCHITECT PROMPT'); // preserved
    expect(fs.readFileSync(path.join(dir, 'ask.md'), 'utf8')).toBe(cur('ask.md')); // pristine v1 -> upgraded
  });

  it('re-seeds a file the user deleted under an older marker exactly once, then the v3 marker guards it', () => {
    const dir = tmpDir();
    // An existing v2 install MINUS debug.md (deleted while on v2); the v3 marker is
    // still unset, so the one-time bump re-creates it as v3.
    for (const a of ARCHETYPES_V2.filter((x) => x.file !== 'debug.md')) {
      fs.writeFileSync(path.join(dir, a.file), a.content, 'utf8');
    }
    const f = fakeMarker(false);
    ensureArchetypes({ marker: f.marker, dir, log: () => {} });
    expect(fs.readFileSync(path.join(dir, 'debug.md'), 'utf8')).toBe(cur('debug.md'));
    expect(f.state.installed).toBe(true); // v3 marker set after the pass
    // Now the marker is set: a subsequent delete is NOT resurrected.
    fs.rmSync(path.join(dir, 'debug.md'));
    ensureArchetypes({ marker: f.marker, dir, log: () => {} });
    expect(fs.existsSync(path.join(dir, 'debug.md'))).toBe(false);
  });

  it('freeze guards: every v1 payload differs from v3; architect/ask changed at v3; debug/orchestrator re-ship byte-identical to v2', () => {
    // If a frozen prior is re-pasted to equal current, the pristine check would
    // treat a real current file as an upgradeable prior (or never upgrade). Assert
    // the intended divergences/identities so a stale freeze fails loudly.
    // scout is new at v3, cartographer is new at v4 - neither has a v1 counterpart.
    for (const v3 of ARCHETYPES.filter((a) => a.file !== 'scout.md' && a.file !== 'cartographer.md')) {
      const v1 = ARCHETYPES_V1.find((a) => a.file === v3.file)!;
      expect(v1.content).not.toBe(v3.content);           // v1 (S9) always predates v3
    }
    for (const f of ['architect.md', 'ask.md']) {
      expect(ARCHETYPES_V2.find((a) => a.file === f)!.content).not.toBe(cur(f)); // reworded at v3
    }
    for (const f of ['debug.md', 'orchestrator.md']) {
      expect(ARCHETYPES_V2.find((a) => a.file === f)!.content).toBe(cur(f));     // unchanged re-ship
    }
    expect(ARCHETYPES_V1.some((a) => a.file === 'scout.md')).toBe(false); // scout is new at v3
    expect(ARCHETYPES_V2.some((a) => a.file === 'scout.md')).toBe(false);
    expect(ARCHETYPES_V1.some((a) => a.file === 'cartographer.md')).toBe(false); // cartographer new at v4
    expect(ARCHETYPES_V2.some((a) => a.file === 'cartographer.md')).toBe(false);
  });
});

describe('ensureArchetypes v3 -> v4 bump (cartographer added, others byte-identical)', () => {
  const cur = (f: string) => ARCHETYPES.find((a) => a.file === f)!.content;

  it('adds ONLY cartographer.md to a byte-identical v3 install; the five shipped files pass the "already shipped" skip branch untouched', () => {
    // The real upgrade path users take: a v3 install has today's five non-cartographer
    // archetypes verbatim (v4 only ADDED cartographer.md, so those five are byte-
    // identical to current) and NO cartographer.md. Under a freshly-unset v4 marker
    // the one-time pass must WRITE cartographer.md and leave the five exactly as they
    // are. The existing v1/v2 fixtures only exercise the PRIOR-overwrite branch; this
    // seeds CURRENT content, so it is the only test that hits the byte-identical skip
    // branch (`existing === a.content -> continue`). Remove that skip and the five
    // would follow a different branch, but the observable contract asserted here -
    // cartographer created, five unchanged, marker set - is what a real user relies on.
    const dir = tmpDir();
    const shipped = ARCHETYPES.filter((a) => a.file !== 'cartographer.md');
    for (const a of shipped) fs.writeFileSync(path.join(dir, a.file), a.content, 'utf8');
    expect(fs.existsSync(path.join(dir, 'cartographer.md'))).toBe(false);

    const { marker, state } = fakeMarker(false); // the v4 marker is unset
    ensureArchetypes({ marker, dir, log: () => {} });

    expect(fs.readFileSync(path.join(dir, 'cartographer.md'), 'utf8')).toBe(cur('cartographer.md')); // installed
    for (const a of shipped) {
      expect(fs.readFileSync(path.join(dir, a.file), 'utf8')).toBe(a.content); // untouched, still current
    }
    expect(state.installed).toBe(true); // the v4 pass completed and recorded itself
  });
});
