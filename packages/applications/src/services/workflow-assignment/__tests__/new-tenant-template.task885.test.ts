/**
 * TASK-885 deliverable 5, AMENDED BY TASK-890 OD-J — a new tenant is PROVISIONED with a copy of
 * the platform template, and `TenantService` is still not the thing that copies it.
 *
 * TASK-885 asked whether a new tenant should REFER to the platform template or receive a COPY,
 * and deferred the answer. **TASK-890 OD-J answered it: a copy, taken at provisioning.** A
 * workflow definition is CONTENT (§1.5), so SYSTEM holds a reference set rather than a tier, and
 * the "200 tenants, 200 forks" cost this file used to warn about is paid deliberately — with a
 * super-admin re-sync (`POST /admin/tenants/:id/reference-set/sync`) as the way to move a fixed
 * template into the tenants that still carry a pristine copy of it.
 *
 * What this file still pins, and why each half survives that reversal:
 *
 * 1. **`TenantService` is not the copier.** The copy is `TenantReferenceSetService`'s, which is
 *    what keeps the graph rewriting, the provenance stamping and the validation with the service
 *    that owns workflow definitions. A `WorkflowDefinition` write appearing in `tenant.service.ts`
 *    would mean a SECOND copier had grown there. Pinned as a source gate (the precedent is
 *    `task-724-stt-realtime-untouched.grep-gate.test.ts`) because it asserts what a file does NOT
 *    do, which no behavioural test can observe.
 * 2. **No opinion ⇒ no dispatch.** `resolve()` walks `department → tenant` and stops; there is no
 *    SYSTEM tier and OD-J confirms there never will be — the platform default reaches a tenant as
 *    the tenant's own provisioned definition, not as a widened read. The `'platform-default'`
 *    source value here means "nothing assigned", as its own service documents.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { describe, expect, it } from 'vitest';
import { WorkflowAssignmentService } from '../workflow-assignment.service';

const TENANT_SERVICE_SOURCE = readFileSync(join(__dirname, '..', '..', 'tenant', 'tenant.service.ts'), 'utf8');

describe('TASK-885 — a new tenant refers to the SYSTEM template, it does not receive a copy', () => {
  it('tenant provisioning writes NO WorkflowDefinition', () => {
    // The provisioning steps that DO exist, so a future reader can see the gate is not vacuous.
    // (`provisionTenantConfigs` and `provisionTenantModelCatalog` were DELETED by TASK-890
    // OD-P / OD-O — the settings and the catalogue are CONFIG and resolve tenant → SYSTEM at
    // read time rather than being frozen into a per-tenant copy.)
    for (const step of ['provisionDefaultDepartment', 'provisionTenantPipelineCatalog', 'referenceSet']) {
      expect(TENANT_SERVICE_SOURCE).toContain(step);
    }

    // The ones that must never appear IN THIS FILE: a workflow-definition write belongs to
    // `TenantReferenceSetService`, which calls `WorkflowDefinitionService.cloneFromSystem`.
    for (const forbidden of ['WorkflowDefinitionFactory', 'workflowDefinitionRepository', 'WorkflowDefinitionRepository']) {
      expect(TENANT_SERVICE_SOURCE, `tenant provisioning must not copy workflows (${forbidden})`).not.toContain(forbidden);
    }
  });

  it('a tenant with no assignment row has NO OPINION and resolves the platform default', async () => {
    const assignmentRepository = { findForScope: async () => null, findAllForScope: async () => [] };
    const service = new WorkflowAssignmentService(
      assignmentRepository as never,
      { create: () => undefined } as never,
      { findPublishedBySlug: async () => null } as never,
      { findById: () => undefined } as never,
      { baseClient: {} } as never,
      new EventEmitter2(),
      { get: () => undefined } as never,
    );

    await expect(service.resolve('brand-new-tenant', 'consultation', null)).resolves.toEqual({
      workflowDefinitionSlug: null,
      source: 'platform-default',
      selector: [],
    });
  });
});
