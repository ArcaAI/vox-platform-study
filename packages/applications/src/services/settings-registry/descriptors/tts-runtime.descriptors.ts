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

import { EDITABLE_BY_NONE, SettingDescriptor } from '../registry.types';

/**
 * The five provider `*_ENABLED` flags — still read from `process.env`, and
 * declared here so the surface is complete and the pending migration is
 * queryable rather than buried in prose. That is exactly what `targetTier` is
 * for (`platform-knobs.descriptors.ts` records ten keys migrated this way).
 *
 * WHY THEY DID NOT MOVE WITH EVERYTHING ELSE IN THIS FILE
 * --------------------------------------------------------
 * They are DEPLOYMENT SHAPE, not runtime policy: which engines a container runs
 * is chosen together with which optional extras were installed in its image, so
 * a flag that enables an engine whose package is absent does nothing useful.
 *
 * The binding constraint is concrete. `TTS_KOKORO_ENABLED=true` in the k8s
 * ConfigMap is what makes a KEYLESS deployment reach `/health/ready` at all —
 * `apps/tts/src/tts/tests/unit/test_keyless_readiness_task642.py` exists because
 * `hope-tts` once answered 503 forever, so its Service carried no endpoints and
 * `TTS_URL` resolved to nothing. Closing that env path with no seeded
 * `GlobalSetting` row, while the manifests live in a separate repository
 * (`arca/hope-v2-deployment`), would reproduce that outage on the next deploy.
 *
 * Moving them is therefore a COORDINATED change — seed the rows, update the
 * manifests, then close the env path — not something to slip in alongside a
 * tuning migration. `tts.indicF5.enabled` is the one that most wants it: its
 * CC-BY-NC licensing gate is still enforced only by a code comment.
 *
 * `tier: 'env'` ⇒ `editableBy: EDITABLE_BY_NONE` (a governance test binds that
 * both ways) and NO `consumedBy`: a key the service does not read off the pull
 * route must not claim to be served on it.
 *
 * NAMING — note these do NOT all share a prefix with their `global-kv` siblings
 * above (`tts.parler.enabled` next to `tts.indicParler.*`, `tts.indicf5.enabled`
 * next to `tts.indicF5.*`). That is required, not sloppy: an `env`-tier key must
 * DERIVE its real variable name through `toEnvVarName`, and the variables the
 * service actually reads are `TTS_PARLER_ENABLED` and `TTS_INDICF5_ENABLED` —
 * `tts.indicParler.enabled` would derive `TTS_INDIC_PARLER_ENABLED`, which no
 * process reads. `global-kv` keys are DB-addressed and carry no such obligation,
 * so they keep the readable camelCase spelling. When these flags eventually move
 * to `redis-flag` the constraint lifts and the names can be unified.
 */
const PROVIDER_ENABLE_FLAGS: ReadonlyArray<{ key: string; label: string; description: string; category: string }> = [
  {
    key: 'tts.azure.enabled',
    label: 'Azure Speech provider enabled',
    description:
      'Registers the Azure AI Speech provider at boot (env `TTS_AZURE_ENABLED`). A registered cloud ' +
      'provider with no platform credential is still not a routing candidate — it would 401 the live ' +
      'API — so enabling it without a key only makes it reachable to tenants that bring their own.',
    category: 'TTS Providers',
  },
  {
    key: 'tts.sarvam.enabled',
    label: 'Sarvam provider enabled',
    description:
      'Registers the Sarvam Bulbul provider (env `TTS_SARVAM_ENABLED`). The PUBLIC Sarvam API is not ' +
      'PHI-safe — no BAA, 30-day retention, not India-resident — so point `tts.sarvam.baseUrl` at the ' +
      'enterprise VPC or on-prem host before enabling it for real patient data.',
    category: 'TTS Providers',
  },
  {
    key: 'tts.kokoro.enabled',
    label: 'Kokoro engine enabled',
    description:
      'Registers the self-hosted Kokoro English engine (env `TTS_KOKORO_ENABLED`). This is the flag a ' +
      'KEYLESS deployment needs to become Ready: the SYSTEM row routes `en` to kokoro, so without it ' +
      'the service registers no provider and reports 503. Weights load on the first synthesis request.',
    category: 'TTS Engines',
  },
  {
    key: 'tts.parler.enabled',
    label: 'Indic Parler engine enabled',
    description: 'Registers the self-hosted AI4Bharat Indic Parler-TTS Malayalam engine (env `TTS_PARLER_ENABLED`).',
    category: 'TTS Engines',
  },
  {
    key: 'tts.indicf5.enabled',
    label: 'IndicF5 engine enabled (LICENSE-GATED)',
    description:
      'Registers the experimental IndicF5 voice-clone engine (env `TTS_INDICF5_ENABLED`). Prod and ' +
      'commercial enablement are NO-GO pending license review: the released weights are a fine-tune of ' +
      'the CC-BY-NC SWivid F5-TTS base, and the MIT tag cannot override NonCommercial. That gate is ' +
      'currently enforced only by a code comment — moving this key to `redis-flag`, where enabling it ' +
      'is a SUPER_ADMIN write with an audit trail, is the reason `targetTier` is recorded here.',
    category: 'TTS Engines',
  },
];

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

const ENABLE_FLAG_SETTINGS: SettingDescriptor[] = PROVIDER_ENABLE_FLAGS.map<SettingDescriptor>((flag) => ({
  key: flag.key,
  // The honest present-tense answer: this value lives in `process.env` TODAY.
  tier: 'env',
  targetTier: 'redis-flag',
  dataType: 'boolean',
  sensitivity: 'internal',
  maxScope: 'system',
  editableBy: EDITABLE_BY_NONE,
  globalOnly: true,
  // NOT `killSwitch: true` — that flag marks an ENFORCING gate, and the registry
  // requires one to default OFF. These select which engines a deployment runs;
  // `tts.kokoro.enabled` is set true in the live manifest precisely so the
  // service can serve anything at all. Marking them would assert a fail-safe
  // default that is not the one in force.
  failMode: 'open-to-default',
  // Deliberately no `consumedBy`: the service reads these from env, not from the
  // pull route. Declaring one would advertise a delivery path that does not exist.
  category: flag.category,
  label: flag.label,
  description: flag.description,
  default: false,
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
