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
import { createHash } from 'node:crypto';
import { ClsService } from 'nestjs-cls';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { OptimisticConcurrencyException } from '@arcaai/exceptions';
import {
  ConsultationEntity,
  ConsultationRepository,
  ConsultationFactory,
  ConsultationProcessing,
  ConsultationStatus,
  ContextItemSource,
  ContextItemType,
  DepartmentRepository,
  ResourceType,
  SysEventType,
  UserDepartmentRepository,
  UserRepository,
  UserRoleAssignmentRepository,
  WorkflowDefinitionRepository,
} from '@arcaai/domains';
import type { ConsultationOpenKey } from '@arcaai/domains';
import type { LifecycleEventType } from '@arcaai/types';
import { IConsultationService, type StartRecordingOptions } from './IConsultationService';
import {
  OpenConsultationRequest,
  UpdateConsultationRequest,
  ConsultationResponse,
  ConsultationAggregateResponse,
  ConsultationWorkflowResponse,
  PaginatedConsultationResponse,
  ConsultationSort,
  DEFAULT_CONSULTATION_SORT,
} from './dto';
import { ConsultationDtoMapper } from './consultation.dto.mapper';
import type { ClinicalCaller } from '../summary/clinician-attribution';
import {
  IConsultationLifecycleService,
  IConsultationLifecycleServiceToken,
  type ClinicalCaller as LifecycleCaller,
} from '../lifecycle/IConsultationLifecycleService';
import { IConsultationEncounterService, IConsultationEncounterServiceToken } from '../encounter/IConsultationEncounterService';
import { ConsultationPipelineEvent, type LifecycleChangedPayload } from '../events/consultation.events';
import {
  BaseService,
  assertEqualTenants,
  assertParentInScope,
  assertUserBelongsToTenant,
  isSuperAdmin,
  normalizeLanguageMode,
  requireLanguageMode,
  requestedLanguageMode,
} from '../../../common';
import { IActiveUserContext } from '../../../interfaces';
import { IEntitlementsService } from '../../entitlements/IEntitlementsService';
import { IConsentGrantService } from '../../consent/IConsentGrantService';
import { IConsultationWorkflowDispatchService } from '../workflow-dispatch/IConsultationWorkflowDispatchService';
import { SelectableConsultationWorkflowListResponse } from '../workflow-dispatch/dto';
import { governingRunOf, readGoverningEngineMarker } from '../governing-engine';
import { jsonSchemaValueProblems } from '@arcaai/json-schema-subset';
import { withWorkflowSelectionMarker } from './workflow-selection';
import { readSpokenLanguageMode, withSummaryLanguage } from './summary-language';
import {
  type ConsultationVisitTypeKey,
  readExternalRef,
  readRecordedVisitType,
  resolveVisitTypeKey,
  withExternalRefMarker,
  withVisitTypeMarker,
} from './open-markers';
import { DEFAULT_VISIT_TYPE_SERVICE, VisitTypeService } from '../visit-type/visit-type.service';
import { PolicyEngine } from '../../../authorization/policy.engine';
import { TenantSettingsService } from '../../settings-registry/tenant-settings.service';
import {
  CONSULTATION_APPOINTMENT_DAY_TIME_ZONE_DEFAULT,
  CONSULTATION_APPOINTMENT_DAY_TIME_ZONE_KEY,
  isValidTimeZone,
} from '../../settings-registry/descriptors/consultation-appointment-day.descriptors';
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

/** TASK-1020 D-5 — `parentConsultationId` names a consultation of another patient (400). */
export const PARENT_PATIENT_MISMATCH_CODE = 'PARENT_PATIENT_MISMATCH';

/** The `externalRef` already identifies an encounter of another patient in this tenant (409). */
export const EXTERNAL_REF_CONFLICT_CODE = 'EXTERNAL_REF_CONFLICT';

/** Prisma's unique-constraint violation — the open-key / encounter partial unique indexes. */
function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002';
}

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

/** Everything `open` settled before it looks for the encounter — threaded through the match, append and create steps. */
interface OpenEpisodeInput {
  tenantId: string;
  userId: string | null | undefined;
  request: OpenConsultationRequest;
  openContext: ResolvedOpenContext;
  declaredLanguageMode: ReturnType<typeof requestedLanguageMode>;
  /** Stamped on a NEW consultation; not part of the key. */
  appointmentDate: Date;
  /** The create-path metadata, markers applied. */
  metadata: unknown;
  /** The resolved encounter id (schema-declared, else hand-posted under the marker key), or `null`. */
  externalRef: string | null;
  openKey: ConsultationOpenKey;
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
 * A consultation is an EPISODE of one patient with one clinician (and department), made of
 * encounters; `open` resolves the encounter (see `openEpisode`).
 */
/** A stored declaration compared as a mode — a legacy `en-IN` marker equals a declared `en`. */
function normalizeStoredMode(value: string | null): string | null {
  return normalizeLanguageMode(value) ?? value;
}

/**
 * TASK-1020 BP-5 — the calendar day (`YYYY-MM-DD`) `now` falls on in `timeZone`. `en-CA` formats a
 * date as ISO `YYYY-MM-DD`, so the formatter's own output is the answer; no offset arithmetic.
 */
export function calendarDayIn(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/** The controller's credential description, in the lifecycle service's terms. */
function toLifecycleCaller(caller: ClinicalCaller | undefined): LifecycleCaller | undefined {
  if (!caller) return undefined;
  switch (caller.credentialClass) {
    case 'service-account':
      return { isMachine: true, serviceAccountId: caller.principalId };
    case 'api-key':
      return { isMachine: true, apiKeyId: caller.principalId, ...(caller.boundUserId ? { userId: caller.boundUserId } : {}) };
    default:
      return { isMachine: false, userId: caller.principalId };
  }
}

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
    // The encounters of the episode: `open` matches an encounter by its `externalRef`, appends one
    // to the open consultation, or creates a consultation with its first one.
    @Inject(IConsultationEncounterServiceToken) private readonly encounters: IConsultationEncounterService,
    // The lifecycle commands (start / stop / close / reopen) belong to the lifecycle service; the
    // deprecated methods on this service delegate to it.
    @Inject(IConsultationLifecycleServiceToken) private readonly lifecycle: IConsultationLifecycleService,
    // Optional (append-only DI); enforces the plan
    // `monthlyConsultations` meter when STARTING a new consultation
    // (kill-switch-gated, → 429 when over the rolling-monthly cap).
    @Optional() @Inject(IEntitlementsService) private readonly entitlements?: IEntitlementsService,
    // optional: resolves the tenant's appointment-day time zone (`tenantToday`). Absent ⇒ UTC.
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
   *                              tenant (defense vs. audit C-4 / B-3) AND
   *                              belong to the same patient (TASK-1020 D-5).
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
      patientId: string;
      departmentId?: string | null;
      parentConsultationId?: string | null;
    },
  ): Promise<void> {
    await assertUserBelongsToTenant(this.userRoleAssignmentRepository, this.userDepartmentRepository, this.userRepository, refs.doctorId, tenantId);

    if (refs.departmentId) {
      await assertParentInScope(this.departmentRepository, refs.departmentId, tenantId);
    }

    if (refs.parentConsultationId) {
      const parent = await assertParentInScope(this.consultationRepository, refs.parentConsultationId, tenantId);
      // TASK-1020 D-5 — tenancy is not enough. A parent is the visit this one FOLLOWS, and the
      // chain, the timeline and the same-day prequel all read through it: a parent of another
      // patient would put that patient's note into this one's prompt. A 400, not a 404 — the
      // row is in the caller's tenant, so its existence is not the secret; the request is wrong.
      if (parent.patientId !== refs.patientId) {
        throw new BadRequestException({
          message:
            '`parentConsultationId` names a consultation of a different patient. A follow-up must belong to the same patient as the visit it follows.',
          code: PARENT_PATIENT_MISMATCH_CODE,
        });
      }
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
      // The same object `ConsultationResponse.governingRun` carries, from the same derivation —
      // this route and a consultation read must never report different statuses for one run.
      run: governingRunOf(consultation.metadata),
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
      visitTypeKey:
        bindings.visitType && validated.has(bindings.visitType.kindKey) ? this.matchStatedVisitType(tenantId, context, bindings.visitType) : null,
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
  private matchStatedVisitType(
    tenantId: string,
    context: Record<string, unknown>,
    binding: { kindKey: string; field: string },
  ): ConsultationVisitTypeKey | null {
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
  /**
   * Refuse an open whose context the GOVERNING WORKFLOW would reject.
   *
   * ## Why this is a second check and not a stricter first one
   *
   * Two different schemas are in play and both are legitimate:
   *
   *   * the tenant's CURRENT pinned version, which `assertContextConformsToSchema` checks — it
   *     is what the tenant says a consultation context looks like today;
   *   * the version the governing workflow's trigger was FROZEN against, which the interpreter
   *     validates the run payload with and which a PINNED trigger keeps for the life of the
   *     published artifact.
   *
   * They agree for a follow-latest trigger (the gateway re-resolves it at dispatch) and can
   * differ for a pinned one. When they differ, today's behaviour is a 201 followed minutes later
   * by a governing run that failed on its first node — with a metered unit, a written row and
   * persisted PHI context items already committed, and nothing the clinician can act on.
   *
   * ## Only a CONCLUSIVE check may refuse
   *
   * `previewGoverningWorkflow` answers `null` for every inconclusive outcome — no assignment, a
   * definition unpublished since, an unreadable compiled config, a trigger that froze no schema,
   * a dependency outage — and never throws. Those all fall through to today's ungoverned open,
   * because dispatch is best-effort by contract and a clinician must be able to open a
   * consultation when the schema or harness plane is having a bad day. Only a workflow that was
   * resolved, whose trigger schema was read, and which demonstrably refuses this payload produces
   * a 400.
   */
  private async assertGoverningWorkflowAcceptsContext(
    tenantId: string,
    request: OpenConsultationRequest,
    openContext: ResolvedOpenContext,
  ): Promise<void> {
    const authoredContext = ConsultationService.authoredContextOf(request.context, openContext.validatedKindKeys);
    if (!authoredContext || !this.workflowDispatchService?.previewGoverningWorkflow) return;

    let preview: Awaited<ReturnType<NonNullable<IConsultationWorkflowDispatchService['previewGoverningWorkflow']>>>;
    try {
      preview = await this.workflowDispatchService.previewGoverningWorkflow({
        tenantId,
        departmentId: openContext.departmentId ?? null,
        workflowDefinitionSlug: request.workflowDefinitionSlug ?? null,
        parentConsultationId: request.parentConsultationId ?? null,
        visitType: openContext.visitTypeKey,
      });
    } catch (error) {
      // Defensive: the preview's own contract is "never throws". A dependency that breaks that
      // contract must still not cost a clinician their consultation.
      this.logger.warn({
        message: 'Governing-workflow compatibility could not be checked — opening without it, exactly as an unassigned consultation opens',
        tenantId,
        reason: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    if (!preview) return;

    const problems = jsonSchemaValueProblems(preview.resolved, authoredContext);
    if (problems.length === 0) return;

    throw new BadRequestException({
      message: `The supplied \`context\` is not accepted by the workflow that governs this consultation ('${preview.workflowDefinitionSlug}').`,
      code: 'WORKFLOW_CONTEXT_INCOMPATIBLE',
      workflowDefinitionSlug: preview.workflowDefinitionSlug,
      boundSchemaVersion: preview.boundSchemaVersion,
      problems,
    });
  }

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

    // TASK-1059 D-14: an encounter append re-sends the same prior notes. Skip an entry whose
    // origin/kindKey/content digest is already on the consultation. A failed lookup degrades to
    // "write everything" - a duplicate is a smaller loss than a missing note.
    const alreadyMaterialized = new Set<string>();
    try {
      const existing = (await this.contextService!.getCaseNotes?.(consultationId)) ?? [];
      for (const item of existing) {
        const meta = item.metadata ?? {};
        if (meta.origin === 'open.context' && meta.kindKey === kindKey && typeof item.content === 'string') {
          alreadyMaterialized.add(createHash('sha256').update(item.content).digest('hex'));
        }
      }
    } catch (error) {
      this.logger.warn({
        message: 'Existing case notes could not be read; materializing without de-duplication',
        consultationId,
        kindKey,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    for (const [index, entry] of notes.entries()) {
      if (typeof entry !== 'object' || entry === null) continue;
      const note = entry as Record<string, unknown>;
      const text = typeof note.text === 'string' ? note.text : '';
      if (text.length === 0) continue;
      const title = typeof note.title === 'string' && note.title.length > 0 ? note.title : null;
      const content = title ? `${title}\n${text}` : text;
      const digest = createHash('sha256').update(content).digest('hex');
      if (alreadyMaterialized.has(digest)) continue;
      alreadyMaterialized.add(digest);

      try {
        await this.contextService!.addContext(consultationId, {
          type: ContextItemType.CASE_NOTE,
          source: ContextItemSource.USER,
          content,
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
   * Get or create the consultation for one ENCOUNTER — the only entry. The resolution order
   * (encounter ref → open consultation of the key → new chained consultation) is `openEpisode`.
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

    // TASK-1004 — the declared spoken-language mode, normalized ONCE and refused here (400
    // `LANGUAGE_MODE_UNKNOWN`) before any read or write: a pure check, so it costs nothing.
    const declaredLanguageMode = requestedLanguageMode(request);

    // TASK-950 §D-6 / TASK-951 §D-2…D-4 — validate the context payload, MAP everything the
    // tenant's schema declares out of it (department, visit type, external reference), and settle
    // WHO this consultation is for — all BEFORE the tenant guard below and before anything is
    // written. Ordering is deliberate: a provisioned clinician must exist before
    // `assertCrossAggregateRefsInTenant` asks whether they belong to the tenant, a schema
    // violation must be a 400 rather than a 404 about a clinician the caller never named, and the
    // DEPARTMENT has to be settled before either, because it selects the schema the rest is
    // checked against.
    const openContext = await this.resolveOpenContext(tenantId, request);
    const { clinicianId: actingClinicianId, named: clinicianWasNamed } = await this.resolveActingClinician(tenantId, request, doctorId, openContext);

    await this.assertCrossAggregateRefsInTenant(tenantId, {
      doctorId: actingClinicianId,
      // The RESOLVED department. When the payload named it, this is the row its code resolved to;
      // the guard still re-checks tenancy, because a repository answer is a reference like any
      // other. (`findByCode` is already tenant-scoped, so this can only ever agree — which is the
      // point: nothing reaches the factory without having passed the same guard.)
      departmentId: openContext.departmentId,
      patientId: request.patientId,
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
    //     workflow?" must not depend on whether a consultation for (patient, doctor, department)
    //     happens to already exist. Otherwise the status code itself reports that.
    await this.assertWorkflowSelectionAllowed(tenantId, request.workflowDefinitionSlug);

    // TASK-1020 BP-5 — stamped on a NEW consultation (it is not part of the key): a caller-supplied
    // date wins; otherwise TODAY in the TENANT's time zone (`consultation.appointmentDay.timeZone`).
    const appointmentDate = new Date(request.appointmentDate ?? this.tenantToday(tenantId));

    // Create-path metadata, composed BEFORE the lookup because it decides the match: the encounter
    // id `open` matches on is the `externalRef` marker exactly as it will be written.
    //
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
    //
    // TASK-1004 D-3 — the NORMALIZED mode now lives in the typed column `spokenLanguageMode`; the
    // legacy key is still written (same value) for one release so a reader that predates the column
    // keeps seeing the declaration.
    const withLanguage = declaredLanguageMode ? withSummaryLanguage(withSelection, declaredLanguageMode) : withSelection;
    // TASK-951 §D-3/D-4 — the two facts the caller STATED through its schema. Applied last, so a
    // schema-declared value wins over the same key hand-posted in `metadata`: this one was
    // validated against the tenant's pinned schema and alias-matched through the visit-type
    // catalogue, and that one was neither. See `open-markers.ts` for why neither is stripped.
    const withVisitType = openContext.visitTypeKey ? withVisitTypeMarker(withLanguage, openContext.visitTypeKey) : withLanguage;
    const metadata = openContext.externalRef ? withExternalRefMarker(withVisitType, openContext.externalRef) : withVisitType;
    // The resolved encounter id: the schema-declared value, else one hand-posted under the same
    // marker key. `null` ⇒ the open key alone decides.
    const externalRef = readExternalRef(metadata);

    return this.openEpisode(
      {
        tenantId,
        userId,
        request,
        openContext,
        declaredLanguageMode,
        appointmentDate,
        metadata,
        externalRef,
        openKey: { tenantId, doctorId: actingClinicianId, patientId: request.patientId, departmentId: openContext.departmentId ?? null },
      },
      true,
    );
  }

  /**
   * TASK-1045 D-3 — resolve the encounter an `open` is for, in this order:
   *
   * 1. `externalRef` set → the encounter carrying it for the same patient and clinician: returned
   *    as it is, closed or not (`recordable` says whether it can still be captured). The same ref
   *    on another patient is 409 `EXTERNAL_REF_CONFLICT`.
   * 2. Otherwise the non-closed consultation of the open key (tenant, doctor, patient, department —
   *    null-safe). An encounter is APPENDED to it for a new ref, or with no ref when the visit is a
   *    `revisit` and the current encounter has ended; anything else returns it as it is.
   * 3. No non-closed match → a new consultation with encounter 1, chained to the caller's parent,
   *    else to the latest closed consultation of the key (a late return after a close is a new,
   *    chained consultation — never an implicit reopen).
   *
   * The appointment date is not part of the key. A race on the open-key (or encounter-ref) unique
   * index, or on the consultation version during an append, is resolved by running the match once
   * more: the loser answers with the winner.
   */
  private async openEpisode(input: OpenEpisodeInput, mayRetry: boolean): Promise<ConsultationResponse> {
    const { tenantId, request, openKey, externalRef, metadata } = input;
    const visitTypes = this.visitTypes ?? DEFAULT_VISIT_TYPE_SERVICE;

    if (externalRef) {
      const { own, conflict } = await this.encounters.matchExternalRef(tenantId, externalRef, {
        patientId: openKey.patientId,
        doctorId: openKey.doctorId,
      });
      if (own) {
        const consultation = await this.consultationRepository.findWithRelations(own.consultationId);
        if (consultation) return this.answerExisting(consultation, input);
      } else if (conflict) {
        throw new ConflictException({
          code: EXTERNAL_REF_CONFLICT_CODE,
          message: `externalRef '${externalRef}' already identifies an encounter of a different patient in this tenant. An encounter id belongs to exactly one patient; send this visit's own id.`,
        });
      }
    }

    const open = await this.consultationRepository.findOpenByKey(openKey);
    if (open && this.closesForNextVisit(open, request.parentConsultationId ?? null, externalRef)) {
      // BUG-009 (OD-1, OD-4) — the next visit gets its OWN consultation chained to this one. The
      // open-key unique index admits one non-closed row per key, so the parent is closed first
      // (APPROVED → CLOSED_COMPLETE, STOPPED → CLOSED_INCOMPLETE), in the clinician's name. Its
      // note and signature are untouched.
      await this.lifecycle.close(open.id, { clinicianUserId: open.doctorId });
      return this.createEpisode({ ...input, request: { ...request, parentConsultationId: open.id } as OpenConsultationRequest });
    }
    if (open) {
      const statedVisitType = resolveVisitTypeKey(visitTypes, tenantId, metadata, request.parentConsultationId);
      const append = externalRef !== null || (statedVisitType === 'revisit' && Boolean((await this.encounters.currentEncounter(open))?.endedAt));
      if (!append) return this.answerExisting(open, input);
      try {
        return await this.appendEncounter(open, input);
      } catch (error) {
        if (mayRetry && (error instanceof OptimisticConcurrencyException || isUniqueViolation(error))) {
          return this.openEpisode(input, false);
        }
        throw error;
      }
    }

    try {
      return await this.createEpisode(input);
    } catch (error) {
      if (mayRetry && isUniqueViolation(error)) {
        return this.openEpisode(input, false);
      }
      throw error;
    }
  }

  /**
   * BUG-009 — does this open start the NEXT visit as a consultation of its own, after closing
   * `open`? Yes when the caller names `open` as the previous visit (OD-1), or when `open` is
   * signed and the caller brings a new encounter id (a signed visit cannot take another
   * encounter, which used to be a 409). Never while `open` is still capturing or has not been
   * recorded yet: closing it would cut a live visit short.
   */
  private closesForNextVisit(open: ConsultationEntity, namedParentId: string | null, externalRef: string | null): boolean {
    if (open.status !== ConsultationStatus.APPROVED && open.status !== ConsultationStatus.STOPPED) return false;
    if (namedParentId === open.id) return true;
    return open.status === ConsultationStatus.APPROVED && externalRef !== null;
  }

  /**
   * An `open` that lands on an existing encounter. Nothing is persisted or dispatched: the
   * consultation was opened with its own context and governing run, and re-opening it must not
   * append a second copy of the client's PRE items or start a second run. Consent is not
   * re-recorded either — that would silently undo a revocation on every retry (TASK-1020 D-6).
   */
  private async answerExisting(existing: ConsultationEntity, input: OpenEpisodeInput): Promise<ConsultationResponse> {
    const { request, declaredLanguageMode } = input;
    // The selection was authorized, but consultation-open dispatch fires on CREATE only, so there
    // is no dispatch left to steer. Say so rather than let the caller believe their pick took
    // effect — `GET /consultations/:id/workflow` reports what actually governs.
    if (request.workflowDefinitionSlug) {
      this.logger.log({
        message: 'Workflow selection ignored — this consultation is already open and its governing engine was decided at its own open',
        consultationId: existing.id,
        requestedWorkflowDefinitionSlug: request.workflowDefinitionSlug,
      });
    }

    // TASK-1004 — the one thing a re-open DOES change: an explicit, DIFFERENT spoken-language mode.
    if (declaredLanguageMode && normalizeStoredMode(readSpokenLanguageMode(existing)) !== declaredLanguageMode) {
      await this.reopenWithSpokenLanguageMode(existing, declaredLanguageMode);
    }

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      resourceId: existing.id,
      data: { action: 'getOrCreate', found: true },
    });
    return this.respond(existing, false, false);
  }

  /**
   * Append the next encounter to the open consultation of the key. Opening a new encounter is the
   * consent event, as creating a consultation is, and the context the caller sent belongs to this
   * visit, so both happen here; no workflow is dispatched (the consultation's governing run was
   * decided at its own open).
   */
  private async appendEncounter(open: ConsultationEntity, input: OpenEpisodeInput): Promise<ConsultationResponse> {
    const { tenantId, request, openContext, declaredLanguageMode, externalRef, metadata } = input;
    // A second encounter is a follow-up by definition: the stated visit type when there is one,
    // otherwise `revisit`.
    const visitType = resolveVisitTypeKey(this.visitTypes ?? DEFAULT_VISIT_TYPE_SERVICE, tenantId, metadata, open.id);
    const { consultation } = await this.encounters.appendEncounter(open, {
      visitType,
      externalRef,
      actor: input.userId ?? 'system',
    });

    this.emitLifecycle(consultation, 'encounter_appended');

    await this.recordOpenConsent(consultation);
    if (request.context) {
      await this.persistOpenContext(consultation.id, request.context, openContext);
    }
    if (declaredLanguageMode && normalizeStoredMode(readSpokenLanguageMode(consultation)) !== declaredLanguageMode) {
      await this.reopenWithSpokenLanguageMode(consultation, declaredLanguageMode);
    }
    return this.respond(consultation, false, true);
  }

  /** No non-closed consultation for the key: a new one, with encounter 1. */
  private async createEpisode(input: OpenEpisodeInput): Promise<ConsultationResponse> {
    const { tenantId, userId, request, openContext, declaredLanguageMode, appointmentDate, metadata, externalRef, openKey } = input;

    // The LAST refusal before anything is written: would the workflow that is about to govern
    // this consultation actually accept the context the caller sent? Only where the answer is
    // CONCLUSIVE — see `assertGoverningWorkflowAcceptsContext`.
    await this.assertGoverningWorkflowAcceptsContext(tenantId, request, openContext);

    // A genuinely NEW consultation consumes a monthly meter unit (kill-switch-gated; → 429 when
    // over the cap). Returning or appending to an existing consultation does not.
    await this.entitlements?.assertMeterQuota(tenantId, 'monthlyConsultations');

    // The parent: the caller's, when it named one (always wins); otherwise the latest CLOSED
    // consultation of the same key — the episode this return visit follows (D-7).
    const parentConsultationId = request.parentConsultationId ?? (await this.consultationRepository.findLatestClosedByKey(openKey))?.id ?? null;

    const consultation = ConsultationFactory.CreateNewVisit({
      tenantId,
      patientId: request.patientId,
      appointmentDate,
      doctorId: openKey.doctorId,
      departmentId: openContext.departmentId,
      metadata: metadata as Parameters<typeof ConsultationFactory.CreateNewVisit>[0]['metadata'],
      // The first encounter's ref, kept on the row as well (the TASK-1020 column and its index).
      externalRef,
      spokenLanguageMode: declaredLanguageMode,
      createdBy: userId ?? undefined,
    });
    if (parentConsultationId) {
      consultation.parentConsultationId = parentConsultationId;
    }

    const { consultation: saved } = await this.encounters.createConsultation(consultation, {
      visitType: resolveVisitTypeKey(this.visitTypes ?? DEFAULT_VISIT_TYPE_SERVICE, tenantId, metadata, parentConsultationId),
      externalRef,
    });

    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceId: saved.id,
      createdAt: saved.createdAt,
      data: { action: 'getOrCreate', created: true },
    });
    this.emitLifecycle(saved, 'opened');

    await this.recordOpenConsent(saved);

    // TASK-951 §D-5 — write the validated context down, BEFORE dispatch. The warm-start
    // pre-summary reads `CASE_NOTE` items, so a graph dispatched first would warm-start on
    // nothing. Best-effort by contract — see `persistOpenContext`.
    if (request.context) {
      await this.persistOpenContext(saved.id, request.context, openContext);
    }

    await this.dispatchOnCreate(saved, input);

    return this.respond(saved, true, false);
  }

  /**
   * ─── Consent (owner directive, 2026-08-25) ───
   *
   * A doctor opening a consultation (or a new encounter of one) IS the consent event: the
   * clinician is with the patient and attests, by that act, that the patient consented to every
   * purpose. Grants are written inside the doctor's own request context, so `grantedBy` is the
   * doctor and each row lands on the WORM ledger.
   *
   * FAIL-CLOSED, unlike the best-effort workflow dispatch: a consultation whose consent did not
   * persist is one the clinician cannot record and cannot repair, so failing here surfaces that
   * immediately and retryably instead of as a 403 at the moment they press Record.
   */
  private async recordOpenConsent(consultation: ConsultationEntity): Promise<void> {
    if (!this.consentGrantService) {
      this.logger.warn({
        message: 'Consent grant service is NOT WIRED — recording this consultation will be refused by PatientConsentGuard',
        consultationId: consultation.id,
      });
      return;
    }
    await this.consentGrantService.ensureConsultationConsent(consultation.patientId);
  }

  /**
   * The ONE place `WorkflowRun.trigger = 'consultation open'` is stamped — on CREATE only, so a
   * consultation is never dispatched twice. Best-effort by contract: the dispatch service swallows
   * its own failures and returns `dispatched: false`, because a harness outage must never stop a
   * clinician opening a consultation. Every outcome is logged, so which engine governs is
   * observable.
   */
  private async dispatchOnCreate(saved: ConsultationEntity, input: OpenEpisodeInput): Promise<void> {
    const { tenantId, userId, request, openContext } = input;
    // TASK-951 §D-6 — built from the VALIDATED kind keys: only what the tenant's own schema admits
    // reaches the graph's trigger context.
    const authoredContext = ConsultationService.authoredContextOf(request.context, openContext.validatedKindKeys);

    if (!this.workflowDispatchService) {
      this.logger.warn({
        message: 'Consultation workflow dispatch is NOT WIRED — the default loop governs by omission, not by decision',
        consultationId: saved.id,
      });
      return;
    }
    const dispatch = await this.workflowDispatchService.dispatchForConsultation({
      consultationId: saved.id,
      tenantId,
      departmentId: saved.departmentId,
      // TASK-950 — the ROW's clinician, not the `doctorId` PARAMETER: for a machine that identified
      // its clinician by staff id the parameter carries no user at all.
      userId: userId ?? saved.doctorId,
      externalPatientId: saved.patientId,
      // Already authorized; the dispatcher re-verifies rather than trusts.
      workflowDefinitionSlug: request.workflowDefinitionSlug,
      // TASK-891 — threaded in, not re-read by the dispatcher (dispatch is best-effort by contract).
      parentConsultationId: saved.parentConsultationId ?? null,
      // TASK-951 §D-3 — the RECORDED visit type, read off the row, so the dispatcher's selector tag
      // is derived from exactly the value every later reader will read.
      visitType: readRecordedVisitType(saved.metadata),
      // TASK-951 §D-6 — the AUTHORED context, so `trigger.context.*` resolves to what the client sent.
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

  /**
   * A lifecycle change made by `open` (a new consultation, an appended encounter), on the one
   * in-process event the lifecycle publisher fans out (SSE replay, Redis). The stream sequence is
   * the publisher's to assign; `seq` here is a placeholder.
   */
  private emitLifecycle(consultation: ConsultationEntity, type: Extract<LifecycleEventType, 'opened' | 'encounter_appended'>): void {
    const at = new Date().toISOString();
    const payload: LifecycleChangedPayload = {
      consultationId: consultation.id,
      tenantId: consultation.tenantId,
      userId: this.requestUserId ?? undefined,
      timestamp: at,
      event: {
        type,
        consultationId: consultation.id,
        status: consultation.status as LifecycleChangedPayload['event']['status'],
        processing: consultation.processing as LifecycleChangedPayload['event']['processing'],
        encounterSeq: consultation.currentEncounterSeq,
        version: consultation.version,
        at,
        seq: 0,
      },
    };
    try {
      this.eventEmitter.emit(ConsultationPipelineEvent.LifecycleChanged, payload);
    } catch (error) {
      this.logger.warn({
        message: 'Consultation lifecycle event could not be delivered',
        consultationId: consultation.id,
        type,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * A single-consultation answer: the fresh row with its relations, plus the episode facts
   * (encounters, approval, auto-close deadline, reopen policy).
   */
  private async respond(consultation: ConsultationEntity, isNew: boolean, encounterAppended?: boolean): Promise<ConsultationResponse> {
    const fresh = (await this.consultationRepository.findWithRelations(consultation.id)) ?? consultation;
    const view = await this.encounters.lifecycleView(fresh);
    return ConsultationDtoMapper.toResponse(fresh, isNew, view, encounterAppended === undefined ? undefined : { encounterAppended });
  }

  /**
   * TASK-1020 BP-5 — today, as `YYYY-MM-DD`, in the tenant's `consultation.appointmentDay.timeZone`
   * (tenant → SYSTEM → `UTC`). A value that is not a zone this runtime resolves reads as the
   * default — the descriptor validates on write, so reaching that branch means a row was planted
   * around the write lane, which is logged rather than allowed to fail an open.
   */
  private tenantToday(tenantId: string): string {
    const configured = this.tenantSettings?.resolve<unknown>(CONSULTATION_APPOINTMENT_DAY_TIME_ZONE_KEY, tenantId).value;
    let timeZone = CONSULTATION_APPOINTMENT_DAY_TIME_ZONE_DEFAULT;
    if (isValidTimeZone(configured)) {
      timeZone = configured;
    } else if (configured !== undefined && configured !== null) {
      this.logger.warn({
        message: 'consultation.appointmentDay.timeZone is not a valid time zone — dating the consultation in UTC',
        tenantId,
        configured: String(configured),
      });
    }
    return calendarDayIn(new Date(), timeZone);
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

    return ConsultationDtoMapper.toResponseWithContext(consultation, false, await this.encounters.lifecycleView(consultation));
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

    return ConsultationDtoMapper.toResponseWithContext(consultation, false, await this.encounters.lifecycleView(consultation));
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
    /** Optional processing-axis filter (e.g. AWAITING_REVIEW = needs a human because of gaps or an escalation, FAILED). A written note is IDLE + processingReason NOTE_READY. */
    processing?: ConsultationProcessing;
    /** Pre-validated by the controller (`parseConsultationSort`); absent → `DEFAULT_CONSULTATION_SORT`. */
    sort?: ConsultationSort;
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

    const { page, pageSize, patientId, doctorId, departmentId, status, processing, sort } = params;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const filters: any = {};
    if (tenantId) filters.tenantId = tenantId;
    if (patientId) filters.patientId = patientId;
    if (doctorId) filters.doctorId = doctorId;
    if (departmentId) filters.departmentId = departmentId;
    // Optional lifecycle-status filter (indexed by [tenantId, status]);
    // the admin live console uses ?status=RECORDING to find in-progress recordings.
    if (status) filters.status = status;
    if (processing) filters.processing = processing;

    // `sort` arrives pre-validated (`parseConsultationSort`, allow-listed against
    // CONSULTATION_SORTABLE_FIELDS) or absent — default: latest-updated first.
    const effectiveSort = sort ?? DEFAULT_CONSULTATION_SORT;

    const [consultations, count] = await Promise.all([
      this.consultationRepository.findPaginatedWithRelations({
        filters,
        sort: [{ [effectiveSort.field]: effectiveSort.direction }],
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
  // Lifecycle commands
  //
  // The lifecycle (start / pause / stop / approve / close / reopen) belongs to
  // `IConsultationLifecycleService`. The methods below are the older entry
  // points the API still routes to for one release; each delegates and answers
  // with the consultation as it now stands.
  // ============================================

  /**
   * Deprecated: there is no PRIMED state any more — an open consultation is ready to record. A
   * no-op that answers the consultation as it is (the consent decorator on the route still runs).
   */
  async primeConsultation(id: string, _expectedVersion?: number): Promise<ConsultationResponse> {
    return this.respond(await this.findOwned(id), false);
  }

  /** Delegates to `IConsultationLifecycleService.close`. */
  async closeConsultation(
    id: string,
    expectedVersion?: number,
    options?: { clinicianUserId?: string; caller?: ClinicalCaller },
  ): Promise<ConsultationResponse> {
    const caller = toLifecycleCaller(options?.caller);
    return this.lifecycle.close(id, {
      ...(expectedVersion === undefined ? {} : { expectedVersion }),
      ...(options?.clinicianUserId === undefined ? {} : { clinicianUserId: options.clinicianUserId }),
      ...(caller ? { caller } : {}),
    });
  }

  /**
   * Delegates to `IConsultationLifecycleService.reopen`. Without an `If-Match` version (a
   * service-to-service call) the CAS runs on the version just read.
   */
  async reopenConsultation(
    id: string,
    expectedVersion?: number,
    options?: { reason?: string; clinicianUserId?: string; caller?: ClinicalCaller },
  ): Promise<ConsultationResponse> {
    const version = expectedVersion ?? (await this.findOwned(id)).version;
    const caller = toLifecycleCaller(options?.caller);
    return this.lifecycle.reopen(id, {
      expectedVersion: version,
      ...(options?.reason === undefined ? {} : { reason: options.reason }),
      ...(options?.clinicianUserId === undefined ? {} : { clinicianUserId: options.clinicianUserId }),
      ...(caller ? { caller } : {}),
    });
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

    // TASK-1004 — refused before the read, like every other edge check that needs no row.
    const languageMode = requireLanguageMode(request.languageMode, 'languageMode');

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

    // TASK-1004 (OD-2 (a)) — the consultation's spoken-language default, column + legacy key
    // together. Applied AFTER the `metadata` merge so a caller cannot desync the two in one PATCH.
    if (languageMode) {
      consultation.spokenLanguageMode = languageMode;
      consultation.metadata = withSummaryLanguage(consultation.metadata, languageMode) as Parameters<
        typeof ConsultationFactory.CreateNewVisit
      >[0]['metadata'];
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
    return ConsultationDtoMapper.toResponseWithContext(updated, false, await this.encounters.lifecycleView(updated));
  }

  /**
   * TASK-1004 — the re-open write, safe under the race a repeat `start` invites (two opens for the
   * same visit, a moment apart). `open` has never answered 412, so the loser of the CAS re-reads:
   * a row that already carries the mode is done; otherwise it retries ONCE on the fresh version.
   */
  private async reopenWithSpokenLanguageMode(consultation: ConsultationEntity, mode: string): Promise<void> {
    try {
      await this.writeSpokenLanguageMode(consultation, mode, 'open');
    } catch (error) {
      if (!(error instanceof OptimisticConcurrencyException)) throw error;
      const fresh = await this.consultationRepository.findById(consultation.id);
      if (fresh && normalizeStoredMode(readSpokenLanguageMode(fresh)) !== mode) {
        await this.writeSpokenLanguageMode(fresh, mode, 'open');
      }
    }
  }

  /**
   * TASK-1004 — change an EXISTING consultation's declared spoken-language mode from `open`.
   *
   * Column and legacy key move together, under the row's own version (the re-open read it a
   * moment ago), and the change is audited as a `ResourceUpdated` naming both values.
   */
  private async writeSpokenLanguageMode(consultation: ConsultationEntity, mode: string, via: 'open'): Promise<void> {
    const previous = readSpokenLanguageMode(consultation);
    const expectedVersion = consultation.version;
    consultation.spokenLanguageMode = mode;
    consultation.metadata = withSummaryLanguage(consultation.metadata, mode) as Parameters<typeof ConsultationFactory.CreateNewVisit>[0]['metadata'];
    if (this.requestUserId) {
      consultation.updatedBy = this.requestUserId;
    }
    const updated = await this.consultationRepository.updateWithVersion(consultation.id, consultation, expectedVersion);
    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: consultation.id,
      data: { action: 'updateSpokenLanguageMode', via, previous, next: mode, previousVersion: expectedVersion, newVersion: updated.version },
    });
  }

  /**
   * Deprecated alias of `POST :id/start`: delegates to `IConsultationLifecycleService.start` and
   * answers with the consultation.
   */
  async startRecording(id: string, options: StartRecordingOptions = {}): Promise<ConsultationResponse> {
    await this.lifecycle.start(id, {
      sttSessionId: options.sttSessionId,
      supersedeByDurableBinding: options.supersedeByDurableBinding,
    });
    return this.respond(await this.findOwned(id), false);
  }

  /**
   * Deprecated alias of `POST :id/stop`: delegates to `IConsultationLifecycleService.stop` without
   * waiting for the final transcript (the alias never waited), and answers with the consultation.
   */
  async stopRecording(id: string): Promise<ConsultationResponse> {
    await this.lifecycle.stop(id, { waitForFinal: false });
    return this.respond(await this.findOwned(id), false);
  }

  /** The consultation of the caller's tenant, or 404 (400 without a tenant). */
  private async findOwned(id: string): Promise<ConsultationEntity> {
    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }
    const consultation = await this.consultationRepository.findWithRelations(id);
    if (!consultation) {
      throw new NotFoundException('Consultation not found');
    }
    assertEqualTenants(consultation, { tenantId });
    return consultation;
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
