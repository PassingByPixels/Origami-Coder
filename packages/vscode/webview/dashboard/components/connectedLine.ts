// connectedLine.ts — t-yyz5yk (Round 8 E): recognise the host's "session is
// up" system line so the transcript can draw it as a handshake row.
//
// The sentence is built in ONE place, src/dashboard/sessionFork.ts
// startSystemLine(): `Connected. Session <id>. Type a message and press Enter.`
// A webview leaf may not import from src/ (TS6059), so the shape is matched
// here; a line that does not match exactly stays a plain system row, so a
// change on the host side degrades to today's look, never to a wrong one.
const CONNECTED = /^Connected\. Session (\S+)\. Type a message and press Enter\.$/;

export function connectedSessionId(text: string): string | undefined {
  return CONNECTED.exec(text.trim())?.[1];
}

/** `ses_f2a05386dffeA9nEVnmqUnmc34` -> `ses_f2a0…Unmc34`. Short ids stay whole. */
export function shortSessionId(id: string): string {
  return id.length > 16 ? `${id.slice(0, 8)}…${id.slice(-6)}` : id;
}
