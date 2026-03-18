import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PromptManagementController } from '../prompt-management.controller';

const fakeTemplateEntity = {
    id: 'tpl-1',
    name: 'SOAP Summary',
    description: 'Standard SOAP format',
    content: 'Generate a SOAP note for {{department}}',
    category: 'SUMMARY',
    variables: [{ name: 'department', type: 'string', required: true }],
    currentVersionNumber: 2,
    departmentId: 'dept-card',
    tags: ['cardiology', 'soap'],
    resourceStatus: 'ENABLED',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-02-01T00:00:00.000Z',
};

const fakeVersionEntity = {
    id: 'ver-1',
    promptTemplateId: 'tpl-1',
    versionNumber: 1,
    content: 'Generate a SOAP note for {{department}}',
    variables: [{ name: 'department', type: 'string', required: true }],
    changeReason: 'Initial version',
    changedBy: 'admin',
    createdAt: '2026-01-01T00:00:00.000Z',
};

const createMockService = () => ({
    createPromptTemplate: vi.fn(),
    updatePromptTemplate: vi.fn(),
    getPromptTemplate: vi.fn(),
    listPromptTemplates: vi.fn(),
    getVersions: vi.fn(),
    getVersion: vi.fn(),
    getUsageStats: vi.fn(),
    softDeletePromptTemplate: vi.fn(),
});

describe('PromptManagementController', () => {
    let controller: PromptManagementController;
    let mockService: ReturnType<typeof createMockService>;

    beforeEach(() => {
        vi.clearAllMocks();
        mockService = createMockService();
        controller = new PromptManagementController(mockService as any);
    });

    describe('POST /prompt-templates (create)', () => {
        it('should call service.createPromptTemplate with request body', async () => {
            const request = {
                name: 'New Template',
                content: 'Test content',
                category: 'CUSTOM',
            };
            mockService.createPromptTemplate.mockResolvedValue(fakeTemplateEntity);

            await controller.create(request as any);

            expect(mockService.createPromptTemplate).toHaveBeenCalledWith(request);
            expect(mockService.createPromptTemplate).toHaveBeenCalledTimes(1);
        });

        it('should return the created template response', async () => {
            mockService.createPromptTemplate.mockResolvedValue(fakeTemplateEntity);

            const result = await controller.create({
                name: 'New Template',
                content: 'Test',
                category: 'CUSTOM',
            } as any);

            expect(result).toBeDefined();
            expect(result.id).toBe('tpl-1');
            expect(result.name).toBe('SOAP Summary');
        });
    });

    describe('GET /prompt-templates (list)', () => {
        it('should call service.listPromptTemplates with filters', async () => {
            mockService.listPromptTemplates.mockResolvedValue([fakeTemplateEntity]);

            await controller.list({ category: 'SUMMARY', search: 'soap' } as any);

            expect(mockService.listPromptTemplates).toHaveBeenCalledWith({
                category: 'SUMMARY',
                search: 'soap',
                includeDisabled: false,
            });
        });

        it('should pass includeDisabled: true when query param is "true"', async () => {
            mockService.listPromptTemplates.mockResolvedValue([fakeTemplateEntity]);

            await controller.list({ includeDisabled: 'true' } as any);

            expect(mockService.listPromptTemplates).toHaveBeenCalledWith(
                expect.objectContaining({ includeDisabled: true }),
            );
        });

        it('should pass includeDisabled: false when query param is absent', async () => {
            mockService.listPromptTemplates.mockResolvedValue([fakeTemplateEntity]);

            await controller.list({} as any);

            expect(mockService.listPromptTemplates).toHaveBeenCalledWith(
                expect.objectContaining({ includeDisabled: false }),
            );
        });

        it('should return wrapped paginated response', async () => {
            mockService.listPromptTemplates.mockResolvedValue([fakeTemplateEntity]);

            const result = await controller.list({} as any);

            expect(result).toBeDefined();
            expect(result.data).toHaveLength(1);
            expect(result.count).toBe(1);
        });

        it('should pass includeDisabled: false when query param is "false" string', async () => {
            mockService.listPromptTemplates.mockResolvedValue([]);

            await controller.list({ includeDisabled: 'false' } as any);

            expect(mockService.listPromptTemplates).toHaveBeenCalledWith(
                expect.objectContaining({ includeDisabled: false }),
            );
        });

        it('should pass includeDisabled: false for non-boolean string values', async () => {
            mockService.listPromptTemplates.mockResolvedValue([]);

            await controller.list({ includeDisabled: '1' } as any);

            expect(mockService.listPromptTemplates).toHaveBeenCalledWith(
                expect.objectContaining({ includeDisabled: false }),
            );
        });

        it('should return mixed ENABLED and DISABLED templates when includeDisabled is true', async () => {
            const disabledTemplate = { ...fakeTemplateEntity, id: 'tpl-2', resourceStatus: 'DISABLED' };
            mockService.listPromptTemplates.mockResolvedValue([fakeTemplateEntity, disabledTemplate]);

            const result = await controller.list({ includeDisabled: 'true' } as any);

            expect(result.data).toHaveLength(2);
            expect(result.count).toBe(2);
        });
    });

    describe('GET /prompt-templates/:id (getById)', () => {
        it('should call service.getPromptTemplate with id', async () => {
            mockService.getPromptTemplate.mockResolvedValue(fakeTemplateEntity);

            await controller.getById('tpl-1');

            expect(mockService.getPromptTemplate).toHaveBeenCalledWith('tpl-1');
            expect(mockService.getPromptTemplate).toHaveBeenCalledTimes(1);
        });

        it('should throw NotFoundException when template not found', async () => {
            mockService.getPromptTemplate.mockResolvedValue(null);

            await expect(controller.getById('nonexistent')).rejects.toThrow();
        });
    });

    describe('PATCH /prompt-templates/:id (update)', () => {
        it('should call service.updatePromptTemplate with id and body', async () => {
            const body = { content: 'Updated content', changeReason: 'Fix typo' };
            mockService.updatePromptTemplate.mockResolvedValue(fakeTemplateEntity);

            await controller.update('tpl-1', body as any);

            expect(mockService.updatePromptTemplate).toHaveBeenCalledWith('tpl-1', body);
        });

        it('should return the updated template', async () => {
            mockService.updatePromptTemplate.mockResolvedValue(fakeTemplateEntity);

            const result = await controller.update('tpl-1', { content: 'Updated' } as any);

            expect(result).toBeDefined();
            expect(result.name).toBe('SOAP Summary');
        });
    });

    describe('DELETE /prompt-templates/:id (delete)', () => {
        it('should call service.softDeletePromptTemplate with id', async () => {
            mockService.softDeletePromptTemplate.mockResolvedValue(fakeTemplateEntity);

            await controller.remove('tpl-1');

            expect(mockService.softDeletePromptTemplate).toHaveBeenCalledWith('tpl-1');
            expect(mockService.softDeletePromptTemplate).toHaveBeenCalledTimes(1);
        });
    });

    describe('GET /prompt-templates/:id/versions (getVersions)', () => {
        it('should call service.getVersions with templateId', async () => {
            mockService.getVersions.mockResolvedValue([fakeVersionEntity]);

            await controller.getVersions('tpl-1');

            expect(mockService.getVersions).toHaveBeenCalledWith('tpl-1');
        });

        it('should return array of versions', async () => {
            mockService.getVersions.mockResolvedValue([fakeVersionEntity]);

            const result = await controller.getVersions('tpl-1');

            expect(result).toHaveLength(1);
            expect(result[0].versionNumber).toBe(1);
        });
    });

    describe('GET /prompt-templates/:id/versions/:versionNumber (getVersion)', () => {
        it('should call service.getVersion with templateId and versionNumber', async () => {
            mockService.getVersion.mockResolvedValue(fakeVersionEntity);

            await controller.getVersion('tpl-1', 1);

            expect(mockService.getVersion).toHaveBeenCalledWith('tpl-1', 1);
        });

        it('should throw NotFoundException when version not found', async () => {
            mockService.getVersion.mockResolvedValue(null);

            await expect(controller.getVersion('tpl-1', 99)).rejects.toThrow();
        });
    });

    describe('GET /prompt-templates/:id/usage (getUsageStats)', () => {
        it('should call service.getUsageStats with templateId', async () => {
            mockService.getUsageStats.mockResolvedValue({ totalUsages: 42, lastUsedAt: '2026-02-01' });

            const result = await controller.getUsageStats('tpl-1');

            expect(mockService.getUsageStats).toHaveBeenCalledWith('tpl-1');
            expect(result.totalUsages).toBe(42);
        });
    });

    describe('POST /prompt-templates/:id/versions/:versionNumber/activate (activateVersion)', () => {
        it('should get the version content and update the template', async () => {
            mockService.getVersion.mockResolvedValue(fakeVersionEntity);
            mockService.updatePromptTemplate.mockResolvedValue(fakeTemplateEntity);

            await controller.activateVersion('tpl-1', 1);

            expect(mockService.getVersion).toHaveBeenCalledWith('tpl-1', 1);
            expect(mockService.updatePromptTemplate).toHaveBeenCalledWith('tpl-1', {
                content: fakeVersionEntity.content,
                variables: fakeVersionEntity.variables,
                changeReason: 'Activated version 1',
            });
        });

        it('should throw NotFoundException when version not found', async () => {
            mockService.getVersion.mockResolvedValue(null);

            await expect(controller.activateVersion('tpl-1', 99)).rejects.toThrow();
        });
    });
});
