// Origami Remote — R-1, the default-deny allowlist, and R-2a, the envelope.
//
// The claim under test is a NEGATIVE one, so it is written as an enumeration
// rather than as "a bad message did not get through": every verb the phone must
// never reach is NAMED here, and a table that ever admits one fails on the name
// rather than on a symptom three files away.
//
// `setApproveMode` is the row this whole file exists for. Until R-1 landed, the
// phone's own chat bundle could post it — the ChatPane YOLO button does, and so
// does the composer's approve row — straight into the same
// `handleWebviewMessage` the sidebar uses. A phone did not have to defeat the
// approval gate; it could switch the gate off.
import { describe, expect, it } from 'vitest';
import {
  ENVELOPE_REFUSED,
  NAMED_REFUSALS,
  NOT_ALLOWED,
  PHONE_VERBS,
  readCapability,
  verbNeeds,
  verbVerdict,
  type RemoteCapability,
} from '../../../src/remote/remoteVerbs';

function allowed(msg: unknown, capability: RemoteCapability = 'full'): boolean {
  return verbVerdict(msg, capability).allow;
}
function refusal(msg: unknown, capability: RemoteCapability = 'full'): string {
  const v = verbVerdict(msg, capability);
  expect(v.allow, `expected ${JSON.stringify(msg)} to be refused`).toBe(false);
  return v.allow ? '' : v.status;
}

describe('the allowlist is a table, and everything else is dropped', () => {
  it('admits exactly the verbs the phone is meant to send', () => {
    // The table itself, read back. A row added without a reviewer noticing
    // shows up HERE, as a list that no longer matches the one in the test.
    expect([...PHONE_VERBS.keys()].sort()).toEqual([
      'activeSessionChanged',
      'amApply',
      'amOpenFileDiff',
      'cacheStats',
      'cancel',
      'cancelLoopSchedule',
      'chatGridMode',
      'closeSession',
      'collabArchive',
      'collabPoll',
      'collabPreview',
      'collabPromptCapture',
      'compactContext',
      'createChatSection',
      'deleteChatSection',
      'dismissSubagent',
      'engineRetry',
      'flockDecide',
      'flockMailboxRequest',
      'forkChat',
      'glidepathRequest',
      'imageError',
      'interject',
      'listCollabAgentDefs',
      'listCrons',
      'listInstructions',
      'listLoopSchedules',
      'listSkills',
      'modelPanel.load',
      'modelPanel.swap',
      'modelPanel.unload',
      'newCollab',
      'newSession',
      'openAgentManager',
      'openBoardSection',
      'openBotsSection',
      'openCollab',
      'openConnections',
      'openSideQuestsDrawer',
      'openSubagentDrawer',
      'permission',
      'planAction',
      'popOutSession',
      'providerAuthRequest',
      'providerAuthSubmitCode',
      'providerUsageCapableRequest',
      'providerUsageRequest',
      'recallSession',
      'refreshModelLists', // t-ttmo5w: the Connections Refresh button, `ask` (it spends the owner's key)
      'remote/challenge-response',
      'remote/cursors',
      'remote/focus',
      'remote/hello',
      'remote/set-mode',
      'remote/set-mode-request',
      'remote/snapshot',
      'renameChatSection',
      'renameSession',
      'reorderCollabs',
      'reorderSessions',
      'resizeCollabsSection',
      'restoreInstructionDefault',
      'revertToMessage',
      'saveWorkbenchTheme',
      'secondOpinion',
      'send',
      'sendWithImages',
      'setBrowserAutoApprove',
      'setBudget',
      'setChatDensity',
      'setChatSection',
      'setCollabsCollapsed',
      'setCompactionThreshold',
      'setEffort',
      'setMode',
      'setModel',
      'setScheduleTab',
      'setSubagentModel',
      'setVisionPin',
      'setVisionProfile',
      'setupProvider',
      'slashCommand',
      'soloSession',
      'stopBackgroundShell',
      'themeChanged',
      'toggleChatSectionCollapse',
      'undoRevert',
      'webmcpAdd',
      'webmcpEdit',
      'webmcpOpen',
      'webmcpRemove',
      'webmcpRequest',
    ]);
  });

  it('REFUSES every verb that could escalate, schedule, or open a file', () => {
    // Named one at a time, because a loop that printed "some verb was allowed"
    // would not tell the next reader WHICH gate had come undone.
    for (const type of NAMED_REFUSALS) {
      expect(allowed({ type }), `${type} must never reach the host from a phone`).toBe(false);
    }
    // `setApproveMode` is the one the spec names by its user-facing spelling —
    // `/auto` and `/bypass` typed into the composer, and the ChatPane YOLO
    // button, all post it; refusing the type IS refusing them. `/plan` and a
    // plain mode switch are a DIFFERENT escalation question — see the
    // 2026-09-06 sweep below, where `setMode` becomes an ordinary `ask` row
    // because it cannot reach bypass.
    expect(allowed({ type: 'setApproveMode', mode: 'bypass', sessionId: 's1' })).toBe(false);
  });

  describe('the 2026-09-06 sweep — the phone can drive everything benign', () => {
    it('setMode (the AGENT mode: build/plan/deep-plan) is ask, not refused — it cannot reach bypass', () => {
      expect(allowed({ type: 'setMode', modeId: 'build', sessionId: 's1' }, 'ask')).toBe(true);
      expect(allowed({ type: 'setMode', modeId: 'build', sessionId: 's1' }, 'watch')).toBe(false);
    });
    it('setModel / setSubagentModel / setEffort switch among configured options — ask', () => {
      expect(allowed({ type: 'setModel', modelId: 'lmstudio/x', sessionId: 's1' }, 'ask')).toBe(true);
      expect(allowed({ type: 'setSubagentModel', modelId: 'lmstudio/x', sessionId: 's1' }, 'ask')).toBe(true);
      expect(allowed({ type: 'setEffort', effort: 'high', sessionId: 's1' }, 'ask')).toBe(true);
    });
    it('setupProvider / setBrowserAutoApprove / webmcp* are FULL only — an endpoint, credential or tool-surface write', () => {
      for (const type of ['setupProvider', 'providerAuthRequest', 'setBrowserAutoApprove', 'saveWorkbenchTheme', 'restoreInstructionDefault', 'webmcpRequest', 'webmcpRemove', 'webmcpOpen', 'modelPanel.unload']) {
        expect(allowed({ type }, 'full'), `${type} at full`).toBe(true);
        expect(allowed({ type }, 'ask'), `${type} at ask`).toBe(false);
      }
    });
    it('slashCommand refuses /auto and /bypass BY NAME, at every envelope including full — they reach the same unsigned bypass setApproveMode does', () => {
      for (const capability of ['watch', 'ask', 'full'] as RemoteCapability[]) {
        expect(allowed({ type: 'slashCommand', command: 'auto', args: '' }, capability), `auto at ${capability}`).toBe(false);
        expect(allowed({ type: 'slashCommand', command: 'bypass', args: '' }, capability), `bypass at ${capability}`).toBe(false);
      }
    });
    it('slashCommand allows /plan, /default and /deep-plan (they only ever restrict) at ask', () => {
      for (const command of ['plan', 'default', 'deep-plan', 'btw', 'spend']) {
        expect(allowed({ type: 'slashCommand', command, args: '' }, 'ask'), command).toBe(true);
      }
    });
    it('flockDecide is ask — answering a contact sends data out, not just a read', () => {
      expect(allowed({ type: 'flockDecide', requestId: 'r1', decision: 'approve' }, 'ask')).toBe(true);
      expect(allowed({ type: 'flockDecide', requestId: 'r1', decision: 'approve' }, 'watch')).toBe(false);
    });
    it('a handful of read-ish verbs that do not start with `request` are watch', () => {
      for (const type of ['providerUsageRequest', 'providerUsageCapableRequest', 'glidepathRequest', 'flockMailboxRequest', 'listCollabAgentDefs', 'collabPoll', 'collabPreview']) {
        expect(allowed({ type }, 'watch'), type).toBe(true);
      }
    });
  });

  it('names the TYPE on the status line and never the payload', () => {
    // setEngineUrl (not setupProvider, which the 2026-09-06 sweep moved to a
    // FULL row) is still a NAMED refusal with no row at all — the payload
    // redaction is the same either way, so any credential-shaped verb proves it.
    const said = refusal({ type: 'setEngineUrl', apiKey: 'sk-live-do-not-log-me', url: 'https://x' });
    expect(said).toBe(NOT_ALLOWED + 'setEngineUrl');
    expect(said).not.toContain('sk-live');
    expect(said).not.toContain('https://x');
    // A message with no type at all is still dropped, and still says something.
    expect(refusal({ text: 'hello' })).toBe(NOT_ALLOWED + '(no type)');
    expect(refusal(null)).toBe(NOT_ALLOWED + '(no type)');
    expect(refusal({ type: 42 })).toBe(NOT_ALLOWED + '(no type)');
  });

  it('lets every `request*` read through, because they re-broadcast state', () => {
    for (const type of ['requestSessions', 'requestModels', 'requestSpend', 'requestBrowserAutoApprove']) {
      expect(allowed({ type }), type).toBe(true);
      // ...at every envelope: a read is a read.
      expect(allowed({ type }, 'watch'), `${type} under watch`).toBe(true);
    }
  });
});

describe('the capability envelope (R-2a)', () => {
  it('defaults to FULL, and an unknown value is the default rather than a refusal', () => {
    // A typo in settings.json must not silently mute a paired phone.
    expect(readCapability(undefined)).toBe('full');
    expect(readCapability('FULL')).toBe('full');
    expect(readCapability('nonsense')).toBe('full');
    expect(readCapability('watch')).toBe('watch');
    expect(readCapability('ask')).toBe('ask');
  });

  it('FULL lets the phone drive, approve, and ask for YOLO', () => {
    expect(allowed({ type: 'send', text: 'go', sessionId: 's1' }, 'full')).toBe(true);
    expect(allowed({ type: 'permission', toolCallId: 't1', optionId: 'allow_once' }, 'full')).toBe(true);
    expect(allowed({ type: 'remote/set-mode-request', mode: 'yolo', sessionId: 's1' }, 'full')).toBe(true);
    expect(allowed({ type: 'remote/set-mode', mode: 'yolo', sessionId: 's1' }, 'full')).toBe(true);
  });

  it('ASK lets the phone drive and approve, and refuses YOLO by name', () => {
    expect(allowed({ type: 'send', text: 'go', sessionId: 's1' }, 'ask')).toBe(true);
    expect(allowed({ type: 'sendWithImages', sessionId: 's1' }, 'ask')).toBe(true);
    expect(allowed({ type: 'permission', toolCallId: 't1', optionId: 'allow_once' }, 'ask')).toBe(true);
    const said = refusal({ type: 'remote/set-mode', mode: 'yolo', sessionId: 's1' }, 'ask');
    expect(said).toBe(`${ENVELOPE_REFUSED}ask — refused remote/set-mode`);
    expect(allowed({ type: 'remote/set-mode-request', mode: 'yolo', sessionId: 's1' }, 'ask')).toBe(false);
  });

  it('WATCH is reads and cancel: no send, no approval, no escalation', () => {
    expect(allowed({ type: 'remote/snapshot' }, 'watch')).toBe(true);
    expect(allowed({ type: 'cancel', sessionId: 's1' }, 'watch')).toBe(true);
    expect(allowed({ type: 'send', text: 'go', sessionId: 's1' }, 'watch')).toBe(false);
    expect(allowed({ type: 'sendWithImages', sessionId: 's1' }, 'watch')).toBe(false);
    expect(allowed({ type: 'newSession' }, 'watch')).toBe(false);
    expect(allowed({ type: 'permission', toolCallId: 't1', optionId: 'allow_once' }, 'watch')).toBe(false);
    expect(allowed({ type: 'remote/set-mode', mode: 'yolo', sessionId: 's1' }, 'watch')).toBe(false);
  });

  it('DROPPING authority is free at every envelope — a deny, a cancel, a revert', () => {
    // The rule that keeps a gate from teaching people to say yes.
    for (const capability of ['watch', 'ask', 'full'] as RemoteCapability[]) {
      expect(allowed({ type: 'permission', toolCallId: 't1', optionId: null }, capability), capability).toBe(true);
      expect(allowed({ type: 'permission', toolCallId: 't1' }, capability), capability).toBe(true);
      expect(allowed({ type: 'remote/set-mode', mode: 'ask', sessionId: 's1' }, capability), capability).toBe(true);
      expect(allowed({ type: 'cancel', sessionId: 's1' }, capability), capability).toBe(true);
    }
    // ...and the needs themselves say so, which is what the envelope reads.
    expect(verbNeeds({ type: 'permission', toolCallId: 't1', optionId: null })).toBe('watch');
    expect(verbNeeds({ type: 'permission', toolCallId: 't1', optionId: 'allow_once' })).toBe('ask');
    expect(verbNeeds({ type: 'remote/set-mode', mode: 'yolo', sessionId: 's1' })).toBe('full');
    expect(verbNeeds({ type: 'setApproveMode' })).toBeNull();
  });

  it('the handshake is admitted at every envelope, or a phone could never pair', () => {
    for (const capability of ['watch', 'ask', 'full'] as RemoteCapability[]) {
      expect(allowed({ type: 'remote/hello', v: 1 }, capability), capability).toBe(true);
      expect(allowed({ type: 'remote/challenge-response', v: 1 }, capability), capability).toBe(true);
      expect(allowed({ type: 'remote/snapshot' }, capability), capability).toBe(true);
    }
  });
});
