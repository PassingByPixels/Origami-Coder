// OAuth connections, host side — routed out of DashboardPanel.ts like Plugins/Tools. The extension
// talks ACP over stdio with no HTTP channel to the engine's own /provider/auth/* routes, so three
// ACP ext methods bridge that.
//
// providerAuthStart -> provider_auth_authorize answers immediately with a URL to open in the
// browser; for an "auto" method the extension then awaits provider_auth_callback, which parks until
// the browser redirects — this does NOT stall the ACP channel, since the SDK dispatches requests
// without awaiting each handler. providerAuthSubmitCode is the "code" variant; the engine holds the
// pending flow between the two messages.
//
// On success the provider's config block is written WITHOUT an apiKey — see oauthConnections.ts.

import * as vscode from 'vscode';
import { OAUTH_PROVIDERS, oauthMethods } from './oauthConnections';
import type { ModelChoice } from './firstFold';

export const PROVIDER_AUTH_MESSAGE_TYPES = new Set([
  'providerAuthRequest',
  'providerAuthStart',
  'providerAuthSubmitCode',
]);

interface ListResult {
  methods?: Record<string, Array<{ type: string; label: string }>>;
  connected?: Record<string, { type: string; expires?: number; needsReauth?: string }>;
}
interface AuthorizeResult {
  ok: boolean;
  url?: string;
  method?: 'auto' | 'code';
  instructions?: string;
  message?: string;
}
interface CallbackResult {
  ok: boolean;
  credential?: { type: string; expires?: number };
  message?: string;
}

export interface ProviderAuthClient {
  extMethod(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export interface ProviderAuthHost {
  /** The active chat's engine connection. OAuth is an engine capability, so with no session there is nothing to drive. */
  client?: ProviderAuthClient;
  post(message: Record<string, unknown>): void;
  /** The shared config writer (writeModelConfig). */
  write(choice: ModelChoice): { path: string; model: string };
  /** Bust this provider's status cache + re-broadcast, so its pill appears now. */
  refresh(providerId: string): void;
  /** Optional host toast offering a window reload (skipped in tests). */
  notifyReload?(providerName: string, model: string): void;
  /** Injected so tests never launch a real browser. */
  openExternal(url: string): void;
}

const NO_SESSION = 'Open a chat first — signing in runs through a live engine connection.';

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The pane's read: which OAuth methods each supported provider offers, and
 *  which of them already hold a credential. Only the two OAuth connections are
 *  reported — the engine lists every plugin with an auth hook, and the rest
 *  have their own API-key entries. */
async function listPayload(host: ProviderAuthHost): Promise<Record<string, unknown>> {
  const empty = { type: 'providerAuthData', methods: {}, connected: {} };
  if (!host.client) return { ...empty, error: NO_SESSION };
  try {
    const result = (await host.client.extMethod('provider_auth_list', {})) as unknown as ListResult;
    const methods: Record<string, Array<{ index: number; label: string }>> = {};
    const connected: Record<string, { type: string; expires?: number; needsReauth?: string }> = {};
    for (const id of Object.keys(OAUTH_PROVIDERS)) {
      methods[id] = oauthMethods(result?.methods?.[id]);
      const cred = result?.connected?.[id];
      // Only an OAUTH credential lights the OAuth pill. A provider can hold an
      // `api` credential from `origami providers login` at the same time, and
      // reporting that as "signed in with OAuth" would be a lie the user acts
      // on when a browser session actually expired.
      if (cred?.type === 'oauth') connected[id] = cred;
    }
    return { type: 'providerAuthData', methods, connected };
  } catch (e) {
    return { ...empty, error: `Could not read the sign-in options: ${errorText(e)}` };
  }
}

/** Which providers hold an OAUTH credential, for liveness: a signed-in block has no baseURL/apiKey
 *  and used to read "not configured". undefined = COULD NOT ASK, never an empty set (which would
 *  cache a false "nobody signed in" verdict). Degrades, never throws. */
export async function oauthConnectedIds(client: ProviderAuthClient | undefined): Promise<Set<string> | undefined> {
  if (!client) return undefined;
  try {
    const result = (await client.extMethod('provider_auth_list', {})) as unknown as ListResult;
    const oauth = Object.entries(result?.connected ?? {}).filter(([, cred]) => cred?.type === 'oauth');
    return new Set(oauth.map(([id]) => id));
  } catch { return undefined; }
}

/** Everything both completion paths ("auto" and pasted-code) share: write the
 *  provider block, light the pill, tell the user, offer the reload. */
function finish(host: ProviderAuthHost, providerId: string, result: CallbackResult): void {
  if (!result.ok) {
    host.post({ type: 'providerAuthFailed', providerId, message: result.message ?? 'Sign-in failed.' });
    return;
  }
  const spec = OAUTH_PROVIDERS[providerId];
  let written: { path: string; model: string };
  try {
    written = host.write({
      providerId: spec.id,
      providerName: spec.name,
      npm: spec.npm,
      modelId: spec.defaultModel,
      modelName: spec.models[spec.defaultModel].name,
      catalog: spec.models as unknown as Record<string, Record<string, unknown>>,
    });
  } catch (e) {
    // The credential IS stored at this point; only the config write failed.
    // Saying so plainly matters — the sign-in does not need repeating, the
    // config does. (A credential with no config block is inert, not harmful:
    // the engine skips a provider its database has never heard of.)
    host.post({
      type: 'providerAuthFailed',
      providerId,
      message: `Signed in to ${spec.name}, but writing origami.json failed: ${errorText(e)}`,
    });
    return;
  }
  host.refresh(providerId);
  host.post({ type: 'providerAuthDone', providerId, model: written.model, path: written.path });
  host.notifyReload?.(spec.name, written.model);
}

async function start(host: ProviderAuthHost, providerId: unknown, methodIndex: unknown): Promise<void> {
  const id = typeof providerId === 'string' ? providerId : '';
  const spec = OAUTH_PROVIDERS[id];
  if (!spec) return;
  if (!Number.isInteger(methodIndex) || (methodIndex as number) < 0) return;
  if (!host.client) {
    host.post({ type: 'providerAuthFailed', providerId: id, message: NO_SESSION });
    return;
  }
  let authorized: AuthorizeResult;
  try {
    authorized = (await host.client.extMethod('provider_auth_authorize', {
      providerID: id,
      methodIndex,
    })) as unknown as AuthorizeResult;
  } catch (e) {
    host.post({ type: 'providerAuthFailed', providerId: id, message: errorText(e) });
    return;
  }
  if (!authorized.ok || !authorized.url) {
    host.post({ type: 'providerAuthFailed', providerId: id, message: authorized.message ?? 'Could not start sign-in.' });
    return;
  }

  // Opens the sign-in page for them — both plugins' headless methods also answer with a URL, and
  // it's shown in the pane too for a machine where opening a browser isn't wanted. A malformed URL
  // must not abandon the flow: the engine already holds a pending sign-in that only the callback
  // releases, so the pane shows the URL for the user to open by hand instead.
  let launchNote = '';
  try {
    host.openExternal(authorized.url);
  } catch (e) {
    launchNote = ` (could not open your browser automatically — ${errorText(e)}; open the URL below yourself)`;
  }
  host.post({
    type: 'providerAuthPending',
    providerId: id,
    url: authorized.url,
    method: authorized.method ?? 'auto',
    instructions: `${authorized.instructions ?? ''}${launchNote}`,
  });

  // A "code" method stops here: the engine holds the pending flow until the
  // user pastes their code back through providerAuthSubmitCode.
  if (authorized.method === 'code') return;

  try {
    const result = (await host.client.extMethod('provider_auth_callback', {
      providerID: id,
      methodIndex,
    })) as unknown as CallbackResult;
    finish(host, id, result);
  } catch (e) {
    host.post({ type: 'providerAuthFailed', providerId: id, message: errorText(e) });
  }
}

async function submitCode(
  host: ProviderAuthHost,
  providerId: unknown,
  methodIndex: unknown,
  code: unknown,
): Promise<void> {
  const id = typeof providerId === 'string' ? providerId : '';
  const trimmed = typeof code === 'string' ? code.trim() : '';
  if (!OAUTH_PROVIDERS[id] || !trimmed) return;
  if (!Number.isInteger(methodIndex) || (methodIndex as number) < 0) return;
  if (!host.client) {
    host.post({ type: 'providerAuthFailed', providerId: id, message: NO_SESSION });
    return;
  }
  try {
    const result = (await host.client.extMethod('provider_auth_callback', {
      providerID: id,
      methodIndex,
      code: trimmed,
    })) as unknown as CallbackResult;
    finish(host, id, result);
  } catch (e) {
    host.post({ type: 'providerAuthFailed', providerId: id, message: errorText(e) });
  }
}

export async function handleProviderAuthMessage(
  host: ProviderAuthHost,
  m: { type?: string; [k: string]: unknown },
): Promise<void> {
  switch (m.type) {
    case 'providerAuthRequest':
      host.post(await listPayload(host));
      return;
    case 'providerAuthStart':
      await start(host, m.providerId, m.methodIndex);
      // Re-read afterwards so the pill and the "signed in" copy settle on what
      // the engine actually holds, not on what this flow believes it wrote.
      host.post(await listPayload(host));
      return;
    case 'providerAuthSubmitCode':
      await submitCode(host, m.providerId, m.methodIndex, m.code);
      host.post(await listPayload(host));
      return;
  }
}

// The two real-`vscode` adapters this pane needs, kept here so DashboardPanel's
// wiring stays a single line and every test can inject a fake instead.

export function openExternalUrl(url: string): void {
  void vscode.env.openExternal(vscode.Uri.parse(url));
}

/** Same toast the API-key setup path offers — a new provider only takes effect
 *  in a session started after the config write. */
export function offerReload(providerName: string, model: string): void {
  void vscode.window
    .showInformationMessage(
      `Origami: ${providerName} connected (${model}). Reload the window to switch to it.`,
      'Reload Window',
    )
    .then((c) => { if (c === 'Reload Window') void vscode.commands.executeCommand('workbench.action.reloadWindow'); });
}
