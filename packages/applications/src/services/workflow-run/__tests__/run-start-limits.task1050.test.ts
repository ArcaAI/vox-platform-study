/**
 * TASK-1050 W2h (README §9.8.1) — every harness run start carries `guardrailHoldTimeoutSeconds`, the platform
 * setting `guardrail.hold.timeoutSeconds` resolved by the GATEWAY (gateway-resolved injection, rule 06): how
 * long a node held on a guardrail block waits for a resolution. Lane W2f reads exactly this name.
 */
import { describe, expect, it, vi } from 'vitest';
import { GUARDRAIL_HOLD_TIMEOUT_SECONDS_KEY } from '../../settings-registry/descriptors/guardrail-judge.descriptors';
import { HarnessGatewayService } from '../../consultation/harness/harness-gateway.service';
import { resolveRunStartLimits } from '../run-start-limits';

const settingsWith = (values: Record<string, unknown>) => ({
  resolvePlatform: vi.fn((key: string) => ({ key, value: values[key], source: 'system' })),
});

describe('resolveRunStartLimits — guardrailHoldTimeoutSeconds', () => {
  it('reads the platform value', () => {
    expect(resolveRunStartLimits(settingsWith({ [GUARDRAIL_HOLD_TIMEOUT_SECONDS_KEY]: 600 }) as never).limits.guardrailHoldTimeoutSeconds).toBe(600);
  });

  it('fails open to the 24 h descriptor default (absent resolver, unset, invalid, throwing)', () => {
    expect(resolveRunStartLimits(undefined).limits.guardrailHoldTimeoutSeconds).toBe(86_400);
    expect(resolveRunStartLimits(settingsWith({}) as never).limits.guardrailHoldTimeoutSeconds).toBe(86_400);
    expect(resolveRunStartLimits(settingsWith({ [GUARDRAIL_HOLD_TIMEOUT_SECONDS_KEY]: 'x' }) as never).limits.guardrailHoldTimeoutSeconds).toBe(
      86_400,
    );
    expect(
      resolveRunStartLimits({
        resolvePlatform: () => {
          throw new Error('boom');
        },
      } as never).limits.guardrailHoldTimeoutSeconds,
    ).toBe(86_400);
  });

  it('rides the :start body beside retentionSeconds and limits', async () => {
    const post = vi.fn().mockResolvedValue({ data: { runId: 'r', workflowId: 'w', temporalRunId: 't', status: 'started' } });
    const service = new HarnessGatewayService(
      { axiosRef: { post } } as never,
      { get: () => 'http://harness:8866' } as never,
      undefined,
      settingsWith({ [GUARDRAIL_HOLD_TIMEOUT_SECONDS_KEY]: 1200 }) as never,
    );
    await service.startWorkflowRun({ runId: 'r', sessionId: 's', workflowVersionId: 'v', tenantId: 't', configRef: {} as never });
    const [, body] = post.mock.calls[0];
    expect((body.limits as Record<string, unknown>).guardrailHoldTimeoutSeconds).toBe(1200);
  });
});
