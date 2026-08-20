/**
 * WorkflowTestFixtureService encrypt-on-write + PHI response posture (TASK-721 R4).
 *
 * Mirrors `eval/__tests__/eval.service.encryption.test.ts` (the GoldenCase
 * exemplar):
 *   - `encryptFieldsIntoEntity` runs with the freshly built entity BEFORE it is
 *     persisted, on create AND on an update that touches `input`;
 *   - encryption is best-effort in soft mode (dev/test) and FAIL-CLOSED under
 *     `SECRETS_PROVIDER=vault`;
 *   - when no SecretsService is wired the encrypt helper is never called;
 *   - no error message ever carries the payload, and the LIST projection never
 *     carries the plaintext at all.
 *
 * Repository + SecretsService are fully mocked; no DB and no Vault.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ResourceStatusType } from '@arcaai/domains';
import { WorkflowTestFixtureService } from '../workflow-test-fixture.service';

const SYNTHETIC_INPUT = { transcript: 'Clinician: how have you been?', speakerCount: 2 };

const mockClsService = { get: vi.fn(), set: vi.fn() };
const mockEventEmitter = { emit: vi.fn() };

const mockRepository = {
  findById: vi.fn(),
  findAll: vi.fn(),
  count: vi.fn(),
  create: vi.fn(async (entity: unknown) => entity),
  updateWithVersion: vi.fn(async (_id: string, entity: unknown) => entity),
  softDelete: vi.fn(),
  encryptFieldsIntoEntity: vi.fn(async () => undefined),
};

const mockSecretsService = { encrypt: vi.fn(), decrypt: vi.fn() };

const entityFixture = (overrides: Record<string, unknown> = {}) => ({
  id: 'fixture-id-1',
  tenantId: 'tenant-1',
  name: 'Two-speaker follow-up visit',
  description: null,
  paletteId: null,
  workflowDefinitionId: null,
  input: SYNTHETIC_INPUT,
  resourceStatus: ResourceStatusType.ENABLED,
  createdAt: new Date('2026-08-20T00:00:00Z'),
  updatedAt: new Date('2026-08-20T00:00:00Z'),
  version: 1,
  hasChanges: true,
  changes: { input: SYNTHETIC_INPUT },
  ...overrides,
});

function buildService(withSecrets: boolean): WorkflowTestFixtureService {
  return new WorkflowTestFixtureService(
    mockRepository as never,
    mockEventEmitter as never,
    mockClsService as never,
    withSecrets ? (mockSecretsService as never) : undefined,
  );
}

describe('WorkflowTestFixtureService — input field encryption', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClsService.get.mockImplementation((key: string) => {
      if (key === 'tenantId') return 'tenant-1';
      if (key === 'user') return { id: 'admin-1', roles: ['TENANT_ADMIN'] };
      return undefined;
    });
  });

  describe('create', () => {
    it('encrypts the fixture BEFORE persisting it', async () => {
      const service = buildService(true);

      await service.create({ name: 'Two-speaker follow-up visit', input: SYNTHETIC_INPUT });

      expect(mockRepository.encryptFieldsIntoEntity).toHaveBeenCalledTimes(1);
      const [encryptedEntity, secretsArg] = mockRepository.encryptFieldsIntoEntity.mock.calls[0] as [unknown, unknown];
      expect(secretsArg).toBe(mockSecretsService);
      expect(mockRepository.create).toHaveBeenCalledWith(encryptedEntity);
      expect(mockRepository.encryptFieldsIntoEntity.mock.invocationCallOrder[0]).toBeLessThan(mockRepository.create.mock.invocationCallOrder[0]);
    });

    it('does NOT encrypt when no SecretsService is wired (soft dev/test mode)', async () => {
      const service = buildService(false);

      await service.create({ name: 'n', input: SYNTHETIC_INPUT });

      expect(mockRepository.encryptFieldsIntoEntity).not.toHaveBeenCalled();
      expect(mockRepository.create).toHaveBeenCalledTimes(1);
    });

    it('still persists when encryption fails in soft mode (dual-write soak)', async () => {
      mockRepository.encryptFieldsIntoEntity.mockRejectedValueOnce(new Error('vault down'));
      const service = buildService(true);

      await service.create({ name: 'n', input: SYNTHETIC_INPUT });

      expect(mockRepository.create).toHaveBeenCalledTimes(1);
    });
  });

  describe('update', () => {
    it('re-encrypts BEFORE the CAS write when the patch touches `input`', async () => {
      const entity = entityFixture();
      mockRepository.findById.mockResolvedValue(entity);
      const service = buildService(true);

      await service.update('fixture-id-1', { input: { transcript: 'new synthetic text' }, expectedVersion: 1 });

      expect(mockRepository.encryptFieldsIntoEntity).toHaveBeenCalledTimes(1);
      expect(mockRepository.encryptFieldsIntoEntity.mock.invocationCallOrder[0]).toBeLessThan(
        mockRepository.updateWithVersion.mock.invocationCallOrder[0],
      );
    });

    it('does NOT re-encrypt when the patch leaves `input` alone', async () => {
      const entity = entityFixture({ changes: { name: 'renamed' } });
      mockRepository.findById.mockResolvedValue(entity);
      const service = buildService(true);

      await service.update('fixture-id-1', { name: 'renamed', expectedVersion: 1 });

      expect(mockRepository.encryptFieldsIntoEntity).not.toHaveBeenCalled();
      expect(mockRepository.updateWithVersion).toHaveBeenCalledTimes(1);
    });
  });

  describe('PHI disclosure posture', () => {
    it('never echoes the payload in an encryption failure (fail-closed message carries no plaintext)', async () => {
      mockRepository.encryptFieldsIntoEntity.mockRejectedValueOnce(new Error('vault down'));
      const service = buildService(true);
      const previous = process.env.SECRETS_PROVIDER;
      process.env.SECRETS_PROVIDER = 'vault';

      try {
        await expect(service.create({ name: 'n', input: SYNTHETIC_INPUT })).rejects.toThrow();
        // fail-closed: nothing persisted, and the error carries no payload
        expect(mockRepository.create).not.toHaveBeenCalled();
        const err = await service.create({ name: 'n', input: SYNTHETIC_INPUT }).catch((e: unknown) => e);
        expect(JSON.stringify(err instanceof Error ? err.message : String(err))).not.toContain('Clinician');
      } finally {
        if (previous === undefined) delete process.env.SECRETS_PROVIDER;
        else process.env.SECRETS_PROVIDER = previous;
      }
    });

    it('LIST responses carry no decrypted payload — only the id-scoped read does', async () => {
      const entity = entityFixture();
      mockRepository.findAll.mockResolvedValue([entity]);
      mockRepository.count.mockResolvedValue(1);
      mockRepository.findById.mockResolvedValue(entity);
      const service = buildService(true);

      const page = await service.findAll({ page: 0, limit: 10 });
      expect(page.data).toHaveLength(1);
      expect(page.data[0].input).toBeUndefined();
      expect(JSON.stringify(page)).not.toContain('Clinician');

      const one = await service.findById('fixture-id-1');
      expect(one.input).toEqual(SYNTHETIC_INPUT);
    });

    it('the delete acknowledgement carries no payload', async () => {
      const entity = entityFixture();
      mockRepository.findById.mockResolvedValue(entity);
      mockRepository.softDelete.mockResolvedValue(entity);
      const service = buildService(true);

      const deleted = await service.deleteById('fixture-id-1');

      expect(deleted.input).toBeUndefined();
      expect(JSON.stringify(deleted)).not.toContain('Clinician');
    });
  });
});
