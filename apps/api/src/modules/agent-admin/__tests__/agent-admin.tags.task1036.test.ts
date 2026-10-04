/**
 * TASK-1036 R1 — `GET admin/agents/tags?q=&limit=`, the agent mirror of the prompt-template tag
 * autocomplete. Static path, so it must be declared ABOVE every `:id` route; it inherits the
 * class gate (`manage:Agent`, off the API-key surface, `svc:admin:agent:manage`).
 */
import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { REQUIRED_PERMISSIONS_KEY } from '@arcaai/applications';
import { Reflector } from '@nestjs/core';
import { AgentAdminController } from '../agent-admin.controller';

describe('AgentAdminController — GET admin/agents/tags', () => {
  it('is declared above `:id` and inherits manage:Agent', () => {
    const declared = Object.getOwnPropertyNames(AgentAdminController.prototype);
    expect(declared.indexOf('listTags')).toBeGreaterThan(-1);
    expect(declared.indexOf('listTags')).toBeLessThan(declared.indexOf('fetchById'));
    expect(Reflect.getMetadata('path', AgentAdminController.prototype.listTags)).toBe('tags');
    expect(new Reflector().getAllAndOverride(REQUIRED_PERMISSIONS_KEY, [AgentAdminController.prototype.listTags, AgentAdminController])).toEqual([
      { action: 'manage', subject: 'Agent' },
    ]);
  });

  it('passes q and a positive numeric limit through; drops a junk limit', async () => {
    const service = { listTagSuggestions: vi.fn(async () => [{ tag: 'dept:cardiology', count: 2 }]) };
    const controller = new AgentAdminController(service as never);
    expect(await controller.listTags({ q: 'dept', limit: '5' })).toEqual([{ tag: 'dept:cardiology', count: 2 }]);
    expect(service.listTagSuggestions).toHaveBeenCalledWith({ q: 'dept', limit: 5 });
    await controller.listTags({ limit: 'abc' });
    expect(service.listTagSuggestions).toHaveBeenLastCalledWith({ q: undefined, limit: undefined });
  });
});
