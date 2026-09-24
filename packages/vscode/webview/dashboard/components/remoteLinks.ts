// The two off-board destinations the Remote pane points at.
//
// Constants, NOT settings. A relay is a thing a person decides to trust, and
// the guide that tells them how to run their own must be reachable from the
// pane even when the pane cannot reach the engine, the relay or the network —
// a setting that could be blank, wrong or policy-locked would take the escape
// hatch away at exactly the moment it is needed. Neither URL is fetched by the
// extension; both are hrefs the webview hands to VS Code to open externally.

/** The self-host guide (the `selfhost/` kit published as its own repository). */
export const REMOTE_SELF_HOST_URL = 'https://github.com/PassingByPixels/origami-relay';

/** Where a person gets the Origami Remote phone app: the Labs site's Remote page
 *  (relay.html — the page every site link calls "Remote"; a `remote.html` never
 *  existed and 404'd) until the app has a public listing of its own — one
 *  constant to change then, rather than a link buried in a step. */
export const REMOTE_APP_URL = 'https://origamilabs.nl/relay.html';
