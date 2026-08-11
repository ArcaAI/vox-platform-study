// ContextItemRepository
// encryption helpers, exercised via the prototype-augmentation sibling file.
// No real Prisma client is booted; findById is monkeypatched per test.
import { describe, it, expect, vi } from 'vitest';
import 'reflect-metadata';
import { ContextItemRepository } from '../generated/core/ContextItemRepository';
import { ContextItemEntity } from '../../entities/generated/core/ContextItemEntity';
import { ContextItemType, ContextItemSource } from '../../enums';
import type { SecretsServiceLike } from '../../common/field-encryption';

// Side-effect import that registers the prototype methods.
import '../generated/core/ContextItemRepository.encryption';

function makeEntity(overrides: Partial<ConstructorParameters<typeof ContextItemEntity>[0]> = {}): ContextItemEntity {
  return new ContextItemEntity({
    id: 'c0000000-0000-0000-0000-000000000001',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    createdBy: null,
    updatedBy: null,
    tenantId: 'tenant-1',
    Tenant: null,
    consultationId: 'consult-1',
    type: ContextItemType.WORKNOTE,
    source: ContextItemSource.USER,
    currentVersionNumber: 1,
    content: 'Patient presents with chest pain.',
    encryptedContent: null,
    contentKeyVersion: null,
    qdrantSynced: false,
    ...overrides,
  } as any);
}

function makeRepo(): ContextItemRepository {
  // Skip the real constructor (needs a UoW). We only exercise prototype methods.
  return Object.create(ContextItemRepository.prototype) as ContextItemRepository;
}

describe('ContextItemRepository.encryptContentIntoEntity (Phase 3B)', () => {
  it('encrypts content via SecretsService, populating encryptedContent + contentKeyVersion', async () => {
    const secrets: SecretsServiceLike = {
      encrypt: vi.fn(async (b: Buffer) => `vault:v3:${b.toString('base64')}`),
      decrypt: vi.fn(),
    };
    const repo = makeRepo();
    const entity = makeEntity({ content: 'note' });

    await repo.encryptContentIntoEntity(entity, secrets);

    expect(secrets.encrypt).toHaveBeenCalledTimes(1);
    expect(entity.encryptedContent).toBeInstanceOf(Buffer);
    expect(entity.encryptedContent?.toString('utf8')).toBe('vault:v3:bm90ZQ==');
    expect(entity.contentKeyVersion).toBe(3);
  });

  it('routes encryption through the dedicated PHI key when getPhiTransitKeyName is present', async () => {
    const encrypt = vi.fn(async (b: Buffer) => `vault:v1:${b.toString('base64')}`);
    const secrets: SecretsServiceLike = {
      encrypt,
      decrypt: vi.fn(),
      getPhiTransitKeyName: () => 'hope-phi',
    };
    const repo = makeRepo();
    const entity = makeEntity({ content: 'note' });

    await repo.encryptContentIntoEntity(entity, secrets);

    expect(encrypt).toHaveBeenCalledWith(expect.any(Buffer), 'hope-phi');
  });

  it('parses contentKeyVersion=1 fallback when ciphertext is malformed', async () => {
    const secrets: SecretsServiceLike = {
      encrypt: vi.fn(async () => 'not-a-valid-vault-ciphertext'),
      decrypt: vi.fn(),
    };
    const repo = makeRepo();
    const entity = makeEntity({ content: 'note' });

    await repo.encryptContentIntoEntity(entity, secrets);
    expect(entity.contentKeyVersion).toBe(1);
  });

  it('no-ops when content is empty/null (nothing to encrypt)', async () => {
    const secrets: SecretsServiceLike = { encrypt: vi.fn(), decrypt: vi.fn() };
    const repo = makeRepo();
    const entity = makeEntity({ content: null, type: ContextItemType.ATTACHMENT });

    await repo.encryptContentIntoEntity(entity, secrets);
    expect(secrets.encrypt).not.toHaveBeenCalled();
    expect(entity.encryptedContent ?? null).toBeNull();
    expect(entity.contentKeyVersion ?? null).toBeNull();
  });

  it('does NOT clear the transient plaintext content (kept in memory, never persisted)', async () => {
    const secrets: SecretsServiceLike = {
      encrypt: vi.fn(async (b: Buffer) => `vault:v1:${b.toString('base64')}`),
      decrypt: vi.fn(),
    };
    const repo = makeRepo();
    const entity = makeEntity({ content: 'keep-me' });

    await repo.encryptContentIntoEntity(entity, secrets);
    expect(entity.content).toBe('keep-me');
  });
});

describe('ContextItemRepository.decryptContentFromEntity (Phase 3B)', () => {
  it('decrypts encryptedContent via SecretsService', async () => {
    const secrets: SecretsServiceLike = {
      encrypt: vi.fn(),
      decrypt: vi.fn(async (ct: string) => Buffer.from(ct.split(':').pop()!, 'base64')),
    };
    const repo = makeRepo();
    const entity = makeEntity({
      content: null,
      encryptedContent: Buffer.from('vault:v2:bm90ZQ==', 'utf8'),
    });

    const pt = await repo.decryptContentFromEntity(entity, secrets);
    expect(pt).toBe('note');
    // Decryption always resolves to the dedicated PHI key (default 'hope-phi').
    expect(secrets.decrypt).toHaveBeenCalledWith('vault:v2:bm90ZQ==', 'hope-phi');
  });

  it('returns null when encryptedContent is null — no plaintext fallback (Phase 6)', async () => {
    const secrets: SecretsServiceLike = { encrypt: vi.fn(), decrypt: vi.fn() };
    const repo = makeRepo();
    // The plaintext column was DROPPED in Phase 6; `content` survives only as a
    // transient in-memory field. decrypt-on-read is ciphertext-only, so a null
    // ciphertext yields null even if a transient plaintext value is present.
    const entity = makeEntity({ content: 'legacy-note', encryptedContent: null });

    const pt = await repo.decryptContentFromEntity(entity, secrets);
    expect(pt).toBeNull();
    expect(secrets.decrypt).not.toHaveBeenCalled();
  });

  it('returns null when the row has neither ciphertext nor plaintext', async () => {
    const secrets: SecretsServiceLike = { encrypt: vi.fn(), decrypt: vi.fn() };
    const repo = makeRepo();
    const entity = makeEntity({ content: null, encryptedContent: null, type: ContextItemType.AUDIO_RECORDING });

    const pt = await repo.decryptContentFromEntity(entity, secrets);
    expect(pt).toBeNull();
  });

  it('prefers encryptedContent when both are present', async () => {
    const secrets: SecretsServiceLike = {
      encrypt: vi.fn(),
      decrypt: vi.fn(async () => Buffer.from('from-vault', 'utf8')),
    };
    const repo = makeRepo();
    const entity = makeEntity({
      content: 'from-plaintext',
      encryptedContent: Buffer.from('vault:v1:Zg==', 'utf8'),
    });

    const pt = await repo.decryptContentFromEntity(entity, secrets);
    expect(pt).toBe('from-vault');
  });
});

describe('ContextItemRepository.findLatestPreSummaryWithDecryptedContent (B-02 / B-06)', () => {
  // B-02: the warm-start read (`findLatestPreSummary`) never decrypted
  // `encryptedContent` — consumers reading `.content` off the result got
  // empty text in Vault-backed envs. B-06: the finder was not subType-aware,
  // so a case-notes PRE_SUMMARY created after a LIVE_SOAP_SNAPSHOT would
  // shadow it. This method closes both: decrypt via the existing
  // `decryptContentFromEntity` helper, and an optional `subType` filter
  // mirroring harness's `loadLiveSoapSnapshot` in-memory-filter idiom.

  it('decrypts the latest pre-summary content via decryptContentFromEntity', async () => {
    const secrets: SecretsServiceLike = {
      encrypt: vi.fn(),
      decrypt: vi.fn(async () => Buffer.from('decrypted plan', 'utf8')),
    };
    const repo = makeRepo();
    const older = makeEntity({
      id: 'ctx-older',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      content: null,
      encryptedContent: Buffer.from('vault:v1:b2xk', 'utf8'),
    });
    const newer = makeEntity({
      id: 'ctx-newer',
      createdAt: new Date('2026-01-02T00:00:00Z'),
      content: null,
      encryptedContent: Buffer.from('vault:v1:bmV3', 'utf8'),
    });
    (repo as { findPreSummaries: typeof repo.findPreSummaries }).findPreSummaries = vi.fn(async () => [older, newer]);

    const result = await repo.findLatestPreSummaryWithDecryptedContent('consult-1', secrets);

    expect(result.entity?.id).toBe('ctx-newer');
    expect(result.plaintext).toBe('decrypted plan');
    expect(secrets.decrypt).toHaveBeenCalledWith('vault:v1:bmV3', 'hope-phi');
  });

  it('filters by metaData.subType so a newer case-notes row never shadows the live snapshot (B-06)', async () => {
    const secrets: SecretsServiceLike = {
      encrypt: vi.fn(),
      decrypt: vi.fn(async (ct: string) => Buffer.from(ct.includes('snapshot') ? 'snapshot text' : 'case note text', 'utf8')),
    };
    const repo = makeRepo();
    const liveSnapshot = makeEntity({
      id: 'ctx-snapshot',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      content: null,
      encryptedContent: Buffer.from('vault:v1:snapshot', 'utf8'),
      metaData: { subType: 'LIVE_SOAP_SNAPSHOT' },
    } as any);
    const caseNote = makeEntity({
      id: 'ctx-casenote',
      createdAt: new Date('2026-01-02T00:00:00Z'),
      content: null,
      encryptedContent: Buffer.from('vault:v1:casenote', 'utf8'),
      metaData: null,
    } as any);
    (repo as { findPreSummaries: typeof repo.findPreSummaries }).findPreSummaries = vi.fn(async () => [liveSnapshot, caseNote]);

    const result = await repo.findLatestPreSummaryWithDecryptedContent('consult-1', secrets, { subType: 'LIVE_SOAP_SNAPSHOT' });

    expect(result.entity?.id).toBe('ctx-snapshot');
    expect(result.plaintext).toBe('snapshot text');
  });

  it('keeps legacy no-filter behavior available (subType omitted picks the newest row regardless of metaData)', async () => {
    const secrets: SecretsServiceLike = {
      encrypt: vi.fn(),
      decrypt: vi.fn(async () => Buffer.from('case note text', 'utf8')),
    };
    const repo = makeRepo();
    const liveSnapshot = makeEntity({
      id: 'ctx-snapshot',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      content: null,
      encryptedContent: Buffer.from('vault:v1:snapshot', 'utf8'),
      metaData: { subType: 'LIVE_SOAP_SNAPSHOT' },
    } as any);
    const caseNote = makeEntity({
      id: 'ctx-casenote',
      createdAt: new Date('2026-01-02T00:00:00Z'),
      content: null,
      encryptedContent: Buffer.from('vault:v1:casenote', 'utf8'),
      metaData: null,
    } as any);
    (repo as { findPreSummaries: typeof repo.findPreSummaries }).findPreSummaries = vi.fn(async () => [liveSnapshot, caseNote]);

    const result = await repo.findLatestPreSummaryWithDecryptedContent('consult-1', secrets);

    expect(result.entity?.id).toBe('ctx-casenote');
  });

  it('returns { entity: null, plaintext: null } when no pre-summary matches', async () => {
    const secrets: SecretsServiceLike = { encrypt: vi.fn(), decrypt: vi.fn() };
    const repo = makeRepo();
    (repo as { findPreSummaries: typeof repo.findPreSummaries }).findPreSummaries = vi.fn(async () => []);

    const result = await repo.findLatestPreSummaryWithDecryptedContent('consult-1', secrets, { subType: 'LIVE_SOAP_SNAPSHOT' });

    expect(result).toEqual({ entity: null, plaintext: null });
    expect(secrets.decrypt).not.toHaveBeenCalled();
  });

  it('degrades to the entity content transient field (no throw) when no SecretsService is wired', async () => {
    const repo = makeRepo();
    const entity = makeEntity({ id: 'ctx-1', content: 'already-plaintext-in-memory', encryptedContent: null });
    (repo as { findPreSummaries: typeof repo.findPreSummaries }).findPreSummaries = vi.fn(async () => [entity]);

    const result = await repo.findLatestPreSummaryWithDecryptedContent('consult-1', undefined);

    expect(result.entity?.id).toBe('ctx-1');
    expect(result.plaintext).toBe('already-plaintext-in-memory');
  });

  // TASK-655 — this is the SHARED implementation all four former call-site
  // copies now delegate to (live-documentation's `findLiveSnapshotRow`,
  // harness's `loadLiveSoapSnapshot`, `SummaryService`/`SummaryProcessor`'s
  // `resolveWarmStartPreSummary`). A decrypt failure (e.g. a Vault Transit
  // outage) must propagate rather than being swallowed — callers decide how to
  // handle it, the helper does not silently substitute a value.
  it('propagates a decryption failure rather than swallowing it', async () => {
    const secrets: SecretsServiceLike = {
      encrypt: vi.fn(),
      decrypt: vi.fn(async () => {
        throw new Error('vault transit unavailable');
      }),
    };
    const repo = makeRepo();
    const entity = makeEntity({
      id: 'ctx-undecryptable',
      content: null,
      encryptedContent: Buffer.from('vault:v1:corrupt', 'utf8'),
    });
    (repo as { findPreSummaries: typeof repo.findPreSummaries }).findPreSummaries = vi.fn(async () => [entity]);

    await expect(repo.findLatestPreSummaryWithDecryptedContent('consult-1', secrets)).rejects.toThrow('vault transit unavailable');
  });
});

describe('ContextItemRepository.findByIdWithDecryptedContent (Phase 3B)', () => {
  it('wraps findById + decryptContentFromEntity into a single call', async () => {
    const secrets: SecretsServiceLike = {
      encrypt: vi.fn(),
      decrypt: vi.fn(async () => Buffer.from('decrypted-note', 'utf8')),
    };
    const repo = makeRepo();
    const entity = makeEntity({
      content: null,
      encryptedContent: Buffer.from('vault:v1:ZA==', 'utf8'),
    });
    (repo as { findById: typeof repo.findById }).findById = vi.fn(async () => entity);

    const out = await repo.findByIdWithDecryptedContent('any-id', secrets);
    expect(out.entity).toBe(entity);
    expect(out.plaintext).toBe('decrypted-note');
    expect(repo.findById).toHaveBeenCalledWith('any-id');
  });

  it('propagates the not-found error from findById', async () => {
    const secrets: SecretsServiceLike = { encrypt: vi.fn(), decrypt: vi.fn() };
    const repo = makeRepo();
    (repo as { findById: typeof repo.findById }).findById = vi.fn(async () => {
      throw new Error('DataNotFound: ContextItem/nope');
    });

    await expect(repo.findByIdWithDecryptedContent('nope', secrets)).rejects.toThrow(/DataNotFound/);
  });
});
