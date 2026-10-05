/**
 * Test wiring for the per-summary approve (`SummaryService.approveSummary`).
 *
 * Approval is a property of the whole consultation: `approveSummary` resolves the lifecycle
 * command service through `ModuleRef` and delegates to the session approve, which signs the note
 * through the summary service's OWN signing core (`prepareSessionSignature` /
 * `afterSessionSigned`). This wires the REAL `ConsultationApprovalService` behind that `ModuleRef`,
 * adapting the repository mocks a summary spec already builds, so a spec keeps asserting the
 * note-level rules (attribution, the safety stop, the draft→signed delta, the post-sign hand-offs)
 * and the WORM trail through the production path instead of a stub.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { vi } from 'vitest';
import { ConsultationApprovalService } from '../../lifecycle/consultation-approval.service';
import type { SummaryService } from '../summary.service';

export interface SessionApprovalDeps {
  /** The spec's consultation repository mock (`findByIdOrNull` or `findById`, `updateWithVersion`). */
  consultationRepository: any;
  /** The spec's context-item repository mock (`updateWithVersion`, optional `findByConsultation`). */
  contextItemRepository: any;
  /** The spec's version repository mock (`create`). */
  contextItemVersionRepository: any;
  /** The spec's WORM audit mock; a silent one is used when absent. */
  harnessAuditService?: any;
  cls: any;
  eventEmitter?: any;
  unitOfWork?: any;
}

export interface SessionApprovalWiring {
  approvalService: ConsultationApprovalService;
  approvalRepository: { create: ReturnType<typeof vi.fn> };
  events: { publish: ReturnType<typeof vi.fn> };
  harnessAuditService: { append: ReturnType<typeof vi.fn> } | any;
}

/** Wires `summary`'s `ModuleRef` to a real session approve built over the spec's mocks. */
export function wireSessionApproval(summary: SummaryService, deps: SessionApprovalDeps): SessionApprovalWiring {
  const consultations = {
    findByIdOrNull: async (id: string) => {
      const repo = deps.consultationRepository;
      if (typeof repo.findByIdOrNull === 'function') return repo.findByIdOrNull(id);
      try {
        return await repo.findById(id);
      } catch {
        return null;
      }
    },
    updateWithVersion: (...args: unknown[]) => deps.consultationRepository.updateWithVersion(...args),
  };
  const contextItems = {
    findByConsultation: async (...args: unknown[]) =>
      typeof deps.contextItemRepository.findByConsultation === 'function' ? ((await deps.contextItemRepository.findByConsultation(...args)) ?? []) : [],
    updateWithVersion: (...args: unknown[]) => deps.contextItemRepository.updateWithVersion(...args),
  };
  const versions = { create: (...args: unknown[]) => deps.contextItemVersionRepository.create(...args) };
  const harnessAuditService = deps.harnessAuditService ?? { append: vi.fn().mockResolvedValue({ id: 'audit-1' }) };
  const approvalRepository = { create: vi.fn(async (approval: unknown) => approval) };
  const events = { publish: vi.fn().mockResolvedValue(undefined) };

  const approvalService = new ConsultationApprovalService(
    consultations as any,
    contextItems as any,
    versions as any,
    { findByConsultation: vi.fn().mockResolvedValue([]) } as any, // encounterRepository
    approvalRepository as any,
    harnessAuditService,
    summary,
    events as any,
    deps.eventEmitter ?? { emit: vi.fn() },
    deps.cls,
    deps.unitOfWork,
  );

  (summary as any).moduleRef = { get: vi.fn(() => approvalService) };
  return { approvalService, approvalRepository, events, harnessAuditService };
}
