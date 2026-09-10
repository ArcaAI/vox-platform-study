/**
 * Lane D — the `DocumentSection` editing routes.
 *
 * The generated sweep (`tests/e2e/task-776-route-authz-matrix.spec.ts`) already
 * covers per-route authorization off the manifest, so nothing here re-asserts
 * "403 for an API key". What it cannot express is the DEPTH these routes turn on:
 *
 *   * the ACCESS ORDER — a consultation check runs before the section service is
 *     asked anything, so a cross-tenant or unknown id is a 404 and never a
 *     disclosure;
 *   * WHICH check — reads take the broad access gate, the edit takes the narrower
 *     OWNERSHIP gate, exactly as the context-item routes next door do;
 *   * `If-Match` PRECEDENCE — the header beats the body field, so a client cannot
 *     smuggle a different compare-and-set operand past the validator it sent;
 *   * CROSS-CONSULTATION isolation — the path's consultation id is the one the
 *     service is given, so `:id` cannot be a decoration over another encounter's
 *     section.
 */
import { describe, it, expect, vi } from 'vitest';
import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { OptimisticConcurrencyException } from '@arcaai/exceptions';
import { ConsultationController } from '../consultation.controller';

const SECTION = {
  id: 'sec-1',
  consultationId: 'consult-1',
  documentKey: 'soap_note',
  sectionKey: 'assessment',
  title: 'Assessment',
  idx: 2,
  state: 'confirmed' as const,
  revision: 4,
  version: 8,
  content: 'Likely viral URI.',
  documentTemplateVersionId: null,
  confirmedAt: '2026-08-29T00:00:00.000Z',
  confirmedBy: 'doctor-1',
  lockedAt: null,
  createdAt: '2026-08-29T00:00:00.000Z',
  updatedAt: '2026-08-29T00:00:00.000Z',
};

function buildController(overrides: { doctorId?: string; consultation?: unknown } = {}) {
  const consultationService = {
    getById: vi
      .fn()
      .mockResolvedValue(overrides.consultation === undefined ? { id: 'consult-1', doctorId: overrides.doctorId ?? 'doctor-1' } : overrides.consultation),
    doctorHasPatientRelationship: vi.fn().mockResolvedValue(false),
  };
  const documentSectionService = {
    listSections: vi.fn().mockResolvedValue([SECTION]),
    listAllSections: vi.fn().mockResolvedValue([SECTION]),
    getSection: vi.fn().mockResolvedValue(SECTION),
    updateSectionContent: vi.fn().mockResolvedValue(SECTION),
  };
  const policyEngine = { can: vi.fn().mockReturnValue(false) };
  // `userAbility` must be PRESENT or both gates skip their CASL branch entirely and
  // fall straight through to the shared-patient / refuse path — which would make the
  // ability-based cases below pass for the wrong reason.
  const cls = {
    get: vi.fn((key: string) => {
      if (key === 'user') return { id: 'doctor-1' };
      if (key === 'tenantId') return 'tenant-1';
      if (key === 'userAbility') return { can: () => false };
      return undefined;
    }),
  };
  const globalSettingRepository = { findAll: vi.fn().mockResolvedValue([]) };
  const logger = { debug: vi.fn(), warn: vi.fn(), log: vi.fn(), error: vi.fn() };

  const controller: ConsultationController = Object.create(ConsultationController.prototype);
  Object.assign(controller as unknown as Record<string, unknown>, {
    consultationService,
    documentSectionService,
    policyEngine,
    cls,
    globalSettingRepository,
    logger,
  });
  return { controller, consultationService, documentSectionService };
}

describe('GET :id/documents/:documentKey/sections — the read half', () => {
  it('lists a document’s sections for a consultation the caller may read', async () => {
    const { controller } = buildController();
    await expect(controller.listDocumentSections('consult-1', 'soap_note')).resolves.toEqual([SECTION]);
  });

  it('verifies access BEFORE reading — an unknown id never reaches the service', async () => {
    const { controller, documentSectionService } = buildController({ consultation: null });

    await expect(controller.listDocumentSections('nope', 'soap_note')).rejects.toBeInstanceOf(NotFoundException);
    expect(documentSectionService.listSections).not.toHaveBeenCalled();
  });

  it('returns ONE section, carrying the version a client needs as its If-Match', async () => {
    const { controller } = buildController();

    const response = await controller.getDocumentSection('consult-1', 'soap_note', 'assessment');

    // `version`, not `revision`: the ETag interceptor reads this field, and it is
    // the only value the PATCH route accepts as a precondition.
    expect(response.version).toBe(8);
  });

  it('lets a NON-owner with a read ability list sections — reads use the broad access gate', async () => {
    const { controller, documentSectionService } = buildController({ doctorId: 'another-doctor' });
    (controller as unknown as { policyEngine: { can: ReturnType<typeof vi.fn> } }).policyEngine.can.mockReturnValue(true);

    await expect(controller.listDocumentSections('consult-1', 'soap_note')).resolves.toEqual([SECTION]);
    expect(documentSectionService.listSections).toHaveBeenCalled();
  });
});

/**
 * TASK-939 R4 — the DISCOVERY read. Same gate and same ordering as the keyed
 * list above; what is new is that it needs no `documentKey`, which is the whole
 * point (a client reloading mid-encounter has none).
 */
describe('GET :id/documents/sections — every document', () => {
  it('lists every document’s sections for a consultation the caller may read', async () => {
    const { controller, documentSectionService } = buildController();

    await expect(controller.listAllDocumentSections('consult-1')).resolves.toEqual([SECTION]);
    expect(documentSectionService.listAllSections).toHaveBeenCalledWith('consult-1');
  });

  it('verifies access BEFORE reading — an unknown id never reaches the service', async () => {
    const { controller, documentSectionService } = buildController({ consultation: null });

    await expect(controller.listAllDocumentSections('nope')).rejects.toBeInstanceOf(NotFoundException);
    expect(documentSectionService.listAllSections).not.toHaveBeenCalled();
  });

  it('refuses a caller with no relationship to the consultation — discovery is not a weaker gate', async () => {
    const { controller, documentSectionService } = buildController({ doctorId: 'another-doctor' });

    await expect(controller.listAllDocumentSections('consult-1')).rejects.toBeInstanceOf(ForbiddenException);
    expect(documentSectionService.listAllSections).not.toHaveBeenCalled();
  });
});

describe('PATCH :id/documents/:documentKey/sections/:sectionKey — the write', () => {
  it('persists a clinician edit for the consultation’s owner', async () => {
    const { controller, documentSectionService } = buildController();

    await controller.updateDocumentSection('consult-1', 'soap_note', 'assessment', { content: 'Clinician text.' }, 8);

    expect(documentSectionService.updateSectionContent).toHaveBeenCalledWith('consult-1', 'soap_note', 'assessment', {
      content: 'Clinician text.',
      expectedVersion: 8,
    });
  });

  it('takes the OWNERSHIP gate, not the read gate — a shared-patient reader may not edit', async () => {
    // A non-owner whose only ability is `read` passes `verifyConsultationAccess`
    // and must still fail here: editing a colleague's note is not a read.
    const { controller, documentSectionService } = buildController({ doctorId: 'another-doctor' });
    (controller as unknown as { policyEngine: { can: ReturnType<typeof vi.fn> } }).policyEngine.can.mockImplementation(
      (_ability: unknown, action: string) => action === 'read',
    );

    await expect(controller.updateDocumentSection('consult-1', 'soap_note', 'assessment', { content: 'x' }, 8)).rejects.toBeInstanceOf(ForbiddenException);
    expect(documentSectionService.updateSectionContent).not.toHaveBeenCalled();
  });

  it('verifies the consultation BEFORE writing — an unknown id never reaches the service', async () => {
    const { controller, documentSectionService } = buildController({ consultation: null });

    await expect(controller.updateDocumentSection('nope', 'soap_note', 'assessment', { content: 'x' }, 8)).rejects.toBeInstanceOf(NotFoundException);
    expect(documentSectionService.updateSectionContent).not.toHaveBeenCalled();
  });

  it('the If-Match HEADER overrides a body expectedVersion — one operand, and it is the validated one', async () => {
    const { controller, documentSectionService } = buildController();

    await controller.updateDocumentSection('consult-1', 'soap_note', 'assessment', { content: 'x', expectedVersion: 2 }, 8);

    expect(documentSectionService.updateSectionContent).toHaveBeenCalledWith('consult-1', 'soap_note', 'assessment', { content: 'x', expectedVersion: 8 });
  });

  it('CROSS-CONSULTATION: the path’s consultation id is the one the service is given', async () => {
    const { controller, documentSectionService } = buildController();

    await controller.updateDocumentSection('consult-1', 'soap_note', 'assessment', { content: 'x' }, 8);

    const [consultationId] = documentSectionService.updateSectionContent.mock.calls.at(-1)!;
    expect(consultationId).toBe('consult-1');
  });

  it('propagates the LOCK conflict — an edit after finalize is a 409, not a write', async () => {
    const { controller, documentSectionService } = buildController();
    documentSectionService.updateSectionContent.mockRejectedValue(new ConflictException('locked'));

    await expect(controller.updateDocumentSection('consult-1', 'soap_note', 'assessment', { content: 'x' }, 8)).rejects.toBeInstanceOf(ConflictException);
  });

  it('propagates OCC drift so the interceptor can answer 412', async () => {
    const { controller, documentSectionService } = buildController();
    documentSectionService.updateSectionContent.mockRejectedValue(
      new OptimisticConcurrencyException('DocumentSection', 'sec-1', { expectedVersion: 5, currentVersion: 8 }),
    );

    await expect(controller.updateDocumentSection('consult-1', 'soap_note', 'assessment', { content: 'x' }, 5)).rejects.toBeInstanceOf(
      OptimisticConcurrencyException,
    );
  });
});
