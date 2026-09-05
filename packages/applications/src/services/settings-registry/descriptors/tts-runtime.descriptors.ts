// The tts PLATFORM knobs: the handful of process-level settings that are neither
// a model fact, a provider fact nor an agent's opinion.
//
// TASK-879 EMPTIED MOST OF THIS FILE, and what is left is the residue rather
// than a category. A capability is an AGENT: the gateway resolves the tenant's
// TEXT_TO_SPEECH agent per request and pushes a `ResolvedTtsSpec`, so anything
// that describes WHAT is synthesised — the model, its mirror, its artifacts, its
// voices, the vendor endpoint, the vendor region, the vendor timeout, whether an
// engine may serve at all — now lives on the row that owns it:
//
//   `AiModel.sourceUri` / `.localPath` / `._metadata`   model + artifacts + voices
//   `AiProviderConnection.{baseUrl,region,timeoutS}`     where the vendor lives
//   `AiProviderConnection.enabled`                       may this engine serve
//   `Agent.parameters.{voice,sampleRate,…}`              what this capability sounds like
//
// The FOUR keys below survive because none of them is any of those. Two are
// PROCESS placement (`*.device` — which torch device this container's engine
// loads onto, a property of the pod, not of the model row it loads); one is a
// service-wide request ceiling; one is a boot-time strategy. A deployment has
// exactly one answer to each, so they ride the PULL route (`global-kv`,
// `consumedBy: ['tts']`) rather than being resolved per request.
//
// WHAT IS DELIBERATELY ABSENT
// ----------------------------
// **The two cloud credentials.** `TTS_AZURE_API_KEY` and `TTS_SARVAM_API_KEY`
// have no env path and no registry key: `apps/tts/src/tts/core/config.py` pins
// them to a `validation_alias` naming a variable nobody will ever set, with
// `populate_by_name` off, so no environment path to a cloud key exists even if an
// operator tries. Their home is the tenant → SYSTEM `AiProviderConnection` row
// (Vault-Transit ciphertext), injected per request as `provider_overrides`.
//
// **Per-provider VOICE names.** They are not config: a voice is an entry in the
// bound model's `_metadata.voices`, and the agent's `parameters.voice` selects
// one. The gateway resolves that binding into the spec on every request.
//
// EVERY `default` BELOW IS THE PYTHON FIELD'S CURRENT VALUE
// ----------------------------------------------------------
// Asserted by `apps/tts/src/tts/tests/unit/test_task799_descriptor_parity.py`.
// With no `GlobalSetting` row the cascade resolves the descriptor default, so an
// unseeded deployment runs on exactly the values it ran on before.

import { SettingDescriptor } from '../registry.types';

type TtsKnob = {
  dataType: 'boolean' | 'number' | 'string';
  default: boolean | number | string;
  label: string;
  description: string;
  category: string;
  killSwitch?: boolean;
};

const KNOBS: Record<string, TtsKnob> = {
  // ── Engine placement (a property of the POD, not of the model row) ───────
  'tts.indicParler.device': {
    dataType: 'string',
    default: 'cpu',
    label: 'Indic Parler device',
    description: 'Torch device for Indic Parler inference.',
    category: 'TTS Engines',
  },

  'tts.indicF5.device': {
    dataType: 'string',
    default: 'cpu',
    label: 'IndicF5 device',
    description: 'Torch device for IndicF5 inference.',
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

const KNOB_SETTINGS: SettingDescriptor[] = Object.entries(KNOBS).map<SettingDescriptor>(([key, knob]) => ({
  key,
  tier: 'global-kv',
  dataType: knob.dataType,
  // Never `secret`. The two cloud credentials are not here at all — see the
  // header — and the read service filters secrets off this route regardless.
  sensitivity: 'internal',
  // PLATFORM scope. There is no per-tenant half any more: what a tenant owns is
  // its AGENT (and its BYO connection row), and both travel the push channel as
  // the resolved spec.
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

/** The tts platform surface: four process-level knobs, all on the pull route. */
export const TTS_RUNTIME_SETTINGS: SettingDescriptor[] = [...KNOB_SETTINGS];
