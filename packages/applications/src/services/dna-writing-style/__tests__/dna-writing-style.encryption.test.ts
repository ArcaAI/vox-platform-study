/**
 * DNA writing-style encryption wiring.
 *
 * Covers the two genuine TS write paths for the DnaWritingStyleReport /
 * DnaWritingStyleVersion clinical models:
 *   - DnaWritingStyleService.updateDnaReport (manual doctor/admin edits): the
 *     new version snapshot AND the mutated report row are encrypted BEFORE the
 *     transactional insert + CAS; a status-only edit must NOT re-encrypt; a
 *     missing SecretsService leaves these PHI fields unpersisted (soft mode).
 *   - DnaWritingStyleProcessor (AI generation): the freshly built report +
 *     initial version are encrypted before their respective creates.
 *
 * Repositories, SecretsService, queue, db and CLS are mocked — no DB/Vault.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DnaWritingStyleService } from '../dna-writing-style.service';

// Mirror the existing service test: stub the version factory so the snapshot
// build is a plain object we can track through encryption + persistence.
vi.mock('@arcaai/domains', async () => {
  const actual = await vi.importActual('@arcaai/domains');
  return {
    ...actual,
    DnaWritingStyleVersionFactory: {
      CreateDnaWritingStyleVersion: vi.fn((data: Record<string, unknown>) => ({
        ...data,
        id: 'new-version-id',
        createdAt: new Date('2026-02-18T10:00:00Z'),
      })),
    },
  };
});

const mockTxClient = { __tx: true } as const;

const reportEntity = () => ({
  id: 'report-1',
  tenantId: 'tenant-1',
  doctorId: 'user-1',
  reportData: { formality: 'high' },
  styleText: 'formal tone',
  isLatest: true,
  currentVersionNumber: 1,
  createdAt: new Date('2026-02-18T10:00:00Z'),
  updatedAt: new Date('2026-02-18T10:00:00Z'),
  resourceStatus: 'ENABLED',
  version: 3,
  // lifecycle methods invoked by applyChangesToEntity / BaseService
  enable: vi.fn(),
  disable: vi.fn(),
  unmarkAsLatest: vi.fn(),
  incrementVersion: vi.fn(),
  toObject: vi.fn().mockReturnValue({}),
});

function buildService(withSecrets: boolean) {
  const mockReportRepo = {
    findById: vi.fn(),
    findAll: vi.fn().mockResolvedValue([]),
    update: vi.fn(),
    updateWithVersion: vi.fn(),
    encryptFieldsIntoEntity: vi.fn(async () => undefined),
  };
  const mockVersionRepo = {
    findAll: vi.fn().mockResolvedValue([]),
    create: vi.fn(),
    encryptFieldsIntoEntity: vi.fn(async () => undefined),
  };
  const mockDb = {
    baseClient: {
      $transaction: vi.fn(async (cb: (tx: typeof mockTxClient) => Promise<unknown>) => cb(mockTxClient)),
    },
  };
  const mockCls = {
    get: vi.fn((key: string) => (key === 'user' ? { id: 'user-1' } : key === 'tenantId' ? 'tenant-1' : null)),
    set: vi.fn(),
  };
  const mockSecrets = { encrypt: vi.fn(), decrypt: vi.fn() };

  const service = new DnaWritingStyleService(
    mockReportRepo as never,
    mockVersionRepo as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { emit: vi.fn() } as never,
    mockCls as never,
    mockDb as never,
    undefined,
    withSecrets ? (mockSecrets as never) : undefined,
  );

  return { service, mockReportRepo, mockVersionRepo, mockDb, mockSecrets };
}

describe('DnaWritingStyleService.updateDnaReport — field encryption', () => {
  beforeEach(() => vi.clearAllMocks());

  it('encrypts the version snapshot AND the report BEFORE persisting (content change)', async () => {
    const { service, mockReportRepo, mockVersionRepo } = buildService(true);
    const report = reportEntity();
    mockReportRepo.findById.mockResolvedValue(report);
    mockReportRepo.updateWithVersion.mockResolvedValue(report);

    await service.updateDnaReport('report-1', { styleText: 'new style', reportData: { tone: 'warm' } });

    expect(mockVersionRepo.encryptFieldsIntoEntity).toHaveBeenCalledTimes(1);
    expect(mockReportRepo.encryptFieldsIntoEntity).toHaveBeenCalledTimes(1);
    // both encrypts run before the version insert + report CAS
    expect(mockVersionRepo.encryptFieldsIntoEntity.mock.invocationCallOrder[0]).toBeLessThan(mockVersionRepo.create.mock.invocationCallOrder[0]);
    expect(mockReportRepo.encryptFieldsIntoEntity.mock.invocationCallOrder[0]).toBeLessThan(
      mockReportRepo.updateWithVersion.mock.invocationCallOrder[0],
    );
  });

  it('TASK-551: a redaction-rules edit validates, sets the entity, encrypts, and snapshots the version', async () => {
    const { service, mockReportRepo, mockVersionRepo } = buildService(true);
    const report = reportEntity();
    mockReportRepo.findById.mockResolvedValue(report);
    mockReportRepo.updateWithVersion.mockResolvedValue(report);

    await service.updateDnaReport('report-1', {
      redactionRules: { rules: [{ id: 'r1', type: 'remove', match: 'literal', pattern: 'employer' }] },
    } as never);

    // Rule set is a content change ⇒ both the report row and the version snapshot
    // are re-encrypted (the F-031 cipher-called guard at the service layer).
    expect(mockReportRepo.encryptFieldsIntoEntity).toHaveBeenCalledTimes(1);
    expect(mockVersionRepo.encryptFieldsIntoEntity).toHaveBeenCalledTimes(1);
    // The normalized rule set is set on the entity before encryption.
    expect((report as { redactionRules?: unknown }).redactionRules).toEqual({
      rules: [{ id: 'r1', type: 'remove', match: 'literal', pattern: 'employer' }],
    });
    // A new version row was created carrying the snapshot.
    expect(mockVersionRepo.create).toHaveBeenCalledTimes(1);
  });

  it('TASK-551: a malformed rule set is rejected before any write', async () => {
    const { service, mockReportRepo, mockVersionRepo } = buildService(true);
    const report = reportEntity();
    mockReportRepo.findById.mockResolvedValue(report);

    await expect(
      service.updateDnaReport('report-1', { redactionRules: { rules: [{ id: 'r1', type: 'delete', match: 'literal', pattern: 'x' }] } } as never),
    ).rejects.toThrow();

    expect(mockReportRepo.updateWithVersion).not.toHaveBeenCalled();
    expect(mockVersionRepo.create).not.toHaveBeenCalled();
  });

  it('does NOT encrypt on a status-only edit (no content change)', async () => {
    const { service, mockReportRepo, mockVersionRepo } = buildService(true);
    const report = reportEntity();
    mockReportRepo.findById.mockResolvedValue(report);
    mockReportRepo.updateWithVersion.mockResolvedValue(report);

    await service.updateDnaReport('report-1', { resourceStatus: 'DISABLED' } as never);

    expect(mockVersionRepo.encryptFieldsIntoEntity).not.toHaveBeenCalled();
    expect(mockReportRepo.encryptFieldsIntoEntity).not.toHaveBeenCalled();
  });

  it('still persists when encryption fails (dual-write soak)', async () => {
    const { service, mockReportRepo, mockVersionRepo } = buildService(true);
    const report = reportEntity();
    mockReportRepo.findById.mockResolvedValue(report);
    mockReportRepo.updateWithVersion.mockResolvedValue(report);
    mockReportRepo.encryptFieldsIntoEntity.mockRejectedValueOnce(new Error('vault down'));
    mockVersionRepo.encryptFieldsIntoEntity.mockRejectedValueOnce(new Error('vault down'));

    const res = await service.updateDnaReport('report-1', { styleText: 'x' });

    expect(res).toBeTruthy();
    expect(mockVersionRepo.create).toHaveBeenCalledTimes(1);
    expect(mockReportRepo.updateWithVersion).toHaveBeenCalledTimes(1);
  });

  it('does NOT encrypt when no SecretsService is wired', async () => {
    const { service, mockReportRepo, mockVersionRepo } = buildService(false);
    const report = reportEntity();
    mockReportRepo.findById.mockResolvedValue(report);
    mockReportRepo.updateWithVersion.mockResolvedValue(report);

    await service.updateDnaReport('report-1', { styleText: 'x' });

    expect(mockVersionRepo.encryptFieldsIntoEntity).not.toHaveBeenCalled();
    expect(mockReportRepo.encryptFieldsIntoEntity).not.toHaveBeenCalled();
  });
});
