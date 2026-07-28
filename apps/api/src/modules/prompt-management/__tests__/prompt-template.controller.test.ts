import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Reflector } from '@nestjs/core';
import { PATH_METADATA } from '@nestjs/common/constants';
import { REQUIRED_PERMISSIONS_KEY } from '@arcaai/applications';
import { REQUIRES_IF_MATCH_KEY } from '../../../decorators';
import { PromptTemplateController } from '../prompt-template.controller';

// End-user (clinician) prompt-template plane.
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
  // Doctor self-service surface.
  createPersonal: vi.fn(),
  updatePersonal: vi.fn(),
  deletePersonal: vi.fn(),
  setPreferredPromptTemplate: vi.fn(),
});

describe('PromptTemplateController (doc-09 end-user plane)', () => {
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
      const meta = Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, (PromptTemplateController.prototype as any).available);
      expect(meta).toEqual([{ action: 'read', subject: 'PromptTemplate' }]);
    });
  });

  // ─── Doctor self-service routes ───────────
  // These live on the END-USER plane (NOT /admin). Clinicians hold only
  // `read:PromptTemplate` (01-policy.ts), so every self-service route gates on
  // `read` and relies on the service's STRICT caller-ownership for real authz.
  describe('POST /prompt-templates (createPersonal)', () => {
    it('delegates to service.createPersonal with the body', async () => {
      const dto = { name: 'My SOAP', category: 'SUMMARY', content: 'x' };
      mockService.createPersonal.mockResolvedValue({ ...fakeTemplate, scope: 'USER_PERSONAL' });

      await controller.createPersonal(dto as never);

      expect(mockService.createPersonal).toHaveBeenCalledWith(dto);
    });

    it('gates on ["read","PromptTemplate"] (clinician plane)', () => {
      const meta = Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, (PromptTemplateController.prototype as any).createPersonal);
      expect(meta).toEqual([{ action: 'read', subject: 'PromptTemplate' }]);
    });
  });

  describe('PATCH /prompt-templates/:id (updatePersonal)', () => {
    it('delegates to service.updatePersonal with id + dto (no header)', async () => {
      const dto = { content: 'new', expectedVersion: 3 };
      mockService.updatePersonal.mockResolvedValue(fakeTemplate);

      await controller.updatePersonal('tpl-1', dto as never, undefined);

      expect(mockService.updatePersonal).toHaveBeenCalledWith('tpl-1', dto);
    });

    it('folds the If-Match header into expectedVersion (header wins)', async () => {
      mockService.updatePersonal.mockResolvedValue(fakeTemplate);

      await controller.updatePersonal('tpl-1', { content: 'new', expectedVersion: 99 } as never, 7);

      expect(mockService.updatePersonal).toHaveBeenCalledWith('tpl-1', expect.objectContaining({ content: 'new', expectedVersion: 7 }));
    });

    it('requires the If-Match header (@RequiresIfMatch metadata)', () => {
      const reflector = new Reflector();
      const flag = reflector.get(REQUIRES_IF_MATCH_KEY, PromptTemplateController.prototype.updatePersonal);
      expect(flag).toBe(true);
    });

    it('gates on ["read","PromptTemplate"] (clinician plane)', () => {
      const meta = Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, (PromptTemplateController.prototype as any).updatePersonal);
      expect(meta).toEqual([{ action: 'read', subject: 'PromptTemplate' }]);
    });
  });

  describe('DELETE /prompt-templates/:id (deletePersonal)', () => {
    it('delegates to service.deletePersonal with the id', async () => {
      mockService.deletePersonal.mockResolvedValue(fakeTemplate);

      await controller.deletePersonal('tpl-1');

      expect(mockService.deletePersonal).toHaveBeenCalledWith('tpl-1');
    });
  });

  describe('PUT /prompt-templates/preferred (setPreferred)', () => {
    it('delegates to service.setPreferredPromptTemplate with the templateId', async () => {
      mockService.setPreferredPromptTemplate.mockResolvedValue({ preferredPromptTemplateId: 'tpl-1' });

      const res = await controller.setPreferred({ templateId: 'tpl-1' } as never);

      expect(mockService.setPreferredPromptTemplate).toHaveBeenCalledWith('tpl-1');
      expect(res.preferredPromptTemplateId).toBe('tpl-1');
    });

    it('clears the preference when templateId is null', async () => {
      mockService.setPreferredPromptTemplate.mockResolvedValue({ preferredPromptTemplateId: null });

      const res = await controller.setPreferred({ templateId: null } as never);

      expect(mockService.setPreferredPromptTemplate).toHaveBeenCalledWith(null);
      expect(res.preferredPromptTemplateId).toBeNull();
    });
  });
});
