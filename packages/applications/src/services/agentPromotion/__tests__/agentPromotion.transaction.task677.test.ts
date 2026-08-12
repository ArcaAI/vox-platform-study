/**
 * TASK-677 — the agent-promotion write sequence is atomic.
 *
 * Closes TASK-663 **OI-2**. Before this ticket the sequence
 *
 *   deep-copied prompt templates → target agent (create OR update)
 *     → target agent version → AgentPromotion audit record
 *
 * was issued as four-to-fourteen independent writes. TASK-663 mitigated the
 * exposure by ordering the audit row LAST, so a failure could never record a
 * promotion that did not happen — but the reverse window stayed open: a
 * failure after the agent was advanced left the target tenant with a
 * **partially-promoted agent** and no record saying so.
 *
 * What a unit test can actually prove about atomicity is exactly two things,
 * and both are asserted here:
 *
 *   1. every write of the sequence is issued through the **same** transaction
 *      client, so one rollback covers all of them (Prisma owns the rollback
 *      itself — that is `$transaction`'s contract, not this service's);
 *   2. a mid-sequence failure propagates and produces **no** externally visible
 *      side effect — no sys-event announcing a promotion that rolled back, and
 *      no eval run against it.
 *
 * The eval and the `evalRunId` write that follows it are deliberately OUTSIDE
 * the transaction: the eval is an external, long-running call, and holding a
 * Postgres transaction open across it would be a worse defect than the one
 * being fixed. TASK-663 D-7 already establishes that the eval runs after the
 * copy and never blocks a promotion.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AgentPromotionService } from '../agentPromotion.service';

const FROM = 'tenant-source';
const TO = 'tenant-target';

/** The marker handed to `work(tx)` — identity is what the assertions check. */
const TX = { __transactionClient: true };

const mockClsService = { get: vi.fn(), set: vi.fn() };
const mockEventEmitter = { emit: vi.fn() };

const mockPromotionRepository = { create: vi.fn(), update: vi.fn(), findById: vi.fn(), findAll: vi.fn(), count: vi.fn() };
const mockAgentRepository = {
  findById: vi.fn(),
  findBySlug: vi.fn(),
  findPrimaryForDepartment: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
};
const mockAgentVersionRepository = { findLatestForAgent: vi.fn(), findByAgentAndVersionNumber: vi.fn(), create: vi.fn() };
const mockDepartmentRepository = { findById: vi.fn(), findByCode: vi.fn() };
const mockPromptTemplateRepository = { findById: vi.fn(), create: vi.fn() };
const mockPromptVersionRepository = { create: vi.fn() };
const mockContextSchemaRepository = { findDefaultForScope: vi.fn() };
const mockContextSchemaVersionRepository = { findBySchemaAndVersionNumber: vi.fn() };
const mockConsultationRepository = { count: vi.fn() };
const mockPolicyEngine = { buildAbility: vi.fn() };
const mockEvalRunService = { runGoldenSet: vi.fn() };

/**
 * Stands in for `CoreUnitOfWorkService`. `runInTransaction` runs the work with
 * the TX marker and, like the real `$transaction(callback)`, lets a rejection
 * escape after Prisma has rolled back.
 */
const mockUnitOfWork = {
  runInTransaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work(TX)),
};

vi.mock('@arcaai/domains', async () => {
  const actual = await vi.importActual('@arcaai/domains');
  return {
    ...actual,
    DepartmentAgentFactory: {
      CreateDepartmentAgent: vi.fn((data: Record<string, unknown>) => ({ ...data, id: 'new-target-agent', createdAt: new Date(), version: 1 })),
    },
    DepartmentAgentVersionFactory: {
      CreateDepartmentAgentVersion: vi.fn((data: Record<string, unknown>) => ({ ...data, id: 'new-target-version' })),
    },
    PromptTemplateFactory: {
      CreatePromptTemplate: vi.fn((data: Record<string, unknown>) => ({ ...data, id: `copied-${String(data.name)}` })),
    },
    PromptVersionFactory: { CreatePromptVersion: vi.fn((data: Record<string, unknown>) => ({ ...data, id: 'copied-v1' })) },
    AgentPromotionFactory: {
      CreateAgentPromotion: vi.fn((data: Record<string, unknown>) => ({
        ...data,
        id: 'promotion-1',
        tenantId: data.toTenantId,
        createdAt: new Date(),
        version: 1,
        validate: vi.fn(),
      })),
    },
  };
});

const loopSnapshot = () => ({
  role: 'SPECIALIST',
  subscribedKinds: null,
  writeScope: null,
  goal: null,
  guardrailProfile: null,
  alwaysActions: null,
  neverActions: null,
});

const sourceAgent = (overrides: Record<string, unknown> = {}) => ({
  id: 'source-agent',
  tenantId: FROM,
  departmentId: 'src-dept',
  name: 'Cardiology SOAP',
  slug: 'cardiology-soap',
  description: 'desc',
  promptTemplateId: 'src-tpl',
  newPatientTemplateId: null,
  revisitTemplateId: null,
  preSummaryTemplateId: null,
  livePromptTemplateId: null,
  pinnedVersionNumber: 3,
  dnaStylePolicy: 'INHERIT',
  harnessOverrides: null,
  toolConfig: null,
  llmOverrides: null,
  goldenSetId: null,
  tags: [],
  ...loopSnapshot(),
  ...overrides,
});

function buildService() {
  return new AgentPromotionService(
    mockPromotionRepository as never,
    mockEventEmitter as never,
    mockClsService as never,
    mockAgentRepository as never,
    mockAgentVersionRepository as never,
    mockDepartmentRepository as never,
    mockPromptTemplateRepository as never,
    mockPromptVersionRepository as never,
    mockContextSchemaRepository as never,
    mockContextSchemaVersionRepository as never,
    mockConsultationRepository as never,
    mockPolicyEngine as never,
    mockUnitOfWork as never,
    mockEvalRunService as never,
  );
}

function elevatedTenantlessContext() {
  mockClsService.get.mockImplementation((key: string) => {
    switch (key) {
      case 'user':
        return { id: 'admin-1', roles: ['GLOBAL_ADMIN'] };
      case 'tenantId':
        return '';
      default:
        return null;
    }
  });
}

const baseDto = { sourceAgentId: 'source-agent', fromTenantId: FROM, toTenantId: TO };

/**
 * A promotion that WILL run an eval. `goldenSetId` deliberately never travels
 * from the source (the corpus never moves), and the freshly-created target
 * agent has none of its own, so the caller must name a golden set belonging to
 * the target tenant for `runTargetEval` to do anything.
 */
const dtoWithEval = { ...baseDto, targetGoldenSetId: 'target-golden-set' };

describe('TASK-677 — AgentPromotionService.promote is transactional', () => {
  let service: AgentPromotionService;

  beforeEach(() => {
    vi.clearAllMocks();
    elevatedTenantlessContext();

    mockUnitOfWork.runInTransaction.mockImplementation(async (work: (tx: unknown) => Promise<unknown>) => work(TX));

    mockPolicyEngine.buildAbility.mockResolvedValue({ can: () => true });
    mockAgentRepository.findById.mockResolvedValue(sourceAgent());
    mockAgentRepository.findBySlug.mockResolvedValue(null);
    mockAgentRepository.findPrimaryForDepartment.mockResolvedValue(null);
    mockAgentRepository.create.mockImplementation(async (e: unknown) => e);
    mockAgentRepository.update.mockImplementation(async (_id: string, e: unknown) => e);
    mockAgentVersionRepository.findLatestForAgent.mockImplementation(async (agentId: string) =>
      agentId === 'source-agent' ? { id: 'src-version', tenantId: FROM, agentId, versionNumber: 4, configSnapshot: loopSnapshot() } : null,
    );
    mockAgentVersionRepository.create.mockImplementation(async (e: unknown) => e);
    mockDepartmentRepository.findById.mockResolvedValue({ id: 'src-dept', tenantId: FROM, code: 'CARD' });
    mockDepartmentRepository.findByCode.mockResolvedValue({ id: 'tgt-dept', tenantId: TO, code: 'CARD' });
    mockPromptTemplateRepository.findById.mockResolvedValue({
      id: 'src-tpl',
      tenantId: FROM,
      name: 'Src Template',
      content: 'body',
      status: 'APPROVED',
      variables: null,
      tags: [],
    });
    mockPromptTemplateRepository.create.mockImplementation(async (e: unknown) => e);
    mockPromptVersionRepository.create.mockImplementation(async (e: unknown) => e);
    mockContextSchemaRepository.findDefaultForScope.mockResolvedValue(null);
    mockContextSchemaVersionRepository.findBySchemaAndVersionNumber.mockResolvedValue(null);
    mockConsultationRepository.count.mockResolvedValue(0);
    mockPromotionRepository.create.mockImplementation(async (e: unknown) => e);
    mockPromotionRepository.update.mockImplementation(async (_id: string, e: unknown) => e);
    mockEvalRunService.runGoldenSet.mockResolvedValue({ run: { id: 'target-eval-run' }, passed: true, failures: [], aggregates: {} });

    service = buildService();
  });

  // =========================================================================
  // A successful promotion commits everything, through ONE transaction
  // =========================================================================

  describe('a successful promotion commits every write through one transaction', () => {
    it('opens exactly one transaction', async () => {
      await service.promote(baseDto);
      expect(mockUnitOfWork.runInTransaction).toHaveBeenCalledTimes(1);
    });

    it('creates the target agent through the tx client', async () => {
      await service.promote(baseDto);
      expect(mockAgentRepository.create).toHaveBeenCalledTimes(1);
      expect(mockAgentRepository.create.mock.calls[0][1]).toBe(TX);
    });

    it('writes the target agent VERSION through the same tx client', async () => {
      await service.promote(baseDto);
      expect(mockAgentVersionRepository.create).toHaveBeenCalledTimes(1);
      expect(mockAgentVersionRepository.create.mock.calls[0][1]).toBe(TX);
    });

    it('writes the AgentPromotion audit record through the same tx client', async () => {
      await service.promote(baseDto);
      expect(mockPromotionRepository.create).toHaveBeenCalledTimes(1);
      expect(mockPromotionRepository.create.mock.calls[0][1]).toBe(TX);
    });

    it('deep-copies the bound prompt template and its v1 through the same tx client', async () => {
      await service.promote(baseDto);
      expect(mockPromptTemplateRepository.create.mock.calls[0][1]).toBe(TX);
      expect(mockPromptVersionRepository.create.mock.calls[0][1]).toBe(TX);
    });

    it('advances an EXISTING target agent through the tx client — the create-OR-update path OI-2 could not wrap', async () => {
      mockAgentRepository.findBySlug.mockResolvedValue({ ...sourceAgent(), id: 'existing-target', tenantId: TO, departmentId: 'tgt-dept' });

      await service.promote(baseDto);

      expect(mockAgentRepository.update).toHaveBeenCalledTimes(1);
      const [id, , tx] = mockAgentRepository.update.mock.calls[0];
      expect(id).toBe('existing-target');
      expect(tx).toBe(TX);
      expect(mockAgentRepository.create).not.toHaveBeenCalled();
    });

    it('still returns the promotion and still records it', async () => {
      const result = await service.promote(baseDto);
      expect(result.id).toBe('promotion-1');
    });
  });

  // =========================================================================
  // A mid-sequence failure rolls EVERYTHING back
  // =========================================================================

  describe('a mid-sequence failure rolls everything back', () => {
    /**
     * A transaction that actually rolls back: writes are journalled, and a
     * rejection discards the journal before rethrowing — the observable
     * behaviour of `$transaction(callback)`.
     */
    function journallingTransaction() {
      const journal: string[] = [];
      const committed: string[] = [];
      mockAgentRepository.create.mockImplementation(async (e: unknown) => {
        journal.push('agent');
        return e;
      });
      mockAgentRepository.update.mockImplementation(async (_id: string, e: unknown) => {
        journal.push('agent');
        return e;
      });
      mockAgentVersionRepository.create.mockImplementation(async (e: unknown) => {
        journal.push('agentVersion');
        return e;
      });
      mockPromptTemplateRepository.create.mockImplementation(async (e: unknown) => {
        journal.push('promptTemplate');
        return e;
      });
      mockUnitOfWork.runInTransaction.mockImplementation(async (work: (tx: unknown) => Promise<unknown>) => {
        journal.length = 0;
        try {
          const out = await work(TX);
          committed.push(...journal);
          return out;
        } catch (err) {
          journal.length = 0; // ROLLBACK
          throw err;
        }
      });
      return { committed };
    }

    it('leaves NO orphan AgentPromotion row and NO half-cloned agent when the audit write fails', async () => {
      const { committed } = journallingTransaction();
      mockPromotionRepository.create.mockRejectedValue(new Error('promotion insert failed'));

      await expect(service.promote(baseDto)).rejects.toThrow('promotion insert failed');

      // Non-vacuity: the agent and its version were genuinely ATTEMPTED, and
      // attempted THROUGH the transaction. Without these three lines the
      // `committed` assertion below would pass on a service that opens no
      // transaction at all — the exact pre-TASK-677 behaviour.
      expect(mockUnitOfWork.runInTransaction).toHaveBeenCalledTimes(1);
      expect(mockAgentRepository.create).toHaveBeenCalledWith(expect.anything(), TX);
      expect(mockAgentVersionRepository.create).toHaveBeenCalledWith(expect.anything(), TX);

      // …and nothing survived: not the agent, not its version, not the templates.
      expect(committed).toEqual([]);
    });

    it('leaves NO half-cloned agent when the VERSION write fails after the agent write', async () => {
      const { committed } = journallingTransaction();
      mockAgentVersionRepository.create.mockRejectedValue(new Error('version insert failed'));

      await expect(service.promote(baseDto)).rejects.toThrow('version insert failed');

      expect(mockUnitOfWork.runInTransaction).toHaveBeenCalledTimes(1);
      expect(mockAgentRepository.create).toHaveBeenCalledWith(expect.anything(), TX);
      expect(committed).toEqual([]);
      expect(mockPromotionRepository.create).not.toHaveBeenCalled();
    });

    it('leaves NO orphan deep-copied prompt template when the agent write fails after it', async () => {
      const { committed } = journallingTransaction();
      mockAgentRepository.create.mockRejectedValue(new Error('agent insert failed'));

      await expect(service.promote(baseDto)).rejects.toThrow('agent insert failed');

      expect(mockUnitOfWork.runInTransaction).toHaveBeenCalledTimes(1);
      // The template copy was attempted, inside the transaction…
      expect(mockPromptTemplateRepository.create).toHaveBeenCalledWith(expect.anything(), TX);
      // …and did not survive the rollback.
      expect(committed).toEqual([]);
    });

    it('broadcasts NO sys-event for a promotion that rolled back', async () => {
      journallingTransaction();
      mockPromotionRepository.create.mockRejectedValue(new Error('promotion insert failed'));

      await expect(service.promote(baseDto)).rejects.toThrow();

      expect(mockUnitOfWork.runInTransaction).toHaveBeenCalledTimes(1);
      expect(mockEventEmitter.emit).not.toHaveBeenCalled();
    });

    it('runs NO eval against a promotion that rolled back', async () => {
      journallingTransaction();
      mockPromotionRepository.create.mockRejectedValue(new Error('promotion insert failed'));

      await expect(service.promote(dtoWithEval)).rejects.toThrow();

      expect(mockUnitOfWork.runInTransaction).toHaveBeenCalledTimes(1);
      expect(mockEvalRunService.runGoldenSet).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // The eval stays OUTSIDE — and its write proves backward compatibility
  // =========================================================================

  describe('the eval and its write stay outside the transaction', () => {
    it('runs the eval only AFTER the transaction has committed', async () => {
      const order: string[] = [];
      mockUnitOfWork.runInTransaction.mockImplementation(async (work: (tx: unknown) => Promise<unknown>) => {
        const out = await work(TX);
        order.push('commit');
        return out;
      });
      mockEvalRunService.runGoldenSet.mockImplementation(async () => {
        order.push('eval');
        return { run: { id: 'target-eval-run' }, passed: true, failures: [], aggregates: {} };
      });

      await service.promote(dtoWithEval);

      expect(order).toEqual(['commit', 'eval']);
    });

    it('writes evalRunId with the TWO-argument `update` — no tx, proving the parameter stayed optional', async () => {
      await service.promote(dtoWithEval);

      expect(mockPromotionRepository.update).toHaveBeenCalledTimes(1);
      const call = mockPromotionRepository.update.mock.calls[0];
      expect(call).toHaveLength(2);
      expect(call[0]).toBe('promotion-1');
    });
  });
});
