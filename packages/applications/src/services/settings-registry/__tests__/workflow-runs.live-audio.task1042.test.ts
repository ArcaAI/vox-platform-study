/**
 * TASK-1042 — `workflowRuns.liveAudioMaxSeconds`: how long a standalone run waits for its bound
 * live STT session to end (OD-4a). A governed, fail-open `global-kv` knob — default 3600 s, never
 * above the harness's own tighten-only clamp (`LIVE_AUDIO_MAX_WAIT_SECONDS = 3600`).
 */
import { describe, expect, it } from 'vitest';
import { HOPE_SETTINGS_REGISTRY } from '../registry';
import { WORKFLOW_RUNS_DEFAULTS, WORKFLOW_RUNS_LIVE_AUDIO_MAX_SECONDS_KEY } from '../descriptors/workflow-runs.descriptors';

describe('workflowRuns.liveAudioMaxSeconds (TASK-1042)', () => {
  it('is registered as a fail-open global-kv number defaulting to 3600', () => {
    expect(WORKFLOW_RUNS_LIVE_AUDIO_MAX_SECONDS_KEY).toBe('workflowRuns.liveAudioMaxSeconds');
    const descriptor = HOPE_SETTINGS_REGISTRY.get(WORKFLOW_RUNS_LIVE_AUDIO_MAX_SECONDS_KEY);
    expect(descriptor).toMatchObject({ tier: 'global-kv', failMode: 'open-to-default', dataType: 'number', default: 3600 });
    expect(WORKFLOW_RUNS_DEFAULTS.liveAudioMaxSeconds).toBe(3600);
  });

  it('accepts a whole number up to the harness clamp and refuses anything above it or non-integral', () => {
    const validate = HOPE_SETTINGS_REGISTRY.get(WORKFLOW_RUNS_LIVE_AUDIO_MAX_SECONDS_KEY)?.validate;
    expect(validate?.(3600)).toBeUndefined();
    expect(validate?.(60)).toBeUndefined();
    expect(validate?.(3601)).toBeDefined();
    expect(validate?.(59)).toBeDefined();
    expect(validate?.(90.5)).toBeDefined();
  });
});
