/**
 * TASK-863 — AgentInternalController: the tenant is mandatory, CLS is pinned to the CALLER'S
 * tenant before the resolver runs, and the route is `@Public()` behind the internal
 * service-token guard (the EffectiveConfigController posture).
 */
import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { SKIP_AUTH_KEY } from '@arcaai/applications';
import { ArgumentInvalidException } from '@arcaai/exceptions';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { AgentInternalController } from '../agent-internal.controller';
import { InternalServiceTokenGuard } from '../internal-service-token.guard';

function fakeCls() {
  const store = new Map<string, unknown>();
  return {
    store,
    run: vi.fn((fn: () => unknown) => fn()),
    set: vi.fn((key: string, value: unknown) => void store.set(key, value)),
    get: vi.fn((key: string) => store.get(key)),
  };
}

function make() {
  const resolver = { resolve: vi.fn(async (input: unknown) => ({ input })) };
  const cls = fakeCls();
  return { controller: new AgentInternalController(resolver as never, cls as never), resolver, cls };
}

describe('AgentInternalController', () => {
  it('is @Public() behind InternalServiceTokenGuard at internal/agents', () => {
    expect(Reflect.getMetadata('path', AgentInternalController)).toBe('internal/agents');
    expect(new Reflector().getAllAndOverride(SKIP_AUTH_KEY, [AgentInternalController.prototype.resolve, AgentInternalController])).toBe(true);
    expect(Reflect.getMetadata(GUARDS_METADATA, AgentInternalController)).toContain(InternalServiceTokenGuard);
  });

  it('requires a tenant (X-Tenant-Id or tenantId) and refuses a disagreement', async () => {
    const { controller } = make();
    await expect(controller.resolve(undefined, 'TEXT_GENERATION', undefined, undefined, undefined)).rejects.toBeInstanceOf(ArgumentInvalidException);
    await expect(controller.resolve('t1', 'TEXT_GENERATION', undefined, undefined, 't2')).rejects.toBeInstanceOf(ArgumentInvalidException);
    await expect(controller.resolve('t1', undefined, undefined, undefined, undefined)).rejects.toBeInstanceOf(ArgumentInvalidException);
    await expect(controller.resolve('t1', 'NOT_A_TASK', undefined, undefined, undefined)).rejects.toBeInstanceOf(ArgumentInvalidException);
  });

  it('pins CLS to the caller tenant BEFORE resolving, and passes the cascade inputs through', async () => {
    const { controller, resolver, cls } = make();
    await controller.resolve(undefined, 'SPEECH_TO_TEXT', undefined, 'dept-1', 't1');
    expect(cls.set).toHaveBeenCalledWith('tenantId', 't1');
    expect(cls.set.mock.invocationCallOrder[0]).toBeLessThan(resolver.resolve.mock.invocationCallOrder[0]);
    expect(resolver.resolve).toHaveBeenCalledWith({ tenantId: 't1', task: 'SPEECH_TO_TEXT', agentSlug: null, departmentId: 'dept-1' });
    await controller.resolve('t1', undefined, 'platform-tts', undefined, undefined);
    expect(resolver.resolve).toHaveBeenLastCalledWith({ tenantId: 't1', task: undefined, agentSlug: 'platform-tts', departmentId: null });
  });
});
