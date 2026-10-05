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
import { ConsultationEntity } from '@arcaai/domains';
import { ConsultationApprovalService } from '../../lifecycle/consultation-approval.service';
import type { SummaryService } from '../summary.service';

/** Each dependency defaults to the one the summary service itself was constructed with. */
export interface SessionApprovalDeps {
  /** The spec's consultation repository mock (`findByIdOrNull` or `findById`, `updateWithVersion`). */
  consultationRepository?: any;
  /** The spec's context-item repository mock (`updateWithVersion`, optional `findByConsultation`). */
  contextItemRepository?: any;
  /** The spec's version repository mock (`create`). */
  contextItemVersionRepository?: any;
  /** The spec's WORM audit mock; a silent one is used when neither is wired. */
  harnessAuditService?: any;
  cls?: any;
  eventEmitter?: any;
  /** Defaults to a pass-through unit of work (its `runInTransaction` is a spy). */
  unitOfWork?: any;
}

export interface SessionApprovalWiring {
  approvalService: ConsultationApprovalService;
  approvalRepository: { create: ReturnType<typeof vi.fn> };
  events: { publish: ReturnType<typeof vi.fn> };
  harnessAuditService: { append: ReturnType<typeof vi.fn> } | any;
  unitOfWork: { runInTransaction: ReturnType<typeof vi.fn> } | any;
}

/** Wires `summary`'s `ModuleRef` to a real session approve built over the spec's mocks. */
export function wireSessionApproval(summary: SummaryService, given: SessionApprovalDeps = {}): SessionApprovalWiring {
  const own = summary as any;
  const deps = {
    consultationRepository: own.consultationRepository,
    contextItemRepository: own.contextItemRepository,
    contextItemVersionRepository: own.contextItemVersionRepository,
    harnessAuditService: own.harnessAuditService,
    cls: own.clsService,
    eventEmitter: own.eventEmitter,
    ...Object.fromEntries(Object.entries(given).filter(([, value]) => value !== undefined)),
  } as Required<SessionApprovalDeps>;
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
    // A spec's mock may answer a bare `{ id }`; the persisted row is then the entity written.
    updateWithVersion: async (id: string, entity: unknown, ...rest: unknown[]) => {
      const saved = await deps.consultationRepository.updateWithVersion(id, entity, ...rest);
      return saved instanceof ConsultationEntity ? saved : entity;
    },
  };
  const contextItems = {
    findByConsultation: async (...args: unknown[]) =>
      typeof deps.contextItemRepository.findByConsultation === 'function' ? ((await deps.contextItemRepository.findByConsultation(...args)) ?? []) : [],
    updateWithVersion: (...args: unknown[]) => deps.contextItemRepository.updateWithVersion(...args),
    // The approval resolves a legacy summary id first (existence before legality); the specs'
    // repositories answer `findById`, so a lookup that throws reads as "not found".
    findByIdOrNull: async (id: string) => {
      if (typeof deps.contextItemRepository.findByIdOrNull === 'function') return deps.contextItemRepository.findByIdOrNull(id);
      try {
        return (await deps.contextItemRepository.findById(id)) ?? null;
      } catch {
        return null;
      }
    },
  };
  // The version store behaves like the database it stands in for: a signature the approval writes
  // reads back (newest first) on the spec's own `getVersionsByChangeReason`.
  const written: Array<{ contextItemId?: string; changeReason?: string; versionNumber?: number }> = [];
  const versionRepository = deps.contextItemVersionRepository;
  const versions = {
    create: async (version: any, ...rest: unknown[]) => {
      const saved = await versionRepository.create(version, ...rest);
      written.push(version);
      return saved;
    },
  };
  if (typeof versionRepository.getVersionsByChangeReason === 'function') {
    const read = versionRepository.getVersionsByChangeReason;
    versionRepository.getVersionsByChangeReason = vi.fn(async (contextItemId: string, changeReason: string) => {
      const own = written
        .filter((v) => v.contextItemId === contextItemId && (v.changeReason ?? 'approved') === changeReason)
        .sort((a, b) => (b.versionNumber ?? 0) - (a.versionNumber ?? 0));
      return [...own, ...((await read(contextItemId, changeReason)) ?? [])];
    });
  }
  const harnessAuditService = deps.harnessAuditService ?? { append: vi.fn().mockResolvedValue({ id: 'audit-1' }) };
  const approvalRepository = { create: vi.fn(async (approval: unknown) => approval) };
  const events = { publish: vi.fn().mockResolvedValue(undefined) };
  const unitOfWork = deps.unitOfWork ?? { runInTransaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work('tx')) };

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
    unitOfWork,
  );

  own.moduleRef = { get: vi.fn(() => approvalService) };
  return { approvalService, approvalRepository, events, harnessAuditService, unitOfWork };
}
