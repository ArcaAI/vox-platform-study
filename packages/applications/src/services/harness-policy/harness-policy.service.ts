import { BadRequestException, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import {
  CoreDatabaseService,
  HARNESS_POLICY_DEFAULTS,
  HarnessPolicyChangeFactory,
  HarnessPolicyChangeRepository,
  HarnessPolicyEntity,
  HarnessPolicyFactory,
  HarnessPolicyRepository,
  JsonValue,
  SYSTEM_TENANT_ID,
} from '@arcaai/domains';
import { IActiveUserContext } from '../../interfaces';
import { IAiTaskDefaultService } from '../ai-task-default/IAiTaskDefaultService';
import { SecretsService } from '../baseServices/_meta/secrets';
import { HarnessPolicyResponse, HarnessPolicySource, UpdateHarnessPolicyRequest } from './dto';

/**
 * TASK-511 (Phase 3A) — the two SMR routing tasks the loop discriminates on:
 *  - `live`     → the live-documentation delta summariser (`smr.live`).
 *  - `finalize` → the final/comprehensive summary generator (`smr.finalize`).
 * `resolveSmrSelection` consults the matching `AiTaskDefault` key FIRST, then
 * falls back to the legacy `HarnessPolicy.smrProvider/smrModel` cascade.
 */
export type SmrRoutingTask = 'live' | 'finalize';

const SMR_TASK_KEY: Record<SmrRoutingTask, string> = {
  live: 'smr.live',
  finalize: 'smr.finalize',
};

/** Ciphertext payloads threaded into the change factory (TASK-369 Phase 3D). */
interface EncryptedChangePayloads {
  encryptedBeforeJson: Buffer | null;
  encryptedAfterJson: Buffer | null;
  keyVersion: number | null;
}

/**
 * The runtime knobs the clinical loop reads. Decoupled from the entity (whose
 * getters are non-enumerable) and from the DTO (sparse) so merge / snapshot /
 * apply operate on a single, fully-populated value shape.
 *
 * TASK-511 (Phase 3A) appended the seven agentic loop knobs. They are NULLABLE
 * overrides: null ⇒ the harness env/code default applies (per-field
 * fallthrough), so the harness only overrides a runtime default when the policy
 * carries an explicit non-null value.
 */
export interface HarnessPolicyKnobs {
  entityFaithfulnessThreshold: number;
  coverageThreshold: number;
  citationPresenceThreshold: number;
  numericDoseThreshold: number;
  groundednessThreshold: number;
  safetyEnabled: boolean;
  phiEnabled: boolean;
  phiFailClosed: boolean;
  safetyProvider: string;
  safetyModel: string;
  smrProvider: string | null;
  smrModel: string | null;
  maxRegen: number;
  gateSlaSeconds: number;
  gateEscalationSeconds: number;
  toolAllowlist: string[] | null;
  // TASK-511 (Phase 3A) — agentic loop knobs (null ⇒ harness env/code default).
  optimisticDeliveryEnabled: boolean | null;
  atomicFactEnabled: boolean | null;
  retrievalEnabled: boolean | null;
  warmStartEnabled: boolean | null;
  nerPriorsEnabled: boolean | null;
  maxEditReruns: number | null;
  regenFeedbackEnabled: boolean | null;
}

const KNOB_KEYS = Object.keys(HARNESS_POLICY_DEFAULTS) as (keyof HarnessPolicyKnobs)[];

/** Read the knob values off a hydrated entity (getters are not enumerable). */
function entityToKnobs(e: HarnessPolicyEntity): HarnessPolicyKnobs {
  return {
    entityFaithfulnessThreshold: e.entityFaithfulnessThreshold,
    coverageThreshold: e.coverageThreshold,
    citationPresenceThreshold: e.citationPresenceThreshold,
    numericDoseThreshold: e.numericDoseThreshold,
    groundednessThreshold: e.groundednessThreshold,
    safetyEnabled: e.safetyEnabled,
    phiEnabled: e.phiEnabled,
    phiFailClosed: e.phiFailClosed,
    safetyProvider: e.safetyProvider,
    safetyModel: e.safetyModel,
    smrProvider: e.smrProvider ?? null,
    smrModel: e.smrModel ?? null,
    maxRegen: e.maxRegen,
    gateSlaSeconds: e.gateSlaSeconds,
    gateEscalationSeconds: e.gateEscalationSeconds,
    toolAllowlist: (e.toolAllowlist as string[] | null) ?? null,
    optimisticDeliveryEnabled: e.optimisticDeliveryEnabled ?? null,
    atomicFactEnabled: e.atomicFactEnabled ?? null,
    retrievalEnabled: e.retrievalEnabled ?? null,
    warmStartEnabled: e.warmStartEnabled ?? null,
    nerPriorsEnabled: e.nerPriorsEnabled ?? null,
    maxEditReruns: e.maxEditReruns ?? null,
    regenFeedbackEnabled: e.regenFeedbackEnabled ?? null,
  };
}

/** Sparse-patch merge: take the DTO value when present, else the base value. */
function mergeKnobs(base: HarnessPolicyKnobs, dto: UpdateHarnessPolicyRequest): HarnessPolicyKnobs {
  const out = { ...base };
  for (const key of KNOB_KEYS) {
    const patched = (dto as Record<string, unknown>)[key];
    if (patched !== undefined) {
      (out as Record<string, unknown>)[key] = patched;
    }
  }
  return out;
}

/** Apply only the DTO's supplied knobs onto an entity (drives change tracking). */
function applyKnobsToEntity(entity: HarnessPolicyEntity, dto: UpdateHarnessPolicyRequest): void {
  for (const key of KNOB_KEYS) {
    const patched = (dto as Record<string, unknown>)[key];
    if (patched !== undefined) {
      // Bracket assignment invokes the entity's prototype setter, so each write
      // is recorded via `setProperty` (only real value changes mark the row dirty).
      (entity as unknown as Record<string, unknown>)[key] = patched;
    }
  }
}

/**
 * HarnessPolicyService (TASK-330 Phase 6) — DB-backed, editable runtime policy
 * that drives the clinical documentation loop.
 *
 *  - `getEffectivePolicy` resolves the tenant's own row, else the SYSTEM-tenant
 *    GLOBAL-DEFAULT, else the harness code defaults ("tenant OVERRIDES global").
 *  - `updatePolicy` edits the calling tenant's row (creating it on first edit
 *    from the inherited default), under optimistic-concurrency CAS, and appends
 *    a before/after `HarnessPolicyChange` WORM record in the SAME transaction.
 *  - `updateGlobalDefault` does the same against the SYSTEM-tenant row
 *    (platform-only; the controller gates it with a GLOBAL `manage` ability).
 *
 * The policy write + the WORM change-append are wrapped in a single interactive
 * transaction (mirrors `PromptManagementService`) so an edit is never recorded
 * without its audit row and vice versa.
 */
@Injectable()
export class HarnessPolicyService {
  private readonly logger = new Logger(HarnessPolicyService.name);

  constructor(
    private readonly policyRepository: HarnessPolicyRepository,
    private readonly policyChangeRepository: HarnessPolicyChangeRepository,
    @Inject('CORE_DATABASE_SERVICE') private readonly databaseService: CoreDatabaseService,
    private readonly clsService: ClsService<IActiveUserContext>,
    // TASK-369 Phase 3D — optional so fixtures keep their 4-arg construction and
    // non-Vault deployments degrade to plaintext WORM change rows.
    @Optional() @Inject(SecretsService) private readonly secretsService?: SecretsService,
    // TASK-511 (Phase 3A) — optional so existing fixtures keep their 4/5-arg
    // construction; when absent, `resolveSmrSelection` uses only the legacy
    // HarnessPolicy cascade (the AiTaskDefault-first path is a no-op).
    @Optional() @Inject(IAiTaskDefaultService) private readonly aiTaskDefaultService?: IAiTaskDefaultService,
  ) {}

  /**
   * TASK-369 Phase 3D — best-effort encrypt the before/after policy snapshots so
   * the WORM `HarnessPolicyChange` row stores ciphertext (+ a redaction sentinel
   * in the plaintext JSONB). Done OUTSIDE the change transaction (the Vault
   * round-trip must not hold a DB connection open). Returns null when there is no
   * SecretsService or Vault errors — the change is then written in plaintext.
   */
  private async encryptChangePayloads(before: JsonValue | null, after: JsonValue): Promise<EncryptedChangePayloads | null> {
    if (!this.secretsService) return null;
    try {
      return await this.policyChangeRepository.encryptPayloads(this.secretsService, before, after);
    } catch (error) {
      this.logger.warn({
        message: 'HarnessPolicyChange payload encryption failed — writing plaintext change row',
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private get callerTenantId(): string | null {
    return this.clsService.get('tenantId') || null;
  }

  private get callerUserId(): string | null {
    return this.clsService.get('user')?.id ?? null;
  }

  /**
   * The effective policy for a tenant (own row → system default → code default).
   * `tenantId` defaults to the CLS tenant; the worker-facing internal endpoint
   * passes it explicitly.
   */
  async getEffectivePolicy(tenantId?: string): Promise<HarnessPolicyResponse> {
    const tid = tenantId ?? this.callerTenantId;
    if (!tid) throw new BadRequestException('Tenant ID is required');

    const own = await this.policyRepository.findForExactTenant(tid);
    if (own) {
      const resp = toResponse(own, 'tenant');
      // TASK-356 D-7 (B1): field-level fallthrough for the two SMR fields ONLY.
      // A tenant row created before Phase 2 (when the SYSTEM default was null)
      // can carry null smrProvider/smrModel; fill them from the SYSTEM default
      // so the effective SMR selection is never null when a platform default
      // exists. The harness benefits with zero apps/harness change (it reads
      // this via the worker-facing endpoint). All other knobs stay row-level.
      if (resp.smrProvider === null || resp.smrModel === null) {
        const sys = await this.policyRepository.findSystemDefault();
        if (sys) {
          if (resp.smrProvider === null) resp.smrProvider = sys.smrProvider ?? null;
          if (resp.smrModel === null) resp.smrModel = sys.smrModel ?? null;
        }
      }
      return resp;
    }

    const sys = await this.policyRepository.findSystemDefault();
    if (sys) return toResponse(sys, 'system-default');

    return codeDefaultResponse(tid);
  }

  /**
   * TASK-356 D-7 (B2) — the single fail-closed SMR-selection seam every TS
   * `/api/v1/generate` caller funnels through. Resolves the effective policy
   * (tenant own → SYSTEM default → code default, with the B1 field-level
   * fallthrough) and returns a GUARANTEED-non-null `{ provider, model }`.
   *
   * Throws when the cascade yields no provider/model so the admin-managed
   * default can never be silently bypassed (SMR itself also fail-closes with a
   * 422).
   *
   * TASK-511 (Phase 3A) — model-routing precedence (TRACKER D-11): the
   * `AiTaskDefault` key for the task (`smr.live` / `smr.finalize`) is consulted
   * FIRST. When it resolves to an ENABLED model, its `{ provider, sourceUri }`
   * wins (sourceUri is the provider-native identifier actually sent to SMR).
   * The legacy `HarnessPolicy.smrProvider/smrModel` cascade is the documented
   * fallback for tenants that have not migrated to AiTaskDefault. D-10 holds:
   * SMR stays a stateless gateway; the caller model resolved here is authority.
   */
  async resolveSmrSelection(tenantId?: string, task: SmrRoutingTask = 'finalize'): Promise<{ provider: string; model: string }> {
    // Precedence 1 — AiTaskDefault (when wired). A resolved model's sourceUri is
    // the provider-native id SMR expects; provider is the canonical runtime.
    if (this.aiTaskDefaultService) {
      try {
        const eff = await this.aiTaskDefaultService.getEffective(SMR_TASK_KEY[task], tenantId);
        const model = eff.model;
        if (model?.provider && model.sourceUri) {
          return { provider: model.provider, model: model.sourceUri };
        }
      } catch (error) {
        // A misconfigured/unknown task key must not sink the legacy path.
        this.logger.warn({
          message: `AiTaskDefault SMR routing lookup failed for '${SMR_TASK_KEY[task]}' — falling back to HarnessPolicy cascade`,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Precedence 2 — legacy HarnessPolicy.smrProvider/smrModel cascade.
    const effective = await this.getEffectivePolicy(tenantId);
    if (!effective.smrProvider || !effective.smrModel) {
      throw new BadRequestException(
        'No SMR model is configured for this tenant. Configure the AiTaskDefault `smr.finalize`/`smr.live` key or set HarnessPolicy.smrProvider/smrModel on the tenant or the SYSTEM default.',
      );
    }
    return { provider: effective.smrProvider, model: effective.smrModel };
  }

  /** The SYSTEM-tenant GLOBAL-DEFAULT policy (platform editor reads this). */
  async getGlobalDefault(): Promise<HarnessPolicyResponse> {
    const sys = await this.policyRepository.findSystemDefault();
    if (sys) return toResponse(sys, 'system-default');
    return codeDefaultResponse(SYSTEM_TENANT_ID);
  }

  /** Edit the calling tenant's policy row (created on first edit). */
  async updatePolicy(dto: UpdateHarnessPolicyRequest, expectedVersion?: number): Promise<HarnessPolicyResponse> {
    const tid = this.callerTenantId;
    if (!tid) throw new BadRequestException('Tenant ID is required');
    return this.upsert(tid, 'tenant', dto, expectedVersion);
  }

  /** Edit the SYSTEM-tenant GLOBAL-DEFAULT policy row (platform-only). */
  async updateGlobalDefault(dto: UpdateHarnessPolicyRequest, expectedVersion?: number): Promise<HarnessPolicyResponse> {
    return this.upsert(SYSTEM_TENANT_ID, 'system-default', dto, expectedVersion);
  }

  /**
   * Shared CAS-update-or-create for one policy row + its WORM change record.
   * `expectedVersion` (the `If-Match` value) is the CAS predicate when the row
   * exists; on first edit (no row) it is the inherited default's version and a
   * row is created instead (the UNIQUE(tenantId) index is the create backstop).
   */
  private async upsert(
    tenantId: string,
    source: HarnessPolicySource,
    dto: UpdateHarnessPolicyRequest,
    expectedVersion?: number,
  ): Promise<HarnessPolicyResponse> {
    const changedBy = this.callerUserId;
    const reason = dto.reason ?? null;
    const own = await this.policyRepository.findForExactTenant(tenantId);

    if (own) {
      const before = entityToKnobs(own);
      applyKnobsToEntity(own, dto);
      if (!own.hasChanges) {
        // Idempotent no-op edit — nothing to write or audit.
        return toResponse(own, source);
      }
      own.updatedBy = changedBy;
      own.validate();

      // Knobs after the patch == the persisted row's knobs (the update only bumps
      // `version`), so snapshot + encrypt here, before opening the transaction.
      const after = entityToKnobs(own);
      const beforeJson = before as unknown as JsonValue;
      const afterJson = after as unknown as JsonValue;
      const enc = await this.encryptChangePayloads(beforeJson, afterJson);

      const casVersion = expectedVersion ?? own.version;
      const updated = await this.databaseService.baseClient.$transaction(async (tx) => {
        const u = await this.policyRepository.updateWithVersion(own.id, own, casVersion, tx);
        const change = HarnessPolicyChangeFactory.CreateHarnessPolicyChange({
          tenantId,
          changedBy,
          policyVersion: u.version,
          beforeJson,
          afterJson,
          encryptedBeforeJson: enc?.encryptedBeforeJson ?? null,
          encryptedAfterJson: enc?.encryptedAfterJson ?? null,
          keyVersion: enc?.keyVersion ?? null,
          reason,
          createdBy: changedBy,
        });
        await this.policyChangeRepository.create(change, tx);
        return u;
      });
      return toResponse(updated, source);
    }

    // First edit → create the row, seeded from the inherited default (the
    // SYSTEM global default for a tenant row; the code defaults for the global
    // row itself), then apply the patch over it.
    const inherited = source === 'tenant' ? await this.policyRepository.findSystemDefault() : null;
    const base: HarnessPolicyKnobs = inherited
      ? entityToKnobs(inherited)
      : (HARNESS_POLICY_DEFAULTS as unknown as HarnessPolicyKnobs);
    const merged = mergeKnobs(base, dto);
    const entity = HarnessPolicyFactory.CreateHarnessPolicy({ tenantId, ...merged, createdBy: changedBy });
    entity.validate();

    // First edit ⇒ before is null; the created row's knobs == the entity's knobs.
    const afterJson = entityToKnobs(entity) as unknown as JsonValue;
    const enc = await this.encryptChangePayloads(null, afterJson);

    const created = await this.databaseService.baseClient.$transaction(async (tx) => {
      const c = await this.policyRepository.create(entity, tx);
      const change = HarnessPolicyChangeFactory.CreateHarnessPolicyChange({
        tenantId,
        changedBy,
        policyVersion: c.version,
        beforeJson: null,
        afterJson,
        encryptedBeforeJson: enc?.encryptedBeforeJson ?? null,
        encryptedAfterJson: enc?.encryptedAfterJson ?? null,
        keyVersion: enc?.keyVersion ?? null,
        reason,
        createdBy: changedBy,
      });
      await this.policyChangeRepository.create(change, tx);
      return c;
    });
    return toResponse(created, source);
  }
}

/** Map a hydrated policy entity to the flat effective-policy response. */
function toResponse(e: HarnessPolicyEntity, source: HarnessPolicySource): HarnessPolicyResponse {
  return {
    id: e.id,
    tenantId: e.tenantId,
    source,
    ...entityToKnobs(e),
    updatedAt: e.updatedAt ? e.updatedAt.toISOString() : null,
    version: e.version,
  };
}

/**
 * Fallback response when neither a tenant row nor the SYSTEM default exists —
 * the harness code defaults, with `version: 0` so the ETag interceptor emits no
 * ETag (there is no row to compare-and-set against yet).
 */
function codeDefaultResponse(tenantId: string): HarnessPolicyResponse {
  return {
    id: null,
    tenantId,
    source: 'code-default',
    ...(HARNESS_POLICY_DEFAULTS as unknown as HarnessPolicyKnobs),
    updatedAt: null,
    version: 0,
  };
}
