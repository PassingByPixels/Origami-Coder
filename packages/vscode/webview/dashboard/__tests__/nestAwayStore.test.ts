// t-t7lfho — the host's record of chats this desk gave to another desk
// (src/dashboard/nestAway.ts). It must survive a window reload (globalState),
// be cleared by Take back here, stay one record per chat, and stay bounded.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NEST_AWAY_KEY, NEST_AWAY_MAX, NestAway } from '../../../src/dashboard/nestAway';

function memento() {
  const bag = new Map<string, unknown>();
  return { bag, get: <T,>(k: string, d: T) => (bag.has(k) ? (structuredClone(bag.get(k)) as T) : d), update: (k: string, v: unknown) => { bag.set(k, structuredClone(v)); } };
}

describe('NestAway', () => {
  it('a record made in one window is read by the next one (a reload), and Take back clears it there too', () => {
    const store = memento();
    const first = new NestAway();
    first.attach(store);
    first.set('s1', 'dev-5090', 1000);
    const reloaded = new NestAway();
    reloaded.attach(store);
    expect(reloaded.list()).toEqual([{ id: 's1', desk: 'dev-5090', at: 1000 }]);
    reloaded.clear('s1');
    const again = new NestAway();
    again.attach(store);
    expect(again.list()).toEqual([]);
  });
  it('one record per chat: a second hand-over of the same chat replaces the first', () => {
    const a = new NestAway();
    a.attach(memento());
    a.set('s1', 'dev-5090', 1000);
    a.set('s1', 'dev-mac', 2000);
    expect(a.list()).toEqual([{ id: 's1', desk: 'dev-mac', at: 2000 }]);
  });
  it('bounded: past the maximum the oldest record goes', () => {
    const a = new NestAway();
    a.attach(memento());
    for (let i = 0; i <= NEST_AWAY_MAX; i++) a.set(`s${i}`, 'd', i);
    expect(a.list()).toHaveLength(NEST_AWAY_MAX);
    expect(a.list()[0]!.id).toBe('s1');
  });
  it('junk in the store is dropped, not shown', () => {
    const store = memento();
    store.update(NEST_AWAY_KEY, [{ id: 's1', desk: 'd', at: 1 }, { id: '', desk: 'd', at: 1 }, null, 'x', { id: 's2', at: 2 }]);
    const a = new NestAway();
    a.attach(store);
    expect(a.list()).toEqual([{ id: 's1', desk: 'd', at: 1 }]);
  });
});

describe('mirror — the webview declares the same record (tsconfig.webview cannot import src/)', () => {
  it('src/dashboard/nestAway.ts and webview/chat/nestIndex.ts name the same fields', () => {
    const root = join(__dirname, '..', '..', '..');
    const fields = (file: string) => {
      const src = readFileSync(join(root, file), 'utf-8');
      const body = /export interface NestAwayRow \{([\s\S]*?)\}/.exec(src)?.[1] ?? '';
      return [...body.matchAll(/(\w+)\s*:\s*(string|number)/g)].map((m) => `${m[1]}:${m[2]}`).sort();
    };
    expect(fields('src/dashboard/nestAway.ts')).toEqual(['at:number', 'desk:string', 'id:string']);
    expect(fields('webview/chat/nestIndex.ts')).toEqual(fields('src/dashboard/nestAway.ts'));
  });
});
