/**
 * OD-9 — every gateway → TEXT call records its composed messages, through the ONE chokepoint every
 * call already runs (`applyEgressSafety`), fire-and-forget.
 */
import { describe, expect, it, vi } from 'vitest';
import { TextRequestEnrichmentService } from '../text-request-enrichment.service';

function build(tenantId: string | null = 'tenant-a') {
  const cls = { get: vi.fn((key: string) => (key === 'tenantId' ? tenantId : undefined)) };
  const recorder = { record: vi.fn() };
  const service = new TextRequestEnrichmentService(cls as never, undefined, undefined, undefined, recorder as never);
  return { service, recorder };
}

describe('the composed-prompt record on the egress chokepoint', () => {
  it('records the body`s system + user messages with the STAMPED locality, phase and agent', async () => {
    const { service, recorder } = build();
    const body = { prompt: 'USER', system_prompt: 'SYSTEM', provider: 'lm-studio', context: { agentSlug: 'clinic-summarizer' } };

    await service.applyEgressSafety(body, { deploymentKind: 'SELF_HOSTED', consultationId: 'c-1', phase: 'invoke' });

    expect(recorder.record).toHaveBeenCalledWith({
      tenantId: 'tenant-a',
      consultationId: 'c-1',
      agentSlug: 'clinic-summarizer',
      phase: 'invoke',
      provider: 'lm-studio',
      locality: 'local',
      system: 'SYSTEM',
      user: 'USER',
    });
  });

  it('records an UNSTAMPED provider as cloud — what apps/text will treat it as', async () => {
    const { service, recorder } = build();

    await service.applyEgressSafety({ prompt: 'U', system_prompt: 'S', provider: 'mystery' });

    expect(recorder.record).toHaveBeenCalledWith(expect.objectContaining({ locality: 'cloud', phase: 'generate' }));
  });

  it('records nothing for a body with no prompt (a credential probe), or with no tenant', async () => {
    const probe = build();
    await probe.service.applyEgressSafety({ provider: 'azure' });
    expect(probe.recorder.record).not.toHaveBeenCalled();

    const tenantless = build(null);
    await tenantless.service.applyEgressSafety({ prompt: 'U', provider: 'azure' });
    expect(tenantless.recorder.record).not.toHaveBeenCalled();
  });

  it('runs on the credential fold every caller uses', async () => {
    const { service, recorder } = build();

    await service.applyTenantProviderOverrides({ prompt: 'U', system_prompt: 'S', provider: 'azure' } as { provider?: string }, { phase: 'live' });

    expect(recorder.record).toHaveBeenCalledWith(expect.objectContaining({ phase: 'live', provider: 'azure' }));
  });
});
