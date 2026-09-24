// botsManager.ts - the BOTS section's host half.
//
// A "bot" is the same agent definition this board has always edited, read
// for what it declares about itself (botContract.ts) and given a session and
// a memory of its own. The def CRUD is the same filesystem CRUD that used to
// sit in collabManager.ts, moved here because it IS the Bots section.
//
// Every path derives from `host.configDir()`, so a test is fixture-safe by construction.

import { listCollabAgentDefs, writeCollabAgentDef, deleteCollabAgentDef, listArchetypeRefs, setArchetypeModel, SLUG_RE } from './collabAgentCrud';
import { defFromForm } from './collabAgentDefForm';
import { clearBotMemory, readBotMemory } from './botMemoryStore';
import { globalConfigDir } from './globalConfig';
import { openExternalUrl } from './providerAuthPane';
import { agentDirOf, agentDefPayload } from './botsDefPayload';
import { clearBoardSection, pendingBoardSection, requestBoardSection } from './boardSection';

/** What this dispatcher needs from the panel. Fine-grained on purpose, so the
 *  module never imports `vscode` and every case runs against a fake. */
export interface BotsManagerHost {
  post(msg: Record<string, unknown>): void;
  /** The origami config directory - `agent/` and `bot/` both live under it. */
  configDir?(): string;
    /**
     * Start a CHAT session running AS one bot definition, and open its tab.
     *
     * `slug` is the engine agent id; `displayName` is what the tab reads —
     * passing the slug for both would mislabel the chat. `glyph` brands the
     * chat's empty state with the bot's own creature. Optional: a host older
     * than this module simply lacks the method, and the pane must be told so.
     */
  startBotSession?(slug: string, displayName: string, glyph: string): Promise<void>;

  /** Open a URL in the OS browser. Optional test seam — absent, the real
   *  vscode.env.openExternal (via providerAuthPane's openExternalUrl) runs. */
  openExternal?(url: string): void;
}

/** Where the board rail's Docs button lands — the live docs site,
 *  deep-linked to the docs page rather than the root. */
export const DOCS_URL = 'https://origamilabs.nl/docs.html';

/** Every message type this module owns. */
export const BOT_MESSAGE_TYPES = new Set([
  'listCollabAgentDefs', 'saveCollabAgentDef', 'deleteCollabAgentDef', 'collabArchetypeSetModel',
  'startBotSession', 'botMemoryRead', 'botMemoryClear',
  'openBotsSection', 'openBoardSection', 'boardReady', 'boardSectionShown',
  // The rail's Docs button (bottom of the board nav).
  'boardOpenDocs',
]);

// The pending-section handshake itself lives in boardSection.ts - see there
// for why a request must be acknowledged, and why a COMMAND needs it too.

/** Route one Bots-section message. Returns false when it is not ours. */
export async function handleBotMessage(host: BotsManagerHost, m: { type?: string; [k: string]: unknown }): Promise<boolean> {
  switch (m.type) {
        // Agent-def CRUD is filesystem, not an engine method: the pane needs
        // fields the `collab_agents` wire doesn't carry. The engine re-scans defs
        // on every collab call, so a saved def is live immediately; only a deleted one needs a
        // restart.
    case 'listCollabAgentDefs': {
      host.post({ type: 'collabAgentDefs', ...agentDefPayload(host), archetypes: listArchetypeRefs(agentDirOf(host)) });
      return true;
    }
        // Archetype model pin: a byte-surgical single-line edit — NEVER the
        // collab serializer, which would stamp a preset block over a hand-tuned one.
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
         * A bot session is an ordinary chat whose agent is this definition —
         * permission tier, skills allowlist, memory and model all follow from
         * the agent alone.
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
                // The pane's sent name is honored; the slug is the fallback. The
                // glyph is read off the def on disk, since the pane's copy may be stale.
        const def = listCollabAgentDefs(agentDirOf(host)).find((d) => d.slug === slug);
        await host.startBotSession(slug, typeof m.displayName === 'string' && m.displayName ? m.displayName : slug, def?.glyph ?? '');
        host.post({ type: 'botSessionResult', slug, ok: true });
      } catch (e) {
        host.post({ type: 'botSessionResult', slug, error: e instanceof Error ? e.message : String(e) });
      }
      return true;
    }

        // Memory read and clear answer with the SAME payload shape, so a wipe is
        // visible as the resulting store rather than as a bare acknowledgement.
    case 'botMemoryRead':
    case 'botMemoryClear': {
      const slug = typeof m.slug === 'string' ? m.slug : '';
      const configDir = host.configDir?.() ?? globalConfigDir();
      const err = m.type === 'botMemoryClear' ? clearBotMemory(configDir, slug) : null;
      host.post({ type: 'botMemoryData', slug, ...readBotMemory(configDir, slug), ...(err ? { error: err } : {}) });
      return true;
    }

    // --- the board-section handshake; see `pendingSection` above ---
    case 'openBotsSection':
    // The same handshake with the section CARRIED rather than baked in, so the
    // sidebar's Front Desk link lands on the Flock view without a second one.
    case 'openBoardSection': {
      requestBoardSection(m.type === 'openBotsSection' ? 'bots' : typeof m.section === 'string' ? m.section : '');
      const wanted = pendingBoardSection();
      if (wanted) host.post({ type: 'boardShowSection', section: wanted });
      return true;
    }
    case 'boardReady': {
      const wanted = pendingBoardSection();
      if (wanted) host.post({ type: 'boardShowSection', section: wanted });
      return true;
    }
    case 'boardSectionShown': {
      clearBoardSection();
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
