// Tweak 4 — parseModelId: the pure provider/quant/name split behind the picker's
// structured label. These assert the requirement (a quant chip appears ONLY when
// a real quant token is in the id; provider is the prefix; name is the cleaned
// remainder), not the implementation — a plain param count like "30b" must never
// masquerade as a quant, and an id with no token must yield quant ''.

import { describe, expect, it } from 'vitest';
import { parseModelId } from './modelLabel';

describe('parseModelId — provider / quant / name', () => {
  it('splits provider prefix and strips a trailing K-quant into a chip token', () => {
    const r = parseModelId('lmstudio/qwen2.5-coder-32b-instruct-Q4_K_M');
    expect(r.provider).toBe('lmstudio');
    expect(r.quant).toBe('Q4_K_M');
    expect(r.name).toBe('qwen2.5-coder-32b-instruct');
  });

  it('no quant token in the id => no chip (quant is empty), name keeps the remainder', () => {
    const r = parseModelId('qwen/qwen3-coder-30b');
    expect(r.provider).toBe('qwen');
    expect(r.quant).toBe('');
    expect(r.name).toBe('qwen3-coder-30b');
  });

  it('an id with no provider prefix keeps the whole string as the name', () => {
    const id = 'qwen3.6-27b-heretic-uncensored-finetune-neo-code-di-imatrix-max';
    const r = parseModelId(id);
    expect(r.provider).toBe('');
    expect(r.quant).toBe('');
    expect(r.name).toBe(id);
  });

  it('prefers a provider-supplied display name and keeps deeper slashes out of the provider', () => {
    const r = parseModelId('openrouter/x-ai/grok-4', 'xAI: Grok 4');
    expect(r.provider).toBe('openrouter');
    expect(r.quant).toBe('');
    expect(r.name).toBe('xAI: Grok 4');
  });

  it('quant match is case-insensitive and normalised uppercase for the chip', () => {
    const r = parseModelId('lmstudio/some-model-q6_k');
    expect(r.quant).toBe('Q6_K');
    expect(r.name).toBe('some-model');
  });

  it('recognises I-quants and bare format tokens (IQ4_NL / AWQ / FP8), never a param count', () => {
    expect(parseModelId('lmstudio/foo-IQ4_NL').quant).toBe('IQ4_NL');
    expect(parseModelId('vllm/qwen3-awq').quant).toBe('AWQ');
    expect(parseModelId('vllm/deepseek-fp8').quant).toBe('FP8');
    // "8b" is a parameter count, NOT a quant — it must not produce a chip.
    expect(parseModelId('lmstudio/llama-3.1-8b-instruct').quant).toBe('');
  });

  it('never invents a quant chip from the provider org prefix (only the model id counts)', () => {
    // mlx-community is a real LM Studio / HuggingFace publisher whose ORG name
    // ends in "mlx" — that is not a quant of a model whose own id has no token.
    const mlx = parseModelId('mlx-community/Llama-3.2-3B-Instruct');
    expect(mlx.provider).toBe('mlx-community');
    expect(mlx.quant).toBe('');
    expect(mlx.name).toBe('Llama-3.2-3B-Instruct');
    // A format token living in the provider segment must likewise not leak.
    const awq = parseModelId('AWQ-cluster/mistral-7b-chat');
    expect(awq.provider).toBe('AWQ-cluster');
    expect(awq.quant).toBe('');
    expect(awq.name).toBe('mistral-7b-chat');
    // ...but a real token in the MODEL id after that provider still chips.
    expect(parseModelId('mlx-community/Llama-3.2-3B-Instruct-4bit-MLX').quant).toBe('MLX');
  });
});
