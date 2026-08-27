// The connection surface is ALWAYS the compact grid of traffic-light squares
// — no pill phase, from the very first configured provider on. Pure +
// display-only, mirroring the modelGrouping.ts pattern: the DECISION (which
// surface, which colour, what the tooltip says) lives here, unit-testable
// with no DOM; ControlStrip only renders it.

/** True once at least one provider is configured — the grid IS the layout;
 *  zero configured providers still show the "+ Add provider" empty state. */
export function useGrid(count: number): boolean {
  return count > 0;
}

export interface GridProviderStatus {
  name: string;
  live: boolean;
  reason?: string;
  /** An OAuth credential for this provider is on file in the ENGINE's store.
   *  Its config block deliberately carries no apiKey (the plugin injects the
   *  real bearer), so the host's key-presence probe reports it "not
   *  configured" — a red light for a connection that works. The engine's own
   *  credential store is the truth for those, and it wins here. */
  oauth?: boolean;
}

/** The traffic light for a provider: green = live, or signed in via OAuth;
 *  red = the host probed and it genuinely failed (not live, with a reason);
 *  yellow = not live but no reason yet (the probe hasn't answered / unknown). */
export function lightOf(p: GridProviderStatus): 'green' | 'red' | 'yellow' {
  if (p.live || p.oauth) return 'green';
  return p.reason ? 'red' : 'yellow';
}

/** The square's tooltip/aria-label: the connection name, plus the reason when
 *  red (the only state with something to add). Name alone otherwise. */
export function gridLabel(p: GridProviderStatus): string {
  return lightOf(p) === 'red' && p.reason ? `${p.name} — ${p.reason}` : p.name;
}
