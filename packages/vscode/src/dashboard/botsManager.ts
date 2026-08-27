// botsManager.ts - the BOTS section's host half.
//
// A "bot" is the agent DEFINITION this board has always edited, read for the
// four things it can now declare about itself (botContract.ts) and given the
// two things a character needs to feel set up: a session of its own, and a
// memory of its own. Nothing here is a parallel subsystem - the def CRUD below
// is the same filesystem CRUD that used to sit in collabManager.ts, moved here
// when that dispatcher reached its cap. Moved HERE specifically, rather than
// into some new sibling, because these four cases ARE the Bots section: the
// list they answer is the list that view renders.
//
// SHAPE: the same MESSAGE_TYPES-set + handler pair collabSupervise.ts and
// chatSectionsManager.ts already use, with one difference - `handleBotMessage`
// returns whether it took the message, because collabManager's `default:` has
// to fall through to the supervision dispatcher on anything this one declines.
//
// FIXTURE-SAFE BY CONSTRUCTION: every path is derived from `host.configDir()`,
// so a test supplies a temp directory and nothing here can resolve the
// developer's real config dir on its own.

import { listCollabAgentDefs, writeCollabAgentDef, deleteCollabAgentDef, listArchetypeRefs, setArchetypeModel, SLUG_RE } from './collabAgentCrud';
import { defFromForm } from './collabAgentDefForm';
import { clearBotMemory, readBotMemory } from './botMemoryStore';
import { globalConfigDir } from './globalConfig';
import { openExternalUrl } from './providerAuthPane';
import { agentDirOf, agentDefPayload } from './botsDefPayload';

/** What this dispatcher needs from the panel. Fine-grained on purpose, so the
 *  module never imports `vscode` and every case runs against a fake. */
export interface BotsManagerHost {
  post(msg: Record<string, unknown>): void;
  /** The origami config directory - `agent/` and `bot/` both live under it. */
  configDir?(): string;
  /**
   * Start a CHAT session running AS one bot definition, and open its tab.
   *
   * TWO names, because they are two different things and the panel needs both:
   * `slug` is the engine agent id the session's mode is set to, and
   * `displayName` is what the chat tab and the header read. Passing the slug
   * for both would title the tab "Collab-crane" for a bot every other surface
   * calls Crane.
   *
   * `glyph` is the def's own `glyph:` key, and the chat is BRANDED from it: a
   * bot's empty state draws that creature where an ordinary chat draws the
   * crane. The panel stamps it onto the session at create time, so every view
   * of that chat is told the same thing. '' = the def states none. (W9 first
   * spent this on the editor TAB icon; that failed UAT and was reversed.)
   *
   * OPTIONAL, and that is deliberate rather than lazy: session creation lives
   * in the panel, so a shell older than this module simply has no such method,
   * and the pane must be told that instead of watching a button do nothing.
   */
  startBotSession?(slug: string, displayName: string, glyph: string): Promise<void>;

  /** Open a URL in the OS browser. Optional test seam — absent, the real
   *  vscode.env.openExternal (via providerAuthPane's openExternalUrl) runs. */
  openExternal?(url: string): void;
}

/** Where the board rail's Docs button lands. The port from origami.gratis
 *  landed 2026-08-22: origamilabs.nl is the live home (verified 200 before this
 *  swap), and the docs page is the button's whole purpose, so it deep-links
 *  there rather than to the root. */
export const DOCS_URL = 'https://origamilabs.nl/docs.html';

/** Every message type this module owns. */
export const BOT_MESSAGE_TYPES = new Set([
  // The def CRUD, moved out of collabManager.ts.
  'listCollabAgentDefs', 'saveCollabAgentDef', 'deleteCollabAgentDef', 'collabArchetypeSetModel',
  // What the Bots section added.
  'startBotSession', 'botMemoryRead', 'botMemoryClear',
  // The board-section handshake (see below).
  'openBotsSection', 'boardReady', 'boardSectionShown',
  // The rail's Docs button (bottom of the board nav).
  'boardOpenDocs',
]);

/**
 * The section a board should show on its next mount, or undefined.
 *
 * MODULE STATE, and the smallest amount that closes the S9 dead end honestly.
 * The collab room and the board are two different webviews: clicking "Manage
 * bots" in a room opens the board tab, but a board being opened for the FIRST
 * time has not attached yet when the broadcast goes out, so the immediate post
 * reaches nobody. The board therefore also ASKS on mount (`boardReady`), and
 * acknowledges what it was given (`boardSectionShown`) - the ack is what stops
 * a request outliving the click and hijacking a board opened an hour later for
 * an unrelated reason.
 */
let pendingSection: string | undefined;

/** Route one Bots-section message. Returns false when it is not ours. */
export async function handleBotMessage(host: BotsManagerHost, m: { type?: string; [k: string]: unknown }): Promise<boolean> {
  switch (m.type) {
    // Agent-def CRUD. Deliberately FILESYSTEM, not an engine method: the pane
    // needs fields (persona, permission, steps, the bot contract) the
    // `collab_agents` wire does not carry. The engine re-scans agent defs on
    // every collab-facing call (collab/acp.ts), so a def saved here is live for
    // the NEXT collab with no restart - only a DELETED def file still needs one.
    case 'listCollabAgentDefs': {
      host.post({ type: 'collabAgentDefs', ...agentDefPayload(host), archetypes: listArchetypeRefs(agentDirOf(host)) });
      return true;
    }
    // Archetype model pin: a byte-surgical single-line frontmatter edit (see
    // archetypeRefs.ts) - NEVER the collab serializer, which would stamp a
    // preset permission block over the archetype's hand-tuned one.
    case 'collabArchetypeSetModel': {
      const err = setArchetypeModel(typeof m.slug === 'string' ? m.slug : '', typeof m.model === 'string' ? m.model : '', agentDirOf(host));
      host.post({ type: 'collabAgentDefs', ...agentDefPayload(host), archetypes: listArchetypeRefs(agentDirOf(host)), ...(err ? { error: err } : {}) });
      return true;
    }
    case 'saveCollabAgentDef': {
      // The stated-only field rule lives in collabAgentDefForm.ts - see there
      // for why an unstated field must not reach the writer at all.
      const err = writeCollabAgentDef(defFromForm(m.def), agentDirOf(host));
      host.post({ type: 'collabAgentDefs', ...agentDefPayload(host), ...(err ? { error: err } : {}) });
      return true;
    }
    case 'deleteCollabAgentDef': {
      const err = deleteCollabAgentDef(typeof m.slug === 'string' ? m.slug : '', agentDirOf(host));
      host.post({ type: 'collabAgentDefs', ...agentDefPayload(host), ...(err ? { error: err } : {}) });
      return true;
    }

    /**
     * A BOT SESSION is an ordinary chat whose agent is this definition - the
     * engine has no `session.kind` and needs none (engine test/collab/
     * bot-session.test.ts). Everything that makes it a bot session follows from
     * the agent alone: the definition's permission tier and skills allowlist
     * (applied in the registry, so every run mode gets them), its own memory
     * (keyed to the definition file) and its model preference.
     */
    case 'startBotSession': {
      const slug = typeof m.slug === 'string' ? m.slug : '';
      if (!SLUG_RE.test(slug)) {
        host.post({ type: 'botSessionResult', slug, error: `"${slug}" is not a valid agent name.` });
        return true;
      }
      if (!host.startBotSession) {
        host.post({ type: 'botSessionResult', slug, error: 'This window cannot start a bot session yet - reload the window and try again.' });
        return true;
      }
      try {
        // The pane sends the name it draws on the card; the slug is the honest
        // fallback when it did not, never a fabricated prettier one.
        //
        // The GLYPH is read off the def on DISK, not the message: the pane's
        // copy is only as fresh as its last list reply.
        const def = listCollabAgentDefs(agentDirOf(host)).find((d) => d.slug === slug);
        await host.startBotSession(slug, typeof m.displayName === 'string' && m.displayName ? m.displayName : slug, def?.glyph ?? '');
        host.post({ type: 'botSessionResult', slug, ok: true });
      } catch (e) {
        host.post({ type: 'botSessionResult', slug, error: e instanceof Error ? e.message : String(e) });
      }
      return true;
    }

    // Memory: see it, wipe it. Both answer with the SAME payload, so a clear
    // and a read leave the pane holding one shape and the wipe is visible as
    // the store it produced rather than as an acknowledgement to be trusted.
    case 'botMemoryRead':
    case 'botMemoryClear': {
      const slug = typeof m.slug === 'string' ? m.slug : '';
      const configDir = host.configDir?.() ?? globalConfigDir();
      const err = m.type === 'botMemoryClear' ? clearBotMemory(configDir, slug) : null;
      host.post({ type: 'botMemoryData', slug, ...readBotMemory(configDir, slug), ...(err ? { error: err } : {}) });
      return true;
    }

    // --- the board-section handshake; see `pendingSection` above ---
    case 'openBotsSection': {
      pendingSection = 'bots';
      host.post({ type: 'boardShowSection', section: 'bots' });
      return true;
    }
    case 'boardReady': {
      if (pendingSection) host.post({ type: 'boardShowSection', section: pendingSection });
      return true;
    }
    case 'boardSectionShown': {
      pendingSection = undefined;
      return true;
    }
    // The rail's Docs button. The URL is HOST-owned (DOCS_URL above) so the
    // webview cannot name an arbitrary target to open.
    case 'boardOpenDocs': {
      (host.openExternal ?? openExternalUrl)(DOCS_URL);
      return true;
    }
    default:
      return false;
  }
}
