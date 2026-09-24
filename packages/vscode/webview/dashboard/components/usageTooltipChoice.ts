// usageTooltipChoice.ts — WHICH limit the usage pill's tooltip names.
//
// EXTRACTED from ModelPicker.svelte, which was exactly on its 610-line cap
// when the pill's tooltip became a warm tooltip and needed one import line.
// The rule was already a branching display decision sitting beside its
// siblings usagePillText.ts and usageWindowsTooltip.ts, so this is where it
// belongs: a pure leaf, testable with nothing rendered.
//
// Two or more reported windows list EVERY one of them (owner's ask: a 73%
// five-hour lane must not hide a maxed-out monthly one). One window, or none
// reported at all, falls back to the single-sentence title, then to the pill
// text itself — never to an empty tooltip on a pill that says something.

export interface UsageTooltipInput {
  /** The Claude-subscription pill's text, '' when this is not that pill. */
  ccUsageText: string;
  /** Its windows, and the one-sentence title it falls back to. */
  ccWindowCount: number;
  ccPillTitle: string;
  /** The generic provider pill's windows and text. */
  genericWindowCount: number;
  genericText: string;
  /** Pre-rendered multi-window list, built by usageWindowsTooltip.ts. */
  ccList: string;
  genericList: string;
  /** The pill's own text, the last fallback. */
  usageText: string;
}

export function chooseUsageTooltip(i: UsageTooltipInput): string {
  if (i.ccUsageText) {
    return i.ccWindowCount > 1 ? i.ccList : (i.ccPillTitle || i.usageText);
  }
  return i.genericWindowCount > 1 ? i.genericList : i.genericText;
}
