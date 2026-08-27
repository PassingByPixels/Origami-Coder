// Tweak 4 — parse a raw model id into up-to-three display parts so the picker
// reads as a clean structured label instead of a dense slug:
//   PROVIDER  the id prefix before the first '/' (else '', the whole id is name)
//   QUANT     a quant/format token IF one is literally present in the id/name —
//             never invented; absent token => '' => the caller renders no chip
//   NAME      the remainder, with the quant token stripped and separators tidied
//
// Display-only: the caller keeps selecting the exact original id as the value.

export interface ModelLabel {
  provider: string;
  quant: string;
  name: string;
}

// Common quant / format tokens, case-insensitive, matched only as a whole token
// (bounded by start/end or a separator) so param counts like "30b" and words
// like "instruct" can never be mistaken for a quant.
//   · K-quants:   Q2_K, Q3_K_M, Q4_K_M, Q4_K_S, Q5_K_M, Q6_K, Q8_0, Q4_0, Q4_1
//   · I-quants:   IQ2_XXS, IQ3_M, IQ4_NL, …
//   · formats:    NVFP4, FP8, GGUF, GPTQ, AWQ, MLX, BF16, F16
const QUANT_RE =
  /(?:^|[-_.\s/])(Q\d(?:_K(?:_[MS])?|_[01])?|IQ\d(?:_[A-Za-z0-9]+)*|NVFP4|FP8|GGUF|GPTQ|AWQ|MLX|BF16|F16)(?=$|[-_.\s/])/i;

const SEP_RUN = /[-_.\s/]{2,}/g;
const SEP_EDGE = /^[-_.\s/]+|[-_.\s/]+$/g;

export function parseModelId(value: string, displayName?: string): ModelLabel {
  const id = (value ?? "").trim();
  const slash = id.indexOf("/");
  const provider = slash > 0 ? id.slice(0, slash) : "";
  const rest = slash > 0 ? id.slice(slash + 1) : id;

  // Prefer a provider-supplied display name (e.g. OpenRouter's "xAI: Grok 4");
  // otherwise the id remainder after the provider prefix.
  const base = displayName && displayName.trim() ? displayName.trim() : rest;

  // Detect the quant from the model id (the part AFTER the provider prefix)
  // first, then the name. Never scan the provider org: a publisher prefix like
  // "mlx-community" or "AWQ-cluster" is not a quant of the model, and matching
  // the full id would invent a chip from the org name.
  const m = QUANT_RE.exec(rest) ?? QUANT_RE.exec(base);
  const quantRaw = m ? m[1] : "";
  const quant = quantRaw ? quantRaw.toUpperCase() : "";

  let name = base;
  if (quantRaw) {
    // Strip the token (plus the separator gluing it on) out of the name so the
    // chip isn't duplicated in the label, then tidy any separator left behind.
    const esc = quantRaw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    name = base
      .replace(new RegExp(`[-_.\\s/]*${esc}(?=$|[-_.\\s/])`, "i"), "")
      .replace(SEP_RUN, " ")
      .replace(SEP_EDGE, "")
      .trim();
    if (!name) name = base;
  }

  return { provider, quant, name };
}
