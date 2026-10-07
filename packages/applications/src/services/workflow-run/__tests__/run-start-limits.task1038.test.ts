/**
 * TASK-1038 B3a deliverable 4 — every interpreter run start carries the stream retention and the
 * payload-size limits, resolved by the GATEWAY (gateway-resolved injection, rule 06): never a
 * literal in the harness, never an env var (owner config rule). Lane B1 consumes exactly
 * `retentionSeconds` and `limits: { nodeOutputClaimCheckMinBytes, resultInlineMaxBytes,
 * activityInputMaxBytes }`.
 */
import { describe, expect, it, vi } from 'vitest';
import { HOPE_SETTINGS_REGISTRY } from '../../settings-registry/registry';
import {
  WORKFLOW_RUNS_ACTIVITY_INPUT_MAX_BYTES_KEY,
  WORKFLOW_RUNS_DEFAULTS,
  WORKFLOW_RUNS_EVENT_RETENTION_HOURS_KEY,
  WORKFLOW_RUNS_NODE_OUTPUT_CLAIM_CHECK_MIN_BYTES_KEY,
  WORKFLOW_RUNS_RESULT_INLINE_MAX_BYTES_KEY,
} from '../../settings-registry/descriptors/workflow-runs.descriptors';
import { HarnessGatewayService } from '../../consultation/harness/harness-gateway.service';
import { resolveRunStartLimits } from '../run-start-limits';

const settingsWith = (values: Record<string, unknown>) => ({ resolvePlatform: vi.fn((key: string) => ({ key, value: values[key], source: 'system' })) });

describe('the three payload-limit descriptors', () => {
  it.each([
    [WORKFLOW_RUNS_NODE_OUTPUT_CLAIM_CHECK_MIN_BYTES_KEY, 20480],
    [WORKFLOW_RUNS_RESULT_INLINE_MAX_BYTES_KEY, 65536],
    [WORKFLOW_RUNS_ACTIVITY_INPUT_MAX_BYTES_KEY, 1572864],
  ])('%s: platform-only, open-to-default, default %s', (key, value) => {
    const descriptor = HOPE_SETTINGS_REGISTRY.get(key);
    expect(descriptor).toMatchObject({ tier: 'global-kv', failMode: 'open-to-default', maxScope: 'system', globalOnly: true, default: value });
    expect(descriptor?.validate?.(value)).toBeUndefined();
    expect(descriptor?.validate?.(0)).toBeDefined();
    expect(descriptor?.validate?.(1.5)).toBeDefined();
  });

  it('the inline-result ceiling cannot exceed the protocol`s 64 KiB inline rule', () => {
    expect(HOPE_SETTINGS_REGISTRY.get(WORKFLOW_RUNS_RESULT_INLINE_MAX_BYTES_KEY)?.validate?.(65537)).toBeDefined();
  });
});

describe('resolveRunStartLimits', () => {
  it('reads the platform values', () => {
    const settings = settingsWith({
      [WORKFLOW_RUNS_EVENT_RETENTION_HOURS_KEY]: 2,
      [WORKFLOW_RUNS_NODE_OUTPUT_CLAIM_CHECK_MIN_BYTES_KEY]: 4096,
      [WORKFLOW_RUNS_RESULT_INLINE_MAX_BYTES_KEY]: 32768,
      [WORKFLOW_RUNS_ACTIVITY_INPUT_MAX_BYTES_KEY]: 1000000,
    });
    expect(resolveRunStartLimits(settings as never)).toEqual({
      retentionSeconds: 7200,
      limits: { nodeOutputClaimCheckMinBytes: 4096, resultInlineMaxBytes: 32768, activityInputMaxBytes: 1000000 },
      // TASK-1050 — the guardrail hold timeout rides the same body (its own test: run-start-limits.task1050).
      guardrailHoldTimeoutSeconds: 86_400,
    });
  });

  it('fails open to the defaults (absent resolver, unset or invalid value, a resolver that throws)', () => {
    const expected = {
      retentionSeconds: WORKFLOW_RUNS_DEFAULTS.eventRetentionHours * 3600,
      limits: { nodeOutputClaimCheckMinBytes: 20480, resultInlineMaxBytes: 65536, activityInputMaxBytes: 1572864 },
      guardrailHoldTimeoutSeconds: 86_400,
    };
    expect(resolveRunStartLimits(undefined)).toEqual(expected);
    expect(resolveRunStartLimits(settingsWith({ [WORKFLOW_RUNS_RESULT_INLINE_MAX_BYTES_KEY]: 'x' }) as never)).toEqual(expected);
    expect(resolveRunStartLimits({ resolvePlatform: () => { throw new Error('boom'); } } as never)).toEqual(expected);
  });
});

describe('HarnessGatewayService.startWorkflowRun carries them on EVERY start', () => {
  it('adds retentionSeconds + limits to the :start body', async () => {
    const post = vi.fn().mockResolvedValue({ data: { runId: 'r', workflowId: 'w', temporalRunId: 't', status: 'started' } });
    const service = new HarnessGatewayService(
      { axiosRef: { post } } as never,
      { get: () => 'http://harness:8866' } as never,
      undefined,
      settingsWith({ [WORKFLOW_RUNS_EVENT_RETENTION_HOURS_KEY]: 1 }) as never,
    );
    await service.startWorkflowRun({ runId: 'r', sessionId: 's', workflowVersionId: 'v', tenantId: 't', configRef: {} as never });
    const [, body] = post.mock.calls[0];
    expect(body.retentionSeconds).toBe(3600);
    expect(body.limits).toEqual({ nodeOutputClaimCheckMinBytes: 20480, resultInlineMaxBytes: 65536, activityInputMaxBytes: 1572864 });
  });
});
