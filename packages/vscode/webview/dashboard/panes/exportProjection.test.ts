// exportRows — which of a transcript row's fields reach a markdown export.
//
// The extraction's gift (docs/WORKING_ON_ORIGAMI_CODER.md Part 4): inside
// `exportSession` this rule could only be checked by posting a message and
// reading the wire; as a pure function it is three assertions, and the one that
// matters has never been checked at all — that a pasted image does NOT travel.
// A base64 data URL is hundreds of kilobytes and would dwarf the conversation
// in the exported file, and nothing downstream would report it as wrong.

import { describe, expect, it } from 'vitest';
import { exportRows } from './exportProjection';
import type { Message } from './chatMessage';

const row = (over: Partial<Message>): Message => ({ id: 1, kind: 'agent', label: 'Agent', text: 'hi', ...over });

describe('exportRows', () => {
  it('DROPS images — a base64 data URL is unreadable in markdown and dwarfs the text', () => {
    const [out] = exportRows([row({ kind: 'user', label: 'You', images: ['data:image/png;base64,AAAA'] })]);
    expect(out).not.toHaveProperty('images');
    expect(Object.values(out).join(' ')).not.toContain('base64');
  });

  it('KEEPS tool cards — what the agent ran is most of what an export is read for', () => {
    const [out] = exportRows([
      row({ kind: 'tool', label: 'edit', text: '', toolName: 'edit', toolStatus: 'completed', toolResult: 'Edit applied.' }),
    ]);
    expect(out).toEqual({
      kind: 'tool',
      label: 'edit',
      text: '',
      toolName: 'edit',
      toolStatus: 'completed',
      toolResult: 'Edit applied.',
    });
  });

  it('carries no field the type does not name, whatever else the row holds', () => {
    // The widening trap: a spread of the whole Message would leak every field
    // added later into every export, silently.
    const [out] = exportRows([row({ engineMsgId: 'msg_1', tokensAtTurn: 4200, taskStream: 'x'.repeat(50) })]);
    expect(Object.keys(out).sort()).toEqual(['kind', 'label', 'text', 'toolName', 'toolResult', 'toolStatus']);
  });

  it('preserves order and length, including a kind added later', () => {
    const out = exportRows([
      row({ id: 1, kind: 'user', label: 'You', text: 'first' }),
      row({ id: 2, kind: 'secondOpinion', label: 'Second opinion — GPT-5', text: 'second' }),
    ]);
    expect(out.map((r) => r.text)).toEqual(['first', 'second']);
  });

  it('returns nothing for an empty transcript', () => {
    expect(exportRows([])).toEqual([]);
  });
});
