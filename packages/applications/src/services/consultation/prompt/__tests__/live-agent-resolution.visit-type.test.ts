/**
 * 2026-09-13 — `resolveForSession` hands the live chain the consultation's VISIT TYPE, derived
 * exactly as the live session derives its own (recorded marker first, parent link second), so the
 * per-turn agent tier can follow the graph's visit-type branch.
 */
import { describe, it, expect, vi } from 'vitest';

// The service imports two string constants from the live-documentation service, whose module
// graph pulls in the whole API surface (and `@nestjs/terminus`, absent from this package's
// dev tree). Only the constants are needed here.
vi.mock('../../live-documentation/live-documentation.service', () => ({
  LIVE_DOCUMENT_STABLE_SYSTEM_PREFIX: 'stable-prefix',
  LIVE_DOCUMENT_SYSTEM_PROMPT: 'system-prompt',
}));

import { LiveAgentResolutionService } from '../live-agent-resolution.service';

const TENANT = 'tenant-lar-visit';

function build(consultation: Record<string, unknown> | null) {
  const promptResolutionService = { resolve: vi.fn().mockResolvedValue({ resolvedFrom: 'code-default', content: null }) };
  const service = new LiveAgentResolutionService(
    { findById: vi.fn().mockResolvedValue(consultation) } as never,
    promptResolutionService as never,
    { findByVersionNumber: vi.fn() } as never,
    { findById: vi.fn() } as never,
    undefined,
  );
  return { service, promptResolutionService };
}

describe('LiveAgentResolutionService.resolveForSession — the visit type reaches the live chain', () => {
  it("derives 'revisit' from the parent link when nothing was recorded", async () => {
    const { service, promptResolutionService } = build({ id: 'c-1', tenantId: TENANT, departmentId: 'd-1', parentConsultationId: 'c-0', metadata: null });
    await service.resolveForSession({ consultationId: 'c-1', tenantId: TENANT });
    expect(promptResolutionService.resolve).toHaveBeenCalledWith(expect.objectContaining({ promptType: 'live', departmentId: 'd-1', visitType: 'revisit' }));
  });

  it("derives 'new-visit' without a parent link", async () => {
    const { service, promptResolutionService } = build({ id: 'c-1', tenantId: TENANT, departmentId: 'd-1', parentConsultationId: null, metadata: {} });
    await service.resolveForSession({ consultationId: 'c-1', tenantId: TENANT });
    expect(promptResolutionService.resolve).toHaveBeenCalledWith(expect.objectContaining({ visitType: 'new-visit' }));
  });

  it('the RECORDED visit type outranks the parent link (TASK-951 D-3), and an explicit input outranks both', async () => {
    const recorded = { id: 'c-1', tenantId: TENANT, departmentId: 'd-1', parentConsultationId: 'c-0', metadata: { visitType: 'new-visit' } };
    const a = build(recorded);
    await a.service.resolveForSession({ consultationId: 'c-1', tenantId: TENANT });
    expect(a.promptResolutionService.resolve).toHaveBeenCalledWith(expect.objectContaining({ visitType: 'new-visit' }));

    const b = build(recorded);
    await b.service.resolveForSession({ consultationId: 'c-1', tenantId: TENANT, visitType: 'revisit' });
    expect(b.promptResolutionService.resolve).toHaveBeenCalledWith(expect.objectContaining({ visitType: 'revisit' }));
  });

  it('passes no visit type when the consultation cannot be read (the chain is unchanged)', async () => {
    const { service, promptResolutionService } = build(null);
    await service.resolveForSession({ consultationId: 'missing', tenantId: TENANT });
    const params = promptResolutionService.resolve.mock.calls[0][0] as Record<string, unknown>;
    expect(params).not.toHaveProperty('visitType');
  });
});
