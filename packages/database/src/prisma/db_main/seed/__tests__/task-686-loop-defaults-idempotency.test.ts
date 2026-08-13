/**
 * Idempotency of the day-1 loop defaults.
 *
 * The repo-wide guard in `seed-idempotency.test.ts` only covers models whose
 * operator-owned state lives in a column literally called `value`
 * (`GlobalSetting`, `UserSettings`). It does NOT — and structurally cannot —
 * cover what this ticket seeds: a whole `ConsultationContextSchema` row whose
 * `definition`, `status`, `pinnedVersionNumber` and `isDefault` are ALL the
 * tenant's, and seven loop-config columns on `DepartmentAgent` that a tenant
 * admin owns through the console.
 *
 * So this file is that guard, and it is behavioural rather than static: it runs
 * the two real seed phases against an in-memory fake Prisma client (the
 * `task-641-allowed-origins-seed-corrections.test.ts` precedent — no seed test
 * in this repo touches a live database) and asserts what a SECOND run does to
 * rows a human has since edited.
 *
 * The contract:
 *
 *   context schema      CREATE-ONLY. Never re-created, never updated, and never
 *                       created alongside a default the tenant already owns.
 *   agent loop-config   FILL-IF-ABSENT. Written only onto agents carrying no
 *                       loop configuration at all — which is what lets an
 *                       already-seeded database adopt the defaults while leaving
 *                       a configured agent untouched.
 *   agent version row   CREATE-ONLY, and skipped entirely for a configured agent.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CorePrismaClient } from '../../../../client';
import { ARCAAI_TENANT_AGENTS, GLOBAL_TENANT_AGENTS, GOLDEN_AGENTS, seedAgentGoldenLibrary } from '../07a-agent-golden-library';
import { DAY1_AGENT_LOOP_CONFIG, DAY1_CONTEXT_SCHEMAS, seedConsultationLoopDefaults } from '../07e-consultation-loop-defaults';

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
    departmentAgent: new FakeTable(),
    departmentAgentVersion: new FakeTable(),
    consultationContextSchema: new FakeTable(),
    consultationContextSchemaVersion: new FakeTable(),
  };
  return { tables, client: tables as unknown as CorePrismaClient };
}

const ALL_SEEDED_AGENT_IDS = [...GOLDEN_AGENTS, ...GLOBAL_TENANT_AGENTS, ...ARCAAI_TENANT_AGENTS].map((a) => a.id);

describe('day-1 loop defaults are idempotent', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  it('a first seed creates one servable schema per tenant and one loop-config version per agent', async () => {
    const { tables, client } = fakeClient();

    await seedAgentGoldenLibrary(client);
    await seedConsultationLoopDefaults(client);

    expect(tables.consultationContextSchema.rows).toHaveLength(DAY1_CONTEXT_SCHEMAS.length);
    expect(tables.consultationContextSchemaVersion.rows).toHaveLength(DAY1_CONTEXT_SCHEMAS.length);
    expect(tables.departmentAgentVersion.rows).toHaveLength(ALL_SEEDED_AGENT_IDS.length);

    for (const agent of tables.departmentAgent.rows) {
      expect(agent.role).toBe('PRIMARY');
      expect(agent.subscribedKinds).toEqual(DAY1_AGENT_LOOP_CONFIG.subscribedKinds);
    }
  });

  it('a second seed creates nothing new', async () => {
    const { tables, client } = fakeClient();

    await seedAgentGoldenLibrary(client);
    await seedConsultationLoopDefaults(client);
    const afterFirst = {
      schemas: tables.consultationContextSchema.creates,
      versions: tables.consultationContextSchemaVersion.creates,
      agentVersions: tables.departmentAgentVersion.creates,
    };

    await seedAgentGoldenLibrary(client);
    await seedConsultationLoopDefaults(client);

    expect(tables.consultationContextSchema.creates).toBe(afterFirst.schemas);
    expect(tables.consultationContextSchemaVersion.creates).toBe(afterFirst.versions);
    expect(tables.departmentAgentVersion.creates).toBe(afterFirst.agentVersions);
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

  it("does not revert a tenant admin's loop-config edit, and writes no extra version row", async () => {
    const { tables, client } = fakeClient();
    await seedAgentGoldenLibrary(client);

    const agentId = ARCAAI_TENANT_AGENTS[0]!.id;
    const agent = tables.departmentAgent.rows.find((r) => r.id === agentId)!;
    const tenantAuthored = { version: 1, kinds: [{ key: 'work_note' }] };
    agent.subscribedKinds = tenantAuthored;
    const versionsBefore = tables.departmentAgentVersion.rows.length;

    await seedAgentGoldenLibrary(client);

    expect(tables.departmentAgent.rows.find((r) => r.id === agentId)!.subscribedKinds).toEqual(tenantAuthored);
    expect(tables.departmentAgentVersion.rows).toHaveLength(versionsBefore);
  });

  /**
   * The other half of fill-if-absent: an agent row that predates this ticket
   * (all seven columns null, `role` defaulted to SPECIALIST by the DB) MUST pick
   * the defaults up. Without this, every already-seeded environment stays
   * `enabled: false` forever and the ticket only works on a fresh install.
   */
  it('fills an already-seeded agent that carries no loop configuration', async () => {
    const { tables, client } = fakeClient();
    const agent = GOLDEN_AGENTS[0]!;
    tables.departmentAgent.rows.push({
      id: agent.id,
      tenantId: agent.tenantId,
      departmentId: agent.departmentId,
      slug: agent.slug,
      role: 'SPECIALIST',
      subscribedKinds: null,
      writeScope: null,
      goal: null,
      guardrailProfile: null,
      alwaysActions: null,
      neverActions: null,
    });

    await seedAgentGoldenLibrary(client);

    const filled = tables.departmentAgent.rows.find((r) => r.id === agent.id)!;
    expect(filled.role).toBe('PRIMARY');
    expect(filled.subscribedKinds).toEqual(DAY1_AGENT_LOOP_CONFIG.subscribedKinds);
    expect(tables.departmentAgentVersion.rows.some((v) => v.agentId === agent.id)).toBe(true);
  });
});
