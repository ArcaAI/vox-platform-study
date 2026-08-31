import type { InferenceEngineProvider } from '../api/types';

/**
 * ONE screen component, TWO routes.
 *
 * ─── Why a shared screen ────────────────────────────────────────────────────
 * LM Studio and vLLM are the same OPERATIONAL object: a self-hosted LLM engine
 * reached through one `AiProviderConnection` row, probed through one discovery
 * path, serving weights out of one MinIO bucket. Every region of the screen —
 * probe badge, latency, connection tier, model list, artifact list — is
 * populated by identical reads. Two copies would drift the moment one of them
 * gained a state the other did not.
 *
 * ─── Why two ROUTES and not one screen with an engine switcher ──────────────
 * Three reasons, and they are about operations rather than code:
 *   1. An engine's status is a distinct thing to link to. "LM Studio is down"
 *      wants a URL, and a `?engine=` query param on a shared page makes that a
 *      filter rather than a page.
 *   2. The nav is the inventory. An operator scanning the AI Platform rail
 *      should see WHICH engines this platform has; folding them behind a
 *      selector hides the second one entirely.
 *   3. Their futures diverge. vLLM is the priority-1 serving tier and LM Studio
 *      is the eval/secondary tier; the engine-specific affordances each will
 *      grow (per-engine tuning, per-engine deploy state) land on its own route
 *      without either screen becoming a conditional.
 *
 * So the DIFFERENCES live here as data, and the screen renders them. Anything
 * that is not identical between the two engines belongs in this file.
 */
export interface EngineDescriptor {
  provider: InferenceEngineProvider;
  route: string;
  /** Page `h1`. */
  title: string;
  /** Meta line under the title. */
  summary: string;
  /** The engine's own listing API, named so an operator knows what the model list came from. */
  listingSurface: string;
  /**
   * Why this engine is normally NOT reachable right now. Rendered in the
   * unreachable state, next to the probe error, because "unreachable" without
   * "and here is why that is expected" reads as a broken screen.
   */
  notDeployedNote: string;
  /** MinIO prefix under the models bucket. */
  artifactPrefix: string;
  /**
   * Capabilities this screen deliberately does NOT offer, with the reason.
   * Rendered verbatim on the Server tab: an operator who cannot find a button
   * is owed the reason it is absent, in the place they looked for it.
   */
  omissions: ReadonlyArray<{ title: string; detail: string }>;
}

/**
 * Shared omission. Container lifecycle is a gateway privilege surface that this
 * console deliberately does not open — see the LM Studio ticket's OPEN-824-A
 * ruling. Argo CD already owns the deployment and gives the audit trail for free.
 */
const LIFECYCLE_OMISSION = {
  title: 'Start / stop / restart is not available here',
  detail:
    'Changing how many replicas run is a GitOps operation, not a console button. Giving the gateway the ability to ' +
    'mutate cluster workloads would be a large new privilege surface in a PHI cluster, and Argo CD already owns the ' +
    'deployment and records who changed what. This screen reports engine state; it never changes it.',
} as const;

export const ENGINE_DESCRIPTORS: Record<InferenceEngineProvider, EngineDescriptor> = {
  'lm-studio': {
    provider: 'lm-studio',
    route: '/ai-services/lm-studio',
    title: 'LM Studio',
    summary: 'Self-hosted GGUF engine — the evaluation and secondary serving tier behind vLLM',
    listingSurface: 'LM Studio’s own model listing, aggregated by the text service',
    notDeployedNote:
      'The LM Studio deployment currently runs at zero replicas, so an unreachable probe is the expected result rather ' +
      'than a fault. Scale it up through Argo CD to bring this screen to life.',
    artifactPrefix: 'lm-studio/',
    omissions: [
      LIFECYCLE_OMISSION,
      {
        title: 'The active runtime cannot be shown over HTTP',
        detail:
          'Whether this engine is actually using the GPU, or has silently fallen back to CPU, is not exposed by any HTTP ' +
          'endpoint — LM Studio reports it only over its WebSocket RPC channel (what `lms runtime survey` reads). The ' +
          'weights format shown per model is a FILE format, not an accelerator, and must not be read as one. Surfacing ' +
          'the real answer needs the gateway to exec inside the container, which is the same privilege surface as the ' +
          'lifecycle controls above and was not opened for the same reason.',
      },
      {
        title: 'Models are loaded and unloaded on the engine, not from here',
        detail:
          'This screen reads which models the engine reports and how the registry governs them. It does not load, unload, ' +
          'download or delete weights: those need either an engine-mutating call this read plane does not make, or a CLI ' +
          'exec the gateway deliberately cannot perform.',
      },
    ],
  },
  vllm: {
    provider: 'vllm',
    route: '/ai-services/vllm',
    title: 'vLLM',
    summary: 'Self-hosted OpenAI-compatible engine — the priority-1 serving tier for concurrent clinical traffic',
    listingSurface: 'the OpenAI-compatible `/v1/models` listing, aggregated by the text service',
    notDeployedNote:
      'The vLLM deployment currently runs at zero replicas and is blocked on A100/H100-class hardware, so "not deployed" ' +
      'is its normal state today rather than an outage. This screen is here so that state is legible instead of silent.',
    artifactPrefix: 'vllm/',
    omissions: [
      LIFECYCLE_OMISSION,
      {
        title: 'Model swaps are a re-deploy, not a hot swap',
        detail:
          'vLLM serves the model it was started with. Promoting a different one is a rolling re-deploy through GitOps with ' +
          'the new `--served-model-name`, which is why there is no load/unload control here — there is nothing for it to call.',
      },
      {
        title: 'Weights are not fetched from this screen',
        detail:
          'vLLM reads safetensors straight from the models bucket at start-up. The Artifacts tab shows what is in that ' +
          'bucket; putting something new there is a storage operation, and serving it is a deployment one.',
      },
    ],
  },
};
