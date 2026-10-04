/**
 * TASK-1036 OD-21 — `GET admin/agents/:slug/versions/:versionNumber/usage`. Inherits the class
 * gate (`manage:Agent`, off the API-key surface, `svc:admin:agent:manage`).
 */
import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { REQUIRED_PERMISSIONS_KEY } from '@arcaai/applications';
import { Reflector } from '@nestjs/core';
import { AgentAdminController } from '../agent-admin.controller';

describe('AgentAdminController — GET admin/agents/:slug/versions/:versionNumber/usage', () => {
  it('is mounted at :slug/versions/:versionNumber/usage and inherits manage:Agent', () => {
    expect(Reflect.getMetadata('path', AgentAdminController.prototype.fetchVersionUsage)).toBe(':slug/versions/:versionNumber/usage');
    expect(Reflect.getMetadata('method', AgentAdminController.prototype.fetchVersionUsage)).toBe(0);
    expect(
      new Reflector().getAllAndOverride(REQUIRED_PERMISSIONS_KEY, [AgentAdminController.prototype.fetchVersionUsage, AgentAdminController]),
    ).toEqual([{ action: 'manage', subject: 'Agent' }]);
  });

  it('delegates to the usage service with the slug and the numeric version', async () => {
    const usage = { usage: vi.fn(async () => ({ publishedWorkflows: [], count: 0 })) };
    const controller = new AgentAdminController({} as never, undefined, usage as never);
    expect(await controller.fetchVersionUsage('scribe', 2)).toEqual({ publishedWorkflows: [], count: 0 });
    expect(usage.usage).toHaveBeenCalledWith('scribe', 2);
  });
});
