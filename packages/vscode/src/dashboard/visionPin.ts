// The per-model VISION PIN — the third bit that tells Auto from a manual choice.
// A model's vision lives in origami.json as one boolean (`modalities.input`), and visionDetect's
// reconcile pass writes that same boolean — so config alone can't say whether `true` means "LM
// Studio called this a vlm" or "the owner said so", and without that distinction a manual choice
// gets silently reverted on the next reconcile. The pin is that difference, kept in VS Code's
// GLOBAL state (a fact about the owner, not a workspace) rather than in the engine-owned config.
// Semantics: absent = AUTO (detection owns the flag); 'on'/'off' = the owner's choice, written to
// config once at pin time and skipped by reconcile from then on. Unpinning restores AUTO and asks
// for one immediate reconcile pass.
// The pin is LIVE: the panel wires `writeVision` through `refreshingWriter` (providerRefresh.ts),
// which fires `provider_refresh` after the write, dropping the running engine's provider memo so
// the model is rebuilt from the new config on the next step — no window reload needed.
// No vscode import — `PinStore` is the structural shape of a Memento.

/** A manual choice. The absence of one is AUTO — never a third enum value. */
export type VisionPin = 'on' | 'off';

/** What the composer's Vision control shows. `auto-*` is a DETECTED answer, so
 *  it is a different fact from the identical pinned one and reads differently. */
export type VisionState = 'auto-on' | 'auto-off' | 'on' | 'off';

/** The two Memento methods this needs. `update(key, undefined)` DELETES the key
 *  — that is VS Code's documented behaviour and it is how a pin is cleared. */
export interface PinStore {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): PromiseLike<void>;
}

const PREFIX = 'origami.visionPin.';

/** `origami.visionPin.<providerId>/<modelId>` — the provider is part of the key because one model
 *  id can be served by more than one box, and a pin on the local copy must not speak for a remote
 *  one with a different quant. */
export function visionPinKey(providerId: string, modelId: string): string {
  return `${PREFIX}${providerId}/${modelId}`;
}

/** The pin, or undefined for AUTO. An unrecognised stored value reads as AUTO too, rather than
 *  throwing. */
export function readVisionPin(store: PinStore, providerId: string, modelId: string): VisionPin | undefined {
  if (!providerId || !modelId) return undefined;
  const raw = store.get<string>(visionPinKey(providerId, modelId));
  return raw === 'on' || raw === 'off' ? raw : undefined;
}

/** Store a pin, or clear it back to AUTO with `undefined`. */
export function writeVisionPin(
  store: PinStore,
  providerId: string,
  modelId: string,
  pin: VisionPin | undefined,
): PromiseLike<void> {
  return store.update(visionPinKey(providerId, modelId), pin);
}

/** Split the engine's `provider/model` string on the FIRST slash only — model ids carry slashes of
 *  their own. A bare id belongs to the local provider, the only one the engine can serve
 *  unqualified. */
export function splitModel(current: string, localId: string | undefined): { providerId: string; modelId: string } {
  const i = current.indexOf('/');
  if (i > 0) return { providerId: current.slice(0, i), modelId: current.slice(i + 1) };
  return { providerId: current ? (localId ?? '') : '', modelId: current };
}

/** What the control must show for one model: the pin when there is one, else the config flag the
 *  next engine will read. `readVision` is injected, not imported, to keep this fs-free. */
export function visionStateFor(
  store: PinStore,
  model: { providerId: string; modelId: string },
  readVision: (providerId: string, modelId: string) => boolean,
): VisionState {
  if (!model.providerId || !model.modelId) return 'auto-off';
  return readVisionPin(store, model.providerId, model.modelId)
    ?? (readVision(model.providerId, model.modelId) ? 'auto-on' : 'auto-off');
}

/**
 * The same answer for a LIST of `provider/model` rows — the model picker's
 * per-row vision chips. Needed because the engine flattens capabilities away
 * when it builds the ACP model list, so both halves of the answer live on
 * this side. A leaf beside `visionStateFor`, not a `.map` inside the panel,
 * so one model and forty rows answer the same question the same way.
 * Generic over the row so a caller's other fields travel through untouched.
 */
export function visionStatesFor<T extends { value: string }>(
  store: PinStore,
  rows: readonly T[],
  localId: string | undefined,
  readVision: (providerId: string, modelId: string) => boolean,
): Array<T & { visionState: VisionState }> {
  return rows.map((row) => ({
    ...row,
    visionState: visionStateFor(store, splitModel(row.value, localId), readVision),
  }));
}

/**
 * The reconcile pass's write plan, now testable without a panel. Two skips
 * for two different reasons: a model ABSENT from `seen` is UNKNOWN (writing
 * false would blind a hand-configured VLM); a PINNED model is known and
 * deliberately overruled, since detection winning would make the pin last
 * only until the next panel opened.
 */
export function visionWrites(input: {
  models: readonly string[];
  seen: ReadonlyMap<string, boolean>;
  pinned: (modelId: string) => boolean;
  current: (modelId: string) => boolean;
}): { modelId: string; enabled: boolean }[] {
  const out: { modelId: string; enabled: boolean }[] = [];
  for (const modelId of input.models) {
    const want = input.seen.get(modelId);
    if (want === undefined) continue; // the server said nothing — leave the config alone
    if (input.pinned(modelId)) continue; // the owner overruled detection
    if (input.current(modelId) === want) continue; // already correct — no write, no .bak churn
    out.push({ modelId, enabled: want });
  }
  return out;
}

/** Everything applying a pin needs from the panel, and nothing else. */
export interface VisionPinHost {
  store: PinStore;
  /** `provider/model` for the chat the click came from, plus the local provider
   *  id used when that string carries no provider prefix. */
  current: string;
  localId: string | undefined;
  writeVision(input: { providerId: string; modelId: string; enabled: boolean }): unknown;
  /** Run ONE reconcile pass now — the caller clears its once-per-panel guard. */
  reconcile(): Promise<void>;
  /** Re-broadcast model status so the control repaints from the new truth. */
  refresh(): void;
  warn(text: string): void;
}

/**
 * Apply a click on Auto / On / Off. Order matters: the config write goes
 * first, since it's the half that can fail (a hand-edited origami.json that
 * no longer parses) — storing the pin only after it lands keeps a failed
 * write on AUTO rather than pinned to a value the config never took.
 * Reconcile is asked for only on the way back to Auto, the one transition
 * this module doesn't already hold the answer to.
 */
export async function applyVisionPin(host: VisionPinHost, mode: string): Promise<void> {
  const { providerId, modelId } = splitModel(host.current, host.localId);
  if (!providerId || !modelId) {
    host.warn('This chat has no model selected yet, so there is nothing to set vision for.');
    return;
  }
  const pin: VisionPin | undefined = mode === 'on' || mode === 'off' ? mode : undefined;
  try {
    if (pin) host.writeVision({ providerId, modelId, enabled: pin === 'on' });
    await writeVisionPin(host.store, providerId, modelId, pin);
    if (!pin) await host.reconcile();
  } catch (e) {
    host.warn(`Couldn't set vision for ${providerId}/${modelId} — ${e instanceof Error ? e.message : String(e)}`);
  }
  host.refresh();
}
