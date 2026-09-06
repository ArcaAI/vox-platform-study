import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';
import { REQUIRED_PERMISSIONS_KEY } from '@arcaai/applications';
import { REQUIRES_IF_MATCH_KEY } from '../../../decorators';
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
  createPersonal: vi.fn(),
  updatePromptTemplate: vi.fn(),
  getPromptTemplate: vi.fn(),
  listPromptTemplates: vi.fn(),
  listPromptTemplatesPaginated: vi.fn(),
  listDefaultsForDepartment: vi.fn(),
  listMyPersonalForDepartment: vi.fn(),
  getVersions: vi.fn(),
  getVersion: vi.fn(),
  diffVersions: vi.fn(),
  getUsageStats: vi.fn(),
  startPromptTemplateTest: vi.fn(),
  finalizePromptTemplateTest: vi.fn(),
  getUsageAnalytics: vi.fn(),
  listUsageRecords: vi.fn(),
  softDeletePromptTemplate: vi.fn(),
  assignToDepartment: vi.fn(),
  // prompt governance approval.
  approveTemplate: vi.fn(),
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
    // Pagination is resolved in the repository; the controller delegates
    // to `listPromptTemplatesPaginated` and returns its
    // `{data,count,page,limit}` shape unchanged.
    const paginated = (data: unknown[], count = data.length, page = 1, limit = 50) => ({ data, count, page, limit });

    it('should call service.listPromptTemplatesPaginated with filters + page/limit', async () => {
      mockService.listPromptTemplatesPaginated.mockResolvedValue(paginated([fakeTemplateEntity]));

      await controller.list({ category: 'SUMMARY', search: 'soap' } as any);

      expect(mockService.listPromptTemplatesPaginated).toHaveBeenCalledWith({
        category: 'SUMMARY',
        departmentId: undefined,
        search: 'soap',
        includeDisabled: false,
        page: 1,
        limit: 50,
      });
    });

    // TASK-890 J2-4 — `?tags=a,b` was silently dropped by the inline query
    // type even though the service resolves it (`hasEvery`).
    it('should forward a comma-separated tags filter as an array', async () => {
      mockService.listPromptTemplatesPaginated.mockResolvedValue(paginated([fakeTemplateEntity]));

      await controller.list({ tags: 'pre-summary,dept-free' } as any);

      expect(mockService.listPromptTemplatesPaginated).toHaveBeenCalledWith(
        expect.objectContaining({ tags: ['pre-summary', 'dept-free'] }),
      );
    });

    it('should forward a repeated tags query param as an array', async () => {
      mockService.listPromptTemplatesPaginated.mockResolvedValue(paginated([fakeTemplateEntity]));

      await controller.list({ tags: ['pre-summary', 'dept-free'] } as any);

      expect(mockService.listPromptTemplatesPaginated).toHaveBeenCalledWith(
        expect.objectContaining({ tags: ['pre-summary', 'dept-free'] }),
      );
    });

    // An empty / whitespace-only chip is "no filter", not "match a row with no
    // tags" — the service treats an empty array the same way, but sending
    // `[]` from a cleared chip would be indistinguishable from a real filter.
    it('should send no tags filter when the param is empty', async () => {
      mockService.listPromptTemplatesPaginated.mockResolvedValue(paginated([fakeTemplateEntity]));

      await controller.list({ tags: ' , ' } as any);

      expect(mockService.listPromptTemplatesPaginated).toHaveBeenCalledWith(expect.objectContaining({ tags: undefined }));
    });

    it('should pass includeDisabled: true when query param is "true"', async () => {
      mockService.listPromptTemplatesPaginated.mockResolvedValue(paginated([fakeTemplateEntity]));

      await controller.list({ includeDisabled: 'true' } as any);

      expect(mockService.listPromptTemplatesPaginated).toHaveBeenCalledWith(expect.objectContaining({ includeDisabled: true }));
    });

    it('should pass includeDisabled: false when query param is absent', async () => {
      mockService.listPromptTemplatesPaginated.mockResolvedValue(paginated([fakeTemplateEntity]));

      await controller.list({} as any);

      expect(mockService.listPromptTemplatesPaginated).toHaveBeenCalledWith(expect.objectContaining({ includeDisabled: false }));
    });

    it('should forward explicit page/limit query params', async () => {
      mockService.listPromptTemplatesPaginated.mockResolvedValue(paginated([], 0, 3, 10));

      await controller.list({ page: 3, limit: 10 } as any);

      expect(mockService.listPromptTemplatesPaginated).toHaveBeenCalledWith(expect.objectContaining({ page: 3, limit: 10 }));
    });

    it('should return the paginated response from the service', async () => {
      mockService.listPromptTemplatesPaginated.mockResolvedValue(paginated([fakeTemplateEntity], 1));

      const result = await controller.list({} as any);

      expect(result).toBeDefined();
      expect(result.data).toHaveLength(1);
      expect(result.count).toBe(1);
      expect(result.page).toBe(1);
      expect(result.limit).toBe(50);
    });

    it('should pass includeDisabled: false when query param is "false" string', async () => {
      mockService.listPromptTemplatesPaginated.mockResolvedValue(paginated([]));

      await controller.list({ includeDisabled: 'false' } as any);

      expect(mockService.listPromptTemplatesPaginated).toHaveBeenCalledWith(expect.objectContaining({ includeDisabled: false }));
    });

    it('should pass includeDisabled: false for non-boolean string values', async () => {
      mockService.listPromptTemplatesPaginated.mockResolvedValue(paginated([]));

      await controller.list({ includeDisabled: '1' } as any);

      expect(mockService.listPromptTemplatesPaginated).toHaveBeenCalledWith(expect.objectContaining({ includeDisabled: false }));
    });

    it('should return mixed ENABLED and DISABLED templates when includeDisabled is true', async () => {
      const disabledTemplate = { ...fakeTemplateEntity, id: 'tpl-2', resourceStatus: 'DISABLED' };
      mockService.listPromptTemplatesPaginated.mockResolvedValue(paginated([fakeTemplateEntity, disabledTemplate], 2));

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
    it('should call service.updatePromptTemplate with id and body (no If-Match header → body wins)', async () => {
      // When `@ExpectedVersion()` resolves to `undefined` (header missing
      // on a non-`@RequiresIfMatch()` route, or in this unit test where
      // the guard does not run), the controller forwards the request
      // unchanged.
      const body = { content: 'Updated content', changeReason: 'Fix typo', expectedVersion: 5 };
      mockService.updatePromptTemplate.mockResolvedValue(fakeTemplateEntity);

      await controller.update('tpl-1', body as any, undefined);

      expect(mockService.updatePromptTemplate).toHaveBeenCalledWith('tpl-1', body);
    });

    it('should return the updated template', async () => {
      mockService.updatePromptTemplate.mockResolvedValue(fakeTemplateEntity);

      const result = await controller.update('tpl-1', { content: 'Updated', expectedVersion: 1 } as any, undefined);

      expect(result).toBeDefined();
      expect(result.name).toBe('SOAP Summary');
    });

    it('folds the If-Match header into the body-field expectedVersion (header wins)', async () => {
      // Mirrors the tenant/department/global-setting controllers: when
      // the client sets `If-Match: "7"`, the parser hands us `7` and
      // it must take precedence over any body-supplied value.
      mockService.updatePromptTemplate.mockResolvedValue(fakeTemplateEntity);

      await controller.update('tpl-1', { content: 'Updated', expectedVersion: 99 } as any, 7);

      expect(mockService.updatePromptTemplate).toHaveBeenCalledWith(
        'tpl-1',
        expect.objectContaining({
          content: 'Updated',
          expectedVersion: 7,
        }),
      );
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

  describe('GET /prompt-templates/:id/versions/:from/diff/:to (diffVersions)', () => {
    it('delegates to service.diffVersions with id + from/to version numbers', async () => {
      const diff = {
        promptTemplateId: 'tpl-1',
        fromVersion: 1,
        toVersion: 2,
        fields: [],
        changes: [],
        patch: '',
        stats: { additions: 0, deletions: 0, unchanged: 0 },
      };
      mockService.diffVersions.mockResolvedValue(diff);

      const result = await controller.diffVersions('tpl-1', 1, 2);

      expect(mockService.diffVersions).toHaveBeenCalledWith('tpl-1', 1, 2);
      expect(result).toBe(diff);
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

  // ─── Prompt test run ────────────────────────────────────

  describe('POST /prompt-templates/:id/test (testTemplate — BUG-018 submit)', () => {
    const fakeAck = {
      mode: 'stream' as const,
      provider: 'azure-openai',
      model: 'gpt-4o',
      assembledPrompt: 'Summarize asthma',
      taskId: 'task-1',
      streamUrl: 'text/tasks/task-1/stream',
    };

    it('delegates to service.startPromptTemplateTest with id + body (no If-Match involved)', async () => {
      mockService.startPromptTemplateTest.mockResolvedValue(fakeAck);
      const body = { variables: { topic: 'asthma' } };

      await controller.testTemplate('tpl-1', body as any);

      expect(mockService.startPromptTemplateTest).toHaveBeenCalledWith('tpl-1', body);
    });

    it('returns the ack (taskId + streamUrl) without awaiting a completion', async () => {
      mockService.startPromptTemplateTest.mockResolvedValue(fakeAck);

      const result = await controller.testTemplate('tpl-1', {} as any);

      expect(result.mode).toBe('stream');
      expect(result.taskId).toBe('task-1');
      expect(result.streamUrl).toBe('text/tasks/task-1/stream');
      expect(result.assembledPrompt).toBe('Summarize asthma');
    });

    it('returns a dry-run ack carrying the assembled prompt and no task id', async () => {
      mockService.startPromptTemplateTest.mockResolvedValue({
        mode: 'dry-run',
        provider: 'azure-openai',
        model: 'gpt-4o',
        assembledPrompt: 'Summarize asthma',
      });

      const result = await controller.testTemplate('tpl-1', { dryRun: true } as any);

      expect(result.mode).toBe('dry-run');
      expect(result.taskId).toBeUndefined();
    });
  });

  describe('POST /prompt-templates/:id/test/finalize (finalizeTestTemplate)', () => {
    const fakeResult = { id: 'tpl-1', score: 0.92, output: 'Generated output', testedAt: '2026-06-02T00:00:00.000Z', version: 6 };

    it('delegates to service.finalizePromptTemplateTest with id + body when no If-Match header', async () => {
      mockService.finalizePromptTemplateTest.mockResolvedValue(fakeResult);
      const body = { taskId: 'task-1', expectedVersion: 5 };

      await controller.finalizeTestTemplate('tpl-1', body as any, undefined);

      expect(mockService.finalizePromptTemplateTest).toHaveBeenCalledWith('tpl-1', body);
    });

    it('folds the If-Match header into expectedVersion (header wins) — OCC parity with update', async () => {
      mockService.finalizePromptTemplateTest.mockResolvedValue(fakeResult);

      await controller.finalizeTestTemplate('tpl-1', { taskId: 'task-1', expectedVersion: 99 } as any, 7);

      expect(mockService.finalizePromptTemplateTest).toHaveBeenCalledWith('tpl-1', expect.objectContaining({ expectedVersion: 7 }));
    });

    it('returns the score + output result DTO from the service', async () => {
      mockService.finalizePromptTemplateTest.mockResolvedValue(fakeResult);

      const result = await controller.finalizeTestTemplate('tpl-1', { taskId: 'task-1' } as any, undefined);

      expect(result.score).toBe(0.92);
      expect(result.output).toBe('Generated output');
      expect(result.version).toBe(6);
    });
  });

  // ─── Usage analytics ────────────────────────────────────

  describe('GET /prompt-templates/analytics/usage (getUsageAnalytics)', () => {
    const fakeAnalytics = {
      totalUsages: 5,
      byDepartment: [{ departmentId: 'dept-1', count: 5 }],
      byDoctor: [{ doctorId: 'doc-1', count: 5 }],
      byDay: [{ day: '2026-06-01', count: 5 }],
    };

    it('delegates to service.getUsageAnalytics with the promptTemplateId filter', async () => {
      mockService.getUsageAnalytics.mockResolvedValue(fakeAnalytics);

      await controller.getUsageAnalytics({ promptTemplateId: 'tpl-9' } as any);

      expect(mockService.getUsageAnalytics).toHaveBeenCalledWith({ promptTemplateId: 'tpl-9' });
    });

    it('delegates with an empty filter when no query params are supplied', async () => {
      mockService.getUsageAnalytics.mockResolvedValue(fakeAnalytics);

      await controller.getUsageAnalytics({} as any);

      expect(mockService.getUsageAnalytics).toHaveBeenCalledWith({ promptTemplateId: undefined });
    });

    it('returns the analytics aggregates from the service', async () => {
      mockService.getUsageAnalytics.mockResolvedValue(fakeAnalytics);

      const result = await controller.getUsageAnalytics({} as any);

      expect(result.totalUsages).toBe(5);
      expect(result.byDepartment).toHaveLength(1);
      expect(result.byDoctor).toHaveLength(1);
      expect(result.byDay).toHaveLength(1);
    });
  });

  // Raw run rows for the tenant-detail Agent Jobs surface.
  describe('GET /prompt-templates/usage-records (listUsageRecords)', () => {
    const fakePage = {
      count: 42,
      page: 1,
      limit: 10,
      data: [
        {
          id: 'run-1',
          promptTemplateId: 'tpl-1',
          promptVersionNumber: 2,
          consultationId: 'cons-1',
          doctorId: 'doc-1',
          departmentId: 'dept-1',
          createdAt: '2026-07-01T09:00:00.000Z',
        },
      ],
    };

    it('parses page/limit query strings into numbers and forwards the template filter', async () => {
      mockService.listUsageRecords.mockResolvedValue(fakePage);

      await controller.listUsageRecords({ page: '1', limit: '10', promptTemplateId: 'tpl-1' });

      expect(mockService.listUsageRecords).toHaveBeenCalledWith({ page: 1, limit: 10, promptTemplateId: 'tpl-1' });
    });

    it('passes undefined page/limit when omitted (service applies defaults)', async () => {
      mockService.listUsageRecords.mockResolvedValue(fakePage);

      await controller.listUsageRecords({});

      expect(mockService.listUsageRecords).toHaveBeenCalledWith({ page: undefined, limit: undefined, promptTemplateId: undefined });
    });

    it('returns the paginated envelope from the service unchanged', async () => {
      mockService.listUsageRecords.mockResolvedValue(fakePage);

      const result = await controller.listUsageRecords({ page: '1', limit: '10' });

      expect(result.count).toBe(42);
      expect(result.data).toHaveLength(1);
      expect(result.data[0].id).toBe('run-1');
    });

    it('is declared as a static usage-records path (not shadowed by :id routes)', () => {
      const path = Reflect.getMetadata(PATH_METADATA, PromptManagementController.prototype.listUsageRecords);
      expect(path).toBe('usage-records');
    });
  });

  describe('POST /prompt-templates/:id/versions/:versionNumber/activate (activateVersion)', () => {
    it('should get the version content and update the template, passing expectedVersion from the current template', async () => {
      // `activateVersion` is a server-driven rollback (no user-supplied
      // If-Match). The controller re-reads the current template to
      // capture its `_version` and forwards it as `expectedVersion` so
      // the CAS write still has a valid predicate.
      mockService.getVersion.mockResolvedValue(fakeVersionEntity);
      mockService.getPromptTemplate.mockResolvedValue({ ...fakeTemplateEntity, version: 13 });
      mockService.updatePromptTemplate.mockResolvedValue(fakeTemplateEntity);

      await controller.activateVersion('tpl-1', 1);

      expect(mockService.getVersion).toHaveBeenCalledWith('tpl-1', 1);
      expect(mockService.getPromptTemplate).toHaveBeenCalledWith('tpl-1');
      expect(mockService.updatePromptTemplate).toHaveBeenCalledWith('tpl-1', {
        content: fakeVersionEntity.content,
        variables: fakeVersionEntity.variables,
        changeReason: 'Activated version 1',
        expectedVersion: 13,
      });
    });

    it('should throw NotFoundException when version not found', async () => {
      mockService.getVersion.mockResolvedValue(null);

      await expect(controller.activateVersion('tpl-1', 99)).rejects.toThrow();
    });

    it('should throw NotFoundException when the template itself is gone between getVersion and CAS read', async () => {
      // Defensive — if the template was hard-deleted between the
      // version lookup and our re-read for `_version`, surface as 404
      // rather than risk passing `undefined` into the CAS write.
      mockService.getVersion.mockResolvedValue(fakeVersionEntity);
      mockService.getPromptTemplate.mockResolvedValue(null);

      await expect(controller.activateVersion('tpl-1', 1)).rejects.toThrow();
      expect(mockService.updatePromptTemplate).not.toHaveBeenCalled();
    });
  });

  // ─── prompt governance approval ─────────────────

  describe('POST /prompt-templates/:id/approve (approveTemplate)', () => {
    const approvedResponse = { ...fakeTemplateEntity, status: 'APPROVED', version: 3 };

    it('delegates to service.approveTemplate with id + body when no If-Match header (body wins)', async () => {
      mockService.approveTemplate.mockResolvedValue(approvedResponse);
      const body = { reason: 'Vetted by clinical lead', expectedVersion: 2 };

      await controller.approve('tpl-1', body as any, undefined);

      expect(mockService.approveTemplate).toHaveBeenCalledWith('tpl-1', body);
    });

    it('folds the If-Match header into expectedVersion (header wins) — OCC parity with update', async () => {
      mockService.approveTemplate.mockResolvedValue(approvedResponse);

      await controller.approve('tpl-1', { reason: 'ok', expectedVersion: 99 } as any, 7);

      expect(mockService.approveTemplate).toHaveBeenCalledWith('tpl-1', expect.objectContaining({ reason: 'ok', expectedVersion: 7 }));
    });

    it('returns the APPROVED template response from the service', async () => {
      mockService.approveTemplate.mockResolvedValue(approvedResponse);

      const result = await controller.approve('tpl-1', {} as any, undefined);

      expect(result.status).toBe('APPROVED');
    });

    it('propagates ForbiddenException (403) when caller is not a SUPER_ADMIN', async () => {
      mockService.approveTemplate.mockRejectedValue(new ForbiddenException('super admins only'));

      await expect(controller.approve('tpl-1', {} as any, 1)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('propagates NotFoundException (404) on cross-tenant / unknown template', async () => {
      mockService.approveTemplate.mockRejectedValue(new NotFoundException('not found'));

      await expect(controller.approve('missing', {} as any, 1)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('is marked @RequiresIfMatch() so a missing If-Match header is rejected 428 by the guard/param decorator', () => {
      const flag = Reflect.getMetadata(REQUIRES_IF_MATCH_KEY, PromptManagementController.prototype.approve);
      expect(flag).toBe(true);
    });
  });

  // ─── Authorization metadata ─────────────────────────

  describe('Authorization decorators (DEF-C2)', () => {
    const getClassMetadata = () => Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, PromptManagementController);

    const getMethodMetadata = (method: string) =>
      Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, (PromptManagementController.prototype as any)[method]);

    // Plane separation. The admin read surface is bumped class-level
    // `read`→`manage` so that granting clinicians the `read:PromptTemplate`
    // ability does NOT also open the admin GET routes
    // (list/getById/versions/usage/analytics) to them. Admins keep
    // `manage` (no regression); the method-level create/update/delete
    // tuples are unchanged because `getAllAndOverride` lets a handler
    // decorator win over the class one.
    it('should require ["manage","PromptTemplate"] at class level (doc-09 D1 plane bump)', () => {
      expect(getClassMetadata()).toEqual([{ action: 'manage', subject: 'PromptTemplate' }]);
    });

    it('should require ["create","PromptTemplate"] on create (POST /prompt-templates)', () => {
      expect(getMethodMetadata('create')).toEqual([{ action: 'create', subject: 'PromptTemplate' }]);
    });

    it('should require ["update","PromptTemplate"] on update (PATCH /prompt-templates/:id)', () => {
      expect(getMethodMetadata('update')).toEqual([{ action: 'update', subject: 'PromptTemplate' }]);
    });

    it('should require ["delete","PromptTemplate"] on remove (DELETE /prompt-templates/:id)', () => {
      expect(getMethodMetadata('remove')).toEqual([{ action: 'delete', subject: 'PromptTemplate' }]);
    });

    it('should require ["update","PromptTemplate"] on activateVersion (POST /prompt-templates/:id/versions/:n/activate)', () => {
      expect(getMethodMetadata('activateVersion')).toEqual([{ action: 'update', subject: 'PromptTemplate' }]);
    });

    it('should require ["update","PromptTemplate"] on testTemplate (POST /prompt-templates/:id/test)', () => {
      expect(getMethodMetadata('testTemplate')).toEqual([{ action: 'update', subject: 'PromptTemplate' }]);
    });

    it('should require ["update","Department"] on assignDepartment (POST /prompt-templates/assign-department)', () => {
      // TASK-873 — narrowed from `manage:Department`. The route performs one OCC
      // UPDATE of the Department row's prompt-slot columns (via
      // `DepartmentService.updatePromptConfig`), so `manage` overstated it and
      // put the requirement out of reach of this controller's own machine scope.
      expect(getMethodMetadata('assignDepartment')).toEqual([{ action: 'update', subject: 'Department' }]);
    });
  });

  describe('mounted under the audited /admin prefix', () => {
    it('is served at admin/prompt-templates (not the unprefixed path)', () => {
      const path = Reflect.getMetadata(PATH_METADATA, PromptManagementController);
      expect(path).toBe('admin/prompt-templates');
    });
  });

  describe('POST /prompt-templates/assign-department (DEF-C4)', () => {
    it('should delegate to service.assignToDepartment with the request body', async () => {
      const body = { departmentId: 'dept-card', newPatientPromptId: 'np-1', revisitPromptId: 'rv-1' };
      mockService.assignToDepartment.mockResolvedValue({ id: 'dept-card' });

      await controller.assignDepartment(body as never);

      expect(mockService.assignToDepartment).toHaveBeenCalledWith(body);
      expect(mockService.assignToDepartment).toHaveBeenCalledTimes(1);
    });

    it('should return the value produced by the service (no transformation)', async () => {
      const deptResponse = { id: 'dept-card', name: 'Cardiology' };
      mockService.assignToDepartment.mockResolvedValue(deptResponse);

      const result = await controller.assignDepartment({
        departmentId: 'dept-card',
      } as never);

      expect(result).toBe(deptResponse);
    });

    it('should propagate errors from the service (e.g., tenant guard NotFoundException)', async () => {
      mockService.assignToDepartment.mockRejectedValue(new Error('Department not found'));

      await expect(controller.assignDepartment({ departmentId: 'wrong' } as never)).rejects.toThrow('Department not found');
    });
  });
});
