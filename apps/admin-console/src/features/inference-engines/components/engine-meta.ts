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
   * Whether this engine gets the Serving Control tab (TASK-996, owner decision
   * D-1) — the ONE surface in `/ai-services/*` that mutates the workload.
   *
   * A property of the ENGINE, not a feature flag. LM Studio holds several
   * models at once and loads them at runtime, so "which model, on which card,
   * with which context" is a live decision an admin can make. vLLM, llama.cpp
   * and Ollama have no such decision to offer: the first two serve the model
   * they were STARTED with (a change is a re-deploy) and Ollama pulls and
   * evicts on its own. Giving them the tab would be a control with nothing
   * behind it.
   */
  servingControl?: boolean;
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
    servingControl: true,
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
        title: 'Load and unload live on the Serving Control tab — everything else here is read-only',
        detail:
          'Loading a model, unloading it and changing its load-time profile (context, parallel slots, flash attention, GPU ' +
          'split) are the ONLY mutations this console makes to an engine, and they are confined to that one tab behind a ' +
          'super-admin gate. Downloading or deleting weights is still not offered: that is a storage operation, and it ' +
          'belongs to the storage browser rather than to an engine screen.',
      },
    ],
  },
  ollama: {
    provider: 'ollama',
    route: '/ai-services/ollama',
    title: 'Ollama',
    summary: 'Self-hosted GGUF engine — the pull-and-run tier, kept for local and fallback serving',
    listingSurface: 'Ollama’s `/api/tags` catalogue plus its `/api/ps` running list, aggregated by the text service',
    notDeployedNote:
      'Ollama has no deployment in this cluster today, so an unreachable probe is the expected result rather than a ' +
      'fault. The engine stays selectable because a tenant or a local developer may point the platform at one; this ' +
      'screen exists so that state is legible instead of silent.',
    artifactPrefix: 'ollama/',
    omissions: [
      LIFECYCLE_OMISSION,
      {
        title: 'Models are pulled on the engine, not from here',
        detail:
          'Ollama fetches its own weights with `ollama pull`, straight from its registry rather than from the models ' +
          'bucket. This screen reads what the engine reports and how the registry governs it; the Artifacts tab is ' +
          'therefore usually empty for Ollama, and that is correct rather than missing data.',
      },
      {
        title: 'Residency is reported, never changed',
        detail:
          'Ollama distinguishes a model it KNOWS (`/api/tags`) from one it is currently RUNNING (`/api/ps`), which is ' +
          'what "loaded" means on this screen. Loading or evicting one is an engine-mutating call this read plane does ' +
          'not make.',
      },
    ],
  },
  'llama-cpp': {
    provider: 'llama-cpp',
    route: '/ai-services/llama-cpp',
    title: 'llama.cpp',
    summary: 'Self-hosted GGUF server — the single-model, low-overhead serving tier',
    listingSurface: 'the llama.cpp server’s `/health` probe and its OpenAI-compatible model listing, aggregated by the text service',
    notDeployedNote:
      'llama.cpp has no deployment in this cluster today, so "unreachable" is its normal state rather than an outage. ' +
      'The engine is kept in the inventory because it is the cheapest way to serve one GGUF model on modest hardware.',
    artifactPrefix: 'llama-cpp/',
    omissions: [
      LIFECYCLE_OMISSION,
      {
        title: 'One server serves one model',
        detail:
          'A llama.cpp server is started with its model and serves that one. Promoting a different model is a ' +
          're-deploy through GitOps, which is why there is no load/unload control here — there is nothing for it to ' +
          'call. Anything the server lists, it is already serving.',
      },
      {
        title: 'Weights are not fetched from this screen',
        detail:
          'The server reads its GGUF at start-up. The Artifacts tab shows what is in the models bucket under this ' +
          'engine’s prefix; putting something new there is a storage operation, and serving it is a deployment one.',
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
