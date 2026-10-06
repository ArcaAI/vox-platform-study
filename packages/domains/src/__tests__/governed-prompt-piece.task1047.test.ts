/**
 * TASK-1047 FC-3 — the GovernedPromptPiece domain trio.
 *
 *  - The entity refuses a malformed digest (sha256 lower-case hex), an empty policy version and a
 *    negative text length: a verdict row that does not name exactly one text under exactly one
 *    policy cannot vouch for anything.
 *  - The repository reads [tenant, SYSTEM] EXPLICITLY on the base client (the boot backfill runs
 *    with no CLS tenant, and a SYSTEM row must verify for every tenant's call), writes ONE row per
 *    (tenant, digest, policyVersion) by upsert, and never sees or stores text.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GovernedPromptPieceKind, GovernedPromptSourceType, GovernedPromptVerdict, ResourceStatusType } from '../enums';

vi.mock('../common/unitsOfWork/core', () => ({ CoreUnitOfWorkService: vi.fn() }));

const SYSTEM = '00000000-0000-0000-0000-000000000000';
const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);

async function pieceEntity(overrides: Record<string, unknown> = {}) {
  const { GovernedPromptPieceFactory } = await import('../factories/generated/core/GovernedPromptPieceFactory');
  return GovernedPromptPieceFactory.CreateGovernedPromptPiece({
    tenantId: 't-1',
    digest: DIGEST_A,
    kind: GovernedPromptPieceKind.TEMPLATE_BODY,
    sourceType: GovernedPromptSourceType.AGENT,
    sourceId: 'agent-1',
    sourceKey: 'body',
    policyVersion: 'pv-1',
    verdict: GovernedPromptVerdict.PASS,
    findings: null,
    textChars: 120,
    screenedAt: new Date('2026-10-06T00:00:00Z'),
    ...overrides,
  } as never);
}

describe('GovernedPromptPieceEntity', () => {
  it('factory mints a UUIDv7 id, keeps every field and starts unchanged', async () => {
    const entity = await pieceEntity();
    expect(entity.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);
    expect(entity.digest).toBe(DIGEST_A);
    expect(entity.kind).toBe(GovernedPromptPieceKind.TEMPLATE_BODY);
    expect(entity.policyVersion).toBe('pv-1');
    expect(entity.verdict).toBe(GovernedPromptVerdict.PASS);
    expect(entity.textChars).toBe(120);
    expect(entity.hasChanges).toBe(false);
    expect(() => entity.validate()).not.toThrow();
  });

  it('validate refuses a digest that is not sha256 lower-case hex', async () => {
    await expect(pieceEntity({ digest: 'ABC' }).then((e) => e.validate())).rejects.toThrow(/digest/);
    await expect(pieceEntity({ digest: 'A'.repeat(64) }).then((e) => e.validate())).rejects.toThrow(/digest/);
    await expect(pieceEntity({ digest: 'a'.repeat(63) }).then((e) => e.validate())).rejects.toThrow(/digest/);
  });

  it('validate refuses an empty policy version and a negative text length', async () => {
    await expect(pieceEntity({ policyVersion: ' ' }).then((e) => e.validate())).rejects.toThrow(/policyVersion/);
    await expect(pieceEntity({ textChars: -1 }).then((e) => e.validate())).rejects.toThrow(/textChars/);
  });

  it('setters are change-tracked', async () => {
    const entity = await pieceEntity();
    entity.verdict = GovernedPromptVerdict.FAIL;
    expect(entity.changes).toHaveProperty('verdict', GovernedPromptVerdict.FAIL);
  });

  it('mapper round-trips and never writes _version', async () => {
    const { GovernedPromptPieceEntityMapper } = await import('../mappers/generated/core/GovernedPromptPieceEntityMapper');
    const mapper = GovernedPromptPieceEntityMapper.getInstance();
    const entity = await pieceEntity();
    const model = mapper.toPersistence(entity) as unknown as Record<string, unknown>;
    expect(model).not.toHaveProperty('version');
    expect(model.digest).toBe(DIGEST_A);
    const back = mapper.toDomainEntity({ ...model, version: 3 } as never);
    expect(back.digest).toBe(DIGEST_A);
    expect(back.policyVersion).toBe('pv-1');
  });
});

describe('GovernedPromptPieceRepository', () => {
  let base: Record<string, ReturnType<typeof vi.fn>>;
  let repo: any;

  beforeEach(async () => {
    base = {
      findMany: vi.fn().mockResolvedValue([]),
      upsert: vi.fn().mockImplementation(async ({ create }) => ({ ...create, version: 1, createdAt: new Date(), updatedAt: new Date() })),
    };
    const databaseService = { baseClient: { governedPromptPiece: base, agent: { findMany: vi.fn() }, promptTemplate: { findMany: vi.fn() } } };
    const { GovernedPromptPieceRepository } = await import('../repositories/generated/core/GovernedPromptPieceRepository');
    repo = new GovernedPromptPieceRepository({ getDatabaseService: () => ({}) } as never, databaseService as never);
  });

  it('findPassing reads PASS rows for the digests under one policy version in [tenant, SYSTEM], de-duplicated', async () => {
    base.findMany.mockResolvedValue([
      {
        id: 'r1',
        tenantId: SYSTEM,
        digest: DIGEST_A,
        policyVersion: 'pv-1',
        verdict: 'PASS',
        kind: 'PLATFORM',
        sourceType: 'PLATFORM',
        textChars: 1,
        screenedAt: new Date(),
      },
    ]);
    const rows = await repo.findPassing('t-1', [DIGEST_A, DIGEST_B, DIGEST_A], 'pv-1');
    expect(base.findMany).toHaveBeenCalledWith({
      where: {
        tenantId: { in: ['t-1', SYSTEM] },
        digest: { in: [DIGEST_A, DIGEST_B] },
        policyVersion: 'pv-1',
        verdict: GovernedPromptVerdict.PASS,
        resourceStatus: { not: ResourceStatusType.DELETED },
      },
    });
    expect(rows.map((row: { digest: string }) => row.digest)).toEqual([DIGEST_A]);
  });

  it('findPassing short-circuits an empty digest list (no query)', async () => {
    expect(await repo.findPassing('t-1', [], 'pv-1')).toEqual([]);
    expect(base.findMany).not.toHaveBeenCalled();
  });

  it('findPassing for SYSTEM reads SYSTEM once', async () => {
    await repo.findPassing(SYSTEM, [DIGEST_A], 'pv-1');
    expect(base.findMany.mock.calls[0][0].where.tenantId).toEqual({ in: [SYSTEM] });
  });

  it('upsertVerdict writes one row per (tenant, digest, policyVersion) and refreshes the verdict on conflict', async () => {
    const screenedAt = new Date('2026-10-06T01:00:00Z');
    const saved = await repo.upsertVerdict({
      tenantId: SYSTEM,
      digest: DIGEST_B,
      policyVersion: 'pv-2',
      kind: GovernedPromptPieceKind.PLATFORM,
      sourceType: GovernedPromptSourceType.PLATFORM,
      sourceId: null,
      sourceKey: 'platform-rules@1',
      verdict: GovernedPromptVerdict.FAIL,
      findings: [{ code: 'PROMPT_SCREENING_UNSAFE', reason: 'prompt_safety' }],
      textChars: 42,
      screenedAt,
      actorId: 'u-1',
    });
    const args = base.upsert.mock.calls[0][0];
    expect(args.where).toEqual({ tenantId_digest_policyVersion: { tenantId: SYSTEM, digest: DIGEST_B, policyVersion: 'pv-2' } });
    expect(args.create).toMatchObject({ tenantId: SYSTEM, digest: DIGEST_B, verdict: 'FAIL', textChars: 42, createdBy: 'u-1' });
    expect(args.create.id).toMatch(/^[0-9a-f]{8}-/);
    expect(args.update).toMatchObject({ verdict: 'FAIL', screenedAt, textChars: 42, resourceStatus: ResourceStatusType.ENABLED, updatedBy: 'u-1' });
    expect(args.update).not.toHaveProperty('tenantId');
    expect(args.update).not.toHaveProperty('digest');
    expect(saved.digest).toBe(DIGEST_B);
  });

  it('findBySource reads one source, optionally under one policy version', async () => {
    await repo.findBySource(GovernedPromptSourceType.AGENT, 'agent-1', 'pv-1');
    expect(base.findMany).toHaveBeenCalledWith({
      where: { sourceType: 'AGENT', sourceId: 'agent-1', policyVersion: 'pv-1', resourceStatus: { not: ResourceStatusType.DELETED } },
      orderBy: [{ screenedAt: 'desc' }],
    });
  });
});

describe('GovernedPromptPieceRepository — boot backfill sources', () => {
  it('findPublishedAgentSources reads every PUBLISHED, non-deleted agent across tenants (projection only)', async () => {
    const agent = { findMany: vi.fn().mockResolvedValue([{ id: 'a1', tenantId: 't-1', compiledConfig: {} }]) };
    const { GovernedPromptPieceRepository } = await import('../repositories/generated/core/GovernedPromptPieceRepository');
    const repo = new GovernedPromptPieceRepository({ getDatabaseService: () => ({}) } as never, { baseClient: { agent } } as never);
    expect(await repo.findPublishedAgentSources()).toEqual([{ id: 'a1', tenantId: 't-1', compiledConfig: {} }]);
    expect(agent.findMany).toHaveBeenCalledWith({
      where: { status: 'PUBLISHED', resourceStatus: { not: ResourceStatusType.DELETED } },
      select: { id: true, tenantId: true, compiledConfig: true },
      orderBy: [{ tenantId: 'asc' }, { id: 'asc' }],
    });
  });

  it('findApprovedVersionSources reads the PINNED version of every approved template', async () => {
    const promptTemplate = { findMany: vi.fn().mockResolvedValue([{ id: 'pt1', approvedVersionNumber: 3 }]) };
    const promptVersion = { findMany: vi.fn().mockResolvedValue([{ id: 'pv1', tenantId: 't-1', promptTemplateId: 'pt1', content: 'x' }]) };
    const { GovernedPromptPieceRepository } = await import('../repositories/generated/core/GovernedPromptPieceRepository');
    const repo = new GovernedPromptPieceRepository(
      { getDatabaseService: () => ({}) } as never,
      { baseClient: { promptTemplate, promptVersion } } as never,
    );
    expect(await repo.findApprovedVersionSources()).toHaveLength(1);
    expect(promptVersion.findMany.mock.calls[0][0].where).toEqual({ OR: [{ promptTemplateId: 'pt1', versionNumber: 3 }] });
  });

  it('findApprovedVersionSources issues no version read when nothing is approved', async () => {
    const promptTemplate = { findMany: vi.fn().mockResolvedValue([]) };
    const promptVersion = { findMany: vi.fn() };
    const { GovernedPromptPieceRepository } = await import('../repositories/generated/core/GovernedPromptPieceRepository');
    const repo = new GovernedPromptPieceRepository(
      { getDatabaseService: () => ({}) } as never,
      { baseClient: { promptTemplate, promptVersion } } as never,
    );
    expect(await repo.findApprovedVersionSources()).toEqual([]);
    expect(promptVersion.findMany).not.toHaveBeenCalled();
  });
});
