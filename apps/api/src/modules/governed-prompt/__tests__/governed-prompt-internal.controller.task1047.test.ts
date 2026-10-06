/**
 * TASK-1047 L12 / FC-6 — `POST internal/governed-prompts/verify`: the harness asks whether a set of
 * piece digests is governed, and offers the static text of its non-instruction pieces so they can be
 * registered. `@Public()` behind the harness service-token guard then the restore lock; no CLS tenant,
 * so the tenant is passed explicitly into the registry. Text is never echoed.
 */
import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { SKIP_AUTH_KEY } from '@arcaai/applications';
import { GUARDS_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ValidationPipe } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { GovernedPromptInternalController, VerifyGovernedPromptsRequest } from '../governed-prompt-internal.controller';
import { HarnessServiceTokenGuard } from '../../consultation/harness-service-token.guard';
import { InternalTenantLockGuard } from '../../../guards/internal-tenant-lock.guard';

const TENANT = '10000000-0000-0000-0000-000000000001';
const D1 = 'a'.repeat(64);
const D2 = 'b'.repeat(64);

function make(governed = true, version: string | null = 'pv1') {
  const registry = {
    areGoverned: vi.fn(async () => governed),
    currentPolicyVersion: vi.fn(async () => version),
    registerPlatformPieces: vi.fn(async () => undefined),
  };
  return { controller: new GovernedPromptInternalController(registry as never), registry };
}

const validate = async (body: unknown) =>
  new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: true }).transform(body, {
    type: 'body',
    metatype: VerifyGovernedPromptsRequest,
  });

describe('GovernedPromptInternalController', () => {
  it('is @Public() behind the service-token guard, then the restore lock', () => {
    expect(Reflect.getMetadata(PATH_METADATA, GovernedPromptInternalController)).toBe('internal/governed-prompts');
    expect(new Reflector().getAllAndOverride(SKIP_AUTH_KEY, [GovernedPromptInternalController])).toBe(true);
    expect(Reflect.getMetadata(GUARDS_METADATA, GovernedPromptInternalController)).toEqual([HarnessServiceTokenGuard, InternalTenantLockGuard]);
  });

  it('answers governed + policyVersion from the registry for the explicit tenant', async () => {
    const { controller, registry } = make();
    await expect(controller.verify({ tenantId: TENANT, digests: [D1, D2] })).resolves.toEqual({ governed: true, policyVersion: 'pv1' });
    expect(registry.areGoverned).toHaveBeenCalledWith(TENANT, [D1, D2]);
    expect(registry.currentPolicyVersion).toHaveBeenCalledWith(TENANT);
    expect(registry.registerPlatformPieces).not.toHaveBeenCalled();
  });

  it('answers governed:false and a null version when unknown', async () => {
    const { controller } = make(false, null);
    await expect(controller.verify({ tenantId: TENANT, digests: [D1] })).resolves.toEqual({ governed: false, policyVersion: null });
  });

  it('registers PLATFORM/LANGUAGE/CONTRACT pieces as SYSTEM platform pieces under the request tenant, without waiting', async () => {
    const { controller, registry } = make();
    registry.registerPlatformPieces.mockReturnValue(new Promise(() => undefined) as never); // never resolves: fire-and-forget
    await controller.verify({
      tenantId: TENANT,
      digests: [D1],
      pieces: [
        { kind: 'PLATFORM', key: 'platform-rules@1', digest: D1, text: 'rules' },
        { kind: 'LANGUAGE', key: 'language:English', digest: D2, text: 'Write in English.' },
      ],
    });
    expect(registry.registerPlatformPieces).toHaveBeenCalledWith(
      [
        { kind: 'PLATFORM', sourceType: 'PLATFORM', sourceId: null, sourceKey: 'platform-rules@1', text: 'rules' },
        { kind: 'LANGUAGE', sourceType: 'PLATFORM', sourceId: null, sourceKey: 'language:English', text: 'Write in English.' },
      ],
      TENANT,
    );
  });

  it('a registration failure never fails the verification', async () => {
    const { controller, registry } = make();
    registry.registerPlatformPieces.mockRejectedValue(new Error('boom'));
    await expect(
      controller.verify({ tenantId: TENANT, digests: [D1], pieces: [{ kind: 'CONTRACT', key: 'contract', digest: D1, text: 'x' }] }),
    ).resolves.toEqual({ governed: true, policyVersion: 'pv1' });
  });

  it('never echoes piece text', async () => {
    const { controller } = make();
    const out = await controller.verify({
      tenantId: TENANT,
      digests: [D1],
      pieces: [{ kind: 'CONTRACT', key: 'c', digest: D1, text: 'SECRET-TEXT' }],
    });
    expect(JSON.stringify(out)).not.toContain('SECRET-TEXT');
  });

  describe('request validation (400)', () => {
    const ok = { tenantId: TENANT, digests: [D1] };
    it('accepts a well-formed body', async () => {
      await expect(validate(ok)).resolves.toBeInstanceOf(VerifyGovernedPromptsRequest);
    });
    it.each([
      ['no digests', { ...ok, digests: [] }],
      ['65 digests', { ...ok, digests: Array.from({ length: 65 }, (_, i) => i.toString(16).padStart(64, '0')) }],
      ['upper-case hex', { ...ok, digests: ['A'.repeat(64)] }],
      ['short digest', { ...ok, digests: ['abc'] }],
      ['no tenant', { digests: [D1] }],
      ['instruction piece kind', { ...ok, pieces: [{ kind: 'TEMPLATE_BODY', key: 'body', digest: D1, text: 't' }] }],
      ['piece without text', { ...ok, pieces: [{ kind: 'PLATFORM', key: 'k', digest: D1 }] }],
      ['unknown field', { ...ok, extra: 1 }],
    ])('rejects %s', async (_n, body) => {
      await expect(validate(body)).rejects.toMatchObject({ status: 400 });
    });
  });
});
