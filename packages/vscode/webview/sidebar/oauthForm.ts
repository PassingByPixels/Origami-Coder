// oauthForm.ts: what the OAuth sign-in form shows, as pure rules.
//
// Sibling to oauthCard.ts: oauthCard answers what a provider's settings
// fold offers (sign in / reauthorize / nothing); this file answers what
// the open form displays while a sign-in is running. Same leaf discipline:
// no DOM, no vscode import.

/**
 * The user code inside a plugin's `instructions`, or '' when there is none.
 *
 * Device-code plugins write the code after "enter code:"; a browser flow's
 * instructions never contain that phrase, so they correctly answer ''.
 *
 * Matching "enter code:", not a bare "code:", is load-bearing: the posted
 * string can also carry an OS error message that says "code:" on its own
 * ("exit code: 1"), and a bare match would show that number as the code.
 *
 * Trailing punctuation is excluded, so a sentence-final full stop or quote
 * is not copied into the clipboard as part of the code.
 */
export function deviceCodeOf(instructions: string | undefined): string {
  const match = /\benter code:\s*([A-Za-z0-9][A-Za-z0-9-]*)/i.exec(instructions ?? '');
  return match ? match[1] : '';
}

/**
 * The sentence under the sign-in buttons, per OAuth provider.
 *
 * Mirrors the `hint` field of src/dashboard/oauthConnections.ts's
 * OAUTH_PROVIDERS: the webview cannot import a runtime value out of src/,
 * so the two texts are kept separately but load-bearing-phrase compatible.
 * An unknown id answers '' rather than falling through to another
 * provider's copy.
 */
const FORM_HINTS: Record<string, string> = {
  openai:
    'Signs in with your ChatGPT Plus/Pro account. The models come from the ChatGPT subscription backend (the gpt-5.x Codex family), not the OpenAI platform API — a platform key is a different, metered catalog under the "OpenAI (API)" entry. No API key is stored for this connection.',
  xai: 'Signs in with your SuperGrok subscription. xAI gates OAuth by subscription tier — if sign-in or the first message comes back 403, your plan does not carry OAuth access; use the "Grok (API)" API-key entry instead. No API key is stored for this connection.',
  'github-copilot':
    'Signs in with your GitHub Copilot subscription using a device code: GitHub shows a page, and you type the code above into it. Only github.com is offered here — GitHub Enterprise needs the CLI. Three GPT models are written now, and the rest of what your plan carries is added to the picker once you are signed in. No API key is stored for this connection.',
};

export function oauthFormHint(providerId: string): string {
  return FORM_HINTS[providerId] ?? '';
}
