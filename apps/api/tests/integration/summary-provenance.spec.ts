/**
 * Harness provenance is retrievable over the
 * consultation read API.
 *
 * Wires the REAL `ConsultationController` -> REAL `SummaryService` -> REAL
 * `SummaryDtoMapper` and only stubs the leaf `SummaryMetaRepository` (the DB
 * boundary) + the auth collaborators. This exercises the full read chain the new
 * `GET /consultations/:id/summary/:contextItemId/provenance` route runs at
 * request time, asserting the harness-written citationsMap + sensor scores +
 * modelName surface in the response DTO — and that the consultation read gate is
 * enforced.
 *
 * A full network e2e against the running api (8868) was intentionally not added:
 * the shared `pnpm dev:api` server resolves `@arcaai/applications` from its built
 * `dist` and watches only `apps/api/src`, so picking up this route requires a
 * coordinated restart of a shared dev server. This integration test gives the
 * same controller->service->mapper assurance deterministically.
 */

import { describe, it, expect, vi } from 'vitest';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { SummaryService } from '@arcaai/applications';
import { ConsultationController } from '../../src/modules/consultation/consultation.controller';

const DOCTOR = 'doctor-owner';
const TENANT = 'tenant-1';
const CONSULTATION = 'consult-1';
const SUMMARY_CTX = 'ctx-summary-1';

function buildRealService(summaryMetaRepository: { findByContextItem: ReturnType<typeof vi.fn> }) {
  const configService = { get: vi.fn().mockReturnValue(undefined) };
  const eventEmitter = { emit: vi.fn() };
  const clsService = { get: vi.fn().mockReturnValue(TENANT), set: vi.fn() };

  return new SummaryService(
    {} as never, // contextItemRepository
    {} as never, // consultationRepository
    summaryMetaRepository as never,
    {} as never, // namedEntityRepository
    {} as never, // httpService
    configService as never,
    eventEmitter as never,
    clsService as never,
    {} as never, // contextItemVersionRepository
    {} as never, // promptAssemblyService
  );
}

function buildController(opts: { summaryMetaRepository: { findByContextItem: ReturnType<typeof vi.fn> }; callerId?: string; ownerId?: string }) {
  const { summaryMetaRepository, callerId = DOCTOR, ownerId = DOCTOR } = opts;

  const summaryService = buildRealService(summaryMetaRepository);

  const consultationService = {
    getById: vi.fn().mockResolvedValue({ id: CONSULTATION, doctorId: ownerId, patientId: 'p1', tenantId: TENANT }),
    doctorHasPatientRelationship: vi.fn().mockResolvedValue(false),
  };
  const cls = {
    get: vi.fn((key: string) => {
      if (key === 'user') return { id: callerId, tenantId: TENANT };
      if (key === 'tenantId') return TENANT;
      return undefined;
    }),
  };
  const policyEngine = { can: vi.fn().mockReturnValue(false) };
  const globalSettingRepo = { findAll: vi.fn().mockResolvedValue([]) };

  const controller = new ConsultationController(
    consultationService as never,
    {} as never, // contextService
    summaryService as never,
    {} as never, // chainSummaryService
    {} as never, // consultationJobService
    {} as never, // timelineService
    cls as never,
    policyEngine as never,
    globalSettingRepo as never,
  );

  return { controller, summaryMetaRepository };
}

describe('summary provenance over HTTP (controller→service→mapper integration)', () => {
  it('surfaces citationsMap + sensor scores + modelName for the owning clinician', async () => {
    const summaryMetaRepository = {
      findByContextItem: vi.fn().mockResolvedValue({
        contextItemId: SUMMARY_CTX,
        modelName: 'gpt-x',
        entityFaithfulnessScore: 0.95,
        coverageScore: 0.9,
        ragTriadScore: 0.92,
        citationsMap: { claims: [{ id: 'claim-1', text: 'lisinopril', section: 'P', status: 'verified' }] },
        guardrailDecisions: { entityFaithfulness: 0.95, coverage: 0.9, citationPresence: 1 },
        generatedAt: new Date('2026-06-06T00:00:00.000Z'),
      }),
    };
    const { controller } = buildController({ summaryMetaRepository });

    const result = await controller.getSummaryProvenance(CONSULTATION, SUMMARY_CTX);

    expect(summaryMetaRepository.findByContextItem).toHaveBeenCalledWith(SUMMARY_CTX);
    expect(result).toEqual({
      contextItemId: SUMMARY_CTX,
      modelName: 'gpt-x',
      entityFaithfulnessScore: 0.95,
      coverageScore: 0.9,
      ragTriadScore: 0.92,
      sensorScores: { entityFaithfulness: 0.95, coverage: 0.9, citationPresence: 1 },
      citationsMap: { claims: [{ id: 'claim-1', text: 'lisinopril', section: 'P', status: 'verified' }] },
      generatedAt: '2026-06-06T00:00:00.000Z',
      // No transcriptSegmentRepository wired in this fixture (
      // is best-effort) — degrades to [] rather than blocking the read.
      citedSegments: [],
    });
  });

  it('returns 404 (NotFound) when the summary has no harness provenance yet', async () => {
    const summaryMetaRepository = { findByContextItem: vi.fn().mockResolvedValue(null) };
    const { controller } = buildController({ summaryMetaRepository });

    await expect(controller.getSummaryProvenance(CONSULTATION, SUMMARY_CTX)).rejects.toThrow(NotFoundException);
  });

  it('enforces the consultation read gate before touching provenance', async () => {
    const summaryMetaRepository = { findByContextItem: vi.fn() };
    // Caller is NOT the owner, no CASL grant, sharing disabled → ForbiddenException.
    const { controller } = buildController({ summaryMetaRepository, callerId: 'intruder', ownerId: DOCTOR });

    await expect(controller.getSummaryProvenance(CONSULTATION, SUMMARY_CTX)).rejects.toThrow(ForbiddenException);
    expect(summaryMetaRepository.findByContextItem).not.toHaveBeenCalled();
  });
});
