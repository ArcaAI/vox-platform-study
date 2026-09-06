/**
 * TASK-890 §3.4 (OD-H / OD-J / OD-M) — provision every non-SYSTEM tenant with the platform
 * REFERENCE SET.
 *
 * ## Why this exists as a seed phase at all
 *
 * The runtime copier is `TenantReferenceSetService` (`@arcaai/applications`), and it runs inside
 * `TenantService.create`, so every tenant created THROUGH THE API is provisioned by
 * construction. The seeded tenants are not created that way: `05-tenant.ts` writes Global and
 * ArcaAI directly. After L13 step v nothing widens a CONTENT read to SYSTEM, so a seeded tenant
 * with no reference set resolves `AGENT_NOT_ASSIGNED` / `PROMPT_DEFAULT_NOT_PROVISIONED` on its
 * first consultation — which is exactly what the whole e2e suite would then report.
 *
 * `pnpm db:seed` and `pnpm test:db:reset` therefore have to leave the seeded tenants provisioned,
 * and they can only do that from here.
 *
 * ## Why it is raw Prisma, and what that costs
 *
 * `packages/database` cannot import `@arcaai/applications` (that is the dependency direction
 * inverted), and the applications service needs a Nest container — Vault, Redis, CLS — that a
 * seed process has no business booting. So this file is a SECOND implementation of the copy, and
 * that is a real, acknowledged cost. Two things bound it:
 *
 *  - it writes the SAME provenance columns the service writes (`sourceAgentId` /
 *    `sourceTenantId` / `sourceSlug` / `sourceVersionNumber`, `sourceTemplateId`,
 *    `sourceTemplateSlug` + `templateLocked`), so proof #9 cannot tell the two apart and the
 *    re-sync route treats a seeded clone exactly like a provisioned one;
 *  - it copies `compiledConfig` VERBATIM rather than recompiling. A compiled artifact is a
 *    frozen snapshot by design (invariant 4): its models are SYSTEM `AiModel` rows, which stay
 *    shared-read (OD-O), and its `resolvedPrompt` carries the prompt CONTENT rather than a
 *    reference — so a copied artifact is servable in the target tenant without re-resolving
 *    anything. That is what makes a raw copy honest here and would not be true of a graph.
 *
 * The one thing it does NOT do is decide anything: the SET it copies, the ORDER it copies in and
 * the provenance it stamps all mirror `TenantReferenceSetService`.
 *
 * ## Idempotency
 *
 * Every clone's id is DERIVED from `(targetTenantId, sourceId)`, so a re-seed addresses the same
 * row and `create`-only semantics make the phase a no-op on the second run. Nothing is updated:
 * a tenant that has edited its copy keeps the edit.
 */
import { createHash } from 'node:crypto';
import type { CorePrismaClient } from '../../../client';
import { SYSTEM_TENANT_ID, SYSTEM_USER_ID } from './00-constants';
import { LEGACY_CONTEXT_SCHEMA_SLUG } from './07g-consultation-legacy-context-schema';

/** Per-tenant, per-kind counts — the same shape the service's summary reports. */
export interface ReferenceSetSeedSummary {
  tenantId: string;
  contextSchemas: number;
  promptTemplates: number;
  agents: number;
  agentAssignments: number;
}

/**
 * A STABLE id for the clone of `sourceId` in `tenantId`.
 *
 * Derived rather than random so the phase is idempotent by primary key: a re-seed writes the
 * same id, the create is refused as a duplicate, and nothing is overwritten. The shape is a
 * valid UUID (version nibble forced to 8, variant to 8) so it is indistinguishable from any
 * other id at the type level while never colliding with a generated UUIDv7.
 */
function cloneId(tenantId: string, kind: string, sourceId: string): string {
  const hex = createHash('sha256').update(`task-890:${kind}:${tenantId}:${sourceId}`).digest('hex');
  return [hex.slice(0, 8), hex.slice(8, 12), `8${hex.slice(13, 16)}`, `8${hex.slice(17, 20)}`, hex.slice(20, 32)].join('-');
}

/** Clone the SYSTEM legacy-bridge context schema (and its pinned version) into one tenant. */
async function copyContextSchemas(client: CorePrismaClient, tenantId: string): Promise<number> {
  const sources = await client.consultationContextSchema.findMany({
    where: { tenantId: SYSTEM_TENANT_ID, resourceStatus: 'ENABLED' },
  });
  let added = 0;
  for (const source of sources) {
    const existing = await client.consultationContextSchema.findFirst({
      where: { tenantId, slug: source.slug, resourceStatus: 'ENABLED' },
      select: { id: true },
    });
    if (existing) continue;

    const version =
      source.pinnedVersionNumber === null
        ? null
        : await client.consultationContextSchemaVersion.findFirst({
            where: { schemaId: source.id, versionNumber: source.pinnedVersionNumber },
          });
    // An unpinned source would clone into an unservable row that discovery silently skips —
    // the same refusal `ConsultationContextSchemaService.cloneFromSystem` makes.
    if (!version) continue;

    const id = cloneId(tenantId, 'context-schema', source.id);
    await client.consultationContextSchema.create({
      data: {
        id,
        tenantId,
        slug: source.slug,
        name: source.name,
        description: source.description,
        // A DEPARTMENT-scoped reference cannot cross a tenant boundary (the department ids
        // differ), so the reference set carries TENANT-scoped schemas only.
        scope: 'TENANT',
        departmentId: null,
        status: source.status,
        pinnedVersionNumber: 1,
        isDefault: source.isDefault,
        sourceTemplateSlug: source.slug,
        templateLocked: true,
        createdBy: SYSTEM_USER_ID,
      },
    });
    await client.consultationContextSchemaVersion.create({
      data: {
        id: cloneId(tenantId, 'context-schema-version', version.id),
        tenantId,
        schemaId: id,
        // The clone's history restarts at 1: a tenant's version lineage is its own.
        versionNumber: 1,
        definition: version.definition as never,
        checksum: version.checksum,
        changeReason: 'Provisioned from the platform reference set',
        createdBy: SYSTEM_USER_ID,
      },
    });
    added += 1;
  }
  return added;
}

/** Clone the SYSTEM prompt library into one tenant, stamping `sourceTemplateId`. */
async function copyPromptTemplates(client: CorePrismaClient, tenantId: string): Promise<number> {
  const sources = await client.promptTemplate.findMany({
    where: { tenantId: SYSTEM_TENANT_ID, resourceStatus: 'ENABLED', scope: { not: 'USER_PERSONAL' } },
  });
  let added = 0;
  for (const source of sources) {
    const byProvenance = await client.promptTemplate.findFirst({
      where: { tenantId, sourceTemplateId: source.id, resourceStatus: 'ENABLED' },
      select: { id: true },
    });
    if (byProvenance) continue;
    // `(tenantId, name)` is how the authoring path addresses a template, so a tenant that
    // already owns that name keeps it rather than gaining a second row it cannot tell apart.
    const byName = await client.promptTemplate.findFirst({
      where: { tenantId, name: source.name, resourceStatus: 'ENABLED' },
      select: { id: true },
    });
    if (byName) continue;

    // The APPROVED snapshot, not the mutable column — the same content the runtime serves.
    const approved =
      source.approvedVersionNumber === null
        ? null
        : await client.promptVersion.findFirst({ where: { promptTemplateId: source.id, versionNumber: source.approvedVersionNumber } });
    const content = approved?.content ?? source.content;
    const variables = (approved?.variables ?? source.variables) as never;

    const id = cloneId(tenantId, 'prompt-template', source.id);
    await client.promptTemplate.create({
      data: {
        id,
        tenantId,
        name: source.name,
        description: source.description,
        content,
        category: source.category,
        status: source.status,
        variables,
        currentVersionNumber: 1,
        approvedVersionNumber: source.status === 'APPROVED' ? 1 : null,
        departmentId: null,
        sourceTemplateId: source.id,
        templateLocked: true,
        scope: 'TENANT_DEFAULT',
        ownerUserId: null,
        createdBy: SYSTEM_USER_ID,
      },
    });
    await client.promptVersion.create({
      data: {
        id: cloneId(tenantId, 'prompt-version', source.id),
        tenantId,
        promptTemplateId: id,
        versionNumber: 1,
        content,
        variables,
        changeReason: 'Provisioned from the platform reference set',
        changedBy: SYSTEM_USER_ID,
      },
    });
    added += 1;
  }
  return added;
}

/**
 * Clone every PUBLISHED + ACTIVE SYSTEM agent into one tenant, PUBLISHED and ACTIVE.
 *
 * A DRAFT reference set would leave the tenant's assignments pointing at a slug
 * `findPublishedActiveBySlug` cannot serve — the fail-closed hole provisioning exists to
 * prevent. `compiledConfig` travels verbatim (see the file header for why that is sound); the
 * prompt binding in `instruction` is re-pointed at the tenant's own clone when it has one.
 */
async function copyAgents(client: CorePrismaClient, tenantId: string): Promise<number> {
  const sources = await client.agent.findMany({
    where: { tenantId: SYSTEM_TENANT_ID, status: 'PUBLISHED', isActive: true, resourceStatus: 'ENABLED' },
    orderBy: { slug: 'asc' },
  });
  let added = 0;
  for (const source of sources) {
    const existing = await client.agent.findFirst({ where: { tenantId, slug: source.slug }, select: { id: true } });
    if (existing) continue;

    let instruction = source.instruction as Record<string, unknown> | null;
    const boundTemplateId = typeof instruction?.['promptTemplateId'] === 'string' ? (instruction['promptTemplateId'] as string) : null;
    if (boundTemplateId) {
      const clone = await client.promptTemplate.findFirst({
        where: { tenantId, sourceTemplateId: boundTemplateId, resourceStatus: 'ENABLED' },
        select: { id: true, approvedVersionNumber: true },
      });
      if (clone) {
        instruction = { ...instruction, promptTemplateId: clone.id };
        // The clone's version lineage restarts at 1, so the SOURCE's pin numbers a version the
        // target does not have.
        if (clone.approvedVersionNumber === null) delete (instruction as Record<string, unknown>)['promptVersionNumber'];
        else (instruction as Record<string, unknown>)['promptVersionNumber'] = clone.approvedVersionNumber;
      }
    }

    const id = cloneId(tenantId, 'agent', source.id);
    await client.agent.create({
      data: {
        id,
        tenantId,
        slug: source.slug,
        name: source.name,
        description: source.description,
        task: source.task,
        versionNumber: 1,
        parentVersionId: null,
        sourceAgentId: source.id,
        sourceTenantId: source.tenantId,
        sourceSlug: source.slug,
        sourceVersionNumber: source.versionNumber,
        status: 'PUBLISHED',
        isActive: true,
        modelId: source.modelId,
        // A context pin cannot travel by id; the clone's own schema is bound by the console when
        // the tenant edits the agent. (The runtime reads the FROZEN snapshot in `compiledConfig`.)
        contextSchemaId: null,
        contextSchemaVersionNumber: null,
        instruction: instruction as never,
        parameters: source.parameters as never,
        inputSchema: source.inputSchema as never,
        outputSchema: source.outputSchema as never,
        tools: source.tools as never,
        compiledConfig: source.compiledConfig as never,
        compiledConfigChecksum: source.compiledConfigChecksum,
        validationReport: source.validationReport as never,
        validatedAt: source.validatedAt,
        publishedAt: new Date(),
        // The platform's tags assert something about the PLATFORM's row, not a tenant's copy.
        tags: [],
        createdBy: SYSTEM_USER_ID,
      },
    });

    const fallbacks = await client.agentModelFallback.findMany({ where: { agentId: source.id, resourceStatus: 'ENABLED' } });
    for (const link of fallbacks) {
      await client.agentModelFallback.create({
        data: {
          id: cloneId(tenantId, 'agent-fallback', link.id),
          tenantId,
          agentId: id,
          priority: link.priority,
          modelId: link.modelId,
          enabled: link.enabled,
          createdBy: SYSTEM_USER_ID,
        },
      });
    }
    added += 1;
  }
  return added;
}

/**
 * One TENANT-scope assignment per SYSTEM TENANT-scope assignment.
 *
 * This is what REPLACES the cascade's SYSTEM tier (OD-M): `AgentAssignmentService.resolve` walks
 * department → tenant and stops, so the platform default has to exist AS the tenant's own row.
 * An assignment is only written when the slug actually resolves in the tenant — a row pointing
 * at nothing is worse than no row, because it looks provisioned.
 */
async function copyAgentAssignments(client: CorePrismaClient, tenantId: string): Promise<number> {
  const sources = await client.agentAssignment.findMany({
    where: { tenantId: SYSTEM_TENANT_ID, scope: 'TENANT', resourceStatus: 'ENABLED' },
  });
  let added = 0;
  for (const source of sources) {
    const existing = await client.agentAssignment.findFirst({
      where: { tenantId, scope: 'TENANT', scopeId: null, task: source.task, selectorKey: source.selectorKey, resourceStatus: 'ENABLED' },
      select: { id: true },
    });
    if (existing) continue;

    const resolvable = await client.agent.findFirst({
      where: { tenantId, slug: source.agentSlug, task: source.task, status: 'PUBLISHED', isActive: true, resourceStatus: 'ENABLED' },
      select: { id: true },
    });
    if (!resolvable) continue;

    await client.agentAssignment.create({
      data: {
        id: cloneId(tenantId, 'agent-assignment', source.id),
        tenantId,
        scope: 'TENANT',
        scopeId: null,
        task: source.task,
        agentSlug: source.agentSlug,
        selectorKey: source.selectorKey,
        createdBy: SYSTEM_USER_ID,
      },
    });
    added += 1;
  }
  return added;
}

/**
 * Provision ONE tenant, in the order the runtime requires: schemas, prompts, agents (whose
 * instruction is re-pointed at the prompt clones), then the assignments that name them.
 *
 * Workflow definitions are deliberately NOT copied here. `WorkflowAssignmentService.resolve` has
 * no SYSTEM tier and never had one, so a tenant without a definition behaves exactly as it does
 * today — the legacy dispatch path — and the copy buys nothing the seeded tenants need. The
 * runtime service does copy them (a tenant admin gets something to publish), and the re-sync
 * route adds them to a seeded tenant on request.
 */
export async function provisionTenantReferenceSet(client: CorePrismaClient, tenantId: string): Promise<ReferenceSetSeedSummary> {
  if (!tenantId || tenantId === SYSTEM_TENANT_ID) {
    throw new Error('The SYSTEM tenant is the reference set; it cannot be provisioned from itself.');
  }
  const contextSchemas = await copyContextSchemas(client, tenantId);
  const promptTemplates = await copyPromptTemplates(client, tenantId);
  const agents = await copyAgents(client, tenantId);
  const agentAssignments = await copyAgentAssignments(client, tenantId);
  return { tenantId, contextSchemas, promptTemplates, agents, agentAssignments };
}

/** Every non-SYSTEM tenant that exists — the seed population, plus anything created since. */
export async function provisionAllTenantReferenceSets(client: CorePrismaClient): Promise<ReferenceSetSeedSummary[]> {
  const tenants = await client.tenant.findMany({
    where: { id: { not: SYSTEM_TENANT_ID }, resourceStatus: 'ENABLED' },
    select: { id: true, key: true },
    orderBy: { key: 'asc' },
  });
  const summaries: ReferenceSetSeedSummary[] = [];
  for (const tenant of tenants) {
    if (tenant.id === SYSTEM_TENANT_ID) continue;
    summaries.push(await provisionTenantReferenceSet(client, tenant.id));
  }
  return summaries;
}

export const seedTenantReferenceSets = async (client: CorePrismaClient): Promise<void> => {
  console.log('Provisioning the SYSTEM reference set into every tenant...');
  const summaries = await provisionAllTenantReferenceSets(client);
  for (const summary of summaries) {
    console.log(
      `  ${summary.tenantId}: +${summary.contextSchemas} context schema(s), +${summary.promptTemplates} prompt template(s), ` +
        `+${summary.agents} agent(s), +${summary.agentAssignments} assignment(s)`,
    );
  }
  if (summaries.length === 0) console.log('  (no non-SYSTEM tenants to provision)');
  console.log(`Reference set provisioned for ${summaries.length} tenant(s). Bridge schema slug: ${LEGACY_CONTEXT_SCHEMA_SLUG}`);
};
