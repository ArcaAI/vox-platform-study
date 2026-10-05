/**
 * TASK-1038 — `GET /internal/agents/:slug/versions/:versionNumber/resolved`, the harness's way to
 * run the agent version a published workflow PINNED (D-A). Same posture and the same response
 * shape as `GET /internal/agents/resolve`: `@Public()` behind the internal service-token guard,
 * tenant mandatory (`X-Tenant-Id` and/or `?tenantId=`, agreeing), CLS pinned to that tenant
 * before anything is read, and a TEXT_GENERATION answer carries `textPrimary` + `textFallback`
 * after the workflow-step LLM allowance check.
 */
import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { SKIP_AUTH_KEY } from '@arcaai/applications';
import { ArgumentInvalidException } from '@arcaai/exceptions';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { AgentVersionInternalController } from '../agent-version-internal.controller';
import { InternalServiceTokenGuard } from '../internal-service-token.guard';

function make() {
  const store = new Map<string, unknown>();
  const cls = { run: vi.fn((fn: () => unknown) => fn()), set: vi.fn((key: string, value: unknown) => void store.set(key, value)) };
  const versions = { resolveVersion: vi.fn(async (input: unknown): Promise<unknown> => ({ task: 'SPEECH_TO_TEXT', input })) };
  const textAgents = { resolveFromAgent: vi.fn(async () => ({ primary: { kind: 'primary' }, fallback: { autoSwitch: true, chain: [] } })) };
  const entitlements = { assertMeterQuota: vi.fn(async () => undefined) };
  const controller = new AgentVersionInternalController(versions as never, cls as never, textAgents as never, entitlements as never);
  return { controller, versions, textAgents, entitlements, cls };
}

describe('AgentVersionInternalController', () => {
  it('is @Public() behind InternalServiceTokenGuard, mounted beside the resolve route', () => {
    expect(Reflect.getMetadata('path', AgentVersionInternalController)).toBe('internal/agents');
    const handler = AgentVersionInternalController.prototype.resolveVersion;
    expect(Reflect.getMetadata('path', handler)).toBe(':slug/versions/:versionNumber/resolved');
    expect(new Reflector().getAllAndOverride(SKIP_AUTH_KEY, [handler, AgentVersionInternalController])).toBe(true);
    expect(Reflect.getMetadata(GUARDS_METADATA, AgentVersionInternalController)).toContain(InternalServiceTokenGuard);
  });

  it('requires a tenant, refuses a disagreement, and refuses a non-integer version', async () => {
    const { controller } = make();
    await expect(controller.resolveVersion('slug', '3', undefined, undefined)).rejects.toBeInstanceOf(ArgumentInvalidException);
    await expect(controller.resolveVersion('slug', '3', 't1', 't2')).rejects.toBeInstanceOf(ArgumentInvalidException);
    for (const bad of ['0', '-1', '2.5', 'latest', '']) {
      await expect(controller.resolveVersion('slug', bad, 't1', undefined)).rejects.toBeInstanceOf(ArgumentInvalidException);
    }
  });

  it('pins CLS to the caller tenant BEFORE resolving the pinned version', async () => {
    const { controller, versions, cls } = make();
    await controller.resolveVersion('clinic-asr', '3', undefined, 't1');
    expect(cls.set).toHaveBeenCalledWith('tenantId', 't1');
    expect(cls.set.mock.invocationCallOrder[0]).toBeLessThan(versions.resolveVersion.mock.invocationCallOrder[0]);
    expect(versions.resolveVersion).toHaveBeenCalledWith({ tenantId: 't1', slug: 'clinic-asr', versionNumber: 3 });
  });

  it('a TEXT_GENERATION answer pays the LLM allowance and carries textPrimary + textFallback, like resolve', async () => {
    const { controller, versions, textAgents, entitlements } = make();
    const agent = { slug: 'clinic-summarizer', task: 'TEXT_GENERATION', versionNumber: 3 };
    versions.resolveVersion.mockResolvedValueOnce(agent);
    const answer = await controller.resolveVersion('clinic-summarizer', '3', 't1', undefined);
    expect(entitlements.assertMeterQuota).toHaveBeenCalledWith('t1', 'monthlyLlmTokens');
    expect(textAgents.resolveFromAgent).toHaveBeenCalledWith(agent, 't1');
    expect(answer).toEqual({ ...agent, textPrimary: { kind: 'primary' }, textFallback: { autoSwitch: true, chain: [] } });
  });

  it('passes the resolver`s 404 through (unknown, draft, or another tenant`s agent)', async () => {
    const { controller, versions } = make();
    versions.resolveVersion.mockRejectedValueOnce(new NotFoundException('Agent version not found'));
    await expect(controller.resolveVersion('clinic-summarizer', '3', 't1', undefined)).rejects.toBeInstanceOf(NotFoundException);
  });
});
