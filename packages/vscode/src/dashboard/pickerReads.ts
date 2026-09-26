// pickerReads.ts — t-y5ecbc: what the model picker's two posts (`modelOptions`,
// `providerStatus`) may read without waiting on a chat engine that is still starting.
// DashboardPanel.ts is near its line cap; the rule lives here.
//
// Owner UAT of 0.4.179: a new chat's picker said "Loading models…" for 4-5 s. The picker
// draws that row until its first `providerStatus` lands (NoConnections.svelte). A new chat
// is the active chat from the moment it is registered, before its engine has booted, and
// both posts asked that engine first: the Claude (Sub) Gate B read (`modelOptions` since
// t-tija5f, `providerStatus` since 0.4.179, t-xu5oty) and the OAuth store read. An engine
// that is booting answers nothing, so each post waited for the boot.
//
// THE RULE. A starting engine is not asked. The model list is not per chat: until the
// chat's engine has answered its session, the picker shows the list another chat's engine
// already gave (read from memory: no engine is called, so no hidden chat is woken), else
// the last list seen. The Gate B and OAuth answers come from the last engine answer. When
// the chat's engine is up, DashboardPanel's start calls broadcastModelStatus, which posts
// the chat's own list again (and, for a status row left unread here, a provider pass).

type ModelOption = { current: string; options: Array<{ value: string; name: string }> };

/** The slice of a DashboardPanel Session this reads. */
export interface PickerChat {
  gate?: { current: string };
  client?: { getModelOption(): ModelOption | null } | null;
}

let lastOption: ModelOption | null = null;
let lastOauthIds: Set<string> | undefined;

/** The chat's engine has answered its session (its model list is in) and is not parked: a call to it answers now. */
export function engineAnswered(chat: PickerChat | undefined): boolean {
  return !!chat && chat.gate?.current !== 'parked' && !!chat.client?.getModelOption();
}

/** A chat whose engine has not answered its session yet (booting, or its start failed), and is not parked. It is not asked. */
export function engineStarting(chat: PickerChat | undefined): boolean {
  return !!chat && chat.gate?.current !== 'parked' && !chat.client?.getModelOption();
}

/**
 * `own`: the active chat's list (null until its engine has answered). `shown`: the list the
 * picker gets now — `own`, else the first list another chat's engine already gave, else the
 * last one seen in this window, else null (the caller then seeds from origami.json). With no
 * active chat at all both are null, as before: the caller seeds from origami.json.
 */
export function pickerModelOption(active: PickerChat | undefined, chats: Iterable<PickerChat>): { own: ModelOption | null; shown: ModelOption | null } {
  if (!active) return { own: null, shown: null };
  const own = active.client?.getModelOption() ?? null;
  let shown = own;
  for (const chat of chats) {
    if (shown) break;
    shown = chat.client?.getModelOption() ?? null;
  }
  if (shown) lastOption = shown;
  return { own, shown: shown ?? lastOption };
}

/** The OAuth ids an answered read gave last (undefined = never answered in this window). */
export function rememberOauthIds(ids: Set<string> | undefined): Set<string> | undefined {
  if (ids) lastOauthIds = ids;
  return ids;
}
export function lastKnownOauthIds(): Set<string> | undefined {
  return lastOauthIds;
}

/** Test seam: the memory is window-wide. */
export function resetPickerReads(): void {
  lastOption = null;
  lastOauthIds = undefined;
}
