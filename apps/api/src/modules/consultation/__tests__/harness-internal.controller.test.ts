/**
 * HarnessInternalController Unit Tests (TASK-330 Phase 1 — Lane G)
 *
 * The inbound /internal/harness/* surface. Thin controller: it delegates each
 * route to HarnessInternalService and is class-guarded by HarnessServiceTokenGuard.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { SKIP_AUTH_KEY } from '@arcaai/applications';
import { HarnessInternalController } from '../harness-internal.controller';
import { HarnessServiceTokenGuard } from '../harness-service-token.guard';

const mockService = {
    persistEntities: vi.fn(),
    assemble: vi.fn(),
    persistDraft: vi.fn(),
    recordGateDecision: vi.fn(),
};

describe('HarnessInternalController', () => {
    let controller: HarnessInternalController;

    beforeEach(() => {
        vi.clearAllMocks();
        controller = new HarnessInternalController(mockService as any);
    });

    it('is class-guarded by HarnessServiceTokenGuard', () => {
        const guards = Reflect.getMetadata(GUARDS_METADATA, HarnessInternalController) as unknown[] | undefined;
        expect(guards).toContain(HarnessServiceTokenGuard);
    });

    it('is @Public() so the boot route-audit passes and the global auth chain defers to the service-token guard', () => {
        // The routes are service-to-service (X-Service-Token), not user-JWT. Without
        // @Public() the boot-time route-permission audit (TASK-307 W4a.1) refuses to
        // start, AND a future global APP_GUARD would reject the harness's token calls
        // before HarnessServiceTokenGuard runs. @Public() only sets SKIP_AUTH_KEY — the
        // class-level HarnessServiceTokenGuard still enforces the token.
        const skipAuth = Reflect.getMetadata(SKIP_AUTH_KEY, HarnessInternalController) as boolean | undefined;
        expect(skipAuth).toBe(true);
    });

    it('POST entities -> persistEntities(consultationId, dto)', async () => {
        mockService.persistEntities.mockResolvedValue({ savedCount: 1, entityIds: ['ne-1'] });
        const dto = { tenantId: 't-1', contextItemId: 'tx-1', entities: [{ text: 'X', type: 'CONDITION' }] };

        const result = await controller.persistEntities('consultation-1', dto as any);

        expect(mockService.persistEntities).toHaveBeenCalledWith('consultation-1', dto);
        expect(result).toEqual({ savedCount: 1, entityIds: ['ne-1'] });
    });

    it('POST assemble -> assemble(consultationId, dto)', async () => {
        mockService.assemble.mockResolvedValue({ userPrompt: 'p', systemPrompt: 's' });
        const dto = { tenantId: 't-1' };

        const result = await controller.assemble('consultation-1', dto as any);

        expect(mockService.assemble).toHaveBeenCalledWith('consultation-1', dto);
        expect(result).toEqual({ userPrompt: 'p', systemPrompt: 's' });
    });

    it('POST draft -> persistDraft(consultationId, dto)', async () => {
        mockService.persistDraft.mockResolvedValue({ contextItemId: 'ctx-1' });
        const dto = { tenantId: 't-1', content: 'S: ...' };

        const result = await controller.persistDraft('consultation-1', dto as any);

        expect(mockService.persistDraft).toHaveBeenCalledWith('consultation-1', dto);
        expect(result).toEqual({ contextItemId: 'ctx-1' });
    });

    it('POST gate-decision -> recordGateDecision(consultationId, dto)', async () => {
        mockService.recordGateDecision.mockResolvedValue({ recorded: true });
        const dto = { tenantId: 't-1', decision: 'SIGNED', gateDecision: 'PASS', attestationHash: 'h-1', clinicianId: 'doc-1' };

        const result = await controller.recordGateDecision('consultation-1', dto as any);

        expect(mockService.recordGateDecision).toHaveBeenCalledWith('consultation-1', dto);
        expect(result).toEqual({ recorded: true });
    });
});
