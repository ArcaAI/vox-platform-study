/**
 * TASK-1036 (W2, OD-16) — the capability descriptor every seeded `AiModel` row carries at
 * `_metadata.capabilities`.
 *
 * The agent and workflow editors read it to decide which sections EXIST for the selected model
 * (`ModelCapabilities` of `@arcaai/workflow-contract`): temperature / max-output-tokens only when
 * the model supports them, the TTS voice picker only when it offers voices, vision / attachments /
 * tools only when it declares them (and those three stay hidden until built, OD-16).
 *
 * ## Why this is DERIVED rather than hand-typed onto 31 rows
 *
 * Every reader (`AgentService.capabilitiesOf`, `WorkflowDefinitionService`, the catalogue mapper)
 * reads `metaData.capabilities` when it is an object and falls back to the FLAT `metaData` only
 * when it is not. Adding a nested object therefore MASKS the flat `supportedGenerationParams` /
 * `contextLength` / `supportsSsml` the rows already declare: a row that gained
 * `{ supportsTools: false }` and nothing else would silently lose its generation-parameter gate.
 * So the nested object is built FROM the row's own flat declarations (kept in place, because other
 * readers — `apps/tts` for `voices`, the LM Studio lock-step test for `contextLength` — still read
 * them flat), and the two cannot drift: `task-1036-model-capability-metadata.test.ts` pins that.
 *
 * ## Nothing is invented
 *
 *  - `supportsTools`, `supportsVision`, `supportsAttachments` are `false` everywhere. Nothing in
 *    the catalogue declares tool calling or image/file input, no engine path forwards them yet,
 *    and the contract's rule for "unknown" is `false` / `[]`.
 *  - `voices` is the row's own voice catalogue (ids only; the `{ id, locale }` pairs stay flat for
 *    `apps/tts`), `[]` for every row that offers none.
 *  - `reasoning` is `true` ONLY where the seed itself already says so: `azure-gpt-5.4-mini` is
 *    documented in `llm.ts` as a GPT-5-family reasoning deployment. The LM Studio Gemma rows are
 *    NOT marked: they accept `reasoning` as a posture knob (a supported GENERATION PARAM), but
 *    they take a temperature (every seeded agent runs them at 0), which is what the flag gates.
 *  - `supportedGenerationParams`, `contextLength`, `supportsSsml` are copied when the row declares
 *    them and left absent otherwise — absent means "unprofiled", never "none".
 *
 * ## Rows left alone
 *
 * The three NLP rows whose `metaData.capabilities` is the verb ARRAY (`extract_entities` /
 * `classify_text`, the `apps/nlp` envelope) keep it: the key is taken, and an object cannot share
 * it. They are guardrail / classifier checkpoints with no agent surface, so nothing reads a
 * capability flag off them.
 */
import type { AiModelSeed } from './shared';

/**
 * The shape `AiModel._metadata.capabilities` takes: `ModelCapabilities` plus what the readers
 * already take from it. A type alias (not an interface) so it keeps an implicit index signature
 * and stays assignable to Prisma's `InputJsonValue`, like `TtsVoiceBinding`.
 */
export type AiModelCapabilityFlags = {
  supportsTools: boolean;
  supportsVision: boolean;
  supportsAttachments: boolean;
  voices: string[];
  reasoning: boolean;
  supportedGenerationParams?: string[];
  contextLength?: number;
  supportsSsml?: boolean;
};

/** Rows the seed itself documents as reasoning models (they refuse a temperature). */
export const REASONING_MODEL_SLUGS: readonly string[] = ['azure-gpt-5.4-mini'];

/** Build the descriptor from a row's own declarations. */
export function capabilityFlagsFor(model: AiModelSeed): AiModelCapabilityFlags {
  const meta = model.metaData ?? {};
  const supportsSsml = (meta as { supportsSsml?: boolean }).supportsSsml;
  return {
    supportsTools: false,
    supportsVision: false,
    supportsAttachments: false,
    voices: (meta.voices ?? []).map((voice) => voice.id),
    reasoning: REASONING_MODEL_SLUGS.includes(model.slug),
    ...(meta.supportedGenerationParams !== undefined ? { supportedGenerationParams: [...meta.supportedGenerationParams] } : {}),
    ...(meta.contextLength !== undefined ? { contextLength: meta.contextLength } : {}),
    ...(supportsSsml !== undefined ? { supportsSsml } : {}),
  };
}

/** Attach `metaData.capabilities` to every row that does not already use the key for the NLP verb array. */
export function withCapabilityMetadata(models: AiModelSeed[]): AiModelSeed[] {
  return models.map((model) => {
    if (Array.isArray(model.metaData?.capabilities)) return model;
    return { ...model, metaData: { ...model.metaData, capabilities: capabilityFlagsFor(model) } };
  });
}
