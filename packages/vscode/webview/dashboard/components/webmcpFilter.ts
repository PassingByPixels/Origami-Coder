// The Web MCP view's ONE filter predicate.
//
// The site box lives in MCPPane.svelte's toolbar (each half of the pane owns
// its own search — the servers box never filters sites, and vice versa), but
// the LIST it narrows is rendered by WebMCPSection.svelte, which also needs
// the same answer for its "no sites match" empty state. The pane additionally
// shows an n/m count next to the box. Two copies of the predicate would let
// the count drift from the cards, so both sides call this leaf.
//
// PURE and webview-side on purpose, the same reason mcpAddForm.ts is: the two
// components need the SAME answer, and a pure function is testable with no DOM.

/** The three fields a site can be found by. Everything else rides through. */
export interface WebMcpSiteFields {
  readonly url: string;
  readonly name: string;
  readonly purpose: string;
}

/**
 * Case-insensitive substring match on name, purpose or url — the three fields
 * the card shows, so anything the user can SEE on a card can find it. A blank
 * or whitespace query filters nothing (the box starts empty and stays cheap).
 */
export function filterWebMcpSites<T extends WebMcpSiteFields>(sites: T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return sites;
  return sites.filter(
    (s) =>
      s.name.toLowerCase().includes(q) ||
      s.purpose.toLowerCase().includes(q) ||
      s.url.toLowerCase().includes(q),
  );
}
