/**
 * TASK-1050 W2e — `POST internal/guardrail/evaluations`: service-token auth (`@Public()` +
 * `InternalServiceTokenGuard` `?service=guardrail`, then the restore lock), `X-Tenant-Id` MANDATORY,
 * and the ingest runs in a CLS context pinned to that tenant.
 */
import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { BadRequestException, UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { InternalServiceTokenGuard } from '../../internal/internal-service-token.guard';
import { InternalTenantLockGuard } from '../../../guards/internal-tenant-lock.guard';
import { GUARDRAIL_INGEST_SERVICE, GuardrailEvaluationInternalController } from '../guardrail-evaluation-internal.controller';

function build() {
  const store = new Map<string, unknown>();
  const cls = {
    run: vi.fn(async (fn: () => unknown) => fn()),
    set: vi.fn((key: string, value: unknown) => store.set(key, value)),
  };
  const ingest = { ingest: vi.fn(async (tenantId: string) => ({ accepted: 1, duplicates: 0, seenTenant: store.get('tenantId'), tenantId })) };
  const controller = new GuardrailEvaluationInternalController(ingest as never, cls as never);
  return { controller, ingest, cls };
}

const body = { evaluations: [{ evaluationId: 'e-1', tenantId: 't-1' }] } as never;

describe('GuardrailEvaluationInternalController', () => {
  it('is public to the user chain and authenticated by the service-token guard, then the restore lock', () => {
    expect(Reflect.getMetadata('skip_auth', GuardrailEvaluationInternalController)).toBe(true);
    expect(Reflect.getMetadata(GUARDS_METADATA, GuardrailEvaluationInternalController)).toEqual([InternalServiceTokenGuard, InternalTenantLockGuard]);
  });

  it('refuses a missing or blank X-Tenant-Id (400) without ingesting', async () => {
    const h = build();
    await expect(h.controller.ingest(body, undefined)).rejects.toBeInstanceOf(BadRequestException);
    await expect(h.controller.ingest(body, '   ')).rejects.toBeInstanceOf(BadRequestException);
    expect(h.ingest.ingest).not.toHaveBeenCalled();
  });

  it('ingests under a CLS context pinned to the X-Tenant-Id tenant', async () => {
    const h = build();
    const result = await h.controller.ingest(body, ' t-1 ');
    expect(h.ingest.ingest).toHaveBeenCalledWith('t-1', body);
    expect(result).toMatchObject({ accepted: 1, duplicates: 0, seenTenant: 't-1' });
  });
});

describe('GuardrailEvaluationInternalController — the drainer`s service selector (c72130ab8)', () => {
  const secrets = { getSecretOptional: vi.fn(async (name: string) => (name === 'GUARDRAIL_SERVICE_TOKEN' ? 'guardrail-token' : name === 'INTERNAL_ACCESS_TOKEN' ? 'shared-token' : undefined)) };
  const context = (query: Record<string, string>, token?: string) =>
    ({ switchToHttp: () => ({ getRequest: () => ({ query, headers: token ? { 'x-service-token': token } : {} }) }) }) as unknown as ExecutionContext;

  it('authenticates the drainer`s `?service=guardrail` with the shared or the guardrail token', async () => {
    expect(GUARDRAIL_INGEST_SERVICE).toBe('guardrail');
    const guard = new InternalServiceTokenGuard(secrets as never);
    await expect(guard.canActivate(context({ service: GUARDRAIL_INGEST_SERVICE }, 'shared-token'))).resolves.toBe(true);
    await expect(guard.canActivate(context({ service: GUARDRAIL_INGEST_SERVICE }, 'guardrail-token'))).resolves.toBe(true);
  });

  it('refuses a call without the selector, or with a wrong token (401)', async () => {
    const guard = new InternalServiceTokenGuard(secrets as never);
    await expect(guard.canActivate(context({}, 'shared-token'))).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(guard.canActivate(context({ service: GUARDRAIL_INGEST_SERVICE }, 'wrong'))).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
