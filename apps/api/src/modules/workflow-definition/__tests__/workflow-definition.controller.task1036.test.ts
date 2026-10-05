/**
 * TASK-1036 lane A3 — `POST admin/workflow-definitions/:id/draft` (edit as new draft).
 *
 * The route inherits the class-level `manage:WorkflowDefinition` + `@ForbidApiKey()` +
 * `svc:admin:workflow-definition:manage` exactly as `:id/clone` does; the rules (400 / 409
 * OPEN_DRAFT_EXISTS / 404) live in the service and are pinned in the applications package.
 */
import { describe, it, expect, vi } from 'vitest';
import { RequestMethod } from '@nestjs/common';
import { PATH_METADATA, METHOD_METADATA, HTTP_CODE_METADATA } from '@nestjs/common/constants';
import { WorkflowDefinitionController } from '../workflow-definition.controller';

describe('WorkflowDefinitionController — edit as new draft (TASK-1036)', () => {
  it('declares POST :id/draft as a creation (default 201, no explicit 200 override)', () => {
    expect(Reflect.getMetadata(PATH_METADATA, WorkflowDefinitionController.prototype.createDraft)).toBe(':id/draft');
    expect(Reflect.getMetadata(METHOD_METADATA, WorkflowDefinitionController.prototype.createDraft)).toBe(RequestMethod.POST);
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, WorkflowDefinitionController.prototype.createDraft)).toBeUndefined();
  });

  it('documents the 400, 404 and 409 responses', () => {
    const responses = Reflect.getMetadata('swagger/apiResponse', WorkflowDefinitionController.prototype.createDraft) as Record<string, unknown>;
    expect(Object.keys(responses)).toEqual(expect.arrayContaining(['201', '400', '404', '409']));
  });

  it('delegates the source id to the service', async () => {
    const workflowDefinitionService = { createDraft: vi.fn().mockResolvedValue({ id: 'draft-1', status: 'DRAFT', versionNumber: 3 }) };
    const controller = new WorkflowDefinitionController(workflowDefinitionService as never, {} as never);

    const result = await controller.createDraft('pub-1');

    expect(workflowDefinitionService.createDraft).toHaveBeenCalledWith('pub-1');
    expect(result).toMatchObject({ id: 'draft-1', versionNumber: 3 });
  });
});
