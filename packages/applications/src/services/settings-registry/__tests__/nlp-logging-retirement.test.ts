// TASK-883 — the 11 `nlp.logging.*` keys are RETIRED.
//
// The deployment ships stdout → Alloy → Loki and mounts no log volume for
// `apps/nlp`, so a rotating FILE sink writes to an ephemeral container
// filesystem nobody reads. The whole file/rotation surface goes: the
// descriptors here, the handler wiring in `nlp/core/logging.py`, and the
// `EffectiveConfigSnapshot.logging()` group that served them. structlog to
// stdout stays, which is the sink that was actually in force (`file_enabled`
// defaulted `false` and no GlobalSetting row ever overrode it).
import { describe, expect, it } from 'vitest';
import { HOPE_SETTINGS_REGISTRY } from '../registry';
import { SERVICE_RUNTIME_DEFAULTS } from '../descriptors/service-runtime.descriptors';

const RETIRED_KEYS = [
  'nlp.logging.fileEnabled',
  'nlp.logging.fileMaxSize',
  'nlp.logging.fileMaxFiles',
  'nlp.logging.fileSeparateError',
  'nlp.logging.consoleEnabled',
  'nlp.logging.fileJsonFormat',
  'nlp.logging.consoleJsonFormat',
  'nlp.logging.rotationWhen',
  'nlp.logging.rotationInterval',
  'nlp.logging.rotationBackupCount',
  'nlp.logging.useDailyRotation',
] as const;

describe('TASK-883 — nlp.logging.* retirement', () => {
  it('declares none of the eleven keys as a service-runtime default', () => {
    const declared = Object.keys(SERVICE_RUNTIME_DEFAULTS);
    expect(declared.filter((k) => RETIRED_KEYS.includes(k as (typeof RETIRED_KEYS)[number]))).toEqual([]);
  });

  it('registers none of them in the platform registry', () => {
    for (const key of RETIRED_KEYS) {
      expect(HOPE_SETTINGS_REGISTRY.has(key), `${key} is still registered`).toBe(false);
    }
  });

  it('keeps no `nlp.logging.` key at all — including any later addition', () => {
    expect(HOPE_SETTINGS_REGISTRY.list().filter((d) => d.key.startsWith('nlp.logging.'))).toEqual([]);
  });

  it('leaves the surviving nlp service-runtime groups untouched', () => {
    // The retirement is scoped to log SINKS. The queue/batch geometry and the
    // two concurrency bounds are live control-plane knobs and must not follow.
    for (const key of ['nlp.inference.maxConcurrent', 'nlp.peerCall.maxConcurrent', 'nlp.inference.batchMaxSize', 'nlp.interactiveInference.batchMaxSize']) {
      expect(HOPE_SETTINGS_REGISTRY.has(key), `${key} was collateral damage`).toBe(true);
    }
  });
});
