/**
 * TASK-957 F-9 (mapper half) — one self-hosted provider set, not three.
 *
 * `vocabulary.ts` (`SELF_HOSTED_PROVIDER_IDS`), `consultation/summary/text-usage.ts`
 * and this mapper each carried their own copy. They were identical, which is
 * exactly why it was survivable and exactly why it would not stay that way: the
 * blocking and streaming halves of the SAME agent classify `deployment` through
 * different functions, so the next self-hosted id added to one list and not the
 * others silently bills one half as CLOUD. TASK-952/E already shipped a new
 * provider id (`tei-embed`) that was in none of the three.
 *
 * The convergence is pinned by MEMBERSHIP, not by a spelled-out list: a test
 * that restates the set is a fourth copy. What must hold is that this mapper's
 * verdict and the canonical one are the same function of the same input.
 */
import { describe, expect, it } from 'vitest';
import {
  AgentSessionKind,
  AgentStepStatus,
  AgentStepType,
  AgentTrajectoryStepFactory,
  AiDeploymentKind,
} from '@arcaai/domains';

import { buildHarnessUsageEvent } from '../harness-usage.mapper';
import { classifyLlmDeployment, KNOWN_PROVIDERS, SELF_HOSTED_PROVIDER_IDS } from '../../usageLedger/vocabulary';

function stepFor(provider: string) {
  return AgentTrajectoryStepFactory.CreateStep({
    tenantId: 'tenant-1',
    sessionKind: AgentSessionKind.HARNESS_DOC,
    sessionId: 'wf-session-1',
    runId: 'wf-run-1',
    seq: 1,
    stepType: AgentStepType.LLM_CALL,
    name: 'generate',
    status: AgentStepStatus.OK,
    startedAt: new Date('2026-09-13T10:00:00.000Z'),
    endedAt: new Date('2026-09-13T10:00:02.000Z'),
    stats: { provider, model: 'm', prompt_tokens: 10, predicted_tokens: 5 },
  });
}

describe('harness-usage.mapper — deployment classification (TASK-957 F-9)', () => {
  it('agrees with classifyLlmDeployment for EVERY known provider id', () => {
    for (const provider of KNOWN_PROVIDERS) {
      const event = buildHarnessUsageEvent(stepFor(provider));
      expect(event, `provider ${provider} produced no batch`).not.toBeNull();
      expect(event!.common.deployment, `provider ${provider}`).toBe(AiDeploymentKind[classifyLlmDeployment(provider, false)]);
    }
  });

  it('classifies a provider that is in the canonical set but was NOT in the local copy', () => {
    // `harness` — the durable worker itself — joined `SELF_HOSTED_PROVIDER_IDS`
    // under TASK-959 and never reached this mapper's private list. It is the
    // concrete instance of the fork this convergence removes.
    expect(SELF_HOSTED_PROVIDER_IDS.has('harness')).toBe(true);
    expect(buildHarnessUsageEvent(stepFor('harness'))!.common.deployment).toBe(AiDeploymentKind.SELF_HOSTED);
  });

  it('still lets a tenant-funded step win over the provider — BYOK is derived from funding', () => {
    const step = AgentTrajectoryStepFactory.CreateStep({
      tenantId: 'tenant-1',
      sessionKind: AgentSessionKind.HARNESS_DOC,
      sessionId: 'wf-session-1',
      runId: 'wf-run-1',
      seq: 1,
      stepType: AgentStepType.LLM_CALL,
      name: 'generate',
      status: AgentStepStatus.OK,
      startedAt: new Date('2026-09-13T10:00:00.000Z'),
      endedAt: new Date('2026-09-13T10:00:02.000Z'),
      stats: { provider: 'ollama', model: 'm', prompt_tokens: 10, predicted_tokens: 5, funding_tier: 'tenant' },
    });

    expect(buildHarnessUsageEvent(step)!.common.deployment).toBe(AiDeploymentKind.BYOK);
  });
});
