// Inference-readiness descriptors (TASK-890 §3.12).
//
// FIVE `global-kv` platform knobs, and NOT ONE env var — rule 00
// §Configuration Principles: a cadence, a sweep switch and a cron expression
// are configuration a platform admin changes without a restart, which is the
// definition of a non-env tier.
//
// Two of the five are pre-existing and were UNGOVERNED. `ModelInventoryCronService`
// has read `modelRegistry.inventory.{enabled,cron}` through
// `IAppSettingsService.getValueWithDefault` since TASK-860, but no descriptor
// registered them, so the keys were unreachable from every admin surface and the
// sweep's posture was effectively a code constant (its own header said so: "Until
// those descriptors are registered … the sweep runs on demand only"). Registering
// a descriptor is the ONLY step needed to make a key governed and writable —
// there is no per-key allow-list — so this file closes that gap by existing.
//
// POLARITY. None of the five is a `killSwitch`. The registry enforces that a
// kill-switch defaults OFF, which is right for a knob that disables an
// ENFORCEMENT path; these three switches disable a MEASUREMENT (a readiness
// observation, a bucket inventory). Turning one off removes information, it does
// not remove a guard — the same reasoning `metering.outbox.drain.enabled` carries.
//
// DEFAULTS ARE ON. Pre-production posture (owner rule: build for day-1): a
// platform admin turns readiness off, they do not have to turn it on. The
// inventory default flips with it, because `availability` — which the sweep is
// the only scheduled writer of — is what decides readiness for every
// platform-self-host model row. Left OFF, those rows would report `unknown`
// forever on a working platform.

import { SettingDescriptor } from '../registry.types';
import {
  INFERENCE_READINESS_CLOUD_PROBE_INTERVAL_KEY,
  INFERENCE_READINESS_DEFAULTS,
  INFERENCE_READINESS_ENABLED_KEY,
  INFERENCE_READINESS_INTERVAL_KEY,
} from '../../ai-readiness/inference-readiness.constants';
import { MODEL_INVENTORY_SETTING_KEYS } from '../../ai-model/inventory/model-inventory.cron.service';

export { INFERENCE_READINESS_CLOUD_PROBE_INTERVAL_KEY, INFERENCE_READINESS_ENABLED_KEY, INFERENCE_READINESS_INTERVAL_KEY };

/** Every setting shares this policy: a platform-only, non-secret, fail-open knob. */
const PLATFORM_KNOB = {
  tier: 'global-kv',
  sensitivity: 'internal',
  maxScope: 'system',
  editableBy: 'all',
  globalOnly: true,
  failMode: 'open-to-default',
  category: 'Platform Operations',
} as const satisfies Partial<SettingDescriptor>;

export const AI_READINESS_SETTINGS: SettingDescriptor[] = [
  // ── The readiness sweep ────────────────────────────────────────────────
  {
    ...PLATFORM_KNOB,
    key: INFERENCE_READINESS_ENABLED_KEY,
    dataType: 'boolean',
    label: 'Inference-readiness sweep enabled',
    description:
      'Master switch for the scheduled readiness sweep: one probe of the platform engines through the text service, ' +
      'joined with the six service heartbeats and the model registry, stored as one Redis snapshot. Turning it off ' +
      'stops the observation — every model then reports readiness `unknown` and the catalogue says so, rather than ' +
      'claiming a state nobody measured.',
    default: INFERENCE_READINESS_DEFAULTS.enabled,
  },
  {
    ...PLATFORM_KNOB,
    key: INFERENCE_READINESS_INTERVAL_KEY,
    dataType: 'number',
    label: 'Inference-readiness sweep interval (seconds)',
    description:
      'Minimum seconds between two sweeps. The scheduler ticks on the heartbeat cadence (30s) and skips a tick that ' +
      'arrives sooner than this, so raising it thins the sweep without rescheduling anything. The snapshot expires ' +
      'after three intervals: a stale snapshot is not an observation.',
    default: INFERENCE_READINESS_DEFAULTS.intervalSeconds,
  },
  {
    ...PLATFORM_KNOB,
    key: INFERENCE_READINESS_CLOUD_PROBE_INTERVAL_KEY,
    dataType: 'number',
    label: 'Cloud-connection re-resolve interval (seconds)',
    description:
      'Minimum seconds between two re-resolutions of a SYSTEM cloud connection during the sweep. Deliberately much ' +
      'slower than the engine cadence: resolving a cloud credential is a Vault decrypt, and a vendor model listing is ' +
      'a metered call. A self-hosted engine costs neither and is probed every sweep.',
    default: INFERENCE_READINESS_DEFAULTS.cloudProbeIntervalSeconds,
  },

  // ── The bucket inventory (pre-existing keys, registered here) ───────────
  {
    ...PLATFORM_KNOB,
    key: MODEL_INVENTORY_SETTING_KEYS.enabled,
    dataType: 'boolean',
    label: 'Model-bucket inventory sweep enabled',
    description:
      'Master switch for the scheduled inventory that measures `AiModel.availability` against the models bucket. It is ' +
      'the only scheduled writer of that column, and readiness for every platform-served model is availability × the ' +
      'serving service’s heartbeat — so with this off, those rows never leave `UNKNOWN`. The on-demand route ' +
      '(`POST admin/ai-models/inventory`) stays available either way.',
    default: true,
  },
  {
    ...PLATFORM_KNOB,
    key: MODEL_INVENTORY_SETTING_KEYS.cron,
    dataType: 'string',
    label: 'Model-bucket inventory schedule (cron)',
    description:
      'Standard five-field cron expression for the inventory sweep. The scheduler re-reads it on every settings-cache ' +
      'refresh, so a change takes effect without a restart.',
    default: '0 * * * *',
  },
];
