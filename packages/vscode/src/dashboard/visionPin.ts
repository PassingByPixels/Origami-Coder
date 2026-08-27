/**
 * The per-model VISION PIN — the third bit that tells Auto from a manual choice.
 *
 * WHY A THIRD BIT IS NEEDED. A model's vision lives in origami.json as
 * `modalities.input` carrying "image" plus `attachment: true`, and
 * `readModelVision` reads it back as ONE boolean. visionDetect's reconcile pass
 * writes that SAME boolean. So the config alone can never say whether `true`
 * means "LM Studio called this model a vlm" or "the owner said so" — and
 * without that difference every manual choice is silently reverted by the next
 * reconcile. The pin is that difference. It is kept OUT of the config (which
 * belongs to the engine and is rewritten by detection) and in VS Code's GLOBAL
 * state, because a pin is a fact about the owner, not about a workspace.
 *
 * SEMANTICS.
 *   absent -> AUTO. Detection owns the flag; reconcile writes it, as today.
 *   'on'   -> the owner says this model sees. Written to the config ONCE, at
 *             pin time, and reconcile skips the model from then on.
 *   'off'  -> the owner says it does not. The same, mirrored.
 * Unpinning restores AUTO and asks for one immediate reconcile pass, so the
 * detected answer comes back without waiting for the next panel.
 *
 * THE CONFIG IS NOT THE LIVE ANSWER. The engine freezes model capabilities when
 * it builds a provider instance — there is no TTL and no fs watch — so a pin
 * changes what the NEXT engine reads, not what the running one believes. The
 * control says so; this module does not pretend otherwise.
 *
 * NO `vscode` IMPORT. `PinStore` is the structural shape of a Memento, so
 * `context.globalState` satisfies it and every branch here runs against a Map.
 */

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

/**
 * `origami.visionPin.<providerId>/<modelId>`.
 *
 * The provider is part of the key because one model id is served by more than
 * one box — an `lmstudio` and a `spark` both offering `qwen3-vl` — and a pin set
 * on the local copy must not speak for the remote one, which may be a different
 * quant with a different projector.
 */
export function visionPinKey(providerId: string, modelId: string): string {
  return `${PREFIX}${providerId}/${modelId}`;
}

/** The pin, or `undefined` for AUTO. Anything unrecognised in the store reads as
 *  AUTO rather than throwing: a stale value must degrade to detection, never
 *  strand a model on a state the UI cannot show. */
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

/**
 * Split the engine's `provider/model` string.
 *
 * FIRST slash only — model ids carry slashes of their own (`lmstudio/qwen/qwen3-vl`).
 * A bare id belongs to the local provider, which is the only provider the engine
 * can serve an unqualified model from.
 */
export function splitModel(current: string, localId: string | undefined): { providerId: string; modelId: string } {
  const i = current.indexOf('/');
  if (i > 0) return { providerId: current.slice(0, i), modelId: current.slice(i + 1) };
  return { providerId: current ? (localId ?? '') : '', modelId: current };
}

/**
 * What the control must show for one model: the pin when there is one, else the
 * config flag the next engine will read.
 *
 * `readVision` is injected rather than imported so this stays free of fs — the
 * caller passes firstFold's `readModelVision`.
 */
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
 * The reconcile pass's write plan — the loop that used to sit inline in
 * DashboardPanel, now with the pin rule in it and testable without a panel.
 *
 * Two skips, for two different reasons, and neither may be collapsed into the
 * other. A model ABSENT from `seen` is UNKNOWN (visionDetect's one rule: the
 * server did not answer, so writing `false` would blind a hand-configured VLM).
 * A PINNED model is known and deliberately overruled — detection may be right
 * and is still not allowed to win, or the pin would last exactly until the next
 * panel opened.
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
 * Apply a click on Auto / On / Off.
 *
 * ORDER MATTERS. The config write goes first, because it is the half that can
 * fail (a hand-edited origami.json that no longer parses). Storing the pin only
 * after it lands means a failed write leaves the model on AUTO — visibly
 * unchanged — rather than pinned to a value the config never took, which
 * reconcile would then be forbidden to correct.
 *
 * Reconcile is asked for ONLY on the way back to Auto. That is the one
 * transition whose answer this module does not already hold.
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
