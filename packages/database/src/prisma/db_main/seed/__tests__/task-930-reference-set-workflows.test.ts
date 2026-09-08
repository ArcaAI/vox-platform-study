/**
 * TASK-930 §6.3 — phase 26 clones the SYSTEM `workflowDefinitions` and the TENANT-scope
 * `workflowAssignments` into a tenant, re-stamping each frozen artifact for its new owner.
 *
 * The copier cannot recompile (`packages/database` has no contract dependency), so it RE-STAMPS:
 * the trigger's context-schema reference → the tenant's clone, `definitionId` / `tenantId` /
 * `contextSchemaRefs` / `contextSchemaVersionId` → the clone's, checksum recomputed. The proof
 * that a re-stamp is honest is PARITY: the re-stamped artifact must equal what the REAL
 * `compile()` produces for the re-pointed graph in the target tenant — asserted below through
 * the regen script's own `engineOutputFor`.
 */
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { SEED_CUSTOMER_TENANT_IDS, SYSTEM_TENANT_ID, SYSTEM_USER_ID } from '../00-constants';
import { NOTE_CONTEXT_SCHEMAS, NOTE_CONTEXT_SCHEMA_VERSIONS, canonicalJson, noteContextSchemaIdFor } from '../07e-consultation-note-context-schema';
import { cloneId, provisionTenantReferenceSet, restampCompiledConfig } from '../26-tenant-reference-set';
import { CONSULTATION_WORKFLOW_SLUG, WORKFLOW_LIBRARY_ASSIGNMENTS, WORKFLOW_LIBRARY_ASSIGNMENT_CHANGES, WORKFLOW_LIBRARY_TARGETS, workflowLibraryDefinitions } from '../28-workflow-library';
import { REGISTRY_CHECKSUM } from '../28-workflow-library.generated';

// `scripts/` sits outside this package's tsconfig `rootDir`, so the regen script is loaded by
// PATH at runtime — the same posture the retired parity tests used for the contract itself.
// Reusing the script's own `engineOutputFor` is the point: the test and the generator cannot
// drift apart into two different "real" engines.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REGEN_SRC = path.resolve(HERE, '../../../../../scripts/regen-workflow-seeds.ts');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { engineOutputFor }: any = await import(/* @vite-ignore */ REGEN_SRC);

const TENANT = SEED_CUSTOMER_TENANT_IDS.ARCAAI;
type Row = Record<string, any>;

const matches = (row: Row, where: Row | undefined): boolean =>
  Object.entries(where ?? {}).every(([key, expected]) => {
    if (expected !== null && typeof expected === 'object' && !Array.isArray(expected) && 'in' in expected) return (expected.in as unknown[]).includes(row[key]);
    if (expected !== null && typeof expected === 'object' && !Array.isArray(expected) && 'not' in expected) return row[key] !== expected.not;
    return row[key] === expected;
  });

class Table {
  rows: Row[] = [];
  constructor(readonly log: { create: number; update: number }) {}
  findMany({ where }: { where?: Row; orderBy?: Row } = {}) {
    return Promise.resolve(this.rows.filter((row) => matches(row, where)));
  }
  findFirst({ where }: { where?: Row; select?: Row } = {}) {
    return Promise.resolve(this.rows.find((row) => matches(row, where)) ?? null);
  }
  findUnique({ where }: { where: Row; select?: Row }) {
    return this.findFirst({ where });
  }
  create({ data }: { data: Row }) {
    if (this.rows.some((row) => row.id === data.id)) throw new Error(`duplicate primary key ${String(data.id)}`);
    this.log.create += 1;
    const row = { resourceStatus: 'ENABLED', ...data };
    this.rows.push(row);
    return Promise.resolve(row);
  }
  upsert({ where, create, update }: { where: Row; create: Row; update: Row }) {
    const existing = this.rows.find((row) => matches(row, where));
    if (existing) {
      this.log.update += 1;
      Object.assign(existing, update);
      return Promise.resolve(existing);
    }
    return this.create({ data: create });
  }
}

function makeClient() {
  const log = { create: 0, update: 0 };
  const names = [
    'consultationContextSchema',
    'consultationContextSchemaVersion',
    'promptTemplate',
    'promptVersion',
    'agent',
    'agentModelFallback',
    'agentAssignment',
    'documentTemplate',
    'documentTemplateVersion',
    'workflowDefinition',
    'workflowAssignment',
    'workflowAssignmentChange',
    'tenant',
  ] as const;
  const client = Object.fromEntries(names.map((name) => [name, new Table(log)])) as Record<(typeof names)[number], Table>;
  return { client, log };
}

async function seedSystem(client: ReturnType<typeof makeClient>['client']) {
  for (const schema of NOTE_CONTEXT_SCHEMAS) await client.consultationContextSchema.create({ data: schema });
  for (const version of NOTE_CONTEXT_SCHEMA_VERSIONS) await client.consultationContextSchemaVersion.create({ data: version });
  for (const row of workflowLibraryDefinitions().filter((row) => row.tenantId === SYSTEM_TENANT_ID)) await client.workflowDefinition.create({ data: row });
  for (const row of WORKFLOW_LIBRARY_ASSIGNMENTS.filter((row) => row.tenantId === SYSTEM_TENANT_ID)) await client.workflowAssignment.create({ data: row });
  for (const row of WORKFLOW_LIBRARY_ASSIGNMENT_CHANGES.filter((row) => row.tenantId === SYSTEM_TENANT_ID)) await client.workflowAssignmentChange.create({ data: row });
}

const sha256 = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');

describe('phase 26 clones the SYSTEM workflow library into a tenant', () => {
  it('copies both definitions PUBLISHED + active with clone provenance, and re-points the trigger at the tenant`s schema clone', async () => {
    const { client } = makeClient();
    await seedSystem(client);

    const summary = await provisionTenantReferenceSet(client as never, TENANT);

    expect(summary.contextSchemas).toBe(1);
    expect(summary.workflowDefinitions).toBe(2);
    const cloned = client.workflowDefinition.rows.filter((row) => row.tenantId === TENANT);
    expect(cloned.map((row) => row.slug).sort()).toEqual(WORKFLOW_LIBRARY_TARGETS.filter((t) => t.tenantId === SYSTEM_TENANT_ID).map((t) => t.slug).sort());
    const tenantSchemaId = cloneId(TENANT, 'context-schema', noteContextSchemaIdFor(SYSTEM_TENANT_ID));
    const tenantSchema = client.consultationContextSchema.rows.find((row) => row.tenantId === TENANT)!;
    expect(tenantSchema.id).toBe(tenantSchemaId);
    for (const row of cloned) {
      expect(row).toMatchObject({ status: 'PUBLISHED', isActive: true, paletteKey: 'core', versionNumber: 1, sourceTemplateSlug: row.slug, templateLocked: true, createdBy: SYSTEM_USER_ID });
      const trigger = row.graph.nodes.find((node: Row) => node.type === 'core.trigger');
      expect(trigger.config.contextSchema.contextSchemaId).toBe(tenantSchemaId);
      expect(row.graphChecksum).toBe(sha256(row.graph));
      expect(row.compiledConfig).toMatchObject({ definitionId: row.id, tenantId: TENANT, slug: row.slug });
      expect(row.compiledConfigChecksum).toBe(row.compiledConfig.checksum);
      expect(row.registryChecksum).toBe(REGISTRY_CHECKSUM);
    }
  });

  it('PARITY — the re-stamped compiledConfig equals what the real compile() produces for the re-pointed graph in the target tenant', async () => {
    const { client } = makeClient();
    await seedSystem(client);
    await provisionTenantReferenceSet(client as never, TENANT);

    const tenantVersion = client.consultationContextSchemaVersion.rows.find((row) => row.tenantId === TENANT)!;
    for (const row of client.workflowDefinition.rows.filter((candidate) => candidate.tenantId === TENANT)) {
      const source = WORKFLOW_LIBRARY_TARGETS.find((target) => target.tenantId === SYSTEM_TENANT_ID && target.slug === row.slug)!;
      const real = engineOutputFor({ ...source, key: `PARITY:${row.slug}`, id: row.id, tenantId: TENANT, graph: row.graph, contextSchemaVersionId: tenantVersion.id }, REGISTRY_CHECKSUM);
      expect(real.problems).toEqual([]);
      expect(row.compiledConfig).toEqual(real.compiledConfig);
      expect(row.graphChecksum).toBe(real.graphChecksum);
    }
  });

  it('restampCompiledConfig is pure and recomputes the checksum over the contract`s canonical form', () => {
    const system = workflowLibraryDefinitions().find((row) => row.tenantId === SYSTEM_TENANT_ID && row.slug === CONSULTATION_WORKFLOW_SLUG)!;
    const restamped = restampCompiledConfig(system.compiledConfig as Row, { definitionId: 'd', tenantId: 't', schemaId: 's', versionId: 'v' });
    expect(restamped).toMatchObject({ definitionId: 'd', tenantId: 't' });
    expect((restamped.policyBindings as Row).contextSchemaVersionId).toBe('v');
    expect((restamped.policyBindings as Row).contextSchemaRefs).toEqual([{ nodeId: 'n_trigger', schemaId: 's', versionNumber: 1, versionId: 'v' }]);
    const { checksum, ...rest } = restamped;
    expect(checksum).toBe(sha256(rest));
    expect((system.compiledConfig as Row).definitionId).not.toBe('d'); // untouched input
  });

  it('copies the TENANT-scope assignment (with its WORM change row) only when the slug resolves in the tenant, and never over a row the tenant already has', async () => {
    const { client } = makeClient();
    await seedSystem(client);
    const summary = await provisionTenantReferenceSet(client as never, TENANT);
    expect(summary.workflowAssignments).toBe(1);
    const assignment = client.workflowAssignment.rows.find((row) => row.tenantId === TENANT)!;
    expect(assignment).toMatchObject({ scope: 'TENANT', scopeId: null, paletteKey: 'core', workflowDefinitionSlug: CONSULTATION_WORKFLOW_SLUG, selectorKey: '' });
    expect(client.workflowAssignmentChange.rows.filter((row) => row.tenantId === TENANT)).toHaveLength(1);

    // A tenant that already decided (ArcaAI: phase 29's TENANT default) keeps its own row.
    const own = makeClient();
    await seedSystem(own.client);
    await own.client.workflowAssignment.create({ data: { id: 'own', tenantId: TENANT, scope: 'TENANT', scopeId: null, paletteKey: 'core', workflowDefinitionSlug: 'arcaai-gen-consultation', selectorKey: '' } });
    const ownSummary = await provisionTenantReferenceSet(own.client as never, TENANT);
    expect(ownSummary.workflowAssignments).toBe(0);
    expect(own.client.workflowAssignment.rows.filter((row) => row.tenantId === TENANT)).toHaveLength(1);

    // No definition in the tenant → no assignment (a row pointing at nothing looks provisioned).
    const bare = makeClient();
    for (const row of WORKFLOW_LIBRARY_ASSIGNMENTS.filter((r) => r.tenantId === SYSTEM_TENANT_ID)) await bare.client.workflowAssignment.create({ data: row });
    const bareSummary = await provisionTenantReferenceSet(bare.client as never, TENANT);
    expect(bareSummary.workflowDefinitions).toBe(0);
    expect(bareSummary.workflowAssignments).toBe(0);
  });

  it('is CREATE-ONLY and idempotent — a re-run adds nothing and updates nothing', async () => {
    const { client, log } = makeClient();
    await seedSystem(client);
    await provisionTenantReferenceSet(client as never, TENANT);
    const creates = log.create;
    const second = await provisionTenantReferenceSet(client as never, TENANT);
    expect(second.workflowDefinitions).toBe(0);
    expect(second.workflowAssignments).toBe(0);
    expect(log.create).toBe(creates);
    expect(log.update).toBe(0);
  });
});
