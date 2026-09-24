// The one listener for a group change the pane did not ask for (t-s9jr6u): a
// desk joined, said hello or went away. The controller calls notify; the pane
// host subscribes on groupRequest. Last registration wins: one board per window.

let changeListener: (() => void) | null = null;

export function onGroupChange(fn: (() => void) | null): void {
  changeListener = fn;
}

export function notifyGroupChange(): void {
  changeListener?.();
}
