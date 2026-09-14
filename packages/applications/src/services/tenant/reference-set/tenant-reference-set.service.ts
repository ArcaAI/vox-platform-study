import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import {
  AgentAssignmentRepository,
  AgentRepository,
  AgentTask,
  ConsultationContextSchemaRepository,
  CoreDatabaseService,
  DocumentTemplateRepository,
  DocumentTemplateVersionRepository,
  PipelinePolicyScope,
  PromptTemplateRepository,
  ResourceType,
  SYSTEM_TENANT_ID,
  SysEventType,
  WorkflowAssignmentRepository,
  WorkflowDefinitionRepository,
} from '@arcaai/domains';
import { BaseService } from '../../../common';
import { IActiveUserContext } from '../../../interfaces';
import { runInTenantContext } from '../../agentPromotion/tenant-context';
import { IAgentService } from '../../agent/IAgentService';
import { isPlatformHiddenAgentSlug } from '../../agent/platform-hidden-agents';
import { IAgentAssignmentService } from '../../agent-assignment/IAgentAssignmentService';
import type { IAgentAssignmentService as IAgentAssignmentServicePort } from '../../agent-assignment/IAgentAssignmentService';
import { IConsultationContextSchemaService } from '../../consultation-context-schema/IConsultationContextSchemaService';
import { IDocumentTemplateService } from '../../document-template/IDocumentTemplateService';
import { IPromptManagementService } from '../../prompt-management/IPromptManagementService';
import { IWorkflowAssignmentService } from '../../workflow-assignment/IWorkflowAssignmentService';
import { IWorkflowDefinitionService } from '../../workflow-definition/IWorkflowDefinitionService';
import {
  ITenantReferenceSetService,
  REFERENCE_SET_KINDS,
  type ReferenceSetKind,
  type ReferenceSetKindOutcome,
  type ReferenceSetSummary,
  type ReferenceSetSyncMode,
  type ReferenceSetSyncOptions,
} from './ITenantReferenceSetService';

/**
 * The five collaborators, narrowed to the method(s) this service needs of each.
 *
 * Declared here rather than widened onto `IAgentService` / `IPromptManagementService` /
 * `IWorkflowDefinitionService`, because a port should say what its CONSUMER requires: this
 * service is a caller of the clone machinery, and the clone machinery's public contract is not
 * changed by provisioning existing. The symbol tokens are unchanged, so DI is unaffected.
 */
interface AgentClonePort {
  cloneFromSystem(slug: string, targetTenantId: string): Promise<{ agentId: string; created: boolean; warnings: string[] }>;
}
interface PromptClonePort {
  cloneFromSystem(
    systemTemplateId: string,
    targetTenantId: string,
  ): Promise<{ templateId: string; created: boolean; approvedVersionNumber: number | null }>;
}
interface WorkflowClonePort {
  cloneFromSystem(slug: string, targetTenantId: string): Promise<{ definitionId: string; created: boolean }>;
}
/**
 * TASK-930 §6.3 — the assignment WRITE goes through the owning service, not the repository, so
 * the checks that make an assignment meaningful (the palette is registered, the slug resolves to
 * a PUBLISHED definition in THIS tenant, the WORM change row) run exactly once, where they live.
 */
interface WorkflowAssignmentWritePort {
  upsert(dto: {
    scope: PipelinePolicyScope;
    scopeId?: string | null;
    paletteKey: string;
    workflowDefinitionSlug: string;
    selectorTags?: string[];
    reason?: string;
  }): Promise<unknown>;
}

interface ContextSchemaClonePort {
  cloneFromSystem(slug: string, tenantId: string): Promise<{ id: string }>;
}
/**
 * `DocumentTemplateService` has no `cloneFromSystem`, so this is the only port assembled from
 * the owning service's ORDINARY surface rather than from a bespoke clone method. It is the same
 * two steps `ConsultationContextSchemaService.cloneFromSystem` performs internally — create the
 * head, then publish v1 from the source's pinned shape — run here instead, under the target
 * tenant's context. Reusing `create` + `publish` rather than writing rows directly is what keeps
 * shape validation, compilation, the pin move and the single-default rule in ONE place.
 */
interface DocumentTemplateClonePort {
  create(dto: {
    slug: string;
    name: string;
    description?: string;
    isDefault?: boolean;
    sourceTemplateSlug?: string;
    templateLocked?: boolean;
  }): Promise<{ id: string }>;
  publish(id: string, dto: { shape: Record<string, unknown>; changeReason?: string }): Promise<unknown>;
}

const EMPTY: ReferenceSetKindOutcome = { added: 0, skipped: 0, failed: 0 };

/**
 * A DELIBERATE refusal (4xx) rather than a failure.
 *
 * The clone paths answer 400/409 for a source that CANNOT be copied — a platform workflow
 * template pinning platform-owned catalogue rows is the live case. Recording that as a failure
 * would make a healthy provisioning run report an error for something that can never succeed,
 * which is how a summary stops being read.
 */
function isRefusal(error: unknown): boolean {
  const status = (error as { getStatus?: () => number })?.getStatus?.();
  return typeof status === 'number' && status >= 400 && status < 500;
}

/**
 * TASK-890 §3.4 — clone the SYSTEM REFERENCE SET into a tenant.
 *
 * ## Why a service and not five call sites
 *
 * The six kinds are ORDERED, and the order carries meaning rather than convenience: an agent's
 * instruction is re-pointed at the tenant's prompt clone, so prompts precede agents; an
 * assignment names a slug that must already resolve to a PUBLISHED agent in the tenant, so
 * agents precede assignments; a workflow's generation node binds a document template by ROW ID
 * that the clone re-points by slug, so document templates precede workflow definitions.
 * Spreading that across `TenantService.create` would make the order an accident of statement
 * sequence.
 *
 * ## What it is NOT
 *
 * It is not a copier. Every kind is copied by the service that OWNS that kind
 * (`cloneFromSystem` on each), which is what keeps the provenance stamping, the reference
 * rewriting and the publish gates in one place per kind instead of two. This service decides
 * WHICH rows and IN WHAT ORDER, and reports what happened.
 *
 * ## Failure posture
 *
 * Per-row isolation, exactly like the `provisionTenant*` steps it joins and the pipeline
 * resync it copies: one bad row never aborts the rest, and never aborts tenant creation. Every
 * failure lands in `warnings` and in the log with the tenant, the kind and the key — a tenant
 * missing a kind is a REPORT, not a silence, and proof #9 (§4.4) is what gates the flip on it.
 *
 * ## Tenant context
 *
 * Callers run this with an elevated, tenant-less context (a super admin on the re-sync route, no
 * CLS at all in the backfill) or with CLS bound to the tenant being created. Neither is relied
 * on: every step NAMES its tenant through `runInTenantContext`, the membership-bounded
 * discipline (`syncToTenants`), so the tenant-scope extension filters each read and write
 * exactly as it would an ordinary single-tenant request.
 */
@Injectable()
export class TenantReferenceSetService extends BaseService implements ITenantReferenceSetService {
  private readonly logger = new Logger(TenantReferenceSetService.name);

  constructor(
    private readonly agentRepository: AgentRepository,
    private readonly promptTemplateRepository: PromptTemplateRepository,
    private readonly assignmentRepository: AgentAssignmentRepository,
    private readonly workflowDefinitionRepository: WorkflowDefinitionRepository,
    private readonly workflowAssignmentRepository: WorkflowAssignmentRepository,
    private readonly contextSchemaRepository: ConsultationContextSchemaRepository,
    private readonly documentTemplateRepository: DocumentTemplateRepository,
    private readonly documentTemplateVersionRepository: DocumentTemplateVersionRepository,
    @Inject('CORE_DATABASE_SERVICE') private readonly databaseService: CoreDatabaseService,
    /**
     * The five kind-owning services are resolved from the CONTAINER at call time rather than
     * injected, because importing their modules here closes a pre-existing module cycle that
     * stops the gateway booting (see this module's doc comment). `strict: false` looks the token
     * up across the whole application, which is exactly right: this service does not care WHICH
     * module provides the copier, only that one is registered.
     */
    private readonly moduleRef: ModuleRef,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
  ) {
    super(eventEmitter, clsService, ResourceType.Tenant);
  }

  /** One collaborator, or `undefined` when the host app did not register it — a WARNING, never a throw. */
  private port<T>(token: symbol | (abstract new (...args: never[]) => unknown)): T | undefined {
    try {
      return this.moduleRef.get<T>(token as never, { strict: false });
    } catch {
      return undefined;
    }
  }

  async provision(tenantId: string): Promise<ReferenceSetSummary> {
    return this.run(tenantId, 'missing-only', REFERENCE_SET_KINDS);
  }

  async resync(tenantId: string, options?: ReferenceSetSyncOptions): Promise<ReferenceSetSummary> {
    const kinds = options?.kinds?.length ? options.kinds : REFERENCE_SET_KINDS;
    return this.run(tenantId, options?.mode ?? 'missing-only', kinds);
  }

  // -------------------------------------------------------------------------
  // The run
  // -------------------------------------------------------------------------

  private async run(tenantId: string, mode: ReferenceSetSyncMode, kinds: readonly ReferenceSetKind[]): Promise<ReferenceSetSummary> {
    if (!tenantId || tenantId === SYSTEM_TENANT_ID) {
      // SYSTEM IS the reference set. Reconciling it against itself would clone every row into
      // its own tenant — the `PipelineTemplateResyncService` refusal, for the same reason.
      throw new BadRequestException('The SYSTEM tenant is the reference set; it cannot be provisioned from itself.');
    }

    const summary: ReferenceSetSummary = {
      tenantId,
      mode,
      kinds: {
        contextSchemas: { ...EMPTY },
        promptTemplates: { ...EMPTY },
        agents: { ...EMPTY },
        agentAssignments: { ...EMPTY },
        documentTemplates: { ...EMPTY },
        workflowDefinitions: { ...EMPTY },
        workflowAssignments: { ...EMPTY },
      },
      warnings: [],
    };

    // `refresh-locked` is DECLARED and not yet implemented: every kind below reconciles
    // missing-only. Saying so in `warnings` is the difference between a repair that did nothing
    // and a repair that did nothing SILENTLY — an operator reaching for this mode is trying to
    // fast-forward a pristine clone, and "0 added" would read as "already up to date".
    // Implementing it is the §8 follow-up.
    if (mode === 'refresh-locked') {
      summary.warnings.push(
        'mode: `refresh-locked` is not implemented yet — this run reconciled missing rows only and fast-forwarded no `templateLocked` row.',
      );
    }

    // REFERENCE_SET_KINDS order, whatever order the caller listed them in: prompts before
    // agents (an agent's instruction is re-pointed at the tenant's prompt clone), agents before
    // assignments (an assignment must name a slug that already resolves in the tenant).
    const selected = REFERENCE_SET_KINDS.filter((kind) => kinds.includes(kind));
    for (const kind of selected) {
      try {
        await this.copyKind(kind, tenantId, summary);
      } catch (error) {
        summary.kinds[kind].failed += 1;
        this.warn(summary, `${kind}: the kind could not be read from the reference set`, { tenantId, kind }, error);
      }
    }

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: tenantId,
      data: { action: 'reference-set-sync', mode, kinds: summary.kinds, warnings: summary.warnings.length },
    });
    return summary;
  }

  private async copyKind(kind: ReferenceSetKind, tenantId: string, summary: ReferenceSetSummary): Promise<void> {
    switch (kind) {
      case 'contextSchemas':
        return this.copyContextSchemas(tenantId, summary);
      case 'promptTemplates':
        return this.copyPromptTemplates(tenantId, summary);
      case 'agents':
        return this.copyAgents(tenantId, summary);
      case 'agentAssignments':
        return this.copyAgentAssignments(tenantId, summary);
      case 'documentTemplates':
        return this.copyDocumentTemplates(tenantId, summary);
      case 'workflowDefinitions':
        return this.copyWorkflowDefinitions(tenantId, summary);
      case 'workflowAssignments':
        return this.copyWorkflowAssignments(tenantId, summary);
    }
  }

  // -------------------------------------------------------------------------
  // Kinds
  // -------------------------------------------------------------------------

  /**
   * Every SYSTEM context schema, first among them the `consultation_legacy_v1` bridge whose
   * `context` kind declares the names `PromptAssemblyService` populates. Read under SYSTEM's own
   * context: this model is deliberately absent from `SYSTEM_SHARED_READ_MODELS`, so there is no
   * widening to lean on.
   */
  private async copyContextSchemas(tenantId: string, summary: ReferenceSetSummary): Promise<void> {
    const outcome = summary.kinds.contextSchemas;
    const contextSchemas = this.port<ContextSchemaClonePort>(IConsultationContextSchemaService);
    if (!contextSchemas) {
      outcome.failed += 1;
      summary.warnings.push('contextSchemas: the context-schema service is not wired, so no schema was provisioned.');
      return;
    }
    const sources = await runInTenantContext(this.clsService, SYSTEM_TENANT_ID, () =>
      this.contextSchemaRepository.findAll({ where: { tenantId: SYSTEM_TENANT_ID } }),
    );
    for (const source of sources) {
      try {
        const before = await runInTenantContext(this.clsService, tenantId, () =>
          this.contextSchemaRepository.findByTenantAndSlug(tenantId, source.slug),
        );
        if (before) {
          outcome.skipped += 1;
          continue;
        }
        await contextSchemas.cloneFromSystem(source.slug, tenantId);
        outcome.added += 1;
      } catch (error) {
        outcome.failed += 1;
        this.warn(summary, `contextSchemas: '${source.slug}' was not provisioned`, { tenantId, slug: source.slug }, error);
      }
    }
  }

  /**
   * The SYSTEM prompt library — the golden set, the live defaults and the `SYSTEM_DEFAULTS.*`
   * rows the resolver points at. USER_PERSONAL rows are excluded: a personal prompt belongs to
   * a person in a tenant and has no meaning in another one.
   */
  private async copyPromptTemplates(tenantId: string, summary: ReferenceSetSummary): Promise<void> {
    const outcome = summary.kinds.promptTemplates;
    const prompts = this.port<PromptClonePort>(IPromptManagementService);
    if (!prompts) {
      outcome.failed += 1;
      summary.warnings.push('promptTemplates: the prompt-management service is not wired, so no template was provisioned.');
      return;
    }
    const sources = (await this.promptTemplateRepository.findSystemReferences(this.databaseService.baseClient)).filter(
      (row) => row.scope !== 'USER_PERSONAL',
    );
    for (const source of sources) {
      try {
        const result = await prompts.cloneFromSystem(source.id, tenantId);
        if (result.created) outcome.added += 1;
        else outcome.skipped += 1;
      } catch (error) {
        outcome.failed += 1;
        this.warn(summary, `promptTemplates: '${source.name ?? source.id}' was not provisioned`, { tenantId, templateId: source.id }, error);
      }
    }
  }

  /**
   * Every PUBLISHED SYSTEM agent, cloned and published into the tenant as its own — EXCEPT a
   * platform hidden one (TASK-974 D-1).
   *
   * Cloning is the TASK-890 OD-M rule for CONTENT: the tenant owns its copy and may re-model it.
   * A platform SERVICE agent is CONFIGURATION, and the two differ in both directions — a tenant
   * could change the model the platform funds, and a platform admin's model change would be
   * stranded in SYSTEM because re-sync is missing-only. So it is skipped here and resolved at
   * runtime by the one service that owns the capability, through its own SYSTEM-pinned read.
   *
   * The skip is REPORTED, not silent: it lands in `skipped` with a warning naming the slug, so
   * an operator reading a provisioning summary can tell a deliberate omission from a failed copy.
   */
  private async copyAgents(tenantId: string, summary: ReferenceSetSummary): Promise<void> {
    const outcome = summary.kinds.agents;
    const agents = this.port<AgentClonePort>(IAgentService);
    if (!agents) {
      outcome.failed += 1;
      summary.warnings.push('agents: the agent service is not wired, so no agent was provisioned.');
      return;
    }
    const sources = await this.agentRepository.findSystemReferences(this.databaseService.baseClient);
    for (const source of sources) {
      if (isPlatformHiddenAgentSlug(source.slug)) {
        outcome.skipped += 1;
        summary.warnings.push(
          `agents: '${source.slug}' was NOT provisioned — it is a platform-owned agent, resolved by the platform for every tenant rather than cloned into one.`,
        );
        continue;
      }
      try {
        const result = await agents.cloneFromSystem(source.slug, tenantId);
        if (result.created) outcome.added += 1;
        else outcome.skipped += 1;
        for (const warning of result.warnings) summary.warnings.push(`agents: '${source.slug}': ${warning}`);
      } catch (error) {
        outcome.failed += 1;
        this.warn(summary, `agents: '${source.slug}' was not provisioned`, { tenantId, slug: source.slug }, error);
      }
    }
  }

  /**
   * One TENANT-scope assignment per SYSTEM TENANT-scope assignment.
   *
   * This is what REPLACES the cascade's SYSTEM tier (OD-M): after the flip
   * `AgentAssignmentService.resolve` walks department → tenant → null, so the platform default
   * has to exist AS the tenant's own row or the task fails closed with `AGENT_NOT_ASSIGNED`.
   *
   * Written through `upsert`, which re-checks that the slug resolves to an ACTIVE PUBLISHED
   * agent OF THAT TASK inside the tenant — so a failed agent copy surfaces HERE as a refused
   * assignment rather than as a row pointing at nothing.
   */
  private async copyAgentAssignments(tenantId: string, summary: ReferenceSetSummary): Promise<void> {
    const outcome = summary.kinds.agentAssignments;
    const assignments = this.port<IAgentAssignmentServicePort>(IAgentAssignmentService);
    if (!assignments) {
      outcome.failed += 1;
      summary.warnings.push('agentAssignments: the agent-assignment service is not wired, so no assignment was provisioned.');
      return;
    }
    for (const task of Object.values(AgentTask)) {
      let sources: Array<{ agentSlug: string; selectorKey: string }> = [];
      try {
        sources = await runInTenantContext(this.clsService, SYSTEM_TENANT_ID, () =>
          this.assignmentRepository.findAllForScope(SYSTEM_TENANT_ID, PipelinePolicyScope.TENANT, null, task as AgentTask),
        );
      } catch (error) {
        outcome.failed += 1;
        this.warn(summary, `agentAssignments: the SYSTEM ${task} assignments could not be read`, { tenantId, task }, error);
        continue;
      }

      for (const source of sources) {
        try {
          const selectorTags = source.selectorKey ? source.selectorKey.split(',') : [];
          const existing = await runInTenantContext(this.clsService, tenantId, () =>
            this.assignmentRepository.findForScopeSelector(tenantId, PipelinePolicyScope.TENANT, null, task as AgentTask, source.selectorKey),
          );
          if (existing) {
            outcome.skipped += 1;
            continue;
          }
          await runInTenantContext(this.clsService, tenantId, () =>
            assignments.upsert({
              scope: PipelinePolicyScope.TENANT,
              task: task as AgentTask,
              agentSlug: source.agentSlug,
              selectorTags,
              reason: 'Provisioned from the platform reference set',
            } as never),
          );
          outcome.added += 1;
        } catch (error) {
          outcome.failed += 1;
          this.warn(
            summary,
            `agentAssignments: ${task} → '${source.agentSlug}' was not provisioned`,
            { tenantId, task, agentSlug: source.agentSlug },
            error,
          );
        }
      }
    }
  }

  /**
   * TASK-891 — every SYSTEM `DocumentTemplate`, with the SHAPE of its pinned version.
   *
   * ## Why this kind has to exist at all
   *
   * `DocumentTemplate` is CONTENT (`00-project-context.md` §"Content is cloned; configuration
   * cascades"): it is deliberately absent from `SYSTEM_SHARED_READ_MODELS`, and
   * `DocumentTemplateService.resolveForGeneration` reads the REQUEST tenant only. A SYSTEM row
   * is therefore INVISIBLE to a tenant holding no copy — there is no cascade to widen into. The
   * SYSTEM rows have existed since `seed/27-document-template-library.ts`, which also clones
   * them into the already-seeded tenants; this is the same copy for a tenant created at runtime,
   * and the only way the `reference-set/sync` route can repair one that missed it.
   *
   * ## The copy
   *
   * Two steps, exactly the ones `ConsultationContextSchemaService.cloneFromSystem` performs for
   * the head/version pair it owns: `create` the tenant's own head, then `publish` v1 from the
   * SOURCE's pinned shape, which validates it, compiles the artifacts and moves the pin — so the
   * clone is servable the moment provisioning finishes. The clone's lineage restarts at 1: a
   * tenant's version history is its own.
   *
   * Three deliberate choices:
   *
   *  - **`isDefault: false`, never mirrored from the source.** `DocumentTemplateService.create`
   *    DEMOTES the tenant's existing default when asked for a new one, and a provisioning step
   *    must never silently change a choice the tenant made. The selector is the workflow node's
   *    `documentTemplateSlug`, so an unnamed lane keeps falling open to the platform SOAP shape —
   *    the same reasoning `27-document-template-library.ts` records.
   *  - **CREATE-ONLY, keyed on the SLUG** (`@@unique([tenantId, slug])` is the row's real
   *    identity). A tenant that already carries the slug — provisioned earlier, or authored and
   *    then edited — is SKIPPED without its row being read for content, patched or re-published.
   *    That is what makes "a re-sync cannot clobber a tenant edit" a property of the control
   *    flow rather than a promise. Fast-forwarding a still-`templateLocked` clone is the
   *    `refresh-locked` mode, which is declared and not implemented.
   *  - **An unpinned SOURCE is a REFUSAL, not a silent half-copy.** An unservable reference row
   *    would produce a clone `isServable` skips; naming the platform defect here is the point of
   *    the warnings list.
   *
   * A failure BETWEEN the create and the publish leaves an unservable DRAFT that a later
   * re-sync will skip on the slug — reported by name, and the same exposure
   * `ConsultationContextSchemaService.cloneFromSystem` carries. Repairing it is a deliberate
   * publish by the tenant, not something provisioning may guess at.
   */
  private async copyDocumentTemplates(tenantId: string, summary: ReferenceSetSummary): Promise<void> {
    const outcome = summary.kinds.documentTemplates;
    const templates = this.port<DocumentTemplateClonePort>(IDocumentTemplateService);
    if (!templates) {
      outcome.failed += 1;
      summary.warnings.push('documentTemplates: the document-template service is not wired, so no template was provisioned.');
      return;
    }

    // Read under SYSTEM's own context: this model is not SYSTEM-shared-read, so there is no
    // widening to lean on and none is wanted — naming the tenant each step means is the
    // `syncToTenants` discipline.
    const sources = await runInTenantContext(this.clsService, SYSTEM_TENANT_ID, () =>
      this.documentTemplateRepository.findAll({ where: { tenantId: SYSTEM_TENANT_ID } }),
    );

    for (const source of sources) {
      try {
        const existing = await runInTenantContext(this.clsService, tenantId, () =>
          this.documentTemplateRepository.findByTenantAndSlug(tenantId, source.slug),
        );
        if (existing) {
          outcome.skipped += 1;
          continue;
        }

        const pinnedVersionNumber = source.pinnedVersionNumber;
        const pinned =
          pinnedVersionNumber == null
            ? null
            : await runInTenantContext(this.clsService, SYSTEM_TENANT_ID, () =>
                this.documentTemplateVersionRepository.findByTemplateAndVersionNumber(source.id, pinnedVersionNumber),
              );
        if (!pinned) {
          throw new Error('the reference row carries no pinned version, so the clone would never be servable');
        }

        await runInTenantContext(this.clsService, tenantId, async () => {
          const created = await templates.create({
            slug: source.slug,
            name: source.name,
            description: source.description ?? undefined,
            isDefault: false,
            sourceTemplateSlug: source.slug,
            templateLocked: true,
          });
          await templates.publish(created.id, {
            shape: pinned.shape as Record<string, unknown>,
            changeReason: 'Provisioned from the platform reference set',
          });
        });
        outcome.added += 1;
      } catch (error) {
        outcome.failed += 1;
        this.warn(summary, `documentTemplates: '${source.slug}' was not provisioned`, { tenantId, slug: source.slug }, error);
      }
    }
  }

  /**
   * Every PUBLISHED SYSTEM workflow definition, landed as a DRAFT the tenant owns.
   *
   * No `WorkflowAssignment` row is written, because there is none to mirror: the seeds carry no
   * SYSTEM TENANT-scope workflow assignment, and `WorkflowAssignmentService.resolve` already has
   * no SYSTEM tier — a tenant with no assignment takes the legacy dispatch path exactly as it
   * does today. The copy exists so the tenant has something to publish and assign, not so the
   * runtime silently starts routing through it.
   */
  private async copyWorkflowDefinitions(tenantId: string, summary: ReferenceSetSummary): Promise<void> {
    const outcome = summary.kinds.workflowDefinitions;
    const workflows = this.port<WorkflowClonePort>(IWorkflowDefinitionService);
    if (!workflows) {
      outcome.failed += 1;
      summary.warnings.push('workflowDefinitions: the workflow-definition service is not wired, so no definition was provisioned.');
      return;
    }
    const sources = await this.workflowDefinitionRepository.findSystemTemplates(this.databaseService.baseClient);
    for (const source of sources) {
      try {
        const result = await workflows.cloneFromSystem(source.slug, tenantId);
        if (result.created) outcome.added += 1;
        else outcome.skipped += 1;
      } catch (error) {
        // A platform template that pins PLATFORM-owned catalogue rows REFUSES to be cloned, by
        // design (`assertNoUnresolvableCatalogBindings`): the copy would carry references the
        // tenant cannot resolve. That is the clone path answering correctly, so it is a SKIP
        // with a stated reason — counting it as a FAILURE would make every provisioning report
        // look broken over a template that can never be copied. Anything else is a real failure.
        const refused = isRefusal(error);
        if (refused) outcome.skipped += 1;
        else outcome.failed += 1;
        this.warn(
          summary,
          `workflowDefinitions: '${source.slug}' was ${refused ? 'not clonable and was skipped' : 'not provisioned'}`,
          { tenantId, slug: source.slug },
          error,
        );
      }
    }
  }

  /**
   * TASK-930 §6.3 — SYSTEM's TENANT-scope workflow assignments, so a provisioned tenant does not
   * merely HAVE the platform workflows but actually RUNS them.
   *
   * ## Why this is a kind and not a line in `copyWorkflowDefinitions`
   *
   * `WorkflowAssignmentService.resolve` cascades `department → tenant → platform-default` and has
   * NO SYSTEM tier. So a tenant with a perfect cloned library and no assignment routes exactly as
   * an empty tenant does — the clone changes nothing observable. The assignment is the row that
   * makes provisioning mean something, and it is separate because "which workflows do I have" and
   * "which one do I run" are separately repairable.
   *
   * ## TENANT scope only, and the skip is stated
   *
   * A DEPARTMENT-scope row's `scopeId` is a department of the SOURCE tenant. Departments are
   * tenant TOPOLOGY, not content: the id means nothing in the target, and there is no slug to
   * re-point it by the way a definition or a template is re-pointed. Copying one would dangle, or
   * — worse — land on an unrelated department that happens to share an id. So DEPARTMENT rows are
   * skipped; and because a tenant silently missing a routing rule is precisely the failure this
   * service's warnings exist to prevent, the skip is REPORTED rather than merely counted.
   *
   * `selectorKey` travels: a tag-qualified row is a different row of the same tier (TASK-891), not
   * a variant of the unqualified one, so dropping the selector would collapse two rules into one.
   *
   * Missing-only, per row, like every other kind: a tier+selector the tenant already holds is
   * never rewritten, which is what makes a re-sync safe to run unattended.
   */
  private async copyWorkflowAssignments(tenantId: string, summary: ReferenceSetSummary): Promise<void> {
    const outcome = summary.kinds.workflowAssignments;

    let sources: Array<{ scope: PipelinePolicyScope; paletteKey: string; workflowDefinitionSlug: string; selectorKey: string }> = [];
    try {
      // Every SYSTEM row, both scopes — the DEPARTMENT ones are read precisely so their exclusion
      // can be REPORTED. Filtering them in the query would make the skip invisible.
      sources = await runInTenantContext(this.clsService, SYSTEM_TENANT_ID, () =>
        this.workflowAssignmentRepository.findAll({ filters: { tenantId: SYSTEM_TENANT_ID } as never }),
      );
    } catch (error) {
      outcome.failed += 1;
      this.warn(summary, 'workflowAssignments: the SYSTEM assignments could not be read', { tenantId }, error);
      return;
    }
    if (sources.length === 0) return;

    const assignments = this.port<WorkflowAssignmentWritePort>(IWorkflowAssignmentService);
    if (!assignments) {
      outcome.failed += 1;
      summary.warnings.push('workflowAssignments: the workflow-assignment service is not wired, so no assignment was provisioned.');
      return;
    }

    for (const source of sources) {
      if (source.scope !== PipelinePolicyScope.TENANT) {
        outcome.skipped += 1;
        summary.warnings.push(
          `workflowAssignments: the SYSTEM ${source.scope} assignment for palette '${source.paletteKey}' was skipped — a ` +
            'DEPARTMENT-scope row names a department of the source tenant, which is tenant topology and has no meaning here.',
        );
        continue;
      }
      try {
        const existing = await runInTenantContext(this.clsService, tenantId, () =>
          this.workflowAssignmentRepository.findForScopeSelector(
            tenantId,
            PipelinePolicyScope.TENANT,
            null,
            source.paletteKey,
            source.selectorKey ?? '',
          ),
        );
        if (existing) {
          outcome.skipped += 1;
          continue;
        }
        await runInTenantContext(this.clsService, tenantId, () =>
          assignments.upsert({
            scope: PipelinePolicyScope.TENANT,
            scopeId: null,
            paletteKey: source.paletteKey,
            workflowDefinitionSlug: source.workflowDefinitionSlug,
            selectorTags: source.selectorKey ? source.selectorKey.split(',') : [],
            reason: 'Provisioned from the platform reference set',
          }),
        );
        outcome.added += 1;
      } catch (error) {
        outcome.failed += 1;
        this.warn(
          summary,
          `workflowAssignments: '${source.paletteKey}' -> '${source.workflowDefinitionSlug}' was not provisioned`,
          { tenantId, paletteKey: source.paletteKey, workflowDefinitionSlug: source.workflowDefinitionSlug },
          error,
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private warn(summary: ReferenceSetSummary, message: string, context: Record<string, unknown>, error: unknown): void {
    const reason = error instanceof Error ? error.message : String(error);
    summary.warnings.push(`${message}: ${reason}`);
    this.logger.warn({ message, ...context, error: reason });
  }
}
