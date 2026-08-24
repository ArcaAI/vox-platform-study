// tts provider config and synthesis limits — the keys that used to be env vars.
//
// TASK-799 lane C. Companion to `tts.descriptors.ts`, and the split between them
// is the tenant/platform boundary, not a filing convenience:
//
//   • `tts.descriptors.ts`  — PER-TENANT. BYO provider credentials
//     (`db-secret`) and a tenant's default voice (`db-config`). Tenant-varying,
//     so it declares no `consumedBy` and travels the PUSH channel: the gateway
//     resolves it and injects it into each request body.
//   • THIS FILE            — PLATFORM. The platform's own provider tuning,
//     endpoints, local-engine model ids and service-wide synthesis limits. One
//     value for the whole deployment, so it rides the PULL route (D-1).
//
// Getting that split wrong in either direction is the failure D-1 exists to
// prevent: a tenant-varying key on the pull route turns one cached snapshot per
// process into one per customer, and a platform key on the push channel has to
// be resolved again on every single request.
//
// WHAT IS DELIBERATELY ABSENT
// ----------------------------
// **The two cloud credentials.** `TTS_AZURE_API_KEY` and `TTS_SARVAM_API_KEY`
// have no env path and no registry key here: `apps/tts/src/tts/core/config.py`
// pins them to a `validation_alias` naming a variable nobody will ever set, with
// `populate_by_name` off, so no environment path to a cloud key exists even if an
// operator tries. The assessment calls that "the pattern F-01 should be fixed
// *to*". Their per-tenant homes are the `tts.credential.*` db-secret descriptors,
// and the gateway injects the selected one per request.
//
// **Per-provider VOICE names.** `TTS_KOKORO_VOICE`, `TTS_PARLER_SPEAKER_ML/_EN`,
// `TTS_AZURE_VOICE_EN/_ML` and `TTS_SARVAM_VOICE_ML/_EN` are GONE, not migrated.
// Every one duplicated a string the voice catalog already binds
// (`apps/tts/src/tts/catalog/voices.py`), and the router resolves that binding
// into `req.provider_voice` on every request — so the settings copies were
// unreachable on the request path, and in `indic_parler`'s case the provider read
// its own copy and DISCARDED the catalog's. One fact, one place: the catalog.
//
// EVERY `default` BELOW IS THE PYTHON FIELD'S CURRENT VALUE
// ----------------------------------------------------------
// Asserted by `apps/tts/src/tts/tests/unit/test_task799_descriptor_parity.py`.
// With no `GlobalSetting` row the cascade resolves the descriptor default, so an
// unseeded deployment runs on exactly the values it ran on before.

import { SettingDescriptor } from '../registry.types';

/**
 * The five provider/engine `*_ENABLED` flags — HALF-MIGRATED, and the halves
 * are the point (TASK-799 lane H).
 *
 * They now ride the pull route like every other key in this file
 * (`tier: 'global-kv'`, `consumedBy: ['tts']`) AND `TTS_*_ENABLED` remains a
 * live bootstrap fallback in the service. That is not "configured in two
 * places": `apps/tts/src/tts/core/control_plane.py#ENV_BOOTSTRAP_KEYS` declares
 * env SUBORDINATE, so only a value a DATABASE ROW supplied (`source: 'db'`)
 * overrides it. An `env-fallback` entry — the gateway reporting that no row
 * answered and it resolved the descriptor default — leaves the environment
 * standing.
 *
 * WHY THE ENV PATH IS STILL OPEN
 * --------------------------------
 * Closing it is a THREE-step change and only two steps live in this repository:
 *
 *   1. seed the rows                → `seed/11d-tts-engine-flags.ts` (done)
 *   2. update the k8s ConfigMaps    → `arca/hope-v2-deployment` — NOT this repo
 *   3. close the env read           → here, but ONLY after (2)
 *
 * The binding constraint is concrete. `TTS_KOKORO_ENABLED=true` in the k8s
 * ConfigMap is what makes a KEYLESS deployment reach `/health/ready` at all —
 * `apps/tts/src/tts/tests/unit/test_keyless_readiness_task642.py` exists because
 * `hope-tts` once answered 503 forever, so its Service carried no endpoints and
 * `TTS_URL` resolved to nothing. Doing (3) before (2) reproduces that outage on
 * the next deploy, which is why the env read survives this lane.
 *
 * `tts.indicf5.enabled` is the flag that most wanted this move: its CC-BY-NC
 * licensing restriction was enforced only by a code comment. As a `globalOnly`
 * key on a `locked` SYSTEM row, enabling it is now a SUPER_ADMIN write with an
 * audit trail.
 *
 * DEFAULTS STAY `false`, INCLUDING KOKORO'S. The descriptor default must equal
 * the Python field (`test_task799_descriptor_parity.py` asserts it verbatim), so
 * an unseeded deployment resolves exactly what it always ran on. The seeded ROW
 * is what turns kokoro on — the same split `11c-consultation-gate-settings.ts`
 * uses for the OCR gate.
 *
 * NAMING — two of these do NOT share a prefix with their siblings above
 * (`tts.parler.enabled` beside `tts.indicParler.*`, `tts.indicf5.enabled` beside
 * `tts.indicF5.*`). The spelling was forced when they were `env`-tier, because
 * an env key must DERIVE its real variable through `toEnvVarName` and the
 * variables the service reads are `TTS_PARLER_ENABLED` / `TTS_INDICF5_ENABLED`.
 * That constraint has lifted, but the names are KEPT: a registry key is the
 * primary coordinate of its `GlobalSetting` row, so renaming one now would
 * orphan the seeded row and silently revert the flag to its env value.
 *
 * SHAPE mirrors `KNOBS` below — the same 2-space-indented `'<key>': { … }`
 * record — because `test_task799_descriptor_parity.py` PARSES this file to
 * assert every control-plane key's default matches its Python field verbatim.
 * A differently-shaped literal would be invisible to that gate, which is what
 * these five were while they sat in a separate array.
 */
const PROVIDER_ENABLE_FLAGS: Record<string, { default: false; label: string; description: string; category: string }> = {
  'tts.azure.enabled': {
    default: false,
    label: 'Azure Speech provider enabled',
    description:
      'Registers the Azure AI Speech provider at boot (bootstrap fallback `TTS_AZURE_ENABLED`). A ' +
      'registered cloud provider with no platform credential is still not a routing candidate — it ' +
      'would 401 the live API — so enabling it without a key only makes it reachable to tenants that ' +
      'bring their own.',
    category: 'TTS Providers',
  },
  'tts.sarvam.enabled': {
    default: false,
    label: 'Sarvam provider enabled',
    description:
      'Registers the Sarvam Bulbul provider (bootstrap fallback `TTS_SARVAM_ENABLED`). The PUBLIC ' +
      'Sarvam API is not PHI-safe — no BAA, 30-day retention, not India-resident — so point ' +
      '`tts.sarvam.baseUrl` at the enterprise VPC or on-prem host before enabling it for real patient data.',
    category: 'TTS Providers',
  },
  'tts.kokoro.enabled': {
    default: false,
    label: 'Kokoro engine enabled',
    description:
      'Registers the self-hosted Kokoro English engine (bootstrap fallback `TTS_KOKORO_ENABLED`). ' +
      'This is the flag a KEYLESS deployment needs to become Ready: the SYSTEM row routes `en` to ' +
      'kokoro, so without it the service registers no provider and reports 503. The SEEDED ROW turns ' +
      'it on — the descriptor default stays false so an unseeded deployment resolves what it always ' +
      'ran on. Weights load on the first synthesis request.',
    category: 'TTS Engines',
  },
  'tts.parler.enabled': {
    default: false,
    label: 'Indic Parler engine enabled',
    description: 'Registers the self-hosted AI4Bharat Indic Parler-TTS Malayalam engine (bootstrap fallback `TTS_PARLER_ENABLED`).',
    category: 'TTS Engines',
  },
  'tts.indicf5.enabled': {
    default: false,
    label: 'IndicF5 engine enabled (LICENSE-GATED)',
    description:
      'Registers the experimental IndicF5 voice-clone engine (bootstrap fallback ' +
      '`TTS_INDICF5_ENABLED`). Prod and commercial enablement are NO-GO pending license review: the ' +
      'released weights are a fine-tune of the CC-BY-NC SWivid F5-TTS base, and the MIT tag cannot ' +
      'override NonCommercial. That gate used to be enforced only by a code comment; as a locked, ' +
      'globalOnly registry key, enabling it is now a SUPER_ADMIN write with an audit trail.',
    category: 'TTS Engines',
  },
};

type TtsKnob = {
  dataType: 'boolean' | 'number' | 'string';
  default: boolean | number | string;
  label: string;
  description: string;
  category: string;
  killSwitch?: boolean;
};

const KNOBS: Record<string, TtsKnob> = {
  // ── Azure Speech (managed cloud) ─────────────────────────────────────────
  'tts.azure.region': {
    dataType: 'string',
    default: 'eastus',
    label: 'Azure Speech region',
    description:
      'Azure region for the platform Speech resource (e.g. eastus, westeurope). Region is a DATA ' +
      'RESIDENCY decision for a service that synthesises clinical text, so it belongs to a platform ' +
      'admin with an audit trail rather than to whoever edits the env file.',
    category: 'TTS Providers',
  },
  'tts.azure.timeoutS': {
    dataType: 'number',
    default: 30,
    label: 'Azure Speech timeout (s)',
    description: 'Per-request timeout for Azure Speech synthesis.',
    category: 'TTS Providers',
  },
  'tts.azure.maxConcurrent': {
    dataType: 'number',
    default: 10,
    label: 'Azure Speech concurrency',
    description: 'Ceiling on concurrent in-flight Azure Speech syntheses.',
    category: 'TTS Providers',
  },

  // ── Sarvam (cloud) ───────────────────────────────────────────────────────
  'tts.sarvam.baseUrl': {
    dataType: 'string',
    default: 'https://api.sarvam.ai',
    label: 'Sarvam API base URL',
    description:
      'Where Sarvam synthesis requests go. This is a PHI-safety control, not a convenience: pointing ' +
      'it at the enterprise VPC host is what makes the provider usable for patient data at all.',
    category: 'TTS Providers',
  },
  'tts.sarvam.model': {
    dataType: 'string',
    default: 'bulbul:v3',
    label: 'Sarvam model',
    description:
      'The Sarvam model id sent on every synthesis request. A SELECTION that reaches the wire, not a ' +
      'tuning knob — assessment F-11 names this field. Note the provider branches on it: a `bulbul:v2` ' +
      'prefix enables server-side preprocessing.',
    category: 'TTS Providers',
  },
  'tts.sarvam.sampleRate': {
    dataType: 'number',
    default: 24000,
    label: 'Sarvam sample rate (Hz)',
    description: 'Sample rate requested from Sarvam.',
    category: 'TTS Providers',
  },
  'tts.sarvam.timeoutS': {
    dataType: 'number',
    default: 30,
    label: 'Sarvam timeout (s)',
    description: 'Per-request timeout for Sarvam synthesis.',
    category: 'TTS Providers',
  },
  'tts.sarvam.maxConcurrent': {
    dataType: 'number',
    default: 4,
    label: 'Sarvam concurrency',
    description: 'Ceiling on concurrent in-flight Sarvam syntheses.',
    category: 'TTS Providers',
  },
  'tts.sarvam.useStreaming': {
    dataType: 'boolean',
    default: false,
    label: 'Sarvam WebSocket streaming',
    description: "Use Sarvam's WebSocket streaming API instead of the request/response endpoint.",
    category: 'TTS Providers',
  },

  // ── Kokoro (self-hosted, English) ────────────────────────────────────────
  'tts.kokoro.device': {
    dataType: 'string',
    default: 'cpu',
    label: 'Kokoro device',
    description: 'Torch device for Kokoro inference.',
    category: 'TTS Engines',
  },

  // ── Indic Parler (self-hosted, Malayalam) ────────────────────────────────
  'tts.indicParler.hfModel': {
    dataType: 'string',
    default: 'ai4bharat/indic-parler-tts',
    label: 'Indic Parler model',
    description:
      'HuggingFace repo id for the Parler weights. The repo is click-through gated, so a production ' +
      'deployment normally sets `tts.indicParler.modelPath` to an ungated internal mirror and this id ' +
      'is only the dev fallback.',
    category: 'TTS Engines',
  },
  'tts.indicParler.device': {
    dataType: 'string',
    default: 'cpu',
    label: 'Indic Parler device',
    description: 'Torch device for Indic Parler inference.',
    category: 'TTS Engines',
  },
  'tts.indicParler.modelPath': {
    dataType: 'string',
    default: '',
    label: 'Indic Parler local mirror path',
    description:
      'Local directory holding the model + prompt tokenizer, loaded with local_files_only. Empty = ' +
      'fall back to the gated Hub pull (dev only). Pair with HF_HUB_OFFLINE / TRANSFORMERS_OFFLINE.',
    category: 'TTS Engines',
  },
  'tts.indicParler.descEncoderPath': {
    dataType: 'string',
    default: '',
    label: 'Indic Parler description-encoder path',
    description:
      'Local directory for the description tokenizer (google/flan-t5-large, baked into the model ' +
      'config as a Hub id). Empty = fetch it. Set alongside the model mirror, or an otherwise-offline ' +
      'deployment still reaches out for this one tokenizer.',
    category: 'TTS Engines',
  },

  // ── IndicF5 (self-hosted voice-clone; licensing-gated) ───────────────────
  'tts.indicF5.hfModel': {
    dataType: 'string',
    default: 'ai4bharat/IndicF5',
    label: 'IndicF5 model',
    description: 'HuggingFace repo id for the IndicF5 weights (gated).',
    category: 'TTS Engines',
  },
  'tts.indicF5.modelPath': {
    dataType: 'string',
    default: '',
    label: 'IndicF5 local mirror path',
    description: 'Local mirror directory. Empty = the gated Hub repo.',
    category: 'TTS Engines',
  },
  'tts.indicF5.device': {
    dataType: 'string',
    default: 'cpu',
    label: 'IndicF5 device',
    description: 'Torch device for IndicF5 inference.',
    category: 'TTS Engines',
  },
  'tts.indicF5.refAudioPath': {
    dataType: 'string',
    default: '',
    label: 'IndicF5 reference audio path',
    description:
      'Path to the voice-clone reference wav. IndicF5 is a flow-matching voice-CLONE model: every ' +
      'synthesis conditions on this recording, so it is a deployment path to an asset, not a voice ' +
      'name — which is why it lives here rather than in the voice catalog.',
    category: 'TTS Engines',
  },
  'tts.indicF5.refText': {
    dataType: 'string',
    default: '',
    label: 'IndicF5 reference transcript',
    description:
      'Transcript of the reference wav. Must match the recording: the model aligns against it, so a ' +
      'mismatch degrades every cloned utterance rather than failing loudly.',
    category: 'TTS Engines',
  },

  // ── service-wide synthesis limits ────────────────────────────────────────
  'tts.limits.maxInputChars': {
    dataType: 'number',
    default: 4096,
    label: 'Max input characters',
    description: 'Longest text accepted for one synthesis request.',
    category: 'TTS Runtime',
  },
  'tts.limits.defaultFormat': {
    dataType: 'string',
    default: 'pcm',
    label: 'Default audio format',
    description: 'Audio format used when a request names none: pcm | wav | mp3.',
    category: 'TTS Runtime',
  },
  'tts.limits.sampleRate': {
    dataType: 'number',
    default: 24000,
    label: 'Output sample rate (Hz)',
    description: 'Sample rate requested from every provider and emitted to the caller.',
    category: 'TTS Runtime',
  },
  'tts.warmupEnabled': {
    dataType: 'boolean',
    default: false,
    label: 'Warm local engines at boot',
    description:
      'Loads local engine weights during startup instead of on the first request. OFF by default: ' +
      'lazy loading keeps a freshly booted process holding no weights. Turn it on where fail-at-boot ' +
      'is preferred over a first-request 503 — the provider stays registered either way, so a warm-up ' +
      'failure degrades rather than removing a route.',
    category: 'TTS Runtime',
  },
};

export const ENABLE_FLAG_SETTINGS: SettingDescriptor[] = Object.entries(PROVIDER_ENABLE_FLAGS).map<SettingDescriptor>(([key, flag]) => ({
  key,
  // D-2: `global-kv` is the home for a migrated Python knob — one tier, one
  // write lane, one cascade, one invalidation channel. No `targetTier`: this IS
  // where the key lives now, and a `targetTier` equal to a home it has already
  // reached is noise a governance test rejects.
  tier: 'global-kv',
  dataType: 'boolean',
  sensitivity: 'internal',
  // D-1: PLATFORM scope. Which engines a deployment runs is one value for the
  // whole deployment, so it rides the pull route rather than per-request
  // injection.
  maxScope: 'system',
  editableBy: 'all',
  // SUPER_ADMIN-only in practice, which is what gives `tts.indicf5.enabled`'s
  // CC-BY-NC gate an audit trail instead of a code comment.
  globalOnly: true,
  // NOT `killSwitch: true` — that flag marks an ENFORCING gate, and the registry
  // requires one to default OFF. These select which engines a deployment runs;
  // `tts.kokoro.enabled` is seeded true precisely so the service can serve
  // anything at all. Marking them would assert a fail-safe default that is not
  // the one in force.
  failMode: 'open-to-default',
  consumedBy: ['tts'],
  category: flag.category,
  label: flag.label,
  description: flag.description,
  // Verbatim the Python field default. The seeded ROW carries the platform's
  // actual decision — see the header.
  default: flag.default,
}));

const KNOB_SETTINGS: SettingDescriptor[] = Object.entries(KNOBS).map<SettingDescriptor>(([key, knob]) => ({
  key,
  tier: 'global-kv',
  dataType: knob.dataType,
  // Never `secret`. The two cloud credentials are not here at all — see the
  // header — and the read service filters secrets off this route regardless.
  sensitivity: 'internal',
  // D-1: PLATFORM scope. Per-tenant TTS config lives in `tts.descriptors.ts`
  // and travels the push channel.
  maxScope: 'system',
  editableBy: 'all',
  globalOnly: true,
  failMode: 'open-to-default',
  consumedBy: ['tts'],
  category: knob.category,
  ...(knob.killSwitch ? { killSwitch: true } : {}),
  label: knob.label,
  description: knob.description,
  default: knob.default,
}));

/**
 * The tts platform surface: the knobs that MOVED to the control plane, plus the
 * five provider enable-flags that are still env-read and carry a `targetTier`
 * recording where they are headed.
 */
export const TTS_RUNTIME_SETTINGS: SettingDescriptor[] = [...KNOB_SETTINGS, ...ENABLE_FLAG_SETTINGS];
