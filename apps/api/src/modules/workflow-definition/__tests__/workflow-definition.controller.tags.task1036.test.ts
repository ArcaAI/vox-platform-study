/**
 * TASK-1036 lane B3b — `GET admin/workflow-definitions/tags`. Inherits the class-level
 * `manage:WorkflowDefinition` + `@ForbidApiKey()` posture; declared before `:id` so the static path
 * is not swallowed by the param route.
 */
import { describe, expect, it, vi } from 'vitest';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { WorkflowDefinitionController } from '../workflow-definition.controller';

describe('WorkflowDefinitionController — tags (TASK-1036 B3b)', () => {
  it('declares GET tags', () => {
    expect(Reflect.getMetadata(PATH_METADATA, WorkflowDefinitionController.prototype.listTags)).toBe('tags');
    expect(Reflect.getMetadata(METHOD_METADATA, WorkflowDefinitionController.prototype.listTags)).toBe(RequestMethod.GET);
  });

  it('is declared BEFORE the `:id` read', () => {
    const names = Object.getOwnPropertyNames(WorkflowDefinitionController.prototype);
    const byIdRead = names.find((name) => {
      const handler = (WorkflowDefinitionController.prototype as unknown as Record<string, unknown>)[name];
      return (
        typeof handler === 'function' &&
        Reflect.getMetadata(PATH_METADATA, handler) === ':id' &&
        Reflect.getMetadata(METHOD_METADATA, handler) === RequestMethod.GET
      );
    });
    expect(byIdRead).toBeDefined();
    expect(names.indexOf('listTags')).toBeLessThan(names.indexOf(byIdRead as string));
  });

  it('documents 200, 400 and 403', () => {
    const responses = Reflect.getMetadata('swagger/apiResponse', WorkflowDefinitionController.prototype.listTags) as Record<string, unknown>;
    expect(Object.keys(responses)).toEqual(expect.arrayContaining(['200', '400', '403']));
  });

  it('parses q and limit and delegates', async () => {
    const service = { listTagSuggestions: vi.fn().mockResolvedValue([{ tag: 'notes', count: 2 }]) };
    const controller = new WorkflowDefinitionController(service as never, {} as never);

    expect(await controller.listTags({ q: 'no', limit: '5' })).toEqual([{ tag: 'notes', count: 2 }]);
    expect(service.listTagSuggestions).toHaveBeenCalledWith({ q: 'no', limit: 5 });

    await controller.listTags({ limit: 'abc' });
    expect(service.listTagSuggestions).toHaveBeenLastCalledWith({ q: undefined, limit: undefined });
  });
});
