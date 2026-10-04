/**
 * TASK-1036 §9.3 / TASK-1038 lane B3b — `POST internal/consultations/:consultationId/read`.
 *
 * Service-to-service only: `@Public()` (no user JWT) + `HarnessServiceTokenGuard` (`X-Service-Token`)
 * and `X-Tenant-Id` MANDATORY (owner directive 2026-08-16). CLS is re-established from the header
 * before the service runs, so the tenant-scope extension and the audit row both see the tenant.
 */
import { describe, expect, it, vi } from 'vitest';
import { BadRequestException, RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { ConsultationReadInternalController, ConsultationReadRequestDto } from '../consultation-read-internal.controller';
import { HarnessServiceTokenGuard } from '../harness-service-token.guard';

function makeController() {
  const service = {
    read: vi.fn().mockResolvedValue({ values: { 'consultation.patient.age': 54 }, readAt: '2026-10-04T00:00:00.000Z', schemaVersion: 1 }),
  };
  const store = new Map<string, unknown>();
  const cls = {
    run: vi.fn((fn: () => unknown) => fn()),
    set: vi.fn((k: string, v: unknown) => store.set(k, v)),
    get: vi.fn((k: string) => store.get(k)),
  };
  return { controller: new ConsultationReadInternalController(service as never, cls as never), service, cls };
}

describe('ConsultationReadInternalController', () => {
  it('is mounted at internal/consultations and guarded by the harness service token', () => {
    expect(Reflect.getMetadata(PATH_METADATA, ConsultationReadInternalController)).toBe('internal/consultations');
    expect(Reflect.getMetadata(GUARDS_METADATA, ConsultationReadInternalController)).toContain(HarnessServiceTokenGuard);
    expect(Reflect.getMetadata(PATH_METADATA, ConsultationReadInternalController.prototype.read)).toBe(':consultationId/read');
    expect(Reflect.getMetadata(METHOD_METADATA, ConsultationReadInternalController.prototype.read)).toBe(RequestMethod.POST);
  });

  it('runs the read under the X-Tenant-Id tenant', async () => {
    const { controller, service, cls } = makeController();
    const result = await controller.read('c-1', { runId: 'run-1', nodeId: 'gen', paths: ['consultation.patient.age'] }, 'tenant-1');

    expect(cls.set).toHaveBeenCalledWith('tenantId', 'tenant-1');
    expect(service.read).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      consultationId: 'c-1',
      runId: 'run-1',
      nodeId: 'gen',
      paths: ['consultation.patient.age'],
    });
    expect(result).toEqual({ values: { 'consultation.patient.age': 54 }, readAt: '2026-10-04T00:00:00.000Z', schemaVersion: 1 });
  });

  it('400 without X-Tenant-Id', async () => {
    const { controller, service } = makeController();
    await expect(controller.read('c-1', { runId: 'r', nodeId: 'n', paths: ['consultation.id'] }, undefined)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(service.read).not.toHaveBeenCalled();
  });

  it('the body DTO requires runId, nodeId and a non-empty string array of paths', async () => {
    expect(await validate(plainToInstance(ConsultationReadRequestDto, { runId: 'r', nodeId: 'n', paths: ['consultation.id'] }))).toHaveLength(0);
    expect((await validate(plainToInstance(ConsultationReadRequestDto, { runId: 'r', nodeId: 'n', paths: [] }))).length).toBeGreaterThan(0);
    expect((await validate(plainToInstance(ConsultationReadRequestDto, { nodeId: 'n', paths: ['consultation.id'] }))).length).toBeGreaterThan(0);
    expect((await validate(plainToInstance(ConsultationReadRequestDto, { runId: 'r', nodeId: 'n', paths: [7] }))).length).toBeGreaterThan(0);
  });
});
