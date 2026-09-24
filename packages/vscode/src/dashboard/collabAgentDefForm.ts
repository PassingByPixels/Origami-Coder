// WHICH fields of a save-def message actually reach the writer.
//
// "Stated only": the writer resolves an ABSENT field from disk, so
// forwarding a field the form never stated would overwrite a real value with
// a default. Pure — no fs, no vscode.
import { BOT_TIERS, type BotContract, type BotTier } from './botContract';
import type { CollabAgentDef } from './collabAgentCrud';

/** A permission key the tool checklist could have written; anything else is dropped. */
const keys = (v: unknown): string[] =>
  (v as unknown[]).filter((s): s is string => typeof s === 'string' && /^[A-Za-z0-9_-]+$/.test(s));
/** The bot contract, re-read rather than trusted. A malformed field is dropped. */
function contractFromForm(raw: unknown): BotContract | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const b = raw as Record<string, unknown>;
  const tier = typeof b.tier === 'string' && (BOT_TIERS as readonly string[]).includes(b.tier) ? (b.tier as BotTier) : undefined;
  // An unrecognised tier is KEPT: it is the user's own text, and showing them
  // the typo is the pane's job — erasing it on save is not.
  const unknown = tier === undefined && typeof b.tier === 'string' && b.tier ? b.tier
    : typeof b.unknownTier === 'string' && b.unknownTier ? b.unknownTier : undefined;
  return {
    ...(tier ? { tier } : {}), ...(unknown ? { unknownTier: unknown } : {}),
    ...(typeof b.memory === 'boolean' ? { memory: b.memory } : {}),
  };
}

export function defFromForm(raw: unknown): CollabAgentDef {
  const d = (raw ?? {}) as Partial<CollabAgentDef>;
  const bot = contractFromForm(d.bot); // undefined = the message stated none
  return {
    slug: typeof d.slug === 'string' ? d.slug : '',
    description: typeof d.description === 'string' ? d.description : '',
    model: typeof d.model === 'string' ? d.model : '',
    glyph: typeof d.glyph === 'string' ? d.glyph : '',
    persona: typeof d.persona === 'string' ? d.persona : '',
    // An absent preset means "keep what the file already says".
    ...(d.preset === 'worker' || d.preset === 'observer' || d.preset === 'custom' ? { preset: d.preset } : {}),
    ...(typeof d.customPermission === 'string' ? { customPermission: d.customPermission } : {}),
    // The TOOL TICKS. Absent = "keep the block on disk"; present = the whole
    // set, so `[]` is forwarded as `[]` — a bot allowed nothing is an answer.
    ...(Array.isArray(d.tools) ? { tools: keys(d.tools) } : {}),
    ...(typeof d.steps === 'string' ? { steps: d.steps } : {}),
    // Vision, and t-kgtr6c's `visionProfile` — defaulting an unstated one would
    // move a profile into the collab roster.
    ...(typeof d.vision === 'boolean' ? { vision: d.vision } : {}),
    ...(typeof d.visionProfile === 'boolean' ? { visionProfile: d.visionProfile } : {}),
    ...(bot ? { bot } : {}),
  };
}
