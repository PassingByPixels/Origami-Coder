// trayKeys.ts: which option, if any, a key press answers on the consent tray
// (t-yyz5qi, mockup B: "Deny (Esc) / Allow once (Enter)"). Pure and DOM-free
// apart from reading the event target, so the rule is testable with no render.

import { isQuestionShaped, type PermOption } from './permissionOptions';

/** The option Enter answers: allow ONCE only, never "always" (least privilege). */
export function enterOption(options: ReadonlyArray<PermOption>): PermOption | null {
  return options.find((o) => o.kind === 'allow_once') ?? null;
}

/** The option Esc answers: the plain reject, never "Revise" (that opens a box). */
export function escOption(options: ReadonlyArray<PermOption>): PermOption | null {
  return options.find((o) => o.kind === 'reject_once' && o.name !== 'Revise') ?? null;
}

/**
 * The option id a key answers, or `null` to leave the key alone.
 *
 * Only a CONSENT ask takes keys; a question answers with a pick. Keys typed
 * into a text field are the field's: the composer's Enter sends (it may carry
 * a picture with no words), so an approval never rides on it. A key another
 * handler already took is left alone.
 */
export function trayKeyAnswer(
  e: { key: string; target: EventTarget | null; defaultPrevented: boolean; shiftKey?: boolean; ctrlKey?: boolean; altKey?: boolean; metaKey?: boolean; isComposing?: boolean },
  options: ReadonlyArray<PermOption>,
): string | null {
  if (e.defaultPrevented || e.isComposing || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return null;
  if (e.key !== 'Enter' && e.key !== 'Escape') return null;
  if (isQuestionShaped(options)) return null;
  const t = e.target as HTMLElement | null;
  if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.isContentEditable === true)) return null;
  if (e.key === 'Enter' && t && t.tagName === 'BUTTON') return null; // a focused button keeps its own Enter
  return (e.key === 'Enter' ? enterOption(options) : escOption(options))?.optionId ?? null;
}
