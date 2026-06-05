import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PATH_METADATA } from '@nestjs/common/constants';
import { REQUIRED_PERMISSIONS_KEY } from '@arcaai/applications';
import { PromptTemplateController } from '../prompt-template.controller';

// TASK-331 doc-09 — end-user (clinician) prompt-template plane.
// This controller is the doctor-facing counterpart to the admin
// `PromptManagementController`. It must live OFF the `/admin/*` prefix and
// require only `read:PromptTemplate` (the new clinician policy) so an
// impersonated/direct doctor can populate the Pre-Summary / Summary selector
// without tripping the admin `manage:PromptTemplate` plane.

const fakeTemplate = {
    id: 'tpl-1',
    name: 'SOAP Summary',
    category: 'SUMMARY',
    scope: 'TENANT_DEFAULT',
    resourceStatus: 'ENABLED',
};

const createMockService = () => ({
    listAvailableForCaller: vi.fn(),
});

describe('PromptTemplateController (TASK-331 doc-09 — end-user plane)', () => {
    let controller: PromptTemplateController;
    let mockService: ReturnType<typeof createMockService>;

    beforeEach(() => {
        vi.clearAllMocks();
        mockService = createMockService();
        controller = new PromptTemplateController(mockService as never);
    });

    describe('GET /prompt-templates/available (available)', () => {
        it('delegates to service.listAvailableForCaller with the category filter', async () => {
            mockService.listAvailableForCaller.mockResolvedValue([fakeTemplate]);

            await controller.available({ category: 'SUMMARY' });

            expect(mockService.listAvailableForCaller).toHaveBeenCalledWith({ category: 'SUMMARY' });
            expect(mockService.listAvailableForCaller).toHaveBeenCalledTimes(1);
        });

        it('delegates with undefined category when no query param is supplied', async () => {
            mockService.listAvailableForCaller.mockResolvedValue([]);

            await controller.available({});

            expect(mockService.listAvailableForCaller).toHaveBeenCalledWith({ category: undefined });
        });

        it('returns the plain array produced by the service (no pagination envelope)', async () => {
            mockService.listAvailableForCaller.mockResolvedValue([fakeTemplate]);

            const result = await controller.available({});

            expect(Array.isArray(result)).toBe(true);
            expect(result).toHaveLength(1);
            expect(result[0].id).toBe('tpl-1');
        });
    });

    describe('plane separation (DEF — does NOT live under /admin)', () => {
        it('is served at the unprefixed "prompt-templates" path (not admin/*)', () => {
            const path = Reflect.getMetadata(PATH_METADATA, PromptTemplateController);
            expect(path).toBe('prompt-templates');
        });

        it('requires only ["read","PromptTemplate"] on the available route', () => {
            const meta = Reflect.getMetadata(
                REQUIRED_PERMISSIONS_KEY,
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                (PromptTemplateController.prototype as any).available,
            );
            expect(meta).toEqual([{ action: 'read', subject: 'PromptTemplate' }]);
        });
    });
});
