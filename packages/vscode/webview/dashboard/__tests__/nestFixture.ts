// t-s9k0q6 — a typed nest index fixture: the round-7 demo data in the L4a
// wire shape (origami/nestIndex). Tests and the mock rig drive the sidebar
// with it until L4a's real index lands. `NOW` pins every age.
import type { NestDesk, NestIndexRow } from '../../chat/nestIndex';

export const NOW = Date.UTC(2026, 8, 22, 14, 30);
const MIN = 60_000;

export const SELF: NestDesk = { id: 'dev-surface', name: 'Surface', os: 'windows', online: true, lastSeen: NOW, motherBase: false };
export const RTX: NestDesk = { id: 'dev-5090', name: '5090', os: 'windows', online: true, lastSeen: NOW, motherBase: true };
export const MAC: NestDesk = { id: 'dev-mac', name: 'MacBook', os: 'macos', online: false, lastSeen: NOW - 180 * MIN, motherBase: false };

function row(id: string, title: string, desk: NestDesk, state: NestIndexRow['state'], minsAgo: number): NestIndexRow {
  return { id, title, desk: desk.id, deskName: desk.name, state, owner: desk.id, lastAt: NOW - minsAgo * MIN, size: 1000, seq: 1 };
}

/** Three open chats on two desks (MacBook offline), six closed ones. */
export const ROWS: NestIndexRow[] = [
  row('n-peer', 'Element: Peer message', MAC, 'open', 180),
  row('n-cron', 'Coder: Cron sweep for the board', RTX, 'running', 0),
  row('n-agent', 'Element: Agent message', RTX, 'open', 8),
  row('n-snow', 'Aetheron: snow shader pass', RTX, 'closed', 1500),
  row('n-dflash', 'Spark: DFlash acceptance sweep', RTX, 'closed', 300),
  row('n-tf', 'iOS: TestFlight notes', MAC, 'closed', 1300),
  row('n-relay', 'Coder: relay heartbeat bug', RTX, 'closed', 4300),
  row('n-csp', 'Relay: phone page CSP', MAC, 'closed', 5800),
  row('n-wh3', 'WH3: dwarf unit table', RTX, 'closed', 10100),
];

export const DESKS: NestDesk[] = [SELF, RTX, MAC];

export function nestPush(rows: NestIndexRow[] = ROWS, desks: NestDesk[] = DESKS) {
  return { type: 'origami/nestIndex', rows, desks };
}
