// collabHealth.ts — CAN this agent take a turn? A pure leaf, so the rule is
// assertable without a DOM, mirroring collabInvite.ts / collabHop.ts.
//
// The report's S6: nothing in the invite list tells you whether an agent will
// work, so a user picks one pinned to a disconnected provider and finds out at
// the first turn, as a red `!` on a chip. The data to answer it already exists
// — the dashboard's `providerStatus` broadcast, which the collab agents pane
// already asks for (CollabAgentsPane.svelte's requestProviderStatus).
//
// TWO STATES THIS MUST KEEP APART, because both are ordinary and only one is a
// fault:
//
//   UNPINNED — the def pins no model, so the agent runs on whatever the
//   session's model is. Since the shipped seeds now ship unpinned (report 1.7),
//   this is the out-of-the-box state of a fresh machine. It is a "pick one"
//   prompt, never a broken provider.
//
//   UNKNOWN — a pin whose provider is not in the status list. That list is
//   EMPTY until the first probe answers, so folding unknown into dead would
//   mark every candidate unreachable for one round trip and then silently
//   correct itself. Unknown draws nothing.

/** One row of the host's `providerStatus` broadcast — the only two fields this
 *  rule reads. The broadcast carries more (name, kind, baseURL, flavor); a
 *  wider shape still satisfies this. */
export interface ProviderLiveness {
  id: string;
  live: boolean;
}

export interface AgentHealth {
  kind: 'unpinned' | 'live' | 'dead' | 'unknown';
  /** The provider id the pin names, or '' when the pin names none. */
  provider: string;
}

/** The provider id of a `provider/model` pin. OpenRouter models carry a vendor
 *  path of their own (`openrouter/poolside/laguna-s-2.1:free`), so only the
 *  FIRST segment is the provider. A pin with no slash names no provider — it
 *  is a bare model id, and inventing a provider for it would be a guess. */
export function providerOf(model: string | null | undefined): string {
  if (!model) return '';
  const slash = model.indexOf('/');
  return slash === -1 ? '' : model.slice(0, slash);
}

/** What the invite list should say about one candidate. */
export function agentHealth(
  model: string | null | undefined,
  providers: ProviderLiveness[],
): AgentHealth {
  if (!model) return { kind: 'unpinned', provider: '' };
  const provider = providerOf(model);
  if (!provider) return { kind: 'unknown', provider: '' };
  const row = providers.find((p) => p.id === provider);
  if (!row) return { kind: 'unknown', provider };
  return { kind: row.live ? 'live' : 'dead', provider };
}

/** The marker's words, or '' for "say nothing". Kept beside the rule so the
 *  two surfaces that draw it (the invite list, the setup card) cannot drift. */
export function healthLabel(health: AgentHealth): string {
  if (health.kind === 'unpinned') return 'needs a model';
  if (health.kind === 'dead') return `${health.provider} unreachable`;
  return '';
}
