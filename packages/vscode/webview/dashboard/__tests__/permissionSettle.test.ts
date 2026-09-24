// Pure tests for permissionSettle.ts's settlePermissionAudit — the rule that
// lets a permission ask be settled by something other than a click on THIS
// bar: a phone's signed approve/YOLO, or a sibling tab answering the same
// sub-agent-forwarded ask. `permissionAudit` carries no sessionId, so the
// caller (ChatPane.svelte) offers every session a chance to settle; these
// cases pin what "a chance" actually does to one session's queue.
//
// The rendered, multi-session, real-ChatPane version of the same scenarios
// lives in permissionQueue.test.ts, alongside the sub-agent-stall tests this
// queue was built for.

import { describe, it, expect } from 'vitest';
import {
  enqueuePermission,
  promoteNextPermission,
  settlePermissionAudit,
  type PermissionAsk,
  type PermissionQueueTarget,
} from '../panes/permissionSettle';

function ask(toolCallId: string): PermissionAsk {
  return { toolCallId, title: toolCallId, options: [{ optionId: 'once', name: 'Allow once', kind: 'allow_once' }] };
}

function target(): PermissionQueueTarget {
  return { permission: null, permissionQueue: [] };
}

describe('settlePermissionAudit', () => {
  it('settling the BAR\'s own ask promotes the next queued one', () => {
    const s = target();
    enqueuePermission(s, ask('bar'));
    enqueuePermission(s, ask('queued'));
    settlePermissionAudit(s, 'bar');
    expect(s.permission?.toolCallId).toBe('queued');
    expect(s.permissionQueue).toEqual([]);
  });

  it('settling a QUEUED ask leaves the bar untouched and shortens the queue', () => {
    const s = target();
    enqueuePermission(s, ask('bar'));
    enqueuePermission(s, ask('queued1'));
    enqueuePermission(s, ask('queued2'));
    settlePermissionAudit(s, 'queued1');
    expect(s.permission?.toolCallId).toBe('bar'); // unchanged — no promotion
    expect(s.permissionQueue.map((q) => q.toolCallId)).toEqual(['queued2']);
  });

  it('a local click already promoted past the id — settling it again is a no-op', () => {
    const s = target();
    enqueuePermission(s, ask('bar'));
    enqueuePermission(s, ask('queued'));
    promoteNextPermission(s); // the local click: 'bar' answered, 'queued' promoted
    expect(s.permission?.toolCallId).toBe('queued');
    settlePermissionAudit(s, 'bar'); // the audit for the SAME id arrives after
    expect(s.permission?.toolCallId).toBe('queued'); // no double promotion
    expect(s.permissionQueue).toEqual([]);
  });

  it('an id this session never held changes nothing', () => {
    const s = target();
    enqueuePermission(s, ask('bar'));
    enqueuePermission(s, ask('queued'));
    settlePermissionAudit(s, 'ghost');
    expect(s.permission?.toolCallId).toBe('bar');
    expect(s.permissionQueue.map((q) => q.toolCallId)).toEqual(['queued']);
  });

  it('an empty bar with an empty queue stays empty', () => {
    const s = target();
    settlePermissionAudit(s, 'anything');
    expect(s.permission).toBeNull();
    expect(s.permissionQueue).toEqual([]);
  });
});
