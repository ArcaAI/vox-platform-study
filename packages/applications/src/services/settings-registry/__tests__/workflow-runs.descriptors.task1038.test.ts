/**
 * TASK-1038 — the run-delivery knobs are governed `global-kv` descriptors (no literal config):
 * fail open to their OD-25 defaults, bounded at write time, and registered in the one registry.
 */
import { describe, expect, it } from 'vitest';
import { HOPE_SETTINGS_REGISTRY } from '../registry';
import {
  WORKFLOW_RUNS_DEFAULTS,
  WORKFLOW_RUNS_EVENT_RETENTION_HOURS_KEY,
  WORKFLOW_RUNS_RESULT_RETENTION_DAYS_KEY,
  WORKFLOW_RUNS_RESULT_URL_TTL_SECONDS_KEY,
  WORKFLOW_RUNS_SETTINGS,
  WORKFLOW_RUNS_TERMINAL_CHECK_SECONDS_KEY,
  WORKFLOW_RUNS_WS_MAX_BUFFERED_BYTES_KEY,
} from '../descriptors/workflow-runs.descriptors';

describe('workflowRuns.* descriptors (TASK-1038)', () => {
  it('registers every key as a fail-open global-kv tuning knob', () => {
    for (const descriptor of WORKFLOW_RUNS_SETTINGS) {
      expect(HOPE_SETTINGS_REGISTRY.get(descriptor.key)).toBe(descriptor);
      expect(descriptor).toMatchObject({ tier: 'global-kv', failMode: 'open-to-default', dataType: 'number', sensitivity: 'internal' });
      expect(descriptor.validate?.(descriptor.default)).toBeUndefined();
    }
  });

  it('carries the owner`s OD-25 defaults: events 24 h after terminal, results 30 days', () => {
    expect(HOPE_SETTINGS_REGISTRY.get(WORKFLOW_RUNS_EVENT_RETENTION_HOURS_KEY)?.default).toBe(24);
    expect(HOPE_SETTINGS_REGISTRY.get(WORKFLOW_RUNS_RESULT_RETENTION_DAYS_KEY)?.default).toBe(30);
    expect(WORKFLOW_RUNS_DEFAULTS).toMatchObject({ eventRetentionHours: 24, resultRetentionDays: 30 });
  });

  it('result retention is tenant-overridable (a tenant owns its PHI retention); the delivery-plane knobs are platform-only', () => {
    expect(HOPE_SETTINGS_REGISTRY.get(WORKFLOW_RUNS_RESULT_RETENTION_DAYS_KEY)).toMatchObject({ maxScope: 'tenant', globalOnly: false });
    for (const key of [
      WORKFLOW_RUNS_EVENT_RETENTION_HOURS_KEY,
      WORKFLOW_RUNS_TERMINAL_CHECK_SECONDS_KEY,
      WORKFLOW_RUNS_WS_MAX_BUFFERED_BYTES_KEY,
      WORKFLOW_RUNS_RESULT_URL_TTL_SECONDS_KEY,
    ]) {
      expect(HOPE_SETTINGS_REGISTRY.get(key)).toMatchObject({ maxScope: 'system', globalOnly: true });
    }
  });

  it.each([
    [WORKFLOW_RUNS_RESULT_RETENTION_DAYS_KEY, 0],
    [WORKFLOW_RUNS_RESULT_RETENTION_DAYS_KEY, 366],
    [WORKFLOW_RUNS_EVENT_RETENTION_HOURS_KEY, 1.5],
    [WORKFLOW_RUNS_TERMINAL_CHECK_SECONDS_KEY, 1],
    [WORKFLOW_RUNS_RESULT_URL_TTL_SECONDS_KEY, 7200],
  ])('refuses %s = %s at write time', (key, value) => {
    expect(HOPE_SETTINGS_REGISTRY.get(key)?.validate?.(value)).toEqual(expect.any(String));
  });
});
