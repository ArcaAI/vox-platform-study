/**
 * TASK-885 deliverable 5 — a new tenant REFERS to the platform template; it does not receive a
 * COPY of it.
 *
 * Owner #4: *SYSTEM is the template every customer tenant refers to and the tenant template for
 * new tenants.* The distinction between "refers to" and "receives a copy of" is the whole point:
 * a copy is a fork that stops tracking the platform template the moment it is taken, and 200
 * tenants with 200 copies is 200 workflows to fix when the platform template changes.
 *
 * This file pins BOTH halves of the current answer, including the half that is a gap:
 *
 * 1. **No copy.** Tenant provisioning writes departments, configs and catalogues, and NO
 *    `WorkflowDefinition`. Pinned as a source gate (the precedent is
 *    `task-724-stt-realtime-untouched.grep-gate.test.ts`) because the assertion is about what
 *    provisioning does NOT do, which no behavioural test over the current code can observe.
 * 2. **No opinion ⇒ the platform default.** A tenant with no `WorkflowAssignment` row resolves
 *    `platform-default`, which is the two-tier "tenant → platform" rule of
 *    `00-project-context.md` §Configuration Principles expressed for workflows.
 *
 * ⚠ WHAT IS NOT CLOSED, and is recorded in the ticket README as a deferred seam: the cascade in
 * `resolve()` walks `department → tenant` and stops. There is no SYSTEM tier, and
 * `ConsultationWorkflowDispatchService` resolves the chosen slug with a tenant-scoped
 * `findPublishedBySlug`, so a tenant with no opinion today dispatches NOTHING rather than
 * running the SYSTEM template. Closing it is two changes — a SYSTEM tier here and a widened
 * lookup in `consultation/workflow-dispatch` (another lane's folder) — and it CHANGES RUNTIME
 * BEHAVIOUR for every unopinionated tenant the moment a SYSTEM assignment row exists, so it
 * needs an owner decision rather than a quiet fix. The test below states today's behaviour
 * exactly, so that change cannot land unnoticed.
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
    for (const step of ['provisionTenantConfigs', 'provisionDefaultDepartment', 'provisionTenantModelCatalog']) {
      expect(TENANT_SERVICE_SOURCE).toContain(step);
    }

    // The ones that must never appear: any workflow-definition write on the provisioning path.
    for (const forbidden of ['WorkflowDefinitionFactory', 'workflowDefinitionRepository', 'WorkflowDefinitionRepository']) {
      expect(TENANT_SERVICE_SOURCE, `tenant provisioning must not copy workflows (${forbidden})`).not.toContain(forbidden);
    }
  });

  it('a tenant with no assignment row has NO OPINION and resolves the platform default', async () => {
    const assignmentRepository = { findForScope: async () => null };
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
    });
  });
});
