import {
  Injectable,
  BadRequestException,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
  Inject,
  Logger,
  Optional,
} from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { BusinessException } from '@arcaai/exceptions';
import {
  ConsultationEntity,
  ConsultationRepository,
  ConsultationFactory,
  ConsultationStatus,
  ContextItemSource,
  ContextItemType,
  DepartmentRepository,
  HarnessAuditAction,
  ResourceType,
  SysEventType,
  UserDepartmentRepository,
  UserRepository,
  UserRoleAssignmentRepository,
  WorkflowDefinitionRepository,
} from '@arcaai/domains';
import { IConsultationService } from './IConsultationService';
import {
  OpenConsultationRequest,
  UpdateConsultationRequest,
  ConsultationResponse,
  ConsultationAggregateResponse,
  ConsultationWorkflowResponse,
  PaginatedConsultationResponse,
} from './dto';
import { ConsultationDtoMapper } from './consultation.dto.mapper';
import {
  assertAttributedClinicianInTenant,
  resolveAttributedClinician,
  tenantRoleReaderFor,
  type ClinicalCaller,
} from '../summary/clinician-attribution';
import { BaseService, assertEqualTenants, assertParentInScope, assertUserBelongsToTenant, isSuperAdmin } from '../../../common';
import { IActiveUserContext } from '../../../interfaces';
import { IEntitlementsService } from '../../entitlements/IEntitlementsService';
import { HarnessAuditService } from '../../harness-audit';
import { IConsentGrantService } from '../../consent/IConsentGrantService';
import { IConsultationWorkflowDispatchService } from '../workflow-dispatch/IConsultationWorkflowDispatchService';
import { SelectableConsultationWorkflowListResponse } from '../workflow-dispatch/dto';
import { readGoverningEngineMarker } from '../governing-engine';
import { withWorkflowSelectionMarker } from './workflow-selection';
import { withSummaryLanguage } from './summary-language';
import { type ConsultationVisitTypeKey, readRecordedVisitType, withExternalRefMarker, withVisitTypeMarker } from './open-markers';
import { DEFAULT_VISIT_TYPE_SERVICE, VisitTypeService } from '../visit-type/visit-type.service';
import { PolicyEngine } from '../../../authorization/policy.engine';
import { TenantSettingsService } from '../../settings-registry/tenant-settings.service';
import { CONSULTATION_REQUIRE_PRIMED_BEFORE_RECORDING_KEY } from '../consultation-gates.constants';
// TASK-950 — the two collaborators the schema-typed `context` on `open` needs. The
// context-schema symbols come from their own files rather than that package's barrel, which
// re-exports the service, the module and the DTO surface for the three symbols wanted here.
import { IConsultationContextSchemaService } from '../../consultation-context-schema/IConsultationContextSchemaService';
import type { ConsultationContextSchemaBundleResponse } from '../../consultation-context-schema/dto';
import { openBindingsFromDefinition, type UserIdentityBinding } from '../../consultation-context-schema/context-schema-definition';
import { IContextUserIdentityService, extractUserIdentityValue } from '../../user/identity';
// TASK-951 §D-5 — `open` now PERSISTS the context it validated, and it does so through the one
// service that already knows how (schema pin, canonical content, Vault-Transit encryption, the
// v1 audit version, the live fan-out). Reproducing those five things here is how they drift.
import { IContextService } from '../context/IContextService';

/**
 * TASK-951 — everything `open` learned from the caller's `context`, in one value.
 *
 * Carried between the four steps that need it (identity resolution, the row write, persistence,
 * dispatch) rather than re-derived at each one: the department may have been resolved FROM the
 * payload, so "which schema was this validated against" is a fact with a single answer per
 * request and re-deriving it is how two steps would eventually pick different ones.
 */
interface ResolvedOpenContext {
  /** The department the consultation is written under — request-supplied, or schema-resolved. */
  departmentId?: string;
  /** The catalogue key the caller stated, when a `visitType` binding carried one. */
  visitTypeKey: ConsultationVisitTypeKey | null;
  /** The caller's own encounter id, when an `externalRef` binding carried one. */
  externalRef: string | null;
  /** Kind keys that validated, in request order. */
  validatedKindKeys: string[];
  /** The identity binding to resolve a clinician through, when the schema declares one AND its kind was sent. */
  identityBinding: UserIdentityBinding | null;
  /** Validated kinds the schema marks for materialization into `CASE_NOTE` items. */
  materializeKindKeys: string[];
  /** The effective bundle the payload was validated against — the provenance stamped on a provisioned user. */
  bundle: ConsultationContextSchemaBundleResponse | null;
}

/**
 * The string a `{ kindKey, field }` binding points at inside an `{ [kindKey]: payload }` envelope,
 * or `null`.
 *
 * Deliberately NOT `extractUserIdentityValue`, though the traversal is the same: that helper is
 * shared by THREE PLANES (consultation open, agent invocation, workflow run) and its contract is
 * about identity specifically, so widening it to serve three consultation-open-only bindings
 * would make it a general utility three unrelated callers depend on for a different reason. The
 * tolerance rule is identical on purpose — presence is the schema's `required` flags and type is
 * the validator, both of which have already run; a second refusal here would be a competing
 * validator.
 */
function readBindingString(context: Record<string, unknown>, binding: { kindKey: string; field: string }): string | null {
  const kind = context[binding.kindKey];
  if (typeof kind !== 'object' || kind === null || Array.isArray(kind)) return null;
  const value = (kind as Record<string, unknown>)[binding.field];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Consultation Service
 *
 * Simplified workflow using natural key (patientId, doctorId, appointmentDate)
 */
@Injectable()
export class ConsultationService extends BaseService implements IConsultationService {
  private readonly logger = new Logger(ConsultationService.name);

  constructor(
    private readonly consultationRepository: ConsultationRepository,
    private readonly departmentRepository: DepartmentRepository,
    private readonly userRoleAssignmentRepository: UserRoleAssignmentRepository,
    // Membership is role + department; the guard needs the
    // department join table and the User table (service-account exemption).
    private readonly userDepartmentRepository: UserDepartmentRepository,
    private readonly userRepository: UserRepository,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
    // Optional (append-only DI); enforces the plan
    // `monthlyConsultations` meter when STARTING a new consultation
    // (kill-switch-gated, → 429 when over the rolling-monthly cap).
    @Optional() @Inject(IEntitlementsService) private readonly entitlements?: IEntitlementsService,
    // optional (append-only DI, mirrors `entitlements` above): the
    // WORM audit trail for clinically-significant transitions (prime/close/
    // reopen). Absent ⇒ `appendTransitionAudit` no-ops (best-effort by design
    // for routine transitions — see the method doc).
    @Optional() @Inject(HarnessAuditService) private readonly harnessAuditService?: HarnessAuditService,
    // optional: resolves the `requirePrimedBeforeRecording`
    // kill-switch. Absent ⇒ treated as OFF (the fail-safe default), mirroring
    // `OcrEnrichmentProcessor.ocrEnabled`.
    @Optional() @Inject(TenantSettingsService) private readonly tenantSettings?: TenantSettingsService,
    // optional: dispatches a tenant-authored `consultation`-palette workflow at
    // open. Absent ⇒ no dispatch, and the consultation runs under the default loop (Substrate A),
    // which is exactly the earlier behaviour. Optional so existing test fixtures and any
    // module that does not import ConsultationWorkflowDispatchServiceModule keep constructing.
    @Optional()
    @Inject(IConsultationWorkflowDispatchService)
    private readonly workflowDispatchService?: IConsultationWorkflowDispatchService,
    // owner directive (2026-08-25) — optional + trailing (append-only
    // DI, so existing positional test fixtures keep constructing). Records the
    // consent the doctor gives by opening the consultation. Absent ⇒ no grant
    // is written and the ABAC gate will refuse recording, which is why
    // `getOrCreate` logs loudly rather than silently when it is unwired.
    @Optional() @Inject(IConsentGrantService) private readonly consentGrantService?: IConsentGrantService,
    // optional + trailing (append-only DI, like every dependency above it). READ-ONLY,
    // and used for discovery alone: `getGoverningWorkflow` decorates the durable marker with the
    // definition's human-readable identity. Absent ⇒ the route still answers, with that identity
    // degraded to null — never an error, because "which engine governs" must stay answerable.
    // The SELECTION gate deliberately does NOT use this: authorizing a selection is dispatch
    // policy and lives with the dispatcher, which owns the palette rule.
    @Optional() private readonly workflowDefinitionRepository?: WorkflowDefinitionRepository,
    // TASK-933 — optional + trailing (append-only DI, like every dependency above it). Answers
    // ONE question, and only when a machine caller NAMES a clinician on `open`: "may that user
    // own a consultation?". A route decorator expresses `action + subject` for the CALLER and
    // cannot express it for a THIRD PARTY named in the body — the `AgentService.
    // assertManagesAgentsIn` precedent. Absent ⇒ the question is unanswered, so the named-
    // clinician path fails CLOSED (404); the ordinary human path never reaches it.
    @Optional() private readonly policyEngine?: PolicyEngine,
    // TASK-950 §D-6 — optional + trailing (append-only DI, like every dependency above it).
    // Validates `OpenConsultationRequest.context` against the DEPARTMENT-effective schema and
    // supplies the definition the user-identity marker is read from. Absent ⇒ a request that
    // supplies `context` is refused 503 rather than opened with its context unchecked; a request
    // that supplies none never reaches it, so every existing caller is unaffected.
    @Optional()
    @Inject(IConsultationContextSchemaService)
    private readonly contextSchemaService?: IConsultationContextSchemaService,
    // TASK-950 §D-8/D-10 — optional + trailing. Resolves the schema's user-identity value to a
    // tenant user (`UserProfile.staffId`), provisioning one when the tenant allows it. Reached
    // ONLY when a SERVICE-ACCOUNT caller sends a context payload whose effective schema declares
    // the marker; absent in that case is a 503, for the same reason as above.
    @Optional()
    @Inject(IContextUserIdentityService)
    private readonly userIdentityService?: IContextUserIdentityService,
    // TASK-951 §D-3 — optional + trailing (append-only DI). Matches the visit type a caller
    // STATES against the platform vocabulary, aliases honoured. Holds no state and does no I/O,
    // so `DEFAULT_VISIT_TYPE_SERVICE` is an exact stand-in when unwired — the same
    // `?? DEFAULT_VISIT_TYPE_SERVICE` fallback the other eight consumers use.
    @Optional() @Inject(VisitTypeService) private readonly visitTypes?: VisitTypeService,
    // TASK-951 §D-5 — optional + trailing. Persists each validated `context` kind as a PRE
    // context item once the consultation row exists. Absent ⇒ the values are still mapped
    // (department / visit type / external ref / clinician) and threaded into the run payload,
    // but nothing is written as an item, which is logged rather than silent. NOT a 503: unlike
    // validation, persistence is not a claim the open response makes.
    @Optional() @Inject(IContextService) private readonly contextService?: IContextService,
  ) {
    super(eventEmitter, clsService, ResourceType.Consultation);
  }

  /**
   * (audit C-1 / C-2 / C-4) — assert every cross-aggregate
   * reference on a Consultation write lives in the caller's tenant before
   * any factory or repository call runs:
   *
   *   - `doctorId` — User must hold an ENABLED UserRoleAssignment
   *                            in `tenantId` (defense vs. audit C-1).
   *   - `departmentId` — Department row must be tenant-scoped to
   *                            `tenantId` (defense vs. audit C-2).
   *   - `parentConsultationId` — Parent Consultation must live in the same
   *                              tenant (defense vs. audit C-4 / B-3).
   *
   * All helpers route failures through `NotFoundException` to avoid leaking
   * the existence of a cross-tenant resource. SUPER_ADMIN is intentionally
   * NOT bypassed — assigning consultations to users / departments / parents
   * outside the tenant would produce a structurally invalid aggregate
   * regardless of caller role (mirrors the D.6 DepartmentService rule).
   */
  private async assertCrossAggregateRefsInTenant(
    tenantId: string,
    refs: {
      doctorId: string;
      departmentId?: string | null;
      parentConsultationId?: string | null;
    },
  ): Promise<void> {
    await assertUserBelongsToTenant(this.userRoleAssignmentRepository, this.userDepartmentRepository, this.userRepository, refs.doctorId, tenantId);

    if (refs.departmentId) {
      await assertParentInScope(this.departmentRepository, refs.departmentId, tenantId);
    }

    if (refs.parentConsultationId) {
      await assertParentInScope(this.consultationRepository, refs.parentConsultationId, tenantId);
    }
  }

  /**
   * TASK-933 §3.2 — may the NAMED clinician own a consultation?
   *
   * Runs ONLY when a caller named one (`OpenConsultationRequest.clinicianUserId`, which the
   * controller honours for a service account alone). A human caller never reaches it: their
   * `doctorId` IS their own identity, and `@Authorize(['create','Consultation'])` already
   * proved that ability at the guard.
   *
   * A machine has proved nothing of the sort about the person it names. Its own authority is
   * exactly its `svc:*` scopes (`serviceAccountPolicyRules`) — a set that says the ACCOUNT may
   * open consultations, not that this particular user may hold one. Without this check a
   * service account could file a consultation against a receptionist, a nurse, a disabled
   * account or a fellow machine, and every downstream consumer that keys off `doctorId` would
   * inherit it.
   *
   * The rule is the tenant's own policy, not a role list this file invents: build the named
   * user's ability the way the guard builds a human's, and require `create:Consultation`.
   * `consultation-own-manage` grants it to doctors and `tenant-full-access` to tenant admins;
   * `consultation-read-assigned` (nurses) does not — which is precisely the discrimination
   * wanted, expressed once, in the seeded policy.
   *
   * EVERY failure is a `NotFoundException`, including an unwired engine and a failed build.
   * 404-over-403 twice over: the user id space is not the caller's to probe, and "this user
   * exists but may not own consultations" is exactly the fact not to disclose. Failing closed on
   * an unanswered question is the same posture `AgentService.assertManagesAgentsIn` takes.
   */
  private async assertNamedClinicianMayOwnConsultation(tenantId: string, clinicianUserId: string): Promise<void> {
    const notFound = new NotFoundException(`User ${clinicianUserId} not found`);

    if (!this.policyEngine) {
      this.logger.error({
        message: 'A clinician was named on open but the authorization engine is NOT WIRED — refusing rather than accepting an unverified doctor',
        clinicianUserId,
      });
      throw notFound;
    }

    const ability = await this.policyEngine.buildAbility({ userId: clinicianUserId, tenantId }).catch((err) => {
      this.logger.error({
        message: 'Ability build failed for the named clinician — refusing the open',
        clinicianUserId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    });

    if (!ability?.can('create', 'Consultation')) {
      this.logger.warn({
        message: 'The named clinician may not own a consultation — answering 404 (the user id space is not the caller to probe)',
        clinicianUserId,
      });
      throw notFound;
    }
  }

  /**
   * point 6 — no-op when the caller made no selection; otherwise delegate to the
   * dispatcher's gate, which raises 404 for an invisible definition and 403 for a visible one
   * that cannot govern a consultation.
   *
   * The unwired branch is a 503 on purpose. Every other absent-dependency path in this service
   * degrades (the audit trail no-ops, the kill-switch reads OFF, the cascade is simply not
   * consulted) because nothing was ASKED for. Here something was: the caller named a workflow,
   * and a deployment that cannot honour it would otherwise return 201 for a consultation
   * governed by the default engine. Refusing is retryable and legible; the silent substitution
   * is neither.
   */
  private async assertWorkflowSelectionAllowed(tenantId: string, workflowDefinitionSlug?: string): Promise<void> {
    if (!workflowDefinitionSlug) return;

    if (!this.workflowDispatchService) {
      this.logger.error({
        message:
          'A workflow was selected but consultation workflow dispatch is NOT WIRED — refusing rather than silently opening under the default engine',
        requestedWorkflowDefinitionSlug: workflowDefinitionSlug,
      });
      throw new ServiceUnavailableException('Workflow selection is not available on this deployment');
    }

    await this.workflowDispatchService.assertSelectableForConsultation(tenantId, workflowDefinitionSlug);
  }

  /**
   * the workflows this caller may name at open.
   *
   * Selection shipped without a way to learn what is selectable, so the contract was "guess a
   * slug, get a 404/403". The answer comes from the DISPATCHER, which owns the gate: the list
   * and the gate are one predicate with two consumers
   * (`workflow-dispatch/consultation-selection-policy.ts`), so a slug this route advertises can
   * never be one the gate refuses.
   *
   * This service adds only the two request-shaped facts the dispatcher has no business knowing:
   *
   *   * the tenant is the CLS-resolved one, never a request field — so there is no cross-tenant
   *     identifier on this surface and no 404-over-403 case to get wrong;
   *   * an UNWIRED dispatcher is a 503, exactly as it is for the selection gate. Answering
   *     `{ data: [] }` would be a claim about what the tenant has authored, when the truth is
   *     that this deployment cannot tell — and a caller that believed it would stop selecting
   *     rather than retry.
   *
   * No `ResourceViewed` sys-event: this reads workflow definitions, and this service's audit
   * resource type is `Consultation`. Mis-typing the event to obtain coverage would be worse
   * than the absence — the same call this route's sibling `getGoverningWorkflow` makes.
   */
  async listSelectableWorkflows(): Promise<SelectableConsultationWorkflowListResponse> {
    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    if (!this.workflowDispatchService) {
      this.logger.error({
        message: 'Selectable workflows were requested but consultation workflow dispatch is NOT WIRED — refusing rather than reporting an empty set',
      });
      throw new ServiceUnavailableException('Workflow selection is not available on this deployment');
    }

    return this.workflowDispatchService.listSelectableForConsultation(tenantId);
  }

  /**
   * WHICH engine governs a consultation (see `ConsultationWorkflowResponse`).
   *
   * Reads the durable marker `ConsultationWorkflowDispatchService` wrote at open, through the
   * SAME well-formedness rule `LoopContextSignalService` gates on, so discovery can never
   * disagree with the engine that is actually writing the document.
   *
   * Decoration with the definition's identity is best-effort: a slug that has since been
   * unpublished still answers, with `name`/`activeVersionNumber` null. "Which engine governs" is
   * exactly the question a client asks when something looks wrong, so it must not itself fail
   * when something is wrong.
   */
  async getGoverningWorkflow(consultationId: string): Promise<ConsultationWorkflowResponse> {
    const consultation = await this.consultationRepository.findById(consultationId);
    if (!consultation) {
      throw new NotFoundException(`Consultation ${consultationId} not found`);
    }

    const marker = readGoverningEngineMarker(consultation.metadata);

    const base: ConsultationWorkflowResponse = {
      consultationId,
      governed: marker !== null,
      workflowDefinitionSlug: marker?.workflowDefinitionSlug || null,
      workflowRunId: marker?.workflowRunId ?? null,
      decidedAt: marker?.decidedAt ?? null,
      name: null,
      description: null,
      paletteKey: null,
      activeVersionNumber: null,
      // No per-definition input schema is declared anywhere in the substrate. See the DTO.
      inputSchema: null,
    };

    if (!base.workflowDefinitionSlug || !this.workflowDefinitionRepository) return base;

    const definition = await this.workflowDefinitionRepository.findPublishedBySlug(consultation.tenantId, base.workflowDefinitionSlug);
    if (!definition) return base;

    return {
      ...base,
      name: definition.name,
      description: definition.description ?? null,
      paletteKey: definition.paletteKey,
      activeVersionNumber: definition.versionNumber,
    };
  }

  // ------------------------------------------------------------------------
  // TASK-950 - the schema-typed `context` on `open`, and the clinician it may name
  // ------------------------------------------------------------------------

  /**
   * TASK-950 §D-6 (a) - validate `request.context` against the DEPARTMENT-effective schema.
   *
   * Runs for EVERY credential class: a payload the tenant's own vocabulary does not admit is a
   * caller error whoever sent it, and refusing it here - before the get-or-create branch and
   * before any write - means a violation never depends on whether a consultation for
   * (patient, doctor, date) happens to already exist.
   *
   * Every entry is checked and EVERY problem is reported at once (the same posture the publish
   * gate takes): an integrator fixing a payload should not discover its faults one round-trip at
   * a time. The named code is `CONTEXT_SCHEMA_VIOLATION`, the SAME one the agent invocation
   * plane raises (`AgentInvocationService.invokeText`), so a caller that has met it there
   * recognises it here.
   *
   * An UNWIRED validator is a 503, not a pass. Every other absent dependency on this service
   * degrades because nothing was asked for; here something was - the caller sent a context
   * payload, and opening the consultation with it silently unchecked would be a claim this
   * deployment cannot make.
   *
   * TASK-951 - `departmentId` is a PARAMETER rather than `request.departmentId`, because the
   * department may itself have been resolved FROM the payload (D-2). The schema a payload is
   * checked against must be the one the consultation is actually written under; see
   * {@link resolveOpenContext} for why that takes two passes.
   *
   * @returns the kind keys that validated, in request order - the input to the mapping steps.
   */
  private async assertContextConformsToSchema(context: Record<string, unknown>, departmentId?: string): Promise<string[]> {
    if (!this.contextSchemaService) {
      this.logger.error({
        message: 'A context payload was supplied on open but context-schema validation is NOT WIRED - refusing rather than accepting it unchecked',
        kindKeys: Object.keys(context),
      });
      throw new ServiceUnavailableException('Consultation context validation is not available on this deployment');
    }

    const problems: string[] = [];
    const validatedKindKeys: string[] = [];

    for (const [kindKey, payload] of Object.entries(context)) {
      try {
        await this.contextSchemaService.validateContextPayload({
          kindKey,
          payload: payload as Record<string, unknown>,
          departmentId,
        });
        validatedKindKeys.push(kindKey);
      } catch (err) {
        // ONLY a validation refusal becomes a problem line. A repository outage or a decryption
        // failure must surface as itself, never be reported to the caller as "your payload is
        // invalid".
        if (!(err instanceof BadRequestException)) throw err;
        problems.push(...ConsultationService.contextProblemsOf(kindKey, err));
      }
    }

    if (problems.length > 0) {
      throw new BadRequestException({
        message: "The supplied `context` does not satisfy this tenant's consultation context schema.",
        code: 'CONTEXT_SCHEMA_VIOLATION',
        problems,
      });
    }

    return validatedKindKeys;
  }

  /** Flatten one `validateContextPayload` refusal into caller-facing problem lines, kind-prefixed. */
  private static contextProblemsOf(kindKey: string, err: BadRequestException): string[] {
    const response = err.getResponse() as string | { message?: string; problems?: unknown };
    if (typeof response === 'string') return [`${kindKey}: ${response}`];
    const nested = Array.isArray(response?.problems) ? (response.problems as unknown[]).map((problem) => String(problem)) : [];
    if (nested.length > 0) return nested.map((problem) => `${kindKey}: ${problem}`);
    return [`${kindKey}: ${response?.message ?? err.message}`];
  }

  /**
   * TASK-951 §D-2/D-3/D-4 - everything `open` MAPS out of the context payload, in one pass over
   * the tenant's own declarations.
   *
   * TASK-950 shipped one mapping (the user identity) and read it with an ad-hoc `findKind` walk.
   * Three more mappings arrive here - department, visit type, external reference - and reading
   * four markers with four walks is how two of them would eventually disagree about which schema
   * they came from. `openBindingsFromDefinition` is the single derivation; this method is the
   * single READ of it.
   *
   * ## Why this takes TWO validation passes
   *
   * The department a payload is validated against is the department that SELECTS the schema
   * (`getEffectiveBundle`: department default -> tenant default). When the payload itself names
   * the department (D-2), that is circular, and the circle has to be cut deliberately:
   *
   *   1. Resolve the bundle for the department the REQUEST carried (or the tenant default), and
   *      validate ONLY the kind the `department` binding sits on. A failure here is not reported
   *      - it just leaves the department unresolved - because pass 2 re-validates the same kind
   *      alongside every other one and reports every problem at once, which is the posture
   *      TASK-950 established and this must not weaken.
   *   2. Resolve the department, then validate EVERY kind against the bundle that department
   *      actually selects, re-deriving the bindings from it when it changed.
   *
   * So a tenant whose department-scoped schema declares different kinds than its tenant default
   * gets a violation naming the department's own schema - which is the honest answer, because
   * that is the schema the consultation will be written under.
   *
   * A caller that sends no `context` at all reaches none of this: the result is the request's own
   * `departmentId` and four absent mappings, which is exactly the pre-TASK-951 behaviour.
   */
  private async resolveOpenContext(tenantId: string, request: OpenConsultationRequest): Promise<ResolvedOpenContext> {
    const context = request.context;
    const empty: ResolvedOpenContext = {
      departmentId: request.departmentId ?? undefined,
      visitTypeKey: null,
      externalRef: null,
      validatedKindKeys: [],
      identityBinding: null,
      materializeKindKeys: [],
      bundle: null,
    };
    if (!context || Object.keys(context).length === 0) return empty;

    if (!this.contextSchemaService) {
      // Same refusal `assertContextConformsToSchema` raises, reached one step earlier because
      // the bindings are read before validation runs. Stated here rather than delegated so the
      // 503 cannot depend on which of the two happens to be called first.
      this.logger.error({
        message: 'A context payload was supplied on open but context-schema validation is NOT WIRED - refusing rather than accepting it unchecked',
        kindKeys: Object.keys(context),
      });
      throw new ServiceUnavailableException('Consultation context validation is not available on this deployment');
    }

    let bundle = await this.contextSchemaService.getEffectiveBundle(request.departmentId ?? undefined);
    let bindings = openBindingsFromDefinition(bundle?.definition);

    // ── Pass 1: the department, and nothing else ────────────────────────────
    let departmentId = request.departmentId ?? undefined;
    const departmentBinding = bindings.department;
    if (departmentBinding && context[departmentBinding.kindKey] !== undefined) {
      const stated = await this.readDepartmentBindingValue(context, departmentBinding, departmentId);
      if (stated !== null) {
        const resolvedDepartmentId = await this.resolveDepartmentByBinding(tenantId, stated, departmentBinding.by);

        // D-2 - the two routes must AGREE. Deliberately the same posture as `CLINICIAN_MISMATCH`:
        // a caller that names a department twice and means two different ones has a broken
        // mapping table, and silent precedence either way would hide it until a note came out
        // under the wrong department's prompt.
        if (request.departmentId && request.departmentId !== resolvedDepartmentId) {
          throw new BadRequestException({
            message:
              '`departmentId` and the department named by the context payload are two different departments. Send one, or send both agreeing; this consultation belongs to exactly one.',
            code: 'DEPARTMENT_MISMATCH',
          });
        }

        if (resolvedDepartmentId !== departmentId) {
          departmentId = resolvedDepartmentId;
          bundle = await this.contextSchemaService.getEffectiveBundle(departmentId);
          bindings = openBindingsFromDefinition(bundle?.definition);
        }
      }
    }

    // ── Pass 2: every kind, against the department that will be written ─────
    const validatedKindKeys = await this.assertContextConformsToSchema(context, departmentId);
    const validated = new Set(validatedKindKeys);

    return {
      departmentId,
      visitTypeKey: bindings.visitType && validated.has(bindings.visitType.kindKey) ? this.matchStatedVisitType(tenantId, context, bindings.visitType) : null,
      externalRef: bindings.externalRef && validated.has(bindings.externalRef.kindKey) ? readBindingString(context, bindings.externalRef) : null,
      validatedKindKeys,
      identityBinding: bindings.userIdentity && validated.has(bindings.userIdentity.kindKey) ? bindings.userIdentity : null,
      materializeKindKeys: (bindings.materialize ?? []).filter((entry) => validated.has(entry.kindKey)).map((entry) => entry.kindKey),
      bundle,
    };
  }

  /**
   * Pass 1's narrow validation: the department binding's kind ALONE, against the bundle the
   * request's own `departmentId` selected.
   *
   * A validation refusal returns `null` rather than throwing - pass 2 will re-validate this same
   * kind with every other one and report the full set (see {@link resolveOpenContext}). Anything
   * that is NOT a validation refusal (a repository outage, a decryption failure) propagates
   * untouched, exactly as it does in `assertContextConformsToSchema`.
   */
  private async readDepartmentBindingValue(
    context: Record<string, unknown>,
    binding: { kindKey: string; field: string },
    departmentId: string | undefined,
  ): Promise<string | null> {
    try {
      await this.contextSchemaService!.validateContextPayload({
        kindKey: binding.kindKey,
        payload: context[binding.kindKey] as Record<string, unknown>,
        departmentId,
      });
    } catch (err) {
      if (!(err instanceof BadRequestException)) throw err;
      return null;
    }
    return readBindingString(context, binding);
  }

  /**
   * TASK-951 §D-2 - the tenant's department a stated code (or name) refers to.
   *
   * `by: 'code'` is the default and the only one ArcaAI uses: `Department.code` is
   * `@@unique([tenantId, code])`, so the answer is a row or nothing. `by: 'name'` exists because
   * some rosters carry no codes, and it is deliberately the AWKWARD one: names are not unique
   * (ArcaAI itself carries two rows called "General Medicine", which is what
   * `findAllByTenant`'s `id` tiebreak was added for), so more than one match is a 400 the caller
   * has to fix rather than a coin toss between two rows with completely different prompt
   * configuration.
   *
   * Both misses are 404 `DEPARTMENT_UNKNOWN`, which is the house posture for a cross-aggregate
   * reference the caller named and this tenant does not have (`assertParentInScope`'s own rule) -
   * an unknown code and another tenant's code are indistinguishable, on purpose.
   */
  private async resolveDepartmentByBinding(tenantId: string, stated: string, by: 'code' | 'name'): Promise<string> {
    if (by === 'code') {
      const department = await this.departmentRepository.findByCode(tenantId, stated);
      if (!department) {
        throw new NotFoundException({
          message: `No department of this tenant carries the code '${stated}'.`,
          code: 'DEPARTMENT_UNKNOWN',
        });
      }
      return department.id;
    }

    const wanted = stated.trim().toLowerCase();
    // ENABLED rows only (the repository's default), so a disabled department is "unknown" rather
    // than selectable - the same rule `findByCode` applies on the other branch.
    const matches = (await this.departmentRepository.findAllByTenant(tenantId)).filter((row) => (row.name ?? '').trim().toLowerCase() === wanted);

    if (matches.length === 0) {
      throw new NotFoundException({
        message: `No department of this tenant is named '${stated}'.`,
        code: 'DEPARTMENT_UNKNOWN',
      });
    }
    if (matches.length > 1) {
      throw new BadRequestException({
        message: `More than one department of this tenant is named '${stated}'. Name it by code, or send \`departmentId\`.`,
        code: 'DEPARTMENT_AMBIGUOUS',
      });
    }
    return matches[0].id;
  }

  /**
   * TASK-951 §D-3 - the visit type the caller STATED, as a catalogue key.
   *
   * Matched through `VisitTypeService.match`, so every alias the vocabulary already honours
   * resolves here too (`referral` -> `new-visit`, `follow-up` -> `revisit`). An UNMATCHABLE value
   * is a 400 rather than a silent fall-through to the parent link: the schema declared this field
   * as the visit type, so a value it cannot express is a caller error, and quietly documenting the
   * encounter under the other visit type's prompt is a wrong-prompt clinical failure.
   *
   * An ABSENT value is not an error - `required` on the kind is the tenant's own decision to make,
   * and a marker says what to do with a value when there is one (TASK-950 D-2).
   */
  private matchStatedVisitType(tenantId: string, context: Record<string, unknown>, binding: { kindKey: string; field: string }): ConsultationVisitTypeKey | null {
    const stated = readBindingString(context, binding);
    if (stated === null) return null;

    const matched = (this.visitTypes ?? DEFAULT_VISIT_TYPE_SERVICE).match(tenantId, stated);
    if (!matched) {
      throw new BadRequestException({
        message: `'${stated}' is not a visit type this platform knows. Send one of its keys or aliases (for example 'new-visit', 'referral', 'revisit', 'follow-up').`,
        code: 'VISIT_TYPE_INVALID',
      });
    }
    // `match` returned a catalogue ENTRY, so its key is one of the vocabulary's own. The cast
    // NAMES that fact rather than re-listing the two keys in a second file, which is exactly the
    // drift `visit-type.catalogue.ts` was written to end.
    return matched.key as ConsultationVisitTypeKey;
  }

  /**
   * TASK-950 §D-6 (b) - the clinician a SERVICE-ACCOUNT caller identified by STAFF ID.
   *
   * The tenant may mark ONE string property of ONE STRUCTURED kind as its user identity
   * (`userIdentity: { field }`). When the caller sent that kind and the value is a string, it is
   * resolved to a tenant user by `UserProfile.staffId` - provisioning one when the tenant allows
   * it - and that user becomes the acting clinician.
   *
   * The binding comes from the SAME cascade the validation resolved against, and only for kinds
   * that VALIDATED - both facts are settled in {@link resolveOpenContext}, which is why this now
   * takes a resolution rather than re-deriving one. TASK-951 makes that matter: with a
   * department binding in play, "the schema the payload was checked against" can be the
   * department's own, not the request's.
   *
   * Absent marker, absent kind, or a non-string value => `undefined`, and the caller falls back
   * to `clinicianUserId`. Everything else - an unknown staff id, an unusable user, an ambiguous
   * match, an unresolved department, a seat-quota refusal - is the identity service's own named
   * failure and propagates untouched (D-10); this method never re-labels one.
   */
  private async resolveIdentityClinicianId(
    tenantId: string,
    request: OpenConsultationRequest,
    resolved: ResolvedOpenContext,
    serviceAccountId: string,
  ): Promise<string | undefined> {
    const binding = resolved.identityBinding;
    if (!binding) return undefined;

    const staffId = extractUserIdentityValue(request.context, binding);
    if (typeof staffId !== 'string') return undefined;

    if (!this.userIdentityService) {
      this.logger.error({
        message:
          'The effective context schema declares a user-identity field but identity resolution is NOT WIRED - refusing rather than opening for the wrong clinician',
        kindKey: binding.kindKey,
        field: binding.field,
      });
      throw new ServiceUnavailableException('Context user-identity resolution is not available on this deployment');
    }

    const bundle = resolved.bundle;
    const provisioned = await this.userIdentityService.resolveOrProvision({
      tenantId,
      staffId,
      // TASK-951 - the RESOLVED department, so a user provisioned from a payload that named its
      // department by code lands in that department rather than in none.
      departmentId: resolved.departmentId ?? null,
      provenance: {
        plane: 'consultation-open',
        kindKey: binding.kindKey,
        field: binding.field,
        serviceAccountId,
        ...(bundle?.schemaId ? { schemaId: bundle.schemaId } : {}),
        ...(typeof bundle?.versionNumber === 'number' ? { versionNumber: bundle.versionNumber } : {}),
      },
    });

    return provisioned.userId;
  }

  /**
   * TASK-950 §D-6 (c) - WHO this consultation is for, once the context has been validated.
   *
   * | Caller | Outcome |
   * |---|---|
   * | human (JWT / API key) | the caller, exactly as before. The identity field, if the schema declares one and the payload carries it, was validated as content and is otherwise IGNORED (D-5) - a human already IS the clinician, and resolving someone else from a body field would be impersonation with no gate |
   * | machine, `clinicianUserId` only | that user (TASK-933, unchanged) |
   * | machine, identity value only | the user it resolves or provisions to |
   * | machine, BOTH and they agree | that user - one resolution, one clinician |
   * | machine, BOTH and they disagree | 400 `CLINICIAN_MISMATCH` (D-7): no silent precedence |
   * | machine, NEITHER | 400 `CLINICIAN_REQUIRED` - there is still no safe default |
   *
   * `named` is what decides whether `assertNamedClinicianMayOwnConsultation` runs below. It is
   * true for EVERY machine caller, resolved or named: a machine has proved nothing about the
   * person it acts for, and a freshly provisioned user is exactly as unproven as a named one
   * (it passes, because the role its tenant provisions with grants `create:Consultation` - but
   * it must be ASKED).
   */
  private async resolveActingClinician(
    tenantId: string,
    request: OpenConsultationRequest,
    callerClinicianId: string,
    resolved: ResolvedOpenContext,
  ): Promise<{ clinicianId: string; named: boolean }> {
    const serviceAccount = this.requestServiceAccount;

    if (!serviceAccount) {
      return { clinicianId: callerClinicianId, named: Boolean(request.clinicianUserId) };
    }

    const resolvedFromIdentity = await this.resolveIdentityClinicianId(tenantId, request, resolved, serviceAccount.id);
    const namedByCaller = request.clinicianUserId;

    if (namedByCaller && resolvedFromIdentity && namedByCaller !== resolvedFromIdentity) {
      throw new BadRequestException({
        message:
          '`clinicianUserId` and the user identified by the context payload are two different clinicians. Send one, or send both agreeing; this consultation belongs to exactly one person.',
        code: 'CLINICIAN_MISMATCH',
      });
    }

    const clinicianId = namedByCaller ?? resolvedFromIdentity;
    if (!clinicianId) {
      throw new BadRequestException({
        message:
          'A service account has no clinician of its own. Name the clinician this consultation belongs to with `clinicianUserId`, or send their staff identifier in the context field your schema marks as its user identity; a service account is never recorded as the doctor.',
        code: 'CLINICIAN_REQUIRED',
      });
    }

    return { clinicianId, named: true };
  }

  /**
   * TASK-951 §D-5 - the validated context, written down.
   *
   * Runs AFTER the consultation row exists and BEFORE dispatch, and that order is the whole
   * point of doing it here rather than leaving it to the caller: the warm-start pre-summary
   * reads `CASE_NOTE` items (`findCaseNotes()`), and a graph dispatched before they exist warm-
   * starts on nothing. It is also what lets an integrator drop its own post-open "push the prior
   * notes" loop - the values it already sent at open are the values that get persisted.
   *
   * Two writes per declaration, and they are different claims:
   *
   *   · one `STRUCTURED` item per validated kind, carrying `kindKey` and the canonical payload -
   *     "the client stated this, under this name, against this schema version";
   *   · for a kind the schema marks `materializeAs: 'CASE_NOTE'`, one `CASE_NOTE` per `notes[]`
   *     entry - "these are case notes", in the one shape every existing reader already knows.
   *
   * BEST-EFFORT, per item, and loudly. The row is already created and `ResourceCreated` already
   * broadcast, so throwing here would answer 500 for a consultation that exists - and because
   * `getOrCreate` is get-or-CREATE, the retry would return that same consultation and never
   * re-attempt the write. A failure therefore degrades to "the note is generated without the
   * prior context", which is a quality loss, not a blocked clinician; it is logged at ERROR with
   * the consultation and the kind so it is recoverable rather than invisible. The identical
   * argument the dispatch call below makes, for the identical reason.
   */
  private async persistOpenContext(consultationId: string, context: Record<string, unknown>, resolved: ResolvedOpenContext): Promise<void> {
    if (resolved.validatedKindKeys.length === 0) return;

    if (!this.contextService) {
      this.logger.warn({
        message: 'Context persistence is NOT WIRED - the values sent at open were mapped but no context item was written',
        consultationId,
        kindKeys: resolved.validatedKindKeys,
      });
      return;
    }

    const materialize = new Set(resolved.materializeKindKeys);

    for (const kindKey of resolved.validatedKindKeys) {
      const payload = context[kindKey] as Record<string, unknown> | undefined;
      if (!payload) continue;

      try {
        await this.contextService.addContext(consultationId, {
          type: ContextItemType.STRUCTURED,
          source: ContextItemSource.USER,
          kindKey,
          payload,
        });
      } catch (error) {
        this.logger.error({
          message: 'A context kind validated at open could not be persisted as a context item',
          consultationId,
          kindKey,
          error: error instanceof Error ? error.message : String(error),
        });
        // Deliberately CONTINUE: one unwritable kind must not cost the others, and the case
        // notes below are the ones the warm-start actually reads.
      }

      if (materialize.has(kindKey)) {
        await this.materializeCaseNotes(consultationId, kindKey, payload);
      }
    }
  }

  /**
   * TASK-951 §D-6 - the validated context, as the graph's trigger payload, or `null` when there
   * is none.
   *
   * Static and pure: it takes no decision, so keeping it off the instance says plainly that the
   * run payload is a PROJECTION of what was already validated, not a second source of facts.
   */
  private static authoredContextOf(context: Record<string, unknown> | undefined, validatedKindKeys: string[]): Record<string, unknown> | null {
    if (!context || validatedKindKeys.length === 0) return null;
    const authored: Record<string, unknown> = {};
    for (const kindKey of validatedKindKeys) {
      if (context[kindKey] !== undefined) authored[kindKey] = context[kindKey];
    }
    return Object.keys(authored).length > 0 ? authored : null;
  }

  /**
   * TASK-951 §D-5 - one `CASE_NOTE` item per entry of a kind marked `materializeAs`.
   *
   * The entries live under `notes`, which is the property name the marker's own publish gate
   * requires (an array of objects each carrying a string `text`) - so this reads a shape the
   * schema has already guaranteed rather than guessing at one. A payload that does not have it
   * writes nothing and says so; it cannot be a 400, because the payload VALIDATED.
   *
   * `title` and `text` are joined rather than stored separately because `ContextItem` has one
   * content column, and every reader of a case note (`findCaseNotes`, prompt assembly, the
   * shared-context join) reads exactly that column. The remaining fields (`date`, `department`,
   * `doctor`) stay addressable on the STRUCTURED item written beside these.
   */
  private async materializeCaseNotes(consultationId: string, kindKey: string, payload: Record<string, unknown>): Promise<void> {
    const notes = payload.notes;
    if (!Array.isArray(notes)) {
      this.logger.warn({
        message: "A kind marked `materializeAs: 'CASE_NOTE'` carried no `notes` array - nothing was materialized",
        consultationId,
        kindKey,
      });
      return;
    }

    for (const [index, entry] of notes.entries()) {
      if (typeof entry !== 'object' || entry === null) continue;
      const note = entry as Record<string, unknown>;
      const text = typeof note.text === 'string' ? note.text : '';
      if (text.length === 0) continue;
      const title = typeof note.title === 'string' && note.title.length > 0 ? note.title : null;

      try {
        await this.contextService!.addContext(consultationId, {
          type: ContextItemType.CASE_NOTE,
          source: ContextItemSource.USER,
          content: title ? `${title}\n${text}` : text,
          // Provenance, so a later reader can tell a note the client sent AT OPEN from one a
          // clinician wrote during the visit - they are the same type on purpose (every existing
          // reader must see both), and this is the only thing that distinguishes them.
          metadata: { origin: 'open.context', kindKey, index },
        });
      } catch (error) {
        this.logger.error({
          message: 'A case note supplied at open could not be persisted',
          consultationId,
          kindKey,
          index,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /**
   * Get or create consultation for (patientId, doctorId, appointmentDate)
   *
   * - If consultation exists: returns existing
   * - If not: creates new consultation
   *
   * `doctorId` is the clinician the CALLER resolves to: the authenticated human, or the user a
   * service account named with `clinicianUserId`. TASK-950 adds a third possibility — a machine
   * that identified its clinician by STAFF ID inside `request.context` — which only this service
   * can resolve, so the acting clinician is settled HERE (`resolveActingClinician`) and
   * `doctorId` is that decision's input, not its answer. For a human caller the two are always
   * the same value.
   */
  async getOrCreate(request: OpenConsultationRequest, doctorId: string): Promise<ConsultationResponse> {
    const tenantId = this.tenantId;
    const userId = this.requestUserId;

    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    // TASK-950 §D-6 / TASK-951 §D-2…D-4 — validate the context payload, MAP everything the
    // tenant's schema declares out of it (department, visit type, external reference), and settle
    // WHO this consultation is for — all BEFORE the tenant guard below and before anything is
    // written. Ordering is deliberate: a provisioned clinician must exist before
    // `assertCrossAggregateRefsInTenant` asks whether they belong to the tenant, a schema
    // violation must be a 400 rather than a 404 about a clinician the caller never named, and the
    // DEPARTMENT has to be settled before either, because it selects the schema the rest is
    // checked against.
    const openContext = await this.resolveOpenContext(tenantId, request);
    const { clinicianId: actingClinicianId, named: clinicianWasNamed } = await this.resolveActingClinician(
      tenantId,
      request,
      doctorId,
      openContext,
    );

    await this.assertCrossAggregateRefsInTenant(tenantId, {
      doctorId: actingClinicianId,
      // The RESOLVED department. When the payload named it, this is the row its code resolved to;
      // the guard still re-checks tenancy, because a repository answer is a reference like any
      // other. (`findByCode` is already tenant-scoped, so this can only ever agree — which is the
      // point: nothing reaches the factory without having passed the same guard.)
      departmentId: openContext.departmentId,
      parentConsultationId: request.parentConsultationId,
    });

    // TASK-933 §3.2 — when the DOCTOR was named by the caller rather than being the caller,
    // membership is not enough: the named user must also be able to own a consultation. Runs
    // AFTER the tenant guard above, so a foreign user is 404'd on tenancy before anything about
    // their privileges is computed. TASK-950 widens the trigger from "the caller sent
    // `clinicianUserId`" to "the clinician is not the caller" — a machine that identified its
    // clinician through the context payload has proved exactly as little about that person.
    if (clinicianWasNamed) {
      await this.assertNamedClinicianMayOwnConsultation(tenantId, actingClinicianId);
    }

    // point 6 — authorize the caller's workflow SELECTION here, before the
    // get-or-create branch and before any write.
    //
    // Order is the security property, twice over:
    //
    //   * BEFORE the write, because `dispatchForConsultation` is best-effort by contract and
    //     swallows its own failures. A gate placed inside it would turn a refused request into a
    //     201 whose consultation is quietly governed by something else.
    //   * BEFORE the existing-consultation lookup, because the answer to "may I select this
    //     workflow?" must not depend on whether a consultation for (patient, doctor, date)
    //     happens to already exist. Otherwise the status code itself reports that.
    await this.assertWorkflowSelectionAllowed(tenantId, request.workflowDefinitionSlug);

    // Use today's date if not provided
    const appointmentDate = request.appointmentDate ? new Date(request.appointmentDate) : new Date(new Date().toISOString().split('T')[0]); // Today, no time

    // Try to find existing consultation (first one if multiple exist)
    const existing = await this.consultationRepository.findByUniqueKey(tenantId, request.patientId, appointmentDate, actingClinicianId);

    if (existing) {
      // TASK-951 §D-5/D-6 — nothing is persisted or dispatched on this branch, for the same
      // reason the selection below is ignored: this consultation was already opened, with its own
      // context, and re-opening it must not append a second copy of the client's PRE items or
      // start a second governing run. The mappings above still ran, so a payload the schema does
      // not admit is still a 400 here rather than a silent 200.
      //
      // The selection was authorized above, but consultation-open dispatch fires on CREATE only,
      // so there is no dispatch left to steer. Say so rather than let the caller believe their
      // pick took effect — `GET /consultations/:id/workflow` reports what actually governs.
      if (request.workflowDefinitionSlug) {
        this.logger.log({
          message: 'Workflow selection ignored — this consultation is already open and its governing engine was decided at its own open',
          consultationId: existing.id,
          requestedWorkflowDefinitionSlug: request.workflowDefinitionSlug,
        });
      }

      this.broadcastSysEvent(SysEventType.ResourceViewed, {
        resourceId: existing.id,
        data: { action: 'getOrCreate', found: true },
      });
      const withRelations = await this.consultationRepository.findWithRelations(existing.id);
      return ConsultationDtoMapper.toResponse(withRelations ?? existing, false);
    }

    // A genuinely NEW consultation consumes a monthly
    // meter unit. Only the create branch is metered (returning an existing
    // consultation does not). Kill-switch-gated; → 429 when over the cap.
    await this.entitlements?.assertMeterQuota(tenantId, 'monthlyConsultations');

    // Create new consultation
    // lane A — record the AUTHORIZED selection on the row itself, here, before dispatch
    // is even attempted.
    //
    // The only existing record of a caller's pick is `metadata.governingEngine`, and that marker
    // requires a non-empty `workflowRunId` — so it exists ONLY when the durable dispatch actually
    // started a Temporal run. Every other outcome (harness unreachable, no claim-check storage,
    // dispatcher not wired, definition without a compiled config) returns `dispatched: false` and
    // leaves nothing behind, and those are precisely the deployments where the REALTIME lane still
    // runs. Without this write, the realtime resolver has nothing to honour and the clinician
    // silently gets the tenant default's live nodes.
    //
    // Two keys, two claims: `workflowSelection` says what was ASKED FOR, `governingEngine` says
    // what TOOK OWNERSHIP. Neither is inferred from the other. Caller metadata is merged, not
    // replaced — see `workflow-selection.ts` for why the key is not stripped from caller input.
    const withSelection = request.workflowDefinitionSlug
      ? withWorkflowSelectionMarker(request.metadata, request.workflowDefinitionSlug)
      : request.metadata;
    // TASK-932 §3.7 — the declared SUMMARY language, recorded on the row so the realtime frame
    // and the finalize prompt read one value rather than each re-deriving one. Applied AFTER the
    // selection marker for the same reason that one merges rather than replaces: client metadata
    // from `OpenConsultationRequest` survives untouched, and the two markers are independent.
    const withLanguage = request.language ? withSummaryLanguage(withSelection, request.language) : withSelection;
    // TASK-951 §D-3/D-4 — the two facts the caller STATED through its schema. Applied last, so a
    // schema-declared value wins over the same key hand-posted in `metadata`: this one was
    // validated against the tenant's pinned schema and alias-matched through the visit-type
    // catalogue, and that one was neither. See `open-markers.ts` for why neither is stripped.
    const withVisitType = openContext.visitTypeKey ? withVisitTypeMarker(withLanguage, openContext.visitTypeKey) : withLanguage;
    const metadata = openContext.externalRef ? withExternalRefMarker(withVisitType, openContext.externalRef) : withVisitType;

    const consultation = ConsultationFactory.CreateNewVisit({
      tenantId,
      patientId: request.patientId,
      appointmentDate,
      doctorId: actingClinicianId,
      departmentId: openContext.departmentId,
      metadata: metadata as Parameters<typeof ConsultationFactory.CreateNewVisit>[0]['metadata'],
      createdBy: userId ?? undefined,
    });

    // If parentConsultationId provided, set it (for re-visits/referrals)
    if (request.parentConsultationId) {
      consultation.parentConsultationId = request.parentConsultationId;
    }

    const saved = await this.consultationRepository.create(consultation);

    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceId: saved.id,
      createdAt: saved.createdAt,
      data: { action: 'getOrCreate', created: true },
    });

    // ─── Consent ( owner directive, 2026-08-25) ───
    //
    // A doctor opening a consultation IS the consent event: the clinician is
    // with the patient and attests, by that act, that the patient consented to
    // every purpose. Grants are written here — inside the doctor's own request
    // context, so `grantedBy` is the doctor and each row lands on the WORM
    // ledger — because `POST /admin/consent-grants` requires
    // `manage:ConsentGrant`, a TENANT-ADMIN ability no clinician holds. Before
    // this, a doctor could open a consultation they were then forbidden to
    // record and forbidden to fix (403 `Missing permissions: manage:ConsentGrant`).
    //
    // FAIL-CLOSED, unlike the best-effort workflow dispatch below. Once opening
    // a consultation MEANS consent was recorded, a consultation whose consent
    // did not persist is not "opened with a degraded feature" — it is a
    // consultation the clinician cannot record and cannot repair. Failing here
    // surfaces that immediately and retryably, instead of as a mystifying 403
    // at the moment they press Record.
    if (!this.consentGrantService) {
      this.logger.warn({
        message: 'Consent grant service is NOT WIRED — recording this consultation will be refused by PatientConsentGuard',
        consultationId: saved.id,
      });
    } else {
      await this.consentGrantService.ensureConsultationConsent(saved.patientId);
    }

    // TASK-951 §D-5 — write the validated context down, BEFORE dispatch. The warm-start
    // pre-summary reads `CASE_NOTE` items, so a graph dispatched first would warm-start on
    // nothing. Best-effort by contract — see `persistOpenContext`.
    if (request.context) {
      await this.persistOpenContext(saved.id, request.context, openContext);
    }

    // the ONE place `WorkflowRun.trigger = 'consultation open'` is stamped.
    // Fires only on CREATE: `getOrCreate`'s existing-consultation branch returns earlier, so a
    // re-opened consultation is never dispatched twice. Best-effort by contract — the dispatch
    // service swallows its own failures and returns `dispatched: false`, because a harness
    // outage must never stop a clinician opening a consultation.
    // day-1: which engine governs a consultation must be OBSERVABLE. Every outcome
    // including "the dispatcher is not wired" and "no tenant workflow is assigned" — is logged.
    // Both of those were previously SILENT, so a consultation that quietly fell through to the
    // default engine was indistinguishable from one the dispatcher had never been asked about.
    // TASK-951 §D-6 — built from the VALIDATED kind keys rather than from `request.context`
    // wholesale. The two are the same set whenever validation passed (it throws on any problem),
    // so this is not a filter so much as a statement: only what the tenant's own schema admits
    // reaches the graph's trigger context.
    const authoredContext = ConsultationService.authoredContextOf(request.context, openContext.validatedKindKeys);

    if (!this.workflowDispatchService) {
      this.logger.warn({
        message: 'Consultation workflow dispatch is NOT WIRED — the default loop governs by omission, not by decision',
        consultationId: saved.id,
      });
    } else {
      const dispatch = await this.workflowDispatchService.dispatchForConsultation({
        consultationId: saved.id,
        tenantId,
        departmentId: saved.departmentId,
        // TASK-950 — the ROW's clinician, not the `doctorId` PARAMETER. For a machine that
        // identified its clinician by staff id the parameter carries no user at all, so reading
        // it here would hand the harness `null` for a consultation that has a doctor. `saved`
        // is the same value in every other case, so nothing else changes.
        userId: userId ?? saved.doctorId,
        externalPatientId: saved.patientId,
        // Already authorized above; the dispatcher re-verifies rather than trusts.
        workflowDefinitionSlug: request.workflowDefinitionSlug,
        // TASK-891 — threaded in, not re-read by the dispatcher: it derives the reserved
        // `visit-type:<key>` selector tag (OD-2/OD-3) from this, and dispatch is best-effort by
        // contract, so a DB read inside it would change its failure profile. `saved` already
        // carries this fact (set a few lines above), so no extra read is needed here either.
        parentConsultationId: saved.parentConsultationId ?? null,
        // TASK-951 §D-3 — the RECORDED visit type, read off the row rather than from
        // `openContext`, so the dispatcher's selector tag is derived from exactly the value every
        // LATER reader (summary, pre-summary, harness assemble, gate-edit mining) will read.
        visitType: readRecordedVisitType(saved.metadata),
        // TASK-951 §D-6 — the AUTHORED context, so `trigger.context.*` resolves to what the
        // client actually sent. It rides `payload`, which the dispatcher strips every reserved
        // identity key out of before forwarding — identity travels on `subject` and only there.
        authoredContext: authoredContext ?? undefined,
      });
      this.logger.log({
        message: dispatch.dispatched
          ? 'Consultation governed by a tenant-authored workflow'
          : 'Consultation governed by the default loop (no tenant workflow resolved)',
        consultationId: saved.id,
        departmentId: saved.departmentId ?? null,
        dispatched: dispatch.dispatched,
        source: dispatch.source,
        workflowDefinitionSlug: dispatch.workflowDefinitionSlug,
        runId: dispatch.runId,
        skippedReason: dispatch.skippedReason,
      });
    }

    const savedWithRelations = await this.consultationRepository.findWithRelations(saved.id);
    return ConsultationDtoMapper.toResponse(savedWithRelations ?? saved, true);
  }

  /**
   * Create a re-visit/follow-up consultation
   */
  async createRevisit(request: OpenConsultationRequest, doctorId: string, parentConsultationId: string): Promise<ConsultationResponse> {
    const tenantId = this.tenantId;
    const userId = this.requestUserId;

    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    // Verify all cross-aggregate refs (parent, department,
    // doctor) live in the caller's tenant before any factory call. The
    // helper throws NotFoundException on miss / cross-tenant to keep this
    // behaviour indistinguishable from "resource does not exist".
    await this.assertCrossAggregateRefsInTenant(tenantId, {
      doctorId,
      departmentId: request.departmentId,
      parentConsultationId,
    });

    // a re-visit does not dispatch a consultation workflow at all (only `getOrCreate`
    // stamps `trigger: 'consultation open'`), so a selector here has nothing to steer. Logged
    // rather than silently dropped; the DTO field documents that `open` is the only route that
    // honours it.
    if (request.workflowDefinitionSlug) {
      this.logger.log({
        message: 'Workflow selection ignored — a re-visit dispatches no consultation workflow',
        parentConsultationId,
        requestedWorkflowDefinitionSlug: request.workflowDefinitionSlug,
      });
    }

    const appointmentDate = request.appointmentDate ? new Date(request.appointmentDate) : new Date(new Date().toISOString().split('T')[0]);

    // A re-visit is also a new consultation for meter
    // purposes. Kill-switch-gated; → 429 when over the rolling-monthly cap.
    await this.entitlements?.assertMeterQuota(tenantId, 'monthlyConsultations');

    // TASK-932 §3.7 — a re-visit is a new consultation, so it declares its own summary language.
    // It is NOT inherited from the parent: a follow-up may legitimately be documented in another
    // language, and inferring one from a visit weeks ago would be a decision nobody made.
    const revisitMetadata = request.language ? withSummaryLanguage(request.metadata, request.language) : request.metadata;

    const consultation = ConsultationFactory.CreateRevisit({
      tenantId,
      patientId: request.patientId,
      appointmentDate,
      doctorId,
      departmentId: request.departmentId,
      parentConsultationId,
      metadata: revisitMetadata as Parameters<typeof ConsultationFactory.CreateRevisit>[0]['metadata'],
      createdBy: userId ?? undefined,
    });

    const saved = await this.consultationRepository.create(consultation);

    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceId: saved.id,
      createdAt: saved.createdAt,
      data: { action: 'createRevisit', parentId: parentConsultationId },
    });

    return ConsultationDtoMapper.toResponse(saved, true);
  }

  /**
   * Get consultation by ID with context
   *
   * Defense-in-depth: the Prisma
   * `tenantScope` extension already filters foreign-tenant rows on
   * `findWithContext`, but an explicit service-layer assert provides a
   * second line so the method still refuses to leak data if the
   * extension is ever bypassed (raw query, platform-admin path, stale
   * CLS in a background job). `assertEqualTenants` throws a generic
   * `NotFoundException('Resource not found')` on mismatch — no model /
   * id echo — and `BadRequestException` when CLS has no tenant.
   *
   * The missing-CLS check is hoisted to the
   * top of the method so unprovisioned background calls fail closed
   * BEFORE the repo round-trip, matching the `getConsultationChain`
   * convention.
   */
  async getById(id: string): Promise<ConsultationResponse | null> {
    if (!this.tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    const consultation = await this.consultationRepository.findWithContext(id);
    if (!consultation) return null;

    assertEqualTenants(consultation, { tenantId: this.tenantId });

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      resourceId: consultation.id,
      data: { id: consultation.id },
    });

    return ConsultationDtoMapper.toResponseWithContext(consultation);
  }

  /**
   * Get consultation by ID with all relations (Doctor, Department, Context)
   *
   * Defense-in-depth: same posture as
   * `getById`. The Prisma `tenantScope` extension filters foreign-tenant
   * rows on `findWithRelations`, but the service-layer assert provides
   * an explicit second line on PHI relations so an extension bypass or
   * stale-CLS background call still fails closed with a generic
   * `NotFoundException('Resource not found')`.
   *
   * The missing-CLS check is hoisted to the
   * top of the method (same posture as `getById`); the relations join
   * is more expensive than a single-row read, so the saved round-trip
   * is even more useful here.
   */
  async getByIdWithRelations(id: string): Promise<ConsultationResponse | null> {
    if (!this.tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    const consultation = await this.consultationRepository.findWithRelations(id);
    if (!consultation) return null;

    assertEqualTenants(consultation, { tenantId: this.tenantId });

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      resourceId: consultation.id,
      data: { id: consultation.id, withRelations: true },
    });

    return ConsultationDtoMapper.toResponseWithContext(consultation);
  }

  /**
   * Get all consultations for a patient (across all dates and doctors)
   */
  async getPatientHistory(patientId: string): Promise<ConsultationResponse[]> {
    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    const consultations = await this.consultationRepository.findAll({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      filters: { tenantId, patientId } as any,
      sort: [{ appointmentDate: 'desc' }],
    });

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      data: { patientId, historyCount: consultations.length },
    });

    return consultations.map((c) => ConsultationDtoMapper.toResponse(c));
  }

  /**
   * Get all consultations for a patient on a specific date (all doctors)
   */
  async getByPatientAndDate(patientId: string, date: string): Promise<ConsultationResponse[]> {
    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    const consultations = await this.consultationRepository.findByPatientAndDate(tenantId, patientId, new Date(date));

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      data: { patientId, date, count: consultations.length },
    });

    return consultations.map((c) => ConsultationDtoMapper.toResponse(c));
  }

  /**
   * Get consultation chain (parent + all children)
   *
   * Defense-in-depth: unlike the two
   * single-id reads, the chain query joins by `parentConsultationId` and
   * can in principle return rows from multiple tenants if the FK was
   * ever poisoned cross-tenant (or the Prisma extension is bypassed).
   *
   * The service therefore:
   *   1. Fails closed when CLS has no tenant (no background reads).
   *   2. Filters the returned chain to the caller's tenant BEFORE
   *      mapping to DTO so foreign-tenant rows are never serialised.
   *   3. Throws `NotFoundException` when the repo did return rows but
   *      NONE belong to the caller — returning `[]` in that case would
   *      leak existence by absence (caller learns the chain root is
   *      visible to *someone*, just not them).
   */
  async getConsultationChain(consultationId: string): Promise<ConsultationResponse[]> {
    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    const consultations = await this.consultationRepository.findConsultationChain(consultationId);

    const inTenant = consultations.filter((c) => c.tenantId === tenantId);

    if (consultations.length > 0 && inTenant.length === 0) {
      throw new NotFoundException('Resource not found');
    }

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      data: { consultationId, chainCount: inTenant.length },
    });

    return inTenant.map((c) => ConsultationDtoMapper.toResponse(c));
  }

  /**
   * Get paginated consultation history for a patient.
   *
   * Uses the repository's findAll with skip/take for efficient DB-level pagination.
   */
  async getPatientHistoryPaginated(patientId: string, page: number, limit: number): Promise<PaginatedConsultationResponse> {
    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    const [consultations, count] = await Promise.all([
      this.consultationRepository.findPaginatedWithRelations({
        filters: { tenantId, patientId },
        sort: [{ appointmentDate: 'desc' }],
        page,
        limit,
      }),
      this.consultationRepository.count({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        filters: { tenantId, patientId } as any,
      }),
    ]);

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      data: { patientId, page, limit, count },
    });

    return {
      data: consultations.map((c) => ConsultationDtoMapper.toResponse(c)),
      count,
      page,
      limit,
    };
  }

  /**
   * Get paginated consultations for a patient on a specific date.
   *
   * Since same-day consultations are typically a small set, this still
   * fetches all and paginates in memory. For extremely large result sets,
   * a dedicated repository method with skip/take would be preferred.
   */
  async getByPatientAndDatePaginated(patientId: string, date: string, page: number, limit: number): Promise<PaginatedConsultationResponse> {
    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    const allConsultations = await this.consultationRepository.findByPatientAndDate(tenantId, patientId, new Date(date));

    const count = allConsultations.length;
    const skip = (page - 1) * limit;
    const pageData = allConsultations.slice(skip, skip + limit);

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      data: { patientId, date, page, limit, count },
    });

    return {
      data: pageData.map((c) => ConsultationDtoMapper.toResponse(c)),
      count,
      page,
      limit,
    };
  }

  /**
   * List consultations the doctor owns plus consultations from other
   * doctors for patients the doctor has a relationship with (shared-patient
   * access for continuity of care).
   */
  async listConsultations(params: { page: number; pageSize: number; doctorId?: string; patientId?: string }): Promise<PaginatedConsultationResponse> {
    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    const { page, pageSize, doctorId, patientId } = params;

    if (doctorId) {
      const sharedPatientIds = await this.consultationRepository.findDistinctPatientIds(tenantId, doctorId);

      const [consultations, count] = await Promise.all([
        this.consultationRepository.findPaginatedWithSharedAccess({
          tenantId,
          doctorId,
          sharedPatientIds,
          patientIdFilter: patientId,
          sort: [{ appointmentDate: 'desc' }],
          page,
          limit: pageSize,
        }),
        this.consultationRepository.countWithSharedAccess({
          tenantId,
          doctorId,
          sharedPatientIds,
          patientIdFilter: patientId,
        }),
      ]);

      this.broadcastSysEvent(SysEventType.ResourceViewed, {
        data: { page, pageSize, doctorId, patientId, count },
      });

      return {
        data: consultations.map((c) => ConsultationDtoMapper.toResponse(c)),
        count,
        page,
        limit: pageSize,
      };
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const filters: any = { tenantId };
    if (patientId) filters.patientId = patientId;

    const [consultations, count] = await Promise.all([
      this.consultationRepository.findPaginatedWithRelations({
        filters,
        sort: [{ appointmentDate: 'desc' }],
        page,
        limit: pageSize,
      }),
      this.consultationRepository.count({ filters }),
    ]);

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      data: { page, pageSize, doctorId, patientId, count },
    });

    return {
      data: consultations.map((c) => ConsultationDtoMapper.toResponse(c)),
      count,
      page,
      limit: pageSize,
    };
  }

  /**
   * Admin/tenant-wide listing.
   *
   * Lists EVERY consultation in the caller's tenant (no owner/shared-patient
   * scoping). Reached only from the admin surface (`/admin/consultations`,
   * gated by `@CanManage('Consultation')`). Tenant isolation is still enforced
   * by the `tenantScopeFilter` Prisma extension, so the explicit `tenantId`
   * filter here is defense-in-depth.
   */
  async listConsultationsForTenant(params: {
    page: number;
    pageSize: number;
    patientId?: string;
    doctorId?: string;
    departmentId?: string;
    status?: ConsultationStatus;
  }): Promise<PaginatedConsultationResponse> {
    const tenantId = this.tenantId;
    // (TD3 / DEF-1) — a SUPER_ADMIN with NO tenant scope reads
    // cross-tenant: the Prisma `tenantScope` extension passes through when CLS
    // has no tenant AND the caller is super-admin, so we OMIT the `tenantId`
    // filter and the platform dashboard sees every tenant's consultations
    // (was: a hard 400). A non-super caller still requires a tenant context,
    // and a super-admin pinned to a working tenant (CLS tenantId set) stays
    // scoped to that tenant.
    if (!tenantId && !isSuperAdmin(this.requestUser)) {
      throw new BadRequestException('Tenant ID is required');
    }

    const { page, pageSize, patientId, doctorId, departmentId, status } = params;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const filters: any = {};
    if (tenantId) filters.tenantId = tenantId;
    if (patientId) filters.patientId = patientId;
    if (doctorId) filters.doctorId = doctorId;
    if (departmentId) filters.departmentId = departmentId;
    // Optional lifecycle-status filter (indexed by [tenantId, status]);
    // the admin live console uses ?status=RECORDING to find in-progress recordings.
    if (status) filters.status = status;

    const [consultations, count] = await Promise.all([
      this.consultationRepository.findPaginatedWithRelations({
        filters,
        sort: [{ appointmentDate: 'desc' }],
        page,
        limit: pageSize,
      }),
      this.consultationRepository.count({ filters }),
    ]);

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      data: { scope: tenantId ? 'tenant' : 'all', page, pageSize, patientId, doctorId, departmentId, status, count },
    });

    return {
      data: consultations.map((c) => ConsultationDtoMapper.toResponse(c)),
      count,
      page,
      limit: pageSize,
    };
  }

  /**
   * Server-side, zero-filled date-range aggregation of
   * new vs. revisit consultation counts. Replaces the FE's client-side
   * single-page bucketing (`apps/admin/src/features/tenant-dashboard/chart.ts`)
   * which under-counts long ranges.
   *
   *   - new vs. revisit: `parentConsultationId IS NULL` ⇒ new visit, else revisit.
   *   - granularity: caller may force `day`/`month`; otherwise a span > 70 days
   *     rolls up to months (mirrors the FE `granularityFor` heuristic).
   *   - bucket key/label match the FE format (`yyyy-MM-dd`/`MMM d` for days,
   *     `yyyy-MM`/`MMM` for months) so the chart renders unchanged; boundaries
   *     are UTC (server-TZ-stable) rather than the FE's local-time `startOfDay`.
   *   - scope: SUPER_ADMIN with no working tenant aggregates cross-tenant
   *     (TD3); everyone else is pinned to their CLS tenant.
   */
  async aggregateConsultationsForTenant(params: {
    from: string | Date;
    to: string | Date;
    granularity?: 'day' | 'month';
  }): Promise<ConsultationAggregateResponse> {
    const tenantId = this.tenantId;
    if (!tenantId && !isSuperAdmin(this.requestUser)) {
      throw new BadRequestException('Tenant ID is required');
    }

    const fromDate = new Date(params.from);
    const toDate = new Date(params.to);
    if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
      throw new BadRequestException('Invalid from/to date');
    }
    if (fromDate.getTime() > toDate.getTime()) {
      throw new BadRequestException('`from` must be on or before `to`');
    }

    const spanDays = Math.floor((toDate.getTime() - fromDate.getTime()) / 86_400_000);
    const granularity: 'day' | 'month' = params.granularity ?? (spanDays > 70 ? 'month' : 'day');

    const buckets = buildAggregateBuckets(fromDate, toDate, granularity);
    const counts = buckets.map(() => ({ newVisits: 0, revisits: 0 }));

    const rangeStart = buckets[0]?.start ?? startOfUtcDay(fromDate);
    const rangeEnd = buckets[buckets.length - 1]?.end ?? endOfUtcDay(toDate);

    // Routed through ConsultationRepository; the
    // repository applies the same createdAt range + optional-tenant filter.
    const rows = await this.consultationRepository.findCreatedInRange(rangeStart, rangeEnd, tenantId);

    for (const row of rows) {
      const ts = row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt as unknown as string);
      if (Number.isNaN(ts.getTime())) continue;
      const idx = buckets.findIndex((b) => ts >= b.start && ts <= b.end);
      if (idx === -1) continue;
      if (row.parentConsultationId) counts[idx].revisits += 1;
      else counts[idx].newVisits += 1;
    }

    const resultBuckets = buckets.map((b, i) => ({
      key: b.key,
      label: b.label,
      start: b.start.toISOString(),
      end: b.end.toISOString(),
      newVisits: counts[i].newVisits,
      revisits: counts[i].revisits,
      total: counts[i].newVisits + counts[i].revisits,
    }));

    const totals = resultBuckets.reduce(
      (acc, b) => ({ total: acc.total + b.total, newVisits: acc.newVisits + b.newVisits, revisits: acc.revisits + b.revisits }),
      { total: 0, newVisits: 0, revisits: 0 },
    );

    return { buckets: resultBuckets, totals, granularity, refreshedAt: new Date().toISOString() };
  }

  async doctorHasPatientRelationship(doctorId: string, patientId: string, tenantId: string): Promise<boolean> {
    const count = await this.consultationRepository.count({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      filters: { tenantId, doctorId, patientId } as any,
    });
    return count > 0;
  }

  // ============================================
  // session state machine
  //
  // `Consultation.status` is now the ONLY lifecycle tracker (the legacy
  // `metadata.status` JSON key is deleted — see the removed `readStatus`/
  // `transitionStatus` this replaces). Every write goes through
  // `ConsultationEntity.transitionTo`, the single guarded path that
  // consults the legality matrix

  // `transitionTo` itself handles the idempotent self-transition
  // no-op; the two terminal-close methods add one further no-op check
  // (already-terminal → already-terminal is not a self-pair in the
  // matrix's sense, since CLOSED_COMPLETE and CLOSED_INCOMPLETE are two
  // distinct targets — see `closeConsultation`).
  // ============================================

  /**
   * Illegal `transitionTo` calls throw a bare domain `BusinessException`
   * (packages/domains has no HTTP awareness). Surfaced to callers as
   * `409 Conflict` — the RFC-correct code for "this write conflicts with
   * the resource's current state" — via the generic
   * `ExceptionInterceptor` `BaseException` branch, which today maps to
   * `500` for the whole `BusinessException` family (most of which is
   * ordinary entity-validation, not a conflict). Catching it HERE, at the
   * one call site this ticket controls, avoids reclassifying every other
   * `BusinessException` use in the codebase.
   */
  private applyTransition(entity: ConsultationEntity, next: ConsultationStatus, actor: string, reason: string): boolean {
    try {
      return entity.transitionTo(next, actor, reason);
    } catch (err) {
      if (err instanceof BusinessException) {
        throw new ConflictException(err.message);
      }
      throw err;
    }
  }

  /**
   * Best-effort WORM append for a ROUTINE transition ( pitfall
   * 6): a failure here is logged but never rolls back the (already
   * persisted) status write — only the `SIGNED` write itself
   * (`summary.service.ts#approveSummary`) stays fail-closed.
   */
  private async appendTransitionAudit(input: {
    tenantId: string;
    consultationId: string;
    action: HarnessAuditAction;
    actor: string;
    /** TASK-972 Lane 1 — the CREDENTIAL that submitted the transition, when it is not the actor. */
    submittedBy?: string | null;
  }): Promise<void> {
    if (!this.harnessAuditService) return;
    try {
      await this.harnessAuditService.append({
        tenantId: input.tenantId,
        consultationId: input.consultationId,
        action: input.action,
        modelName: 'session-lifecycle',
        modelVersion: 'v1',
        sensorScores: {},
        citations: [],
        clinicianId: input.actor === 'system' ? null : input.actor,
        // `clinicianId` is WHOSE transition this is; `createdBy` is WHICH credential submitted
        // it. They differ only when a machine acts for a named clinician (TASK-972 Lane 1).
        createdBy: input.submittedBy ?? (input.actor === 'system' ? null : input.actor),
      });
    } catch (error) {
      this.logger.warn({
        message: 'WORM append failed for a routine session transition (non-fatal, status write not rolled back)',
        consultationId: input.consultationId,
        action: input.action,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * `OPEN → PRIMED` — the first checkpoint of the session state machine.
   * Idempotent (no-op if already `PRIMED`, per `transitionTo`).
   *
   * Consent is NOT asserted here: `POST :id/prime`
   * (apps/api) carries `@RequiresConsent`, the single choke point
   * that already runs before this method is reached — duplicating the
   * check here would be a second source of truth for the same decision.
   */
  async primeConsultation(id: string, expectedVersion?: number): Promise<ConsultationResponse> {
    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    const consultation = await this.consultationRepository.findWithRelations(id);
    if (!consultation) {
      throw new NotFoundException('Consultation not found');
    }
    assertEqualTenants(consultation, { tenantId });

    const actor = this.requestUserId ?? 'system';
    const applied = this.applyTransition(consultation, ConsultationStatus.PRIMED, actor, 'primeConsultation');
    if (!applied) {
      return ConsultationDtoMapper.toResponseWithContext(consultation);
    }

    if (this.requestUserId) {
      consultation.updatedBy = this.requestUserId;
    }
    // The client-supplied `If-Match`/`@ExpectedVersion()` CAS predicate, when
    // present (the `@RequiresIfMatch()`-gated route always supplies one) —
    // otherwise the freshly-read row version (defense-in-depth against a
    // concurrent write landing between our read and write).
    const updated = await this.consultationRepository.updateWithVersion(id, consultation, expectedVersion ?? consultation.version);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: id,
      data: { action: 'primeConsultation', status: ConsultationStatus.PRIMED },
    });
    await this.appendTransitionAudit({ tenantId, consultationId: id, action: HarnessAuditAction.SESSION_PRIMED, actor });

    // Map the FRESHLY-PERSISTED entity, not the stale pre-write one: updateWithVersion
    // bumps _version, so returning `consultation` handed the caller version N while the
    // row was already at N+1 — any client chaining If-Match from this response got an
    // immediate 412. Mirrors the house pattern in department.service.ts:318.
    return ConsultationDtoMapper.toResponseWithContext(updated);
  }

  /**
   * Close a consultation. The target terminal is DERIVED from the current
   * status, per :
   *   - `SIGNED → CLOSED_COMPLETE` (a human gave clinical feedback)
   *   - `TIMED_OUT → CLOSED_INCOMPLETE` (manual close before the sweep fires)
   * Any other predecessor is illegal (→ 409) — "how do I close an unsigned,
   * still-active consultation?" is answered by the matrix itself: you
   * cannot, until it either signs or times out. Idempotent: already
   * `CLOSED_COMPLETE`/`CLOSED_INCOMPLETE` (or the superseded, dead
   * `CLOSED`) short-circuits with no write.
   */
  async closeConsultation(
    id: string,
    expectedVersion?: number,
    options?: { clinicianUserId?: string; caller?: ClinicalCaller },
  ): Promise<ConsultationResponse> {
    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    const consultation = await this.consultationRepository.findWithRelations(id);
    if (!consultation) {
      throw new NotFoundException('Consultation not found');
    }
    assertEqualTenants(consultation, { tenantId });

    if (
      consultation.status === ConsultationStatus.CLOSED_COMPLETE ||
      consultation.status === ConsultationStatus.CLOSED_INCOMPLETE ||
      consultation.status === ConsultationStatus.CLOSED
    ) {
      return ConsultationDtoMapper.toResponseWithContext(consultation);
    }

    // TASK-972 Lane 1 — WHOSE close this is, and WHICH credential submitted it. Resolved AFTER
    // the terminal short-circuit above: an already-closed consultation is answered, not re-ruled.
    const { clinicianId: actor, caller: submitter } = await this.resolveAttributedActor(tenantId, options?.clinicianUserId, options?.caller);
    const target = consultation.status === ConsultationStatus.SIGNED ? ConsultationStatus.CLOSED_COMPLETE : ConsultationStatus.CLOSED_INCOMPLETE;
    const worm =
      target === ConsultationStatus.CLOSED_COMPLETE ? HarnessAuditAction.SESSION_CLOSED_COMPLETE : HarnessAuditAction.SESSION_CLOSED_INCOMPLETE;

    // Always applies (from !== target — the terminal-idempotency check above
    // already ruled out every self-pair), so no `applied` guard is needed.
    this.applyTransition(consultation, target, actor, 'closeConsultation');

    consultation.updatedBy = actor;
    const updated = await this.consultationRepository.updateWithVersion(id, consultation, expectedVersion ?? consultation.version);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: id,
      responsibleEntityId: actor,
      data: {
        action: 'closeConsultation',
        status: target,
        actorPrincipalId: submitter.principalId,
        actorCredentialClass: submitter.credentialClass,
      },
    });
    await this.appendTransitionAudit({ tenantId, consultationId: id, action: worm, actor, submittedBy: submitter.principalId || actor });

    // Map the FRESHLY-PERSISTED entity, not the stale pre-write one: updateWithVersion
    // bumps _version, so returning `consultation` handed the caller version N while the
    // row was already at N+1 — any client chaining If-Match from this response got an
    // immediate 412. Mirrors the house pattern in department.service.ts:318.
    return ConsultationDtoMapper.toResponseWithContext(updated);
  }

  /**
   * TASK-972 Lane 1 — the clinician a lifecycle write is attributed to, and the credential that
   * submitted it. Named `resolveAttributedActor` rather than `resolveActingClinician` because
   * that name is already taken here by TASK-950's OPEN-time resolver, which answers a different
   * question (who the consultation BELONGS to, from a context payload). The same three steps as
   * `SummaryService.resolveActingClinician`, and
   * deliberately the same implementation (`consultation/summary/clinician-attribution.ts`): a
   * clinician who may sign a note and a clinician who may close its session are the same person,
   * and two copies of that rule would drift.
   */
  private async resolveAttributedActor(
    tenantId: string,
    named: string | undefined,
    caller: ClinicalCaller | undefined,
  ): Promise<{ clinicianId: string; caller: ClinicalCaller }> {
    const serviceAccount = this.requestServiceAccount;
    const effectiveCaller: ClinicalCaller =
      caller ??
      (serviceAccount
        ? { credentialClass: 'service-account', principalId: serviceAccount.id }
        : { credentialClass: 'jwt', principalId: this.requestUserId ?? '' });

    const clinicianId = await resolveAttributedClinician({
      named,
      caller: effectiveCaller,
      tenantId,
      requestUser: this.requestUser,
      readTenantRoles: tenantRoleReaderFor(this.userRoleAssignmentRepository),
    });

    if (clinicianId !== this.requestUserId) {
      await assertAttributedClinicianInTenant(
        {
          userRoleAssignmentRepository: this.userRoleAssignmentRepository,
          userDepartmentRepository: this.userDepartmentRepository,
          userRepository: this.userRepository,
        },
        clinicianId,
        tenantId,
      );
    }

    return { clinicianId, caller: effectiveCaller };
  }

  /**
   * Reopen a consultation → `REOPENED`. Legal from `TIMED_OUT`, `SIGNED`,
   * `CLOSED_COMPLETE`, or `CLOSED_INCOMPLETE` (; any
   * other predecessor is illegal (→ 409). Idempotent: already `REOPENED`
   * is a self-transition, handled by `transitionTo` itself.
   *
   * Authority unchanged ( Q2, preserved identically for both
   * terminal-closed variants): `verifyConsultationOwnership` at the
   * controller admits the assigned doctor OR any caller holding
   * `manage:Consultation` — this ticket changes *legality*, not *who may act*.
   */
  async reopenConsultation(id: string, expectedVersion?: number): Promise<ConsultationResponse> {
    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    const consultation = await this.consultationRepository.findWithRelations(id);
    if (!consultation) {
      throw new NotFoundException('Consultation not found');
    }
    assertEqualTenants(consultation, { tenantId });

    const actor = this.requestUserId ?? 'system';
    const applied = this.applyTransition(consultation, ConsultationStatus.REOPENED, actor, 'reopenConsultation');
    if (!applied) {
      return ConsultationDtoMapper.toResponseWithContext(consultation);
    }

    if (this.requestUserId) {
      consultation.updatedBy = this.requestUserId;
    }
    const updated = await this.consultationRepository.updateWithVersion(id, consultation, expectedVersion ?? consultation.version);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: id,
      data: { action: 'reopenConsultation', status: ConsultationStatus.REOPENED },
    });
    await this.appendTransitionAudit({ tenantId, consultationId: id, action: HarnessAuditAction.SESSION_REOPENED, actor });

    // Map the FRESHLY-PERSISTED entity, not the stale pre-write one: updateWithVersion
    // bumps _version, so returning `consultation` handed the caller version N while the
    // row was already at N+1 — any client chaining If-Match from this response got an
    // immediate 412. Mirrors the house pattern in department.service.ts:318.
    return ConsultationDtoMapper.toResponseWithContext(updated);
  }

  /**
   * Update safely-mutable fields of an existing consultation.
   *
   * Allowed: `appointmentDate`, `departmentId` (tenant-checked, audit C-2),
   * `metadata` (shallow-merged). Identity / ownership fields (`patientId`,
   * `doctorId`, `tenantId`), the structural `parentConsultationId` link, and
   * the typed `status` COLUMN — routed exclusively through
   * `transitionTo` via the dedicated prime/close/reopen/recording routes)
   * are NOT mutable here.
   */
  async updateConsultation(id: string, request: UpdateConsultationRequest, expectedVersion?: number): Promise<ConsultationResponse> {
    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    const consultation = await this.consultationRepository.findWithRelations(id);
    if (!consultation) {
      throw new NotFoundException('Consultation not found');
    }
    assertEqualTenants(consultation, { tenantId });

    // Audit C-2 — a re-assigned department must live in the caller's tenant.
    // `assertParentInScope` throws NotFoundException on miss / cross-tenant.
    if (request.departmentId) {
      await assertParentInScope(this.departmentRepository, request.departmentId, tenantId);
    }

    if (request.appointmentDate !== undefined) {
      consultation.appointmentDate = new Date(request.appointmentDate);
    }
    if (request.departmentId !== undefined) {
      consultation.departmentId = request.departmentId;
    }

    if (request.metadata !== undefined) {
      const currentMeta = (consultation.metadata as Record<string, unknown> | null) ?? {};
      consultation.metadata = { ...currentMeta, ...request.metadata } as Parameters<typeof ConsultationFactory.CreateNewVisit>[0]['metadata'];
    }

    if (this.requestUserId) {
      consultation.updatedBy = this.requestUserId;
    }

    // `PATCH /consultations/:id` carries `@RequiresIfMatch()`, so the CAS is the
    // enforcement point for the precondition — the same shape the lifecycle
    // transitions (prime/close/reopen) on this aggregate already use. The
    // `?? consultation.version` fall-through keeps the documented
    // service-to-service path (no header) working unchanged.
    const updated = await this.consultationRepository.updateWithVersion(id, consultation, expectedVersion ?? consultation.version);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: id,
      data: { action: 'updateConsultation', fields: Object.keys(request ?? {}) },
    });

    // Map the FRESHLY-PERSISTED entity, not the stale pre-write one: the CAS
    // bumps `_version`, so returning `consultation` handed the caller version N
    // while the row was already at N+1 — and any client chaining `If-Match`
    // from this response would get an immediate 412. Same fix as
    // `reopenConsultation` above.
    return ConsultationDtoMapper.toResponseWithContext(updated);
  }

  // ============================================
  // Recording lifecycle
  //
  // `startRecording`/`stopRecording` route through the same
  // `transitionTo` legality matrix as every other lifecycle write.
  // `PRIMED → RECORDING` carries the ONE flagged precondition in the whole
  // matrix (`consultation.state.requirePrimedBeforeRecording`, default
  // OFF — Task 9 / R1): OFF logs the would-be violation and lets
  // a legacy caller through unchanged; ON enforces via the matrix itself
  // (illegal → 409). `stopRecording` now transitions to `DRAINING`, not
  // `OPEN` — the previous behaviour erased the fact that capture ever
  // happened ( A-13-adjacent finding). The
  // LiveDocumentationService session is started/stopped by the controller
  // around these calls.
  // ============================================

  /**
   * Flip the consultation's `status` column `PRIMED → RECORDING`.
   */
  async startRecording(id: string): Promise<ConsultationResponse> {
    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    const consultation = await this.consultationRepository.findWithRelations(id);
    if (!consultation) {
      throw new NotFoundException('Consultation not found');
    }
    assertEqualTenants(consultation, { tenantId });

    const actor = this.requestUserId ?? 'system';
    const requirePrimed = this.tenantSettings?.resolvePlatform<boolean>(CONSULTATION_REQUIRE_PRIMED_BEFORE_RECORDING_KEY).value === true;

    if (!requirePrimed && !consultation.canTransitionTo(ConsultationStatus.RECORDING)) {
      // grep-gate NOTE — Kill-switch OFF: this is the ONE matrix
      // edge this ticket lets bypass (every other transition is enforced
      // unconditionally from day one — Task 9 step 4). Log the
      // would-be violation and write RECORDING directly (via the deprecated
      // setter, NOT
      // `transitionTo` — the matrix genuinely does not permit this pair,
      // so going through `transitionTo` would throw regardless of the
      // flag) so a legacy caller with no prior `prime` call keeps working
      // unchanged.
      this.logger.warn({
        message: 'recording/start reached without PRIMED — kill-switch OFF, proceeding (would 409 if ON)',
        consultationId: id,
        currentStatus: consultation.status,
      });
      consultation.status = ConsultationStatus.RECORDING;
    } else {
      this.applyTransition(consultation, ConsultationStatus.RECORDING, actor, 'startRecording');
    }

    if (this.requestUserId) {
      consultation.updatedBy = this.requestUserId;
    }
    const expectedVersion = consultation.version;
    const updated = await this.consultationRepository.updateWithVersion(id, consultation, expectedVersion);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: id,
      data: { action: 'startRecording', status: ConsultationStatus.RECORDING },
    });

    // Map the FRESHLY-PERSISTED entity, not the stale pre-write one: updateWithVersion
    // bumps _version, so returning `consultation` handed the caller version N while the
    // row was already at N+1 — any client chaining If-Match from this response got an
    // immediate 412. Mirrors the house pattern in department.service.ts:318.
    return ConsultationDtoMapper.toResponseWithContext(updated);
  }

  /**
   * Flip the consultation's `status` column `RECORDING → DRAINING` when
   * capture stops (manual stop, or forcing this same edge on
   * mid-capture consent revocation). The harness later promotes a drained
   * consult to `DRAFT_PENDING_SENSORS`/`PENDING_REVIEW` (`persistDraft`).
   */
  async stopRecording(id: string): Promise<ConsultationResponse> {
    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    const consultation = await this.consultationRepository.findWithRelations(id);
    if (!consultation) {
      throw new NotFoundException('Consultation not found');
    }
    assertEqualTenants(consultation, { tenantId });

    const actor = this.requestUserId ?? 'system';
    this.applyTransition(consultation, ConsultationStatus.DRAINING, actor, 'stopRecording');

    if (this.requestUserId) {
      consultation.updatedBy = this.requestUserId;
    }
    const expectedVersion = consultation.version;
    const updated = await this.consultationRepository.updateWithVersion(id, consultation, expectedVersion);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: id,
      data: { action: 'stopRecording', status: ConsultationStatus.DRAINING },
    });

    // Map the FRESHLY-PERSISTED entity, not the stale pre-write one: updateWithVersion
    // bumps _version, so returning `consultation` handed the caller version N while the
    // row was already at N+1 — any client chaining If-Match from this response got an
    // immediate 412. Mirrors the house pattern in department.service.ts:318.
    return ConsultationDtoMapper.toResponseWithContext(updated);
  }
}

// ---------------------------------------------------------------------------
// UTC date-bucket helpers for aggregateConsultationsForTenant.
//
// Plain Date math (no date-fns dependency in @arcaai/applications) on UTC
// boundaries so the result is independent of the server timezone. Key/label
// formats mirror the FE `tenant-dashboard/chart.ts` so the chart renders the
// same axis: `yyyy-MM-dd`/`MMM d` for days, `yyyy-MM`/`MMM` for months.
// ---------------------------------------------------------------------------

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0));
}

function endOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59, 999));
}

function startOfUtcMonth(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1, 0, 0, 0, 0));
}

function endOfUtcMonth(d: Date): Date {
  // Day 0 of the next month is the last day of this month.
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0, 23, 59, 59, 999));
}

interface AggregateBucket {
  key: string;
  label: string;
  start: Date;
  end: Date;
}

function buildAggregateBuckets(from: Date, to: Date, granularity: 'day' | 'month'): AggregateBucket[] {
  const buckets: AggregateBucket[] = [];

  if (granularity === 'month') {
    let cursor = startOfUtcMonth(from);
    const last = startOfUtcMonth(to);
    while (cursor.getTime() <= last.getTime()) {
      const y = cursor.getUTCFullYear();
      const m = cursor.getUTCMonth();
      buckets.push({
        key: `${y}-${pad2(m + 1)}`,
        label: MONTH_ABBR[m],
        start: startOfUtcMonth(cursor),
        end: endOfUtcMonth(cursor),
      });
      cursor = new Date(Date.UTC(y, m + 1, 1));
    }
    return buckets;
  }

  let cursor = startOfUtcDay(from);
  const last = startOfUtcDay(to);
  while (cursor.getTime() <= last.getTime()) {
    const y = cursor.getUTCFullYear();
    const m = cursor.getUTCMonth();
    const day = cursor.getUTCDate();
    buckets.push({
      key: `${y}-${pad2(m + 1)}-${pad2(day)}`,
      label: `${MONTH_ABBR[m]} ${day}`,
      start: startOfUtcDay(cursor),
      end: endOfUtcDay(cursor),
    });
    cursor = new Date(Date.UTC(y, m, day + 1));
  }
  return buckets;
}
