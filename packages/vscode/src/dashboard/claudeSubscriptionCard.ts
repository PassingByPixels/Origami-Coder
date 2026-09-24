// claudeSubscriptionCard.ts — the three messages behind the Connections
// "Claude (subscription, experimental)" entry and its card (t-tsw90t).
//
// Picking the catalog entry (ControlStrip.svelte, setupCatalog.ts) posts
// claudeSubscriptionAdd instead of the ordinary setupProvider write: there is
// no key and no OAuth sign-in here, only the ONE setting
// (origami.experimentalClaudeSubscription) the Settings-toggle path already
// owns. Add runs the SAME one-time disclosure that path uses
// (claudeSubscriptionConsent.ts) before flipping it on — Confirm turns it on,
// anything else (Cancel, Escape, click-away) leaves it off. Disconnect turns
// it off directly; turning a feature OFF needs no consent.
//
// The setting stays the single source of truth: this module writes no
// second flag anywhere, and reads readiness fresh on every status request
// rather than caching its own copy.
//
// Readiness for the card's status line prefers the engine's own Gate B
// (provider/claude-subscription.ts, reached through engineStatus.ts) through
// whatever engine the host can ask with NO chat tab open (t-sh7cog's
// hostEngine) — falling back to the local CLI-discovery guess
// (readiness.ts's readinessFromCli) only when no engine will start at all.

import * as vscode from 'vscode';
import { CLAUDE_SUBSCRIPTION_SETTING, claudeSubscriptionEnabled } from '../claudeSubscriptionFlag';
import { confirmClaudeSubscriptionDisclosure } from '../claudeSubscriptionConsent';
import { readinessCliLine, readinessFixLine, readinessFromCli, readinessLabel } from '../claudeSubscription/readiness';
import { fetchClaudeSubscriptionReadiness } from '../claudeSubscription/engineStatus';
import { claudeCli } from './claudeCodeDetect';

export const CLAUDE_SUBSCRIPTION_CARD_MESSAGE_TYPES = new Set([
  'requestClaudeSubscriptionStatus',
  'claudeSubscriptionAdd',
  'claudeSubscriptionDisconnect',
]);

export interface ClaudeSubscriptionCardEngineClient {
  extMethod(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export interface ClaudeSubscriptionCardHost {
  context: vscode.ExtensionContext;
  post(message: Record<string, unknown>): void;
  /** A chat's client, else the host engine started with no chat open
   *  (t-sh7cog's hostEngine.ensure()); undefined when neither will start. */
  engineClient(): Promise<ClaudeSubscriptionCardEngineClient | undefined>;
}

async function setEnabled(value: boolean): Promise<void> {
  await vscode.workspace.getConfiguration('origami').update(CLAUDE_SUBSCRIPTION_SETTING, value, vscode.ConfigurationTarget.Global);
}

async function statusPayload(host: ClaudeSubscriptionCardHost): Promise<Record<string, unknown>> {
  const enabled = claudeSubscriptionEnabled();
  if (!enabled) return { type: 'claudeSubscriptionStatus', enabled, ready: false, label: '', fixLine: '', cli: '' };
  const client = await host.engineClient();
  const readiness = client ? await fetchClaudeSubscriptionReadiness(client) : readinessFromCli(await claudeCli());
  return {
    type: 'claudeSubscriptionStatus',
    enabled,
    ready: readiness.state === 'ready',
    label: readinessLabel(readiness),
    fixLine: readinessFixLine(readiness),
    cli: readinessCliLine(readiness), // t-vd9s7z: which binary the route uses
  };
}

export async function handleClaudeSubscriptionCardMessage(
  host: ClaudeSubscriptionCardHost,
  m: { type?: string; [k: string]: unknown },
): Promise<void> {
  if (m.type === 'requestClaudeSubscriptionStatus') {
    host.post(await statusPayload(host));
    return;
  }
  if (m.type === 'claudeSubscriptionAdd') {
    // Already-on-and-consented (a second Add, or the Settings toggle got
    // there first) skips straight through — confirmClaudeSubscriptionDisclosure
    // asks only once ever.
    const ok = await confirmClaudeSubscriptionDisclosure(host.context);
    if (ok) await setEnabled(true);
    host.post(await statusPayload(host));
    return;
  }
  if (m.type === 'claudeSubscriptionDisconnect') {
    await setEnabled(false);
    host.post(await statusPayload(host));
    return;
  }
}
