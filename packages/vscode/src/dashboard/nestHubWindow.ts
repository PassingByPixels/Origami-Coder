// nestHubWindow.ts — t-sc093o: the one NestHub per VS Code window, and the
// sidebar's source over it. activateGroup.ts attaches the group; the panel's
// nestSidebar.ts route attaches the view (engine client, broadcast, opener).
// Split from nestSidebar.ts, which is at its cap.

import { readNestsEnabled } from '../remote/nestsSetting';
import type { GroupController } from '../remote/groupController';
import { NestHub } from './nestHub';
import type { NestSource } from './nestSidebar';

export const nestHub = new NestHub({
  enabled: () => readNestsEnabled(),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  status: (text) => console.warn(`[origami] ${text}`),
});

/** The hub as the sidebar's source. No device id yet (Nests just turned on, or
 *  a desk in no nest) = no index. Each read refreshes from nest_index first. */
export const hubNestSource: NestSource = {
  index: async () => {
    if (!nestHub.deviceId()) return null;
    await nestHub.sync([]).catch(() => undefined);
    const p = nestHub.payload();
    return { selfId: nestHub.deviceId(), rows: p['rows'] as unknown[], desks: p['desks'] as unknown[] };
  },
  continueHere: (id) => nestHub.continueHere(id),
};

/** The group side of the hub: this desk's id, the roster, and a sealed send per peer. */
export function attachNestGroup(c: GroupController, deskName: string): void {
  nestHub.attachGroup({ deviceId: () => c.deviceId, deskName, devices: () => c.snapshot().devices, send: (p, m) => c.send(p, m) });
}
