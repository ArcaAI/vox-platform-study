import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { PipelinePolicyEntity, PipelinePolicyRepository, PipelinePolicyScope, UserProfileRepository } from '@arcaai/domains';
import { CascadeTier, walkCascade } from '../settings-registry/scope-cascade';

/**
 * Generalized realtime-config cascade resolver.
 *
 * Resolves the per-consultation pipeline toggles by walking the policy cascade
 *
 *   doctor → department → tenant → SYSTEM-tenant default → code default
 *
 * short-circuiting at the first tier that supplies a non-null value, while
 * clamping every setting to its configured MAX SCOPE (so e.g. `harnessEnabled`
 * can never be set per-doctor — Q7). Also threads the consulting doctor's
 * `UserProfile.preferredPromptTemplateId` (read-only here) for every generation
 * path. NO writes happen here — the doctor-scope writes live elsewhere.
 */

/** The realtime cascade knobs ConfigResolver resolves. */
export type PipelineToggleKey = 'autoSummaryEnabled' | 'autoNerEnabled' | 'harnessEnabled' | 'dnaStyleEnabled' | 'dnaRedactionEnabled';

/** Which cascade tier supplied a resolved value (audit trace). */
export type ConfigResolutionSource = 'doctor' | 'department' | 'tenant' | 'system-default' | 'code-default';

export interface ConfigResolutionContext {
  tenantId: string;
  departmentId?: string | null;
  doctorId?: string | null;
  /**
   * The consultation's default DepartmentAgent gate. When its
   * `dnaStylePolicy` is `DISABLED`, DNA redaction is forced OFF for that agent
   * regardless of the tenant/doctor gates. Resolved by the caller (which already
   * knows the department's default agent) and passed in as a plain flag so the
   * resolver stays free of a DepartmentAgent dependency.
   */
  departmentAgentDnaDisabled?: boolean;
}

export interface ResolvedPipelineToggles {
  autoSummaryEnabled: boolean;
  autoNerEnabled: boolean;
  harnessEnabled: boolean;
  dnaStyleEnabled: boolean;
  dnaRedactionEnabled: boolean;
  /** Which cascade tier supplied each toggle (for audit/debug). */
  trace: Record<PipelineToggleKey, ConfigResolutionSource>;
}

/**
 * The resolved per-consultation DNA-style decision.
 * `effective = tenantEnabled && (doctorToggle ?? true)`: the tenant gate is the
 * non-doctor cascade resolution; the doctor toggle is an explicit opt-out (or an
 * implicit opt-in when unset).
 */
export interface ResolvedDnaStyle {
  /** Final decision: apply DNA style / learn from this doctor? */
  effective: boolean;
  /** Whether the tenant (department/tenant/system cascade, doctor EXCLUDED) permits DNA. */
  tenantEnabled: boolean;
  /** The doctor's explicit DOCTOR-scope toggle, or null when unset (implicit opt-in). */
  doctorToggle: boolean | null;
}

/** Per-setting descriptor: the code default + the highest tier allowed to set it. */
interface SettingDescriptor {
  codeDefault: boolean;
  maxScope: PipelinePolicyScope;
}

/**
 * The setting registry (/ Q7):
 *  - `autoSummaryEnabled` / `autoNerEnabled` may be set down to DOCTOR scope.
 *  - `harnessEnabled` is capped at DEPARTMENT (never per-doctor) and code-defaults
 *    to `false` (fail-closed) when nothing resolves.
 *  - `dnaStyleEnabled` is DOCTOR-scope storage (written elsewhere); read here.
 */
export const PIPELINE_SETTING_DESCRIPTORS: Record<PipelineToggleKey, SettingDescriptor> = {
  autoSummaryEnabled: { codeDefault: true, maxScope: PipelinePolicyScope.DOCTOR },
  autoNerEnabled: { codeDefault: true, maxScope: PipelinePolicyScope.DOCTOR },
  harnessEnabled: { codeDefault: false, maxScope: PipelinePolicyScope.DEPARTMENT },
  dnaStyleEnabled: { codeDefault: false, maxScope: PipelinePolicyScope.DOCTOR },
  // The TENANT-level enablement gate for DNA redaction; the doctor
  // opt-in is the doctor's DNA toggle (see resolveEffectiveDnaRedactionEnabled).
  dnaRedactionEnabled: { codeDefault: false, maxScope: PipelinePolicyScope.TENANT },
};

const TOGGLE_KEYS = Object.keys(PIPELINE_SETTING_DESCRIPTORS) as PipelineToggleKey[];

@Injectable()
export class ConfigResolver {
  private readonly logger = new Logger(ConfigResolver.name);

  constructor(
    @Inject(PipelinePolicyRepository) private readonly pipelinePolicyRepository: PipelinePolicyRepository,
    // Optional + trailing so existing positional test fixtures keep compiling;
    // production DI (CoreDatabaseModule) always supplies it.
    @Optional() @Inject(UserProfileRepository) private readonly userProfileRepository?: UserProfileRepository,
  ) {}

  /**
   * Resolve every pipeline toggle for a consultation context. On a lookup failure
   * the resolver degrades to the code defaults (fail-safe realtime path) rather
   * than throwing into the event pipeline.
   */
  async resolvePipelineToggles(ctx: ConfigResolutionContext): Promise<ResolvedPipelineToggles> {
    let cascadeRows: PipelinePolicyEntity[] = [];
    let systemRow: PipelinePolicyEntity | null = null;

    try {
      [cascadeRows, systemRow] = await Promise.all([
        this.pipelinePolicyRepository.findCascadeRows({
          tenantId: ctx.tenantId,
          departmentId: ctx.departmentId ?? null,
          doctorId: ctx.doctorId ?? null,
        }),
        this.pipelinePolicyRepository.findSystemDefault(),
      ]);
    } catch (error) {
      this.logger.warn({
        message: 'Pipeline policy lookup failed — falling back to code defaults',
        tenantId: ctx.tenantId,
        error: error instanceof Error ? error.message : String(error),
      });
      return this.codeDefaultResult();
    }

    const doctorRow =
      ctx.doctorId != null ? (cascadeRows.find((r) => r.scope === PipelinePolicyScope.DOCTOR && r.scopeId === ctx.doctorId) ?? null) : null;
    const departmentRow =
      ctx.departmentId != null
        ? (cascadeRows.find((r) => r.scope === PipelinePolicyScope.DEPARTMENT && r.scopeId === ctx.departmentId) ?? null)
        : null;
    const tenantRow = cascadeRows.find((r) => r.scope === PipelinePolicyScope.TENANT) ?? null;

    const result = this.codeDefaultResult();
    for (const key of TOGGLE_KEYS) {
      const resolved = this.resolveOne(key, { doctorRow, departmentRow, tenantRow, systemRow });
      result[key] = resolved.value;
      result.trace[key] = resolved.source;
    }
    return result;
  }

  /**
   * Resolve the effective DNA-style decision for a
   * consultation context: `effective = tenantEnabled && (doctorToggle ?? true)`.
   *
   *  - `tenantEnabled` is the `dnaStyleEnabled` cascade resolution with the DOCTOR
   *    tier EXCLUDED (department → tenant → SYSTEM default → code default=false),
   *    i.e. "does the tenant permit DNA at all?".
   *  - `doctorToggle` is the doctor's explicit DOCTOR-scope row value, or null
   *    when they have not set it (an unset toggle is an implicit opt-in).
   *
   * Fail-CLOSED: on any lookup failure DNA is treated as off (matching the
   * `dnaStyleEnabled` code default), so the realtime path never styles/learns on
   * a degraded config read.
   */
  async resolveEffectiveDnaStyleEnabled(ctx: ConfigResolutionContext): Promise<ResolvedDnaStyle> {
    let cascadeRows: PipelinePolicyEntity[] = [];
    let systemRow: PipelinePolicyEntity | null = null;

    try {
      [cascadeRows, systemRow] = await Promise.all([
        this.pipelinePolicyRepository.findCascadeRows({
          tenantId: ctx.tenantId,
          departmentId: ctx.departmentId ?? null,
          doctorId: ctx.doctorId ?? null,
        }),
        this.pipelinePolicyRepository.findSystemDefault(),
      ]);
    } catch (error) {
      this.logger.warn({
        message: 'DNA-style policy lookup failed — failing closed (DNA off)',
        tenantId: ctx.tenantId,
        error: error instanceof Error ? error.message : String(error),
      });
      return { effective: false, tenantEnabled: false, doctorToggle: null };
    }

    const departmentRow =
      ctx.departmentId != null
        ? (cascadeRows.find((r) => r.scope === PipelinePolicyScope.DEPARTMENT && r.scopeId === ctx.departmentId) ?? null)
        : null;
    const tenantRow = cascadeRows.find((r) => r.scope === PipelinePolicyScope.TENANT) ?? null;
    const doctorRow =
      ctx.doctorId != null ? (cascadeRows.find((r) => r.scope === PipelinePolicyScope.DOCTOR && r.scopeId === ctx.doctorId) ?? null) : null;

    // Tenant gate = the non-doctor cascade resolution (doctorRow EXCLUDED).
    const tenantEnabled = this.resolveOne('dnaStyleEnabled', {
      doctorRow: null,
      departmentRow,
      tenantRow,
      systemRow,
    }).value;

    const doctorToggle = doctorRow ? ((doctorRow.dnaStyleEnabled as boolean | null | undefined) ?? null) : null;
    const effective = tenantEnabled && (doctorToggle ?? true);

    return { effective, tenantEnabled, doctorToggle };
  }

  /**
   * Resolve the effective DNA REDACTION decision for a
   * consultation context. Mirrors {@link resolveEffectiveDnaStyleEnabled} as a
   * DOUBLE gate, plus the DepartmentAgent gate:
   *
   *  - `tenantEnabled` is the `dnaRedactionEnabled` cascade resolution (maxScope
   *    TENANT ⇒ tenant → SYSTEM default → code default=false; department/doctor
   *    tiers EXCLUDED) — "does the tenant permit redaction at all?".
   *  - `doctorToggle` is the doctor's DNA opt-in (their DOCTOR-scope
   *    `dnaStyleEnabled` row): redaction is a facet of the DNA feature, so a
   *    doctor who has turned DNA OFF gets no redaction. Unset ⇒ implicit opt-in.
   *  - `DepartmentAgent.dnaStylePolicy=DISABLED` (passed as
   *    `ctx.departmentAgentDnaDisabled`) forces the result OFF regardless.
   *
   * Fail-CLOSED: any lookup failure ⇒ redaction OFF (a note the doctor expected
   * redacted must never slip through on a degraded config read).
   */
  async resolveEffectiveDnaRedactionEnabled(ctx: ConfigResolutionContext): Promise<ResolvedDnaStyle> {
    let cascadeRows: PipelinePolicyEntity[] = [];
    let systemRow: PipelinePolicyEntity | null = null;

    try {
      [cascadeRows, systemRow] = await Promise.all([
        this.pipelinePolicyRepository.findCascadeRows({
          tenantId: ctx.tenantId,
          departmentId: ctx.departmentId ?? null,
          doctorId: ctx.doctorId ?? null,
        }),
        this.pipelinePolicyRepository.findSystemDefault(),
      ]);
    } catch (error) {
      this.logger.warn({
        message: 'DNA-redaction policy lookup failed — failing closed (redaction off)',
        tenantId: ctx.tenantId,
        error: error instanceof Error ? error.message : String(error),
      });
      return { effective: false, tenantEnabled: false, doctorToggle: null };
    }

    const tenantRow = cascadeRows.find((r) => r.scope === PipelinePolicyScope.TENANT) ?? null;
    const doctorRow =
      ctx.doctorId != null ? (cascadeRows.find((r) => r.scope === PipelinePolicyScope.DOCTOR && r.scopeId === ctx.doctorId) ?? null) : null;

    // maxScope TENANT ⇒ resolveOne only walks tenant + system-default; department
    // + doctor tiers are excluded by the descriptor, so pass them as null.
    const tenantEnabled = this.resolveOne('dnaRedactionEnabled', {
      doctorRow: null,
      departmentRow: null,
      tenantRow,
      systemRow,
    }).value;

    // Doctor opt-in reuses the doctor's DNA toggle (redaction is part of DNA).
    // The DepartmentAgent DISABLED gate is authoritative and forces the result
    // OFF, but does not change what the tenant/doctor gates independently say.
    const doctorToggle = doctorRow ? ((doctorRow.dnaStyleEnabled as boolean | null | undefined) ?? null) : null;
    const effective = tenantEnabled && (doctorToggle ?? true) && !ctx.departmentAgentDnaDisabled;

    return { effective, tenantEnabled, doctorToggle };
  }

  /**
   * Load the consulting doctor's
   * `UserProfile.preferredPromptTemplateId` (Tier-0 prompt selection). Returns
   * null (and never throws) when absent so resolution falls through to the
   * department/default prompt tiers.
   */
  async resolvePreferredPromptTemplateId(doctorId?: string | null): Promise<string | null> {
    if (!doctorId || !this.userProfileRepository) return null;

    try {
      const profiles = await this.userProfileRepository.findAll({ where: { userId: doctorId } });
      return profiles[0]?.preferredPromptTemplateId ?? null;
    } catch (error) {
      this.logger.warn({
        message: 'Failed to resolve preferred prompt template — falling back to department/default',
        doctorId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /** Resolve a single toggle across the cascade, honoring its max scope. */
  private resolveOne(
    key: PipelineToggleKey,
    rows: {
      doctorRow: PipelinePolicyEntity | null;
      departmentRow: PipelinePolicyEntity | null;
      tenantRow: PipelinePolicyEntity | null;
      systemRow: PipelinePolicyEntity | null;
    },
  ): { value: boolean; source: ConfigResolutionSource } {
    const { codeDefault, maxScope } = PIPELINE_SETTING_DESCRIPTORS[key];

    // Build the tier list honoring max scope (which tiers may set this key),
    // then delegate the first-set-wins walk to the shared cascade primitive.
    const tiers: CascadeTier<ConfigResolutionSource>[] = [];
    if (maxScope === PipelinePolicyScope.DOCTOR) {
      tiers.push({ source: 'doctor', value: rows.doctorRow ? rows.doctorRow[key] : null });
    }
    if (maxScope === PipelinePolicyScope.DOCTOR || maxScope === PipelinePolicyScope.DEPARTMENT) {
      tiers.push({ source: 'department', value: rows.departmentRow ? rows.departmentRow[key] : null });
    }
    tiers.push({ source: 'tenant', value: rows.tenantRow ? rows.tenantRow[key] : null });
    tiers.push({ source: 'system-default', value: rows.systemRow ? rows.systemRow[key] : null });

    return walkCascade<ConfigResolutionSource, boolean>(tiers, codeDefault);
  }

  private codeDefaultResult(): ResolvedPipelineToggles {
    return {
      autoSummaryEnabled: PIPELINE_SETTING_DESCRIPTORS.autoSummaryEnabled.codeDefault,
      autoNerEnabled: PIPELINE_SETTING_DESCRIPTORS.autoNerEnabled.codeDefault,
      harnessEnabled: PIPELINE_SETTING_DESCRIPTORS.harnessEnabled.codeDefault,
      dnaStyleEnabled: PIPELINE_SETTING_DESCRIPTORS.dnaStyleEnabled.codeDefault,
      dnaRedactionEnabled: PIPELINE_SETTING_DESCRIPTORS.dnaRedactionEnabled.codeDefault,
      trace: {
        autoSummaryEnabled: 'code-default',
        autoNerEnabled: 'code-default',
        harnessEnabled: 'code-default',
        dnaStyleEnabled: 'code-default',
        dnaRedactionEnabled: 'code-default',
      },
    };
  }
}
