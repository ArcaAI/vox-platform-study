import { vi } from 'vitest';
import {
  TenantCheckpointFactory,
  TenantCheckpointKind,
  TenantCheckpointOrigin,
  TenantCheckpointRestoreFactory,
  TenantCheckpointStatus,
  type TenantCheckpointEntity,
} from '@arcaai/domains';
import { TenantCheckpointService } from '../tenant-checkpoint.service';

export const TENANT_A = '1032a000-0000-4000-8000-000000001032';
export const TENANT_B = '1032b000-0000-4000-8000-000000001032';
export const SYSTEM = '00000000-0000-0000-0000-000000000000';
export const USER_ID = 'user-1';

export type Actor = { roles: string[] };
export const TENANT_ADMIN: Actor = { roles: ['TENANT_ADMIN'] };
export const SUPER_ADMIN: Actor = { roles: ['SUPER_ADMIN'] };

export function checkpointEntity(overrides: Partial<Parameters<typeof TenantCheckpointFactory.CreateTenantCheckpoint>[0]> = {}): TenantCheckpointEntity {
  return TenantCheckpointFactory.CreateTenantCheckpoint({
    tenantId: TENANT_A,
    label: 'nightly',
    kind: TenantCheckpointKind.MANUAL,
    origin: TenantCheckpointOrigin.CREATED,
    status: TenantCheckpointStatus.READY,
    objectKey: `${TENANT_A}/obj.hcp`,
    manifestSummary: { tables: [{ model: 'Department', columns: ['id', 'tenantId', 'name'], rowCount: 3 }] } as never,
    createdBy: USER_ID,
    ...overrides,
  });
}

export function buildService(actor: Actor = TENANT_ADMIN) {
  const tenant = { id: TENANT_A, name: 'Acme Clinic', key: 'ACME', isDeleted: false };
  const checkpoints = {
    findByIdOrNull: vi.fn(),
    findFirst: vi.fn(),
    findAll: vi.fn().mockResolvedValue([]),
    count: vi.fn().mockResolvedValue(0),
    findRunningByTenant: vi.fn().mockResolvedValue([]),
    create: vi.fn(async (e: unknown) => e),
    updateWithVersion: vi.fn(async (_id: string, e: unknown) => e),
    softDelete: vi.fn().mockResolvedValue(undefined),
  };
  const restores = {
    findByIdOrNull: vi.fn(),
    findActiveByTenant: vi.fn().mockResolvedValue(null),
    findByTenant: vi.fn().mockResolvedValue({ rows: [], total: 0 }),
    create: vi.fn(async (e: unknown) => e),
    updateWithVersion: vi.fn(async (_id: string, e: unknown) => e),
  };
  const tenants = { findByIdOrNull: vi.fn(async () => tenant) };
  const users = { findById: vi.fn(async () => ({ password: 'stored-hash' })) };
  const crypto = { verify: vi.fn(async (password: string) => password === 'right-password') };
  const dataKey = Buffer.alloc(32, 7);
  const sealing = {
    generateDataKey: vi.fn(async () => ({ plaintext: dataKey, platformWrapped: 'vault:v1:WRAPPED' })),
    wrapWithPassphrase: vi.fn(async () => ({ kdf: 'argon2id', salt: 's', m: 1, t: 1, p: 1, nonce: 'n', wrapped: 'w' })),
  };
  const store = {
    objectKey: vi.fn((t: string, id: string) => `${t}/${id}.hcp`),
    presignDownload: vi.fn(async () => 'https://minio/presigned'),
    createUpload: vi.fn(async () => ({ uploadId: 'S3-UPLOAD-1' })),
    presignUploadParts: vi.fn(async (_k: string, _u: string, n: number) => Array.from({ length: n }, (_, i) => ({ partNumber: i + 1, url: `https://minio/p${i + 1}` }))),
    completeUpload: vi.fn(async () => ({ sizeBytes: 123 })),
    abortUpload: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  };
  const settings = { resolve: vi.fn(() => ({ value: 50 })) };
  const col = (column_name: string) => ({ table_name: 'Department', column_name, is_nullable: 'NO', column_default: null, is_identity: 'NO' });
  // the live Department table has exactly the columns the fixture manifest captured
  const queryRawUnsafe = vi.fn().mockResolvedValue([col('id'), col('tenantId'), col('name')]);
  const databaseService = { baseClient: { $queryRawUnsafe: queryRawUnsafe } };
  const exportQueue = { add: vi.fn().mockResolvedValue(undefined) };
  const restoreQueue = { add: vi.fn().mockResolvedValue(undefined) };
  const eventEmitter = { emit: vi.fn() };
  const cls = {
    get: vi.fn((key: string) => {
      if (key === 'user') return { id: USER_ID, tenantId: TENANT_A, roles: actor.roles };
      if (key === 'tenantId') return TENANT_A;
      return undefined;
    }),
  };

  const service = new TenantCheckpointService(
    checkpoints as never,
    restores as never,
    tenants as never,
    users as never,
    crypto as never,
    sealing as never,
    store as never,
    settings as never,
    databaseService as never,
    exportQueue as never,
    restoreQueue as never,
    eventEmitter as never,
    cls as never,
  );
  return { service, cls, checkpoints, restores, tenants, users, crypto, sealing, store, settings, queryRawUnsafe, exportQueue, restoreQueue, eventEmitter, tenant, dataKey };
}

export { TenantCheckpointRestoreFactory };
