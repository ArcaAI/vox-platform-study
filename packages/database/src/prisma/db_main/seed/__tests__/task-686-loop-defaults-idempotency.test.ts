/**
 * Idempotency of the day-1 context-schema default.
 *
 * The repo-wide guard in `seed-idempotency.test.ts` only covers models whose
 * operator-owned state lives in a column literally called `value`
 * (`GlobalSetting`, `UserSettings`). It does NOT — and structurally cannot —
 * cover what this phase seeds: a whole `ConsultationContextSchema` row whose
 * `definition`, `status`, `pinnedVersionNumber` and `isDefault` are ALL the
 * tenant's.
 *
 * So this file is that guard, and it is behavioural rather than static: it runs
 * the real seed phases against an in-memory fake Prisma client (the
 * `task-641-allowed-origins-seed-corrections.test.ts` precedent — no seed test
 * in this repo touches a live database) and asserts what a SECOND run does to
 * rows a human has since edited.
 *
 * The contract:
 *
 *   context schema      CREATE-ONLY. Never re-created, never updated, and never
 *                       created alongside a default the tenant already owns.
 *
 * The suite used to carry a second contract — FILL-IF-ABSENT for the seven
 * loop-config columns on a seeded `DepartmentAgent`, plus a CREATE-ONLY agent
 * version row. Both went with `DepartmentAgent` (TASK-815); the loop resolves
 * its agent-shaped fields from the tenant's governing `WorkflowDefinition` now,
 * and no seed writes them.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CorePrismaClient } from '../../../../client';
import { seedAgentGoldenLibrary } from '../07a-agent-golden-library';
import { DAY1_CONTEXT_SCHEMAS, seedConsultationLoopDefaults } from '../07e-consultation-loop-defaults';

type Row = Record<string, any>;

/** Minimal in-memory stand-in for the model surfaces the two phases call. */
class FakeTable {
  rows: Row[] = [];
  creates = 0;
  updates = 0;

  matches(row: Row, where: Row): boolean {
    return Object.entries(where).every(([key, value]) => {
      if (key === 'OR') return (value as Row[]).some((clause) => this.matches(row, clause));
      if (value !== null && typeof value === 'object' && 'in' in value) return (value.in as unknown[]).includes(row[key]);
      return row[key] === value;
    });
  }

  async findFirst({ where }: { where: Row; select?: Row }): Promise<Row | null> {
    return this.rows.find((row) => this.matches(row, where)) ?? null;
  }

  async findMany({ where }: { where: Row; select?: Row }): Promise<Row[]> {
    return this.rows.filter((row) => this.matches(row, where));
  }

  async create({ data }: { data: Row }): Promise<Row> {
    this.creates += 1;
    this.rows.push({ ...data });
    return data;
  }

  async upsert({ where, update, create }: { where: Row; update: Row; create: Row }): Promise<Row> {
    const index = this.rows.findIndex((row) => this.matches(row, where));
    if (index === -1) {
      this.creates += 1;
      this.rows.push({ ...create });
      return create;
    }
    this.updates += 1;
    this.rows[index] = { ...this.rows[index], ...update };
    return this.rows[index]!;
  }
}

function fakeClient() {
  const tables = {
    department: new FakeTable(),
    promptTemplate: new FakeTable(),
    promptVersion: new FakeTable(),
    consultationContextSchema: new FakeTable(),
    consultationContextSchemaVersion: new FakeTable(),
  };
  return { tables, client: tables as unknown as CorePrismaClient };
}

describe('day-1 loop defaults are idempotent', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  it('a first seed creates one servable schema per tenant', async () => {
    const { tables, client } = fakeClient();

    await seedAgentGoldenLibrary(client);
    await seedConsultationLoopDefaults(client);

    expect(tables.consultationContextSchema.rows).toHaveLength(DAY1_CONTEXT_SCHEMAS.length);
    expect(tables.consultationContextSchemaVersion.rows).toHaveLength(DAY1_CONTEXT_SCHEMAS.length);
  });

  it('a second seed creates nothing new', async () => {
    const { tables, client } = fakeClient();

    await seedAgentGoldenLibrary(client);
    await seedConsultationLoopDefaults(client);
    const afterFirst = {
      schemas: tables.consultationContextSchema.creates,
      versions: tables.consultationContextSchemaVersion.creates,
    };

    await seedAgentGoldenLibrary(client);
    await seedConsultationLoopDefaults(client);

    expect(tables.consultationContextSchema.creates).toBe(afterFirst.schemas);
    expect(tables.consultationContextSchemaVersion.creates).toBe(afterFirst.versions);
  });

  it("does not revert an operator's edit to the seeded schema", async () => {
    const { tables, client } = fakeClient();
    await seedConsultationLoopDefaults(client);

    const edited = tables.consultationContextSchema.rows[0]!;
    edited.status = 'DRAFT';
    edited.pinnedVersionNumber = null;
    edited.isDefault = false;
    edited.name = 'Renamed by the tenant admin';

    await seedConsultationLoopDefaults(client);

    expect(tables.consultationContextSchema.rows[0]).toMatchObject({
      status: 'DRAFT',
      pinnedVersionNumber: null,
      isDefault: false,
      name: 'Renamed by the tenant admin',
    });
    expect(tables.consultationContextSchema.updates).toBe(0);
  });

  it('never resurrects a schema the tenant soft-deleted', async () => {
    const { tables, client } = fakeClient();
    await seedConsultationLoopDefaults(client);

    for (const row of tables.consultationContextSchema.rows) {
      row.resourceStatus = 'DELETED';
      row.isDefault = false;
    }
    const before = tables.consultationContextSchema.rows.length;

    await seedConsultationLoopDefaults(client);

    expect(tables.consultationContextSchema.rows).toHaveLength(before);
    expect(tables.consultationContextSchema.rows.every((r) => r.resourceStatus === 'DELETED')).toBe(true);
  });

  it("never creates a second default alongside a tenant's own", async () => {
    const { tables, client } = fakeClient();
    const tenantId = DAY1_CONTEXT_SCHEMAS[0]!.tenantId;
    tables.consultationContextSchema.rows.push({
      id: 'tenant-authored-schema',
      tenantId,
      scope: 'TENANT',
      departmentId: null,
      isDefault: true,
      resourceStatus: 'ENABLED',
    });

    await seedConsultationLoopDefaults(client);

    const defaults = tables.consultationContextSchema.rows.filter(
      (r) => r.tenantId === tenantId && r.scope === 'TENANT' && r.departmentId === null && r.isDefault && r.resourceStatus === 'ENABLED',
    );
    expect(defaults).toHaveLength(1);
    expect(defaults[0]!.id).toBe('tenant-authored-schema');
  });

});
