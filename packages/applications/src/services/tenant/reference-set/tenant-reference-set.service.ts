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
  PipelinePolicyScope,
  PromptTemplateRepository,
  ResourceType,
  SYSTEM_TENANT_ID,
  SysEventType,
  WorkflowDefinitionRepository,
} from '@arcaai/domains';
import { BaseService } from '../../../common';
import { IActiveUserContext } from '../../../interfaces';
import { runInTenantContext } from '../../agentPromotion/tenant-context';
import { IAgentService } from '../../agent/IAgentService';
import { IAgentAssignmentService } from '../../agent-assignment/IAgentAssignmentService';
import type { IAgentAssignmentService as IAgentAssignmentServicePort } from '../../agent-assignment/IAgentAssignmentService';
import { IConsultationContextSchemaService } from '../../consultation-context-schema/IConsultationContextSchemaService';
import { IPromptManagementService } from '../../prompt-management/IPromptManagementService';
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
 * The four collaborators, narrowed to the ONE method this service needs of each.
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
interface ContextSchemaClonePort {
  cloneFromSystem(slug: string, tenantId: string): Promise<{ id: string }>;
}

const EMPTY: ReferenceSetKindOutcome = { added: 0, skipped: 0, failed: 0 };

/**
 * TASK-890 §3.4 — clone the SYSTEM REFERENCE SET into a tenant.
 *
 * ## Why a service and not five call sites
 *
 * The five kinds are ORDERED, and the order carries meaning rather than convenience: an agent's
 * instruction is re-pointed at the tenant's prompt clone, so prompts precede agents; an
 * assignment names a slug that must already resolve to a PUBLISHED agent in the tenant, so
 * agents precede assignments. Spreading that across `TenantService.create` would make the order
 * an accident of statement sequence.
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
    private readonly contextSchemaRepository: ConsultationContextSchemaRepository,
    @Inject('CORE_DATABASE_SERVICE') private readonly databaseService: CoreDatabaseService,
    /**
     * The four kind-owning services are resolved from the CONTAINER at call time rather than
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
        workflowDefinitions: { ...EMPTY },
      },
      warnings: [],
    };

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
      case 'workflowDefinitions':
        return this.copyWorkflowDefinitions(tenantId, summary);
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

  /** Every PUBLISHED SYSTEM agent, cloned and published into the tenant as its own. */
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
        outcome.failed += 1;
        this.warn(summary, `workflowDefinitions: '${source.slug}' was not provisioned`, { tenantId, slug: source.slug }, error);
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
