/**
 * TASK-970 (L3, F-2/F-4) — per-adapter reasoning-posture support, for the agent editor's
 * `ReasoningField` (`./parameters-form.tsx`).
 *
 * F-2 measured that `parameters-form.tsx` told every admin "when off, the engine is
 * instructed not to reason" — a promise the transport keeps for only 3 of 10 provider
 * adapters. F-4 is the reason: "the model supports reasoning" (`AiModel.capabilities`,
 * gating whether an agent may author this property at all) and "our adapter can express
 * the posture" are TWO DIFFERENT FACTS. This module carries the second fact so the editor
 * can tell an admin, at AUTHORING time, which of three cases the bound model's provider is
 * in — never blocking the save either way (owner decision 2026-09-13: log and proceed).
 *
 * The three-case table below MIRRORS `tests/contracts/reasoning-posture.fixture.json`'s
 * `support` block deliberately, key for key. That fixture is OWNED by the Python transport
 * lane (L1), which verifies each row against the deployed engine version; this lane (L3)
 * only READS it — `__tests__/reasoning-support.test.ts` pins this table against the
 * committed fixture so the two cannot drift silently.
 */

/**
 * `native-off`  — the engine has a real off-switch AND an effort dial; the posture is
 *                 fully honoured.
 * `effort-only` — effort can be expressed but "off" is only approximated (e.g. the
 *                 engine's minimum effort) — never a true stop.
 * `unsupported` — the transport cannot express the posture at all. Per the owner's
 *                 2026-09-13 fail posture this is recorded and the call still runs —
 *                 never a reason to block saving the agent.
 */
export type ReasoningSupportClass = 'native-off' | 'effort-only' | 'unsupported';

export interface ReasoningProviderSupport {
  /** The fixture's classification for the bound model's engine. */
  class: ReasoningSupportClass;
  /** A short, admin-facing label for that engine — e.g. "Ollama", "Amazon Bedrock". */
  providerLabel: string;
}

/**
 * Mirrors `tests/contracts/reasoning-posture.fixture.json#support` exactly — same ten
 * keys, same classification. Do not hand-tune this without re-reading the fixture; L1
 * is the sole writer of what these values actually verify against the deployed engines.
 */
const REASONING_SUPPORT_BY_ADAPTER: Record<string, ReasoningSupportClass> = {
  openai: 'native-off',
  azure_openai: 'native-off',
  openai_compat: 'effort-only',
  lmstudio: 'native-off',
  vllm: 'native-off',
  ollama: 'native-off',
  anthropic: 'native-off',
  llama_cpp: 'unsupported',
  bedrock: 'unsupported',
  vertex: 'native-off',
};

/**
 * `AiModel.provider` (surfaced to the console as `CatalogueModel.provider` — "the engine /
 * vendor id... routing and the usage ledger are keyed on") spells engine ids differently
 * from the Python adapter module names the fixture keys on: `azure` vs `azure_openai`,
 * `lm-studio`/`lmstudio` vs `lmstudio`, `llama-cpp` vs `llama_cpp`
 * (`ENGINE_SERVED_PROVIDERS` in
 * `packages/applications/src/services/ai-provider-connection/constants.ts` keeps both
 * `lm-studio` and `lmstudio` "deliberately, as aliases"). This is the one table
 * translating the catalogue's spelling to the fixture's — every entry that is not an
 * alias maps to itself.
 */
const PROVIDER_ID_TO_ADAPTER: Record<string, string> = {
  openai: 'openai',
  azure: 'azure_openai',
  'openai-compat': 'openai_compat',
  openai_compat: 'openai_compat',
  'lm-studio': 'lmstudio',
  lmstudio: 'lmstudio',
  vllm: 'vllm',
  ollama: 'ollama',
  anthropic: 'anthropic',
  'llama-cpp': 'llama_cpp',
  llama_cpp: 'llama_cpp',
  bedrock: 'bedrock',
  vertex: 'vertex',
};

/** Admin-facing display label per adapter. Copy only — never read by routing or billing. */
const ADAPTER_DISPLAY_LABEL: Record<string, string> = {
  openai: 'OpenAI',
  azure_openai: 'Azure OpenAI',
  openai_compat: 'This OpenAI-compatible engine',
  lmstudio: 'LM Studio',
  vllm: 'vLLM',
  ollama: 'Ollama',
  anthropic: 'Anthropic',
  llama_cpp: 'llama.cpp',
  bedrock: 'Amazon Bedrock',
  vertex: 'Google Vertex AI',
};

/**
 * The bound model's reasoning-enforcement class, or `null` when no model is bound yet, the
 * provider is absent, or it names a provider this table does not recognise. `null` is
 * deliberate in that last case too — an unrecognised provider gets no claim made about it
 * rather than a guessed one, the same "never drop, never fabricate" posture
 * `ModelSlugField` already applies to an unrecognised model slug.
 */
export function reasoningSupportFor(provider: string | null | undefined): ReasoningProviderSupport | null {
  if (!provider) return null;
  const adapter = PROVIDER_ID_TO_ADAPTER[provider] ?? provider;
  const supportClass = REASONING_SUPPORT_BY_ADAPTER[adapter];
  if (!supportClass) return null;
  return { class: supportClass, providerLabel: ADAPTER_DISPLAY_LABEL[adapter] ?? provider };
}
