/**
 * TASK-891 — document templates are provisioned by phase 26, exactly once.
 *
 * `tenant-reference-set-parity.contract.test.ts` is a SOURCE-TEXT guard: it proves the seed and
 * `TenantReferenceSetService` copy the same KIND SET in the same ORDER. It cannot prove what the
 * seed copier does when it runs. This file does, against an in-memory stand-in for the raw Prisma
 * client, and it pins the three properties the fold had to preserve:
 *
 *  1. phase 26 provisions document templates at all, and LAST — the position the runtime service
 *     gives them, because a workflow node's `documentTemplateId` is re-pointed by slug in the
 *     target tenant and the template has to be there first;
 *  2. the copy is CREATE-ONLY and idempotent — a re-seed adds nothing and overwrites nothing, so
 *     a tenant's edited row survives;
 *  3. phase 27 no longer clones into tenants, so the two phases cannot double-provision.
 *
 * The stand-in throws on a duplicate `(tenantId, slug)` exactly as `@@unique([tenantId, slug])`
 * does, so a second create is a test FAILURE rather than a silently absorbed no-op.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { SYSTEM_TENANT_ID } from '../00-constants';
import { provisionTenantReferenceSet } from '../26-tenant-reference-set';
import { DOCUMENT_TEMPLATE_LIBRARY, seedDocumentTemplateLibrary } from '../27-document-template-library';

const TENANT = '50000000-0000-0000-0000-000000000000';

type Row = Record<string, unknown>;

/** Equality, plus the two operators the seed's `where` clauses actually use. */
function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, expected]) => {
    if (expected !== null && typeof expected === 'object' && !Array.isArray(expected)) {
      const clause = expected as Row;
      if ('not' in clause) return row[key] !== clause['not'];
      throw new Error(`unsupported where operator on ${key}: ${JSON.stringify(clause)}`);
    }
    return row[key] === expected;
  });
}

/** Counts every write the seed performs, so "create-only" is measured, not asserted. */
interface WriteLog {
  create: number;
  update: number;
  upsert: number;
}

class Table {
  readonly rows: Row[] = [];
  constructor(
    private readonly name: string,
    private readonly log: WriteLog,
    /** The model's real uniqueness, so a double-provision throws here as it would in Postgres. */
    private readonly unique: readonly string[] | null = null,
  ) {}

  findMany({ where, orderBy }: { where?: Row; orderBy?: Row } = {}): Promise<Row[]> {
    const found = this.rows.filter((row) => matches(row, where));
    if (orderBy) {
      const [[key, direction]] = Object.entries(orderBy) as [[string, string]][number][];
      found.sort((a, b) => String(a[key]).localeCompare(String(b[key])) * (direction === 'desc' ? -1 : 1));
    }
    return Promise.resolve(found);
  }

  findFirst({ where, select }: { where?: Row; select?: Row } = {}): Promise<Row | null> {
    const row = this.rows.find((candidate) => matches(candidate, where)) ?? null;
    if (!row || !select) return Promise.resolve(row);
    return Promise.resolve(Object.fromEntries(Object.keys(select).map((key) => [key, row[key]])));
  }

  create({ data }: { data: Row }): Promise<Row> {
    this.log.create += 1;
    if (this.rows.some((row) => row['id'] === data['id'])) {
      throw new Error(`${this.name}: duplicate primary key ${String(data['id'])}`);
    }
    if (this.unique && this.rows.some((row) => this.unique!.every((key) => row[key] === data[key]))) {
      throw new Error(`${this.name}: unique constraint violated on (${this.unique.join(', ')})`);
    }
    const row = { resourceStatus: 'ENABLED', ...data };
    this.rows.push(row);
    return Promise.resolve(row);
  }

  async upsert({ where, create, update }: { where: Row; create: Row; update: Row }): Promise<Row> {
    const existing = this.rows.find((row) => matches(row, where));
    if (!existing) {
      this.log.upsert += 1;
      const row = { resourceStatus: 'ENABLED', ...create };
      this.rows.push(row);
      return row;
    }
    this.log.upsert += 1;
    this.log.update += 1;
    Object.assign(existing, update);
    return existing;
  }
}

function makeClient() {
  const log: WriteLog = { create: 0, update: 0, upsert: 0 };
  const client = {
    consultationContextSchema: new Table('consultationContextSchema', log),
    consultationContextSchemaVersion: new Table('consultationContextSchemaVersion', log),
    promptTemplate: new Table('promptTemplate', log),
    promptVersion: new Table('promptVersion', log),
    agent: new Table('agent', log),
    agentModelFallback: new Table('agentModelFallback', log),
    agentAssignment: new Table('agentAssignment', log),
    documentTemplate: new Table('documentTemplate', log, ['tenantId', 'slug']),
    documentTemplateVersion: new Table('documentTemplateVersion', log),
    tenant: new Table('tenant', log),
  };
  return { client, log };
}

type FakeClient = ReturnType<typeof makeClient>['client'];

/** The SYSTEM library as phase 27 leaves it: PUBLISHED, pinned at v1. */
async function seedSystemDocumentTemplates(client: FakeClient): Promise<void> {
  for (const item of DOCUMENT_TEMPLATE_LIBRARY) {
    await client.documentTemplate.create({
      data: {
        id: item.id,
        tenantId: SYSTEM_TENANT_ID,
        slug: item.slug,
        name: item.name,
        description: item.description,
        status: 'PUBLISHED',
        pinnedVersionNumber: 1,
        isDefault: false,
        sourceTemplateSlug: null,
        templateLocked: false,
      },
    });
    await client.documentTemplateVersion.create({
      data: {
        id: item.versionId,
        tenantId: SYSTEM_TENANT_ID,
        templateId: item.id,
        versionNumber: 1,
        shape: item.shape,
        compiled: item.compiled,
        compilerVersion: '1.0.0',
        checksum: item.checksum,
      },
    });
  }
}

describe('phase 26 provisions the SYSTEM document-template library into a tenant', () => {
  let client: FakeClient;
  let log: WriteLog;

  beforeEach(async () => {
    ({ client, log } = makeClient());
    await seedSystemDocumentTemplates(client);
  });

  it('copies every SYSTEM template and reports the count in the summary', async () => {
    const summary = await provisionTenantReferenceSet(client as never, TENANT);

    expect(summary.documentTemplates).toBe(DOCUMENT_TEMPLATE_LIBRARY.length);
    const cloned = client.documentTemplate.rows.filter((row) => row['tenantId'] === TENANT);
    expect(cloned.map((row) => row['slug']).sort()).toEqual(DOCUMENT_TEMPLATE_LIBRARY.map((item) => item.slug).sort());
  });

  it('stamps the provenance the runtime clone stamps, and never the tenant default', async () => {
    await provisionTenantReferenceSet(client as never, TENANT);

    for (const row of client.documentTemplate.rows.filter((candidate) => candidate['tenantId'] === TENANT)) {
      expect(row['sourceTemplateSlug']).toBe(row['slug']);
      expect(row['templateLocked']).toBe(true);
      expect(row['isDefault']).toBe(false);
      expect(row['status']).toBe('PUBLISHED');
      expect(row['pinnedVersionNumber']).toBe(1);
    }
  });

  it("carries the pinned version's frozen artifacts verbatim, restarting the lineage at 1", async () => {
    await provisionTenantReferenceSet(client as never, TENANT);

    for (const item of DOCUMENT_TEMPLATE_LIBRARY) {
      const template = client.documentTemplate.rows.find((row) => row['tenantId'] === TENANT && row['slug'] === item.slug)!;
      const version = client.documentTemplateVersion.rows.find(
        (row) => row['tenantId'] === TENANT && row['templateId'] === template['id'],
      )!;
      expect(version['versionNumber']).toBe(1);
      expect(version['checksum']).toBe(item.checksum);
      expect(version['compiled']).toEqual(item.compiled);
      expect(version['compilerVersion']).toBe('1.0.0');
    }
  });

  it('is CREATE-ONLY and idempotent — a re-seed adds nothing and updates nothing', async () => {
    const first = await provisionTenantReferenceSet(client as never, TENANT);
    const rowsAfterFirst = client.documentTemplate.rows.length;
    const versionsAfterFirst = client.documentTemplateVersion.rows.length;

    const second = await provisionTenantReferenceSet(client as never, TENANT);

    expect(first.documentTemplates).toBeGreaterThan(0);
    expect(second.documentTemplates).toBe(0);
    expect(client.documentTemplate.rows).toHaveLength(rowsAfterFirst);
    expect(client.documentTemplateVersion.rows).toHaveLength(versionsAfterFirst);
    expect(log.update).toBe(0);
    expect(log.upsert).toBe(0);
  });

  it("never overwrites a tenant's own edit of a provisioned row", async () => {
    await provisionTenantReferenceSet(client as never, TENANT);
    const edited = client.documentTemplate.rows.find((row) => row['tenantId'] === TENANT)!;
    edited['name'] = 'Renamed by the tenant admin';
    edited['templateLocked'] = false;

    await provisionTenantReferenceSet(client as never, TENANT);

    expect(edited['name']).toBe('Renamed by the tenant admin');
    expect(edited['templateLocked']).toBe(false);
  });

  it('treats a SOFT-DELETED tenant row as still occupying the slug — `@@unique` is absolute', async () => {
    await provisionTenantReferenceSet(client as never, TENANT);
    for (const row of client.documentTemplate.rows.filter((candidate) => candidate['tenantId'] === TENANT)) {
      row['resourceStatus'] = 'DELETED';
    }

    // A probe filtered on ENABLED would try to create over the soft-deleted row, and the fake
    // raises the same unique violation Postgres would.
    const summary = await provisionTenantReferenceSet(client as never, TENANT);
    expect(summary.documentTemplates).toBe(0);
  });

  it('skips an unpinned SYSTEM row rather than cloning something unservable', async () => {
    for (const row of client.documentTemplate.rows) row['pinnedVersionNumber'] = null;

    const summary = await provisionTenantReferenceSet(client as never, TENANT);

    expect(summary.documentTemplates).toBe(0);
    expect(client.documentTemplate.rows.filter((row) => row['tenantId'] === TENANT)).toHaveLength(0);
  });

  it('refuses the SYSTEM tenant — it IS the reference set', async () => {
    await expect(provisionTenantReferenceSet(client as never, SYSTEM_TENANT_ID)).rejects.toThrow(
      /cannot be provisioned from itself/,
    );
  });
});

describe('phase 27 seeds the SOURCE rows only, so the two phases cannot double-provision', () => {
  it('writes nothing into a non-SYSTEM tenant', async () => {
    const { client } = makeClient();
    await client.tenant.create({ data: { id: TENANT, key: 'global', resourceStatus: 'ENABLED' } });

    await seedDocumentTemplateLibrary(client as never);

    expect(client.documentTemplate.rows.every((row) => row['tenantId'] === SYSTEM_TENANT_ID)).toBe(true);
    expect(client.documentTemplateVersion.rows.every((row) => row['tenantId'] === SYSTEM_TENANT_ID)).toBe(true);
  });

  it('leaves phase 26 as the only path from the SYSTEM library into a tenant', async () => {
    const { client } = makeClient();
    await client.tenant.create({ data: { id: TENANT, key: 'global', resourceStatus: 'ENABLED' } });

    await seedDocumentTemplateLibrary(client as never);
    expect(client.documentTemplate.rows.filter((row) => row['tenantId'] === TENANT)).toHaveLength(0);

    const summary = await provisionTenantReferenceSet(client as never, TENANT);
    expect(summary.documentTemplates).toBe(DOCUMENT_TEMPLATE_LIBRARY.length);
  });
});
