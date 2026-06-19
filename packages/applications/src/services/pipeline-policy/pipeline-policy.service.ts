import { BadRequestException, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import {
  CoreDatabaseService,
  JsonValue,
  PipelinePolicyChangeFactory,
  PipelinePolicyChangeRepository,
  PipelinePolicyEntity,
  PipelinePolicyFactory,
  PipelinePolicyRepository,
  PipelinePolicyScope,
  SYSTEM_TENANT_ID,
} from '@arcaai/domains';
import { IActiveUserContext } from '../../interfaces';
import { SecretsService } from '../baseServices/_meta/secrets';
import { ConfigResolver, PIPELINE_SETTING_DESCRIPTORS, PipelineToggleKey } from '../config-resolver';
import { PipelinePolicyEffectiveResponse, PipelinePolicyResponse, PipelinePolicySource, UpdatePipelinePolicyRequest } from './dto';

/** Ciphertext payloads threaded into the change factory (TASK-369 Phase 3D). */
interface EncryptedChangePayloads {
  encryptedBeforeJson: Buffer | null;
  encryptedAfterJson: Buffer | null;
  keyVersion: number | null;
}

/**
 * The three cascade toggles this admin surface may write (NULLABLE = inherit).
 * The doctor-scope `dnaStyleEnabled` column is deliberately excluded — it is
 * READ-only this phase (Phase 6 writes it via the doctor self-service surface).
 */
const WRITABLE_TOGGLE_KEYS = ['autoSummaryEnabled', 'autoNerEnabled', 'harnessEnabled'] as const;

/** Cascade depth: deeper scopes may override shallower ones. */
const SCOPE_DEPTH: Record<PipelinePolicyScope, number> = {
  [PipelinePolicyScope.TENANT]: 1,
  [PipelinePolicyScope.DEPARTMENT]: 2,
  [PipelinePolicyScope.DOCTOR]: 3,
};

interface PolicyToggleSnapshot {
  autoSummaryEnabled: boolean | null;
  autoNerEnabled: boolean | null;
  harnessEnabled: boolean | null;
  dnaStyleEnabled: boolean | null;
}

/**
 * TASK-356 Phase 6 (S3) — the resolved DNA-style settings for one doctor: the
 * effective decision (`tenant AND doctor`), the tenant gate, the doctor's
 * explicit toggle, and the DOCTOR-row OCC `version` (0 when no row exists yet).
 */
export interface DnaStyleSettings {
  effective: boolean;
  tenantEnabled: boolean;
  doctorToggle: boolean | null;
  version: number;
}

/** Read the nullable toggle values off a hydrated entity (getters non-enumerable). */
function entityToToggles(e: PipelinePolicyEntity): PolicyToggleSnapshot {
  return {
    autoSummaryEnabled: e.autoSummaryEnabled ?? null,
    autoNerEnabled: e.autoNerEnabled ?? null,
    harnessEnabled: e.harnessEnabled ?? null,
    dnaStyleEnabled: e.dnaStyleEnabled ?? null,
  };
}

/**
 * PipelinePolicyService (TASK-356 Phase 5 — Pillar B) — DB-backed, editable
 * realtime-pipeline policy that drives the auto-summary / auto-NER / harness-vs-
 * legacy cascade. Mirrors `HarnessPolicyService`'s OCC + WORM contract, adapted
 * for the polymorphic (scope/scopeId) table:
 *
 *  - `getEffective(ctx)` delegates the layered resolution to `ConfigResolver`
 *    (doctor → department → tenant → SYSTEM default → code default) and returns
 *    the resolved booleans + per-toggle trace.
 *  - `getRow(...)` returns ONE raw policy row (nullable toggles) for editing,
 *    or a code-default placeholder (version 0) when the row does not exist yet.
 *  - `upsertRow(...)` edits one row under optimistic-concurrency CAS and appends
 *    a before/after `PipelinePolicyChange` WORM record in the SAME transaction
 *    (an edit is never recorded without its audit row, and vice versa). Every
 *    supplied toggle is checked against its registered MAX SCOPE first, so e.g.
 *    `harnessEnabled` can never be pinned per-doctor (§12 Q7).
 *
 * The doctor-scope `dnaStyleEnabled` column is READ-only here (Phase 5); the
 * Phase 6 doctor self-service surface writes it. This admin write surface is
 * tenant/department only.
 */
@Injectable()
export class PipelinePolicyService {
  private readonly logger = new Logger(PipelinePolicyService.name);

  constructor(
    private readonly policyRepository: PipelinePolicyRepository,
    private readonly policyChangeRepository: PipelinePolicyChangeRepository,
    @Inject('CORE_DATABASE_SERVICE') private readonly databaseService: CoreDatabaseService,
    private readonly clsService: ClsService<IActiveUserContext>,
    private readonly configResolver: ConfigResolver,
    // TASK-369 Phase 3D — optional so fixtures keep their 5-arg construction and
    // non-Vault deployments degrade to plaintext WORM change rows.
    @Optional() @Inject(SecretsService) private readonly secretsService?: SecretsService,
  ) {}

  private get callerUserId(): string | null {
    return this.clsService.get('user')?.id ?? null;
  }

  /**
   * TASK-369 Phase 3D — best-effort encrypt the before/after toggle snapshots so
   * the WORM `PipelinePolicyChange` row stores ciphertext (+ a redaction sentinel
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
        message: 'PipelinePolicyChange payload encryption failed — writing plaintext change row',
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /** The resolved effective cascade (booleans + trace) for a consultation context. */
  async getEffective(ctx: { tenantId: string; departmentId?: string | null; doctorId?: string | null }): Promise<PipelinePolicyEffectiveResponse> {
    const resolved = await this.configResolver.resolvePipelineToggles({
      tenantId: ctx.tenantId,
      departmentId: ctx.departmentId ?? null,
      doctorId: ctx.doctorId ?? null,
    });
    return {
      tenantId: ctx.tenantId,
      departmentId: ctx.departmentId ?? null,
      doctorId: ctx.doctorId ?? null,
      autoSummaryEnabled: resolved.autoSummaryEnabled,
      autoNerEnabled: resolved.autoNerEnabled,
      harnessEnabled: resolved.harnessEnabled,
      dnaStyleEnabled: resolved.dnaStyleEnabled,
      trace: resolved.trace,
    };
  }

  /** One raw policy row for editing (or a code-default placeholder when unset). */
  async getRow(params: { tenantId: string; scope: PipelinePolicyScope; scopeId?: string | null }): Promise<PipelinePolicyResponse> {
    const { tenantId, scope } = params;
    const scopeId = params.scopeId ?? null;
    const row = await this.policyRepository.findForScope(tenantId, scope, scopeId);
    if (row) return toResponse(row);
    return codeDefaultResponse(tenantId, scope, scopeId);
  }

  /**
   * CAS-update-or-create one policy row + its WORM change record. On first edit
   * (no row) the row is created pinning ONLY the supplied toggles (the rest stay
   * null = inherit); the UNIQUE(tenantId, scope, scopeId) index is the create
   * backstop. Every supplied toggle is validated against its max scope first.
   */
  async upsertRow(params: {
    tenantId: string;
    scope: PipelinePolicyScope;
    scopeId?: string | null;
    dto: UpdatePipelinePolicyRequest;
    expectedVersion?: number;
  }): Promise<PipelinePolicyResponse> {
    const { tenantId, scope, dto, expectedVersion } = params;
    const scopeId = scope === PipelinePolicyScope.TENANT ? null : params.scopeId ?? null;

    this.assertWithinMaxScope(scope, dto);

    const changedBy = this.callerUserId;
    const reason = dto.reason ?? null;
    const existing = await this.policyRepository.findForScope(tenantId, scope, scopeId);

    if (existing) {
      const before = entityToToggles(existing);
      applyTogglesToEntity(existing, dto);
      if (!existing.hasChanges) {
        return toResponse(existing); // idempotent no-op — nothing to write or audit.
      }
      existing.updatedBy = changedBy;
      existing.validate();

      // Toggles after the patch == the persisted row's toggles (update only bumps
      // `version`), so snapshot + encrypt here, before opening the transaction.
      const beforeJson = before as unknown as JsonValue;
      const afterJson = entityToToggles(existing) as unknown as JsonValue;
      const enc = await this.encryptChangePayloads(beforeJson, afterJson);

      const casVersion = expectedVersion ?? existing.version;
      const updated = await this.databaseService.baseClient.$transaction(async (tx) => {
        const u = await this.policyRepository.updateWithVersion(existing.id, existing, casVersion, tx);
        await this.policyChangeRepository.create(
          PipelinePolicyChangeFactory.CreatePipelinePolicyChange({
            tenantId,
            scope,
            scopeId,
            changedBy,
            policyVersion: u.version,
            beforeJson,
            afterJson,
            encryptedBeforeJson: enc?.encryptedBeforeJson ?? null,
            encryptedAfterJson: enc?.encryptedAfterJson ?? null,
            keyVersion: enc?.keyVersion ?? null,
            reason,
            createdBy: changedBy,
          }),
          tx,
        );
        return u;
      });
      return toResponse(updated);
    }

    // First edit → create the row pinning only the supplied toggles.
    const entity = PipelinePolicyFactory.CreatePipelinePolicy({
      tenantId,
      scope,
      scopeId,
      autoSummaryEnabled: dto.autoSummaryEnabled ?? null,
      autoNerEnabled: dto.autoNerEnabled ?? null,
      harnessEnabled: dto.harnessEnabled ?? null,
      createdBy: changedBy,
    });
    entity.validate();

    const afterJson = entityToToggles(entity) as unknown as JsonValue;
    const enc = await this.encryptChangePayloads(null, afterJson);

    const created = await this.databaseService.baseClient.$transaction(async (tx) => {
      const c = await this.policyRepository.create(entity, tx);
      await this.policyChangeRepository.create(
        PipelinePolicyChangeFactory.CreatePipelinePolicyChange({
          tenantId,
          scope,
          scopeId,
          changedBy,
          policyVersion: c.version,
          beforeJson: null,
          afterJson,
          encryptedBeforeJson: enc?.encryptedBeforeJson ?? null,
          encryptedAfterJson: enc?.encryptedAfterJson ?? null,
          keyVersion: enc?.keyVersion ?? null,
          reason,
          createdBy: changedBy,
        }),
        tx,
      );
      return c;
    });
    return toResponse(created);
  }

  /**
   * TASK-356 Phase 6 (S3) — READ the per-doctor DNA settings: the effective
   * decision (`tenant AND doctor`, resolved via {@link ConfigResolver}) plus the
   * DOCTOR-scope row's OCC `version` (0 when no override row exists yet) so a
   * subsequent write can compare-and-set.
   */
  async getDnaSettings(params: { tenantId: string; doctorId: string }): Promise<DnaStyleSettings> {
    const { tenantId, doctorId } = params;
    const resolved = await this.configResolver.resolveEffectiveDnaStyleEnabled({ tenantId, doctorId });
    const row = await this.policyRepository.findForScope(tenantId, PipelinePolicyScope.DOCTOR, doctorId);
    return {
      effective: resolved.effective,
      tenantEnabled: resolved.tenantEnabled,
      doctorToggle: resolved.doctorToggle,
      version: row?.version ?? 0,
    };
  }

  /**
   * TASK-356 Phase 6 (S3) — doctor self-service WRITE of the DOCTOR-scope
   * `dnaStyleEnabled` toggle. This is the ONLY write path for that column (the
   * admin `upsertRow` surface above deliberately excludes it). Mirrors
   * `upsertRow`'s OCC + WORM contract: the row edit and its before/after
   * `PipelinePolicyChange` commit together in ONE transaction.
   *
   *  - `true`  → explicit opt-in.
   *  - `false` → explicit opt-out (a doctor may opt out under an enabled tenant).
   *  - `null`  → clear the pin (revert to the implicit opt-in default); when no
   *              row exists this is a no-op (nothing to override).
   *
   * Returns the RE-RESOLVED effective settings so the caller sees the tenant
   * gate applied immediately.
   */
  async setDnaStyleForDoctor(params: {
    tenantId: string;
    doctorId: string;
    enabled: boolean | null;
    reason?: string | null;
    expectedVersion?: number;
  }): Promise<DnaStyleSettings> {
    const { tenantId, doctorId, enabled, expectedVersion } = params;
    const scope = PipelinePolicyScope.DOCTOR;
    const scopeId = doctorId;
    const changedBy = this.callerUserId;
    const reason = params.reason ?? null;

    const existing = await this.policyRepository.findForScope(tenantId, scope, scopeId);

    if (existing) {
      const before = entityToToggles(existing);
      // Bracket assignment invokes the prototype setter, so the write is tracked
      // (only a real value change marks the row dirty → idempotent no-op below).
      (existing as unknown as Record<string, unknown>).dnaStyleEnabled = enabled;
      if (!existing.hasChanges) {
        return this.settingsAfterWrite(tenantId, doctorId, existing.version); // idempotent
      }
      existing.updatedBy = changedBy;
      existing.validate();

      const beforeJson = before as unknown as JsonValue;
      const afterJson = entityToToggles(existing) as unknown as JsonValue;
      const enc = await this.encryptChangePayloads(beforeJson, afterJson);

      const casVersion = expectedVersion ?? existing.version;
      const updated = await this.databaseService.baseClient.$transaction(async (tx) => {
        const u = await this.policyRepository.updateWithVersion(existing.id, existing, casVersion, tx);
        await this.policyChangeRepository.create(
          PipelinePolicyChangeFactory.CreatePipelinePolicyChange({
            tenantId,
            scope,
            scopeId,
            changedBy,
            policyVersion: u.version,
            beforeJson,
            afterJson,
            encryptedBeforeJson: enc?.encryptedBeforeJson ?? null,
            encryptedAfterJson: enc?.encryptedAfterJson ?? null,
            keyVersion: enc?.keyVersion ?? null,
            reason,
            createdBy: changedBy,
          }),
          tx,
        );
        return u;
      });
      return this.settingsAfterWrite(tenantId, doctorId, updated.version);
    }

    // No row yet. Clearing (null) overrides nothing → skip the empty create.
    if (enabled === null) {
      return this.settingsAfterWrite(tenantId, doctorId, 0);
    }

    // First edit → create the DOCTOR-scope row pinning only dnaStyleEnabled.
    const entity = PipelinePolicyFactory.CreatePipelinePolicy({
      tenantId,
      scope,
      scopeId,
      dnaStyleEnabled: enabled,
      createdBy: changedBy,
    });
    entity.validate();

    const afterJson = entityToToggles(entity) as unknown as JsonValue;
    const enc = await this.encryptChangePayloads(null, afterJson);

    const created = await this.databaseService.baseClient.$transaction(async (tx) => {
      const c = await this.policyRepository.create(entity, tx);
      await this.policyChangeRepository.create(
        PipelinePolicyChangeFactory.CreatePipelinePolicyChange({
          tenantId,
          scope,
          scopeId,
          changedBy,
          policyVersion: c.version,
          beforeJson: null,
          afterJson,
          encryptedBeforeJson: enc?.encryptedBeforeJson ?? null,
          encryptedAfterJson: enc?.encryptedAfterJson ?? null,
          keyVersion: enc?.keyVersion ?? null,
          reason,
          createdBy: changedBy,
        }),
        tx,
      );
      return c;
    });
    return this.settingsAfterWrite(tenantId, doctorId, created.version);
  }

  /** Shape the post-write DNA settings: re-resolve effective + carry the row version. */
  private async settingsAfterWrite(tenantId: string, doctorId: string, version: number): Promise<DnaStyleSettings> {
    const resolved = await this.configResolver.resolveEffectiveDnaStyleEnabled({ tenantId, doctorId });
    return {
      effective: resolved.effective,
      tenantEnabled: resolved.tenantEnabled,
      doctorToggle: resolved.doctorToggle,
      version,
    };
  }

  /**
   * Reject any supplied toggle whose registered MAX SCOPE is shallower than the
   * row's scope (e.g. `harnessEnabled` pinned at DOCTOR). This is the write-side
   * guard that complements the `ConfigResolver` read-side clamp (§7).
   */
  private assertWithinMaxScope(scope: PipelinePolicyScope, dto: UpdatePipelinePolicyRequest): void {
    for (const key of WRITABLE_TOGGLE_KEYS) {
      if ((dto as Record<string, unknown>)[key] === undefined) continue;
      const maxScope = PIPELINE_SETTING_DESCRIPTORS[key as PipelineToggleKey].maxScope;
      if (SCOPE_DEPTH[scope] > SCOPE_DEPTH[maxScope]) {
        throw new BadRequestException(`'${key}' cannot be set at ${scope} scope (max scope: ${maxScope}).`);
      }
    }
  }
}

/** Apply only the DTO's supplied toggles onto an entity (drives change tracking). */
function applyTogglesToEntity(entity: PipelinePolicyEntity, dto: UpdatePipelinePolicyRequest): void {
  for (const key of WRITABLE_TOGGLE_KEYS) {
    const patched = (dto as Record<string, unknown>)[key];
    if (patched !== undefined) {
      // Bracket assignment invokes the prototype setter, so each write is
      // recorded via `setProperty` (only real value changes mark the row dirty).
      (entity as unknown as Record<string, unknown>)[key] = patched as boolean | null;
    }
  }
}

/** Map a hydrated policy row to the row response, tagging where it came from. */
function toResponse(e: PipelinePolicyEntity): PipelinePolicyResponse {
  return {
    id: e.id,
    tenantId: e.tenantId,
    scope: e.scope,
    scopeId: e.scopeId ?? null,
    source: rowSource(e.scope, e.tenantId),
    autoSummaryEnabled: e.autoSummaryEnabled ?? null,
    autoNerEnabled: e.autoNerEnabled ?? null,
    harnessEnabled: e.harnessEnabled ?? null,
    dnaStyleEnabled: e.dnaStyleEnabled ?? null,
    updatedAt: e.updatedAt ? e.updatedAt.toISOString() : null,
    version: e.version,
  };
}

function rowSource(scope: PipelinePolicyScope, tenantId: string): PipelinePolicySource {
  if (scope === PipelinePolicyScope.DEPARTMENT) return 'department';
  if (scope === PipelinePolicyScope.DOCTOR) return 'doctor';
  return tenantId === SYSTEM_TENANT_ID ? 'system-default' : 'tenant';
}

/**
 * Placeholder for a row that does not exist yet — all toggles null (full
 * inherit) with `version: 0` so the ETag interceptor emits no ETag (there is no
 * row to compare-and-set against). The first PATCH creates the row.
 */
function codeDefaultResponse(tenantId: string, scope: PipelinePolicyScope, scopeId: string | null): PipelinePolicyResponse {
  return {
    id: null,
    tenantId,
    scope,
    scopeId,
    source: 'code-default',
    autoSummaryEnabled: null,
    autoNerEnabled: null,
    harnessEnabled: null,
    dnaStyleEnabled: null,
    updatedAt: null,
    version: 0,
  };
}
