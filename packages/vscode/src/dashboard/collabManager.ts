// Collab board messages, routed out of DashboardPanel.ts's switch — mirrors
// agentManager/manager.ts's dispatcher shape (a COLLAB_MESSAGE_TYPES set the
// panel checks BEFORE its own switch, plus a handle() the panel delegates
// to). Every case here is wiring only: the ext-method calls, the guards and
// the payload shapes live in collabData.ts / collabBoardData.ts /
// collabAgentCrud.ts; this file owns the message-type dispatch and the one
// bit of panel state a collab reply needs (its ranked list order).
//
// POLLING NOW HAS TWO SOURCES. `collabPoll` is still a request the mounted
// CollabPane repeats on its own fast timer. Alongside it the HOST runs a slow
// watch of its own (collabWatch.ts), armed from every collab list below, so a
// room whose tab is shut keeps reporting and its sidebar ring stays alive.
import { listCollabAgentDefs } from './collabAgentCrud';
import { BOT_MESSAGE_TYPES, handleBotMessage, type BotsManagerHost } from './botsManager';
import { watchCollabs } from './collabWatch';
import {
  collabAgents,
  collabList,
  collabCreate,
  collabPost,
  collabState,
  collabSetCap,
  collabSetConcurrency,
  collabSetFlavor,
  collabArchive,
  collabRename,
  collabAddParticipant,
  collabRemoveParticipant,
  type CollabSource,
  type CollabListPayload,
} from './collabData';
import { collabSetLead, collabSetObjective, collabStop, collabTaskAdd, collabTaskUpdate, collabLedger, collabUnarchive } from './collabBoardData';
import { SUPERVISE_MESSAGE_TYPES, handleSuperviseMessage } from './collabSupervise';
import type { PromptCapturePayload } from './promptCapture';
import { rankEntries } from './agentManager/sessionOrder';

/** Sidebar drag-to-reorder for Collabs — a collab has no order field of its
 *  own (the engine list is newest-first, no order column), so the order is
 *  persisted under this workspaceState key by the host and applied as a
 *  PROJECTION over the engine's own list. */
export const COLLAB_ORDER_KEY = 'origami.collabOrder';

/** The wider context the dispatcher needs from the panel — same shape
 *  ManagerHost gives agentManager, kept fine-grained so this module never
 *  imports `vscode` and every case is exercised against a fake in tests. */
export interface CollabManagerHost extends BotsManagerHost {
  post(msg: Record<string, unknown>): void;
  cwd(): string;
  /** The client the `collab_*` ext-methods ride. Collabs are WORKSPACE-scoped
   *  (keyed by cwd), not session-scoped, so any live client answers for them. */
  collabClient(): CollabSource | undefined;
  collabOrder(): string[];
  saveCollabOrder(order: string[]): void;
  /** Open a collab's stream in its own editor tab (ensures the shared host,
   *  then hands off to collabTab.ts). */
  openCollab(id: string, title: string): Promise<void>;
  /** A collab participant's last real prompt, resolved off whatever the panel
   *  considers its active-then-any client. */
  promptCaptureFor(sessionId: string | undefined): Promise<PromptCapturePayload>;
}

/** Every message type this dispatcher owns. Checked BEFORE DashboardPanel's
 *  own switch, mirroring AM_MESSAGE_TYPES — the same shortcut, applied to the
 *  Collabs half of the board. */
export const COLLAB_MESSAGE_TYPES = new Set([
  'requestCollabs', 'reorderCollabs', 'requestCollabAgents', 'newCollab', 'openCollab',
  'collabPost', 'collabSetCap', 'collabSetConcurrency', 'collabSetFlavor', 'collabPoll',
  'collabArchive', 'collabUnarchive', 'collabRename', 'collabAddParticipant', 'collabRemoveParticipant',
  'collabPromptCapture',
  // The BOTS section's own set (def CRUD, bot sessions, bot memory, the board
  // handshake) — botsManager.ts. ONE set, one check, same shape as W3's below.
  ...BOT_MESSAGE_TYPES,
  // Flock M4: lead/objective/task board/ledger/stop. All five ARE sent by the
  // room now — the composer's `/lead`, `/objective` and `/stop` (CollabPane's
  // dispatch), and the task drawer's Add/Accept/Reopen plus its ledger fetch.
  'collabSetLead', 'collabSetObjective', 'collabStop',
  'collabTaskAdd', 'collabTaskUpdate', 'requestCollabLedger',
  // W3's four PER-MEMBER methods, in collabSupervise.ts — ONE set, one check.
  ...SUPERVISE_MESSAGE_TYPES,
]);

/** rankEntries owns the never-lose-a-collab rule reorderSessions relies on:
 *  no saved order (or one gone wholly stale) returns null, and that leaves
 *  the engine's own order untouched rather than reshuffling it. */
async function rankedCollabList(host: CollabManagerHost): Promise<CollabListPayload> {
  const payload = await collabList(host.collabClient(), host.cwd());
  // Every list is also the host WATCH's input (collabWatch.ts): an archived or
  // deleted room leaves the watched set here, a new one joins it, and neither
  // needs a wire call of its own. `CollabManagerHost` satisfies CollabWatchHost
  // structurally, so the host goes straight through.
  watchCollabs(host, payload.collabs.filter((c) => !c.archivedAt).map((c) => c.id));
  const order = host.collabOrder();
  const ranked = rankEntries(payload.collabs.map((c): [string, typeof c] => [c.id, c]), order);
  return ranked ? { ...payload, collabs: ranked.map(([, c]) => c) } : payload;
}

/** Route one `collab*`/`*CollabAgentDef*` webview message. Fire-and-forget
 *  from the panel switch, same calling convention as agentManager.handle(). */
export async function handleCollabMessage(host: CollabManagerHost, m: { type?: string; [k: string]: unknown }): Promise<void> {
  switch (m.type) {
    case 'requestCollabs': {
      host.post({ type: 'collabList', ...(await rankedCollabList(host)) });
      return;
    }
    case 'reorderCollabs': {
      // The order is saved here, not sent to the engine, then the SAME ranked
      // projection is echoed back so the sidebar settles on it (same
      // optimistic-echo shape as reorderSessions).
      const order = Array.isArray(m.order)
        ? (m.order as unknown[]).map((v) => String(v ?? ''))
        : [];
      if (order.length > 0) host.saveCollabOrder(order);
      host.post({ type: 'collabList', ...(await rankedCollabList(host)) });
      return;
    }
    case 'requestCollabAgents': {
      // The `collab_agents` wire has no glyph field, and adding one would be
      // a protocol change for a presentation detail. So the GLYPH is merged
      // in here, read fs-side from the same def files the engine loaded.
      const glyphs: Record<string, string> = {};
      for (const d of listCollabAgentDefs()) if (d.glyph) glyphs[d.slug] = d.glyph;
      host.post({ type: 'collabAgents', ...(await collabAgents(host.collabClient(), host.cwd())), glyphs });
      return;
    }
    case 'newCollab': {
      const title = typeof m.title === 'string' ? m.title.trim() : '';
      const slugs = Array.isArray(m.agentSlugs) ? m.agentSlugs.filter((s): s is string => typeof s === 'string') : [];
      // Flock M4: the create form's optional objective. Absent stays absent —
      // the leaf omits the field rather than sending an empty string.
      const objective = typeof m.objective === 'string' ? m.objective.trim() : undefined;
      const created = await collabCreate(host.collabClient(), title, slugs, host.cwd(), objective);
      host.post({ type: 'collabCreated', ...created });
      // Re-list from the ENGINE rather than splicing the new row in locally.
      if (created.collab) host.post({ type: 'collabList', ...(await rankedCollabList(host)) });
      return;
    }
    case 'openCollab': {
      const id = typeof m.collabId === 'string' ? m.collabId : '';
      const title = typeof m.title === 'string' && m.title ? m.title : id;
      if (id) await host.openCollab(id, title);
      return;
    }
    case 'collabPost': {
      const id = typeof m.collabId === 'string' ? m.collabId : '';
      const text = typeof m.text === 'string' ? m.text : '';
      // Flock M4 (C17): the composer's parsed @mentions, already filtered
      // against the active roster webview-side. Strings only, and undefined
      // rather than [] when nothing was named, so the field stays off the wire.
      const named = Array.isArray(m.mentions) ? m.mentions.filter((s): s is string => typeof s === 'string') : [];
      // M4.2: the composer's attachments, as bare `data:` URLs. Same shape rule
      // as the mentions — strings only, undefined rather than [] when there are
      // none, so an ordinary post keeps today's exact wire shape. The COUNT and
      // SIZE limits are the engine's; it refuses the whole post for one over
      // the line and names which limit it hit.
      const pics = Array.isArray(m.images) ? m.images.filter((s): s is string => typeof s === 'string' && !!s) : [];
      host.post({ type: 'collabPosted', ...(await collabPost(host.collabClient(), id, text, host.cwd(), named.length ? named : undefined, pics.length ? pics : undefined)) });
      return;
    }
    case 'collabSetCap': {
      // null restores the engine default and 0 turns the loop breaker OFF —
      // two different things, so `cap` is threaded through UNCOALESCED.
      const id = typeof m.collabId === 'string' ? m.collabId : '';
      const raw = typeof m.cap === 'number' && Number.isFinite(m.cap) ? Math.trunc(m.cap) : null;
      const cap = raw !== null && raw >= 0 ? raw : null;
      host.post({ type: 'collabCapSet', ...(await collabSetCap(host.collabClient(), id, cap, host.cwd())) });
      return;
    }
    case 'collabSetConcurrency': {
      // Sent as an ORDINARY collabOpResult, not a `collabCapSet` twin: the
      // engine can refuse this one (a member that can still write files), and
      // the op-result path is what already carries a refusal to the room and
      // re-polls so the control snaps back to what actually stuck.
      const id = typeof m.collabId === 'string' ? m.collabId : '';
      const raw = typeof m.concurrency === 'number' && Number.isFinite(m.concurrency) ? Math.trunc(m.concurrency) : 1;
      const width = raw >= 1 ? raw : 1;
      host.post({ type: 'collabOpResult', op: m.type, ...(await collabSetConcurrency(host.collabClient(), id, width, host.cwd())) });
      return;
    }
    case 'collabSetFlavor': {
      // An ORDINARY collabOpResult, like the width and unlike the cap: the
      // engine REFUSES a council whose member can still write files, and the
      // op-result path is what carries a refusal into the room and re-polls, so
      // the control snaps back to the flavor that actually stuck.
      const id = typeof m.collabId === 'string' ? m.collabId : '';
      // Passed through unvalidated on purpose: which flavors exist is the
      // engine's to answer, and it names the ones that do in its refusal.
      const flavor = typeof m.flavor === 'string' ? m.flavor : '';
      host.post({ type: 'collabOpResult', op: m.type, ...(await collabSetFlavor(host.collabClient(), id, flavor, host.cwd())) });
      return;
    }
    case 'collabPoll': {
      const id = typeof m.collabId === 'string' ? m.collabId : '';
      const since = typeof m.sinceSeq === 'number' && m.sinceSeq > 0 ? Math.trunc(m.sinceSeq) : 0;
      host.post({ type: 'collabStateData', ...(await collabState(host.collabClient(), id, since, host.cwd())) });
      return;
    }
    // All five answer with the SAME `collabOpResult` (re-poll/re-list rule below).
    case 'collabArchive':
    case 'collabUnarchive':
    case 'collabRename':
    case 'collabAddParticipant':
    case 'collabRemoveParticipant': {
      const id = typeof m.collabId === 'string' ? m.collabId : '';
      const slug = typeof m.agentSlug === 'string' ? m.agentSlug : '';
      const title = typeof m.title === 'string' ? m.title.trim() : '';
      const client = host.collabClient();
      const res =
        m.type === 'collabArchive' ? await collabArchive(client, id, host.cwd())
        : m.type === 'collabUnarchive' ? await collabUnarchive(client, id, host.cwd())
        : m.type === 'collabRename' ? await collabRename(client, id, title, host.cwd())
        : m.type === 'collabAddParticipant' ? await collabAddParticipant(client, id, slug, host.cwd())
        : await collabRemoveParticipant(client, id, slug, host.cwd());
      host.post({ type: 'collabOpResult', op: m.type, ...res });
      // Archive/unarchive both move the row into or out of History, which no
      // pane's poll would ever report — so re-list on success, and only then.
      if (res.ok && (m.type === 'collabArchive' || m.type === 'collabUnarchive')) {
        host.post({ type: 'collabList', ...(await rankedCollabList(host)) });
      }
      return;
    }
    case 'collabPromptCapture': {
      // Its session is the one the ROSTER named, never the panel's active
      // chat — the reply carries both ids back, because `post` reaches every
      // view and a capture painted under the wrong agent's name would be a lie.
      const collabId = typeof m.collabId === 'string' ? m.collabId : '';
      const sessionId = typeof m.sessionId === 'string' ? m.sessionId : undefined;
      const slug = typeof m.slug === 'string' ? m.slug : '';
      host.post({
        type: 'collabPromptCaptureData',
        collabId,
        slug,
        ...(await host.promptCaptureFor(sessionId)),
      });
      return;
    }
    // Agent-def CRUD, bot sessions and bot memory left for botsManager.ts when
    // this file reached its cap. They ARE the Bots section, so they went to the
    // module named for it rather than to a fall-through sibling; the `default:`
    // below routes them.
    // --- Flock M4: lead / objective / task board / ledger / stop. Same
    // engine-stays-authoritative shape as the M2 mutations above — a result
    // payload back, no optimistic splice. All of them are driven from the room
    // (composer slash commands and the task drawer), so a refusal here reaches
    // a real surface.
    case 'collabSetLead': {
      const id = typeof m.collabId === 'string' ? m.collabId : '';
      const slug = typeof m.agentSlug === 'string' ? m.agentSlug : null;
      host.post({ type: 'collabOpResult', op: m.type, ...(await collabSetLead(host.collabClient(), id, slug, host.cwd())) });
      return;
    }
    case 'collabSetObjective': {
      const id = typeof m.collabId === 'string' ? m.collabId : '';
      const objective = typeof m.objective === 'string' ? m.objective : '';
      host.post({ type: 'collabOpResult', op: m.type, ...(await collabSetObjective(host.collabClient(), id, objective, host.cwd())) });
      return;
    }
    case 'collabStop': {
      const id = typeof m.collabId === 'string' ? m.collabId : '';
      host.post({ type: 'collabOpResult', op: m.type, ...(await collabStop(host.collabClient(), id, host.cwd())) });
      return;
    }
    case 'collabTaskAdd': {
      const id = typeof m.collabId === 'string' ? m.collabId : '';
      const title = typeof m.title === 'string' ? m.title.trim() : '';
      host.post({ type: 'collabTaskResult', op: m.type, ...(await collabTaskAdd(host.collabClient(), id, title, host.cwd())) });
      return;
    }
    case 'collabTaskUpdate': {
      const id = typeof m.collabId === 'string' ? m.collabId : '';
      const taskId = typeof m.taskId === 'string' ? m.taskId : '';
      const action = m.action === 'claim' || m.action === 'done' || m.action === 'accept' || m.action === 'reopen' ? m.action : undefined;
      if (!action) {
        host.post({ type: 'collabTaskResult', op: m.type, collabId: id, task: null, error: 'Unknown task action.' });
        return;
      }
      const extra = {
        ...(typeof m.result === 'string' ? { result: m.result } : {}),
        ...(typeof m.note === 'string' ? { note: m.note } : {}),
        ...(typeof m.owner === 'string' ? { owner: m.owner } : {}),
      };
      host.post({ type: 'collabTaskResult', op: m.type, ...(await collabTaskUpdate(host.collabClient(), id, taskId, action, extra, host.cwd())) });
      return;
    }
    case 'requestCollabLedger': {
      const id = typeof m.collabId === 'string' ? m.collabId : '';
      const limit = typeof m.limit === 'number' ? m.limit : undefined;
      host.post({ type: 'collabLedgerData', ...(await collabLedger(host.collabClient(), id, limit, host.cwd())) });
      return;
    }
    // A type this switch does not name belongs to one of the two dispatchers
    // this file routes for, never written twice. Bots answers whether it took
    // the message, so the supervision four still get everything it declined.
    default:
      if (await handleBotMessage(host, m)) return;
      await handleSuperviseMessage(host, m);
  }
}
