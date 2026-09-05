import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  PipelinePolicyEntity,
  PipelinePolicyRepository,
  PipelinePolicyScope,
  UserProfileRepository,
  WorkflowDefinitionRepository,
} from '@arcaai/domains';
import type { WorkflowGraph, WorkflowGraphNode } from '@arcaai/workflow-contract';
import { CascadeTier, walkCascade } from '../settings-registry/scope-cascade';
import { IWorkflowAssignmentService } from '../workflow-assignment/IWorkflowAssignmentService';

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
 * to `true` since (Phase 2 exit criterion — the legacy signable
 *    generator this toggle used to fall back to no longer exists; matches the
 *    SYSTEM row flipped in `seed/14-pipeline-policy.ts`).
 *  - `dnaStyleEnabled` is DOCTOR-scope storage (written elsewhere); read here.
 */
export const PIPELINE_SETTING_DESCRIPTORS: Record<PipelineToggleKey, SettingDescriptor> = {
  autoSummaryEnabled: { codeDefault: true, maxScope: PipelinePolicyScope.DOCTOR },
  autoNerEnabled: { codeDefault: true, maxScope: PipelinePolicyScope.DOCTOR },
  harnessEnabled: { codeDefault: true, maxScope: PipelinePolicyScope.DEPARTMENT },
  dnaStyleEnabled: { codeDefault: false, maxScope: PipelinePolicyScope.DOCTOR },
  // The TENANT-level enablement gate for DNA redaction; the doctor
  // opt-in is the doctor's DNA toggle (see resolveEffectiveDnaRedactionEnabled).
  dnaRedactionEnabled: { codeDefault: false, maxScope: PipelinePolicyScope.TENANT },
};

const TOGGLE_KEYS = Object.keys(PIPELINE_SETTING_DESCRIPTORS) as PipelineToggleKey[];

/** The palette whose assigned definition governs a consultation (mirrors `PromptResolutionService`). */
const CONSULTATION_PALETTE_KEY = 'consultation';

/** / DD-6 — the node type that carries the DNA-redaction pass. */
const DNA_REDACTION_NODE_TYPE = 'agent.dna_redaction';

/**
 * TASK-882 — the node types whose config may carry the re-visit `carryForward` binding: the
 * consultation palette's prompt-composition node (directly, or delegated through a
 * `core.action`) and the `core` vocabulary's agent node (`overrides.carryForward`).
 */
const CARRY_FORWARD_PROMPT_NODE_TYPE = 'consultation.assemblePrompt';
const CORE_AGENT_NODE_TYPE = 'core.agent';
const CORE_ACTION_NODE_TYPE = 'core.action';

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function nodeConfigOf(node: WorkflowGraphNode | null | undefined): Record<string, unknown> {
  return asRecord(node?.config);
}

/** `enabled: false` switches a node off without deleting it — both runtimes skip it, so does every read here. */
function isEnabled(node: WorkflowGraphNode): boolean {
  return nodeConfigOf(node).enabled !== false;
}

/** The effective type of a node — a `core.action`'s is the action it delegates to. */
function effectiveTypeOf(node: WorkflowGraphNode): string {
  if (node.type !== CORE_ACTION_NODE_TYPE) return node.type;
  const actionKey = nodeConfigOf(node).actionKey;
  return typeof actionKey === 'string' ? actionKey : node.type;
}

/** The config the effective type reads — a `core.action` carries the delegate's under `action`. */
function effectiveConfigOf(node: WorkflowGraphNode): Record<string, unknown> {
  const config = nodeConfigOf(node);
  return node.type === CORE_ACTION_NODE_TYPE ? asRecord(config.action) : config;
}

/** Whether one node declares the re-visit carry-forward binding. */
function declaresCarryForward(node: WorkflowGraphNode): boolean {
  if (!isEnabled(node)) return false;
  if (node.type === CORE_AGENT_NODE_TYPE) return asRecord(nodeConfigOf(node).overrides).carryForward === true;
  return effectiveTypeOf(node) === CARRY_FORWARD_PROMPT_NODE_TYPE && effectiveConfigOf(node).carryForward === true;
}

@Injectable()
export class ConfigResolver {
  private readonly logger = new Logger(ConfigResolver.name);

  constructor(
    @Inject(PipelinePolicyRepository) private readonly pipelinePolicyRepository: PipelinePolicyRepository,
    // Optional + trailing so existing positional test fixtures keep compiling;
    // production DI (CoreDatabaseModule) always supplies it.
    @Optional() @Inject(UserProfileRepository) private readonly userProfileRepository?: UserProfileRepository,
    // lane A item 2 — the tenant gate for DNA REDACTION moved onto the graph, so the
    // resolver needs the same two collaborators `PromptResolutionService` uses to reach a
    // tenant's governing consultation definition. `@Optional()` and trailing for the same reason
    // its are: this service is constructed positionally in background job processors and a long
    // tail of unit tests, and an unwired resolver must degrade rather than throw on a clinical
    // path. See `resolveEffectiveDnaRedactionEnabled` for exactly what it degrades TO.
    @Optional() @Inject(IWorkflowAssignmentService) private readonly workflowAssignments?: IWorkflowAssignmentService,
    @Optional() @Inject(WorkflowDefinitionRepository) private readonly workflowDefinitionRepository?: WorkflowDefinitionRepository,
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
   * DOUBLE gate:
   *
   *  - `tenantEnabled` is the `dnaRedactionEnabled` cascade resolution (maxScope
   *    TENANT ⇒ tenant → SYSTEM default → code default=false; department/doctor
   *    tiers EXCLUDED) — "does the tenant permit redaction at all?".
   *  - `doctorToggle` is the doctor's DNA opt-in (their DOCTOR-scope
   *    `dnaStyleEnabled` row): redaction is a facet of the DNA feature, so a
   *    doctor who has turned DNA OFF gets no redaction. Unset ⇒ implicit opt-in.
   *
   * A THIRD gate used to sit alongside them: `DepartmentAgent.dnaStylePolicy =
   * DISABLED` forced the result OFF for the department's default agent
   * regardless of the other two. It retired with `DepartmentAgent`.
   * The direction matters — dropping a gate that could only force redaction OFF
   * means a consultation the tenant AND the doctor both enabled is now redacted
   * where an agent could previously veto it. The owner APPROVED that loss, with
   * a rider that is what this method now implements.
   *
   * ## The tenant gate is the NODE (lane A item 2)
   *
   * *"DNA-Redaction must be configured as an agent node."* So the tenant does not
   * enable redaction with a boolean that can disagree with its graph — it enables
   * it by placing an ACTIVE `agent.dna_redaction` node in the governing
   * consultation definition, resolved through the same
   * `department -> tenant -> platform default` assignment cascade every other node
   * tier uses.
   *
   * The DOCTOR opt-in does NOT move onto the node, deliberately: it is a
   * clinician's own preference about their own writing style ( P-4
   * makes that ownership explicit), not something a tenant admin authors into a
   * graph. What the node declares is whether it HONOURS that opt-in —
   * `requireDoctorOptIn`, default true, which reproduces the surviving two-gate
   * behaviour exactly.
   *
   * ## What it degrades to, and why that is safe
   *
   * With the workflow resolvers unwired (`@Optional()` — background job
   * processors, positional test fixtures) the legacy `dnaRedactionEnabled`
   * cascade answers, exactly as before. That path cannot silently enable
   * redaction anywhere real: no seed writes `dnaRedactionEnabled` and its code
   * default is `false`, so in a wired system the node is the only thing that can
   * turn it on.
   *
   * Fail-CLOSED: any lookup failure — policy OR graph — ⇒ redaction OFF (a note
   * the doctor expected redacted must never slip through on a degraded read).
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

    // The NODE is the tenant gate. `undefined` means "the resolvers are not wired" — only then
    // does the legacy cascade answer (maxScope TENANT ⇒ `resolveOne` walks tenant +
    // system-default only, so department and doctor tiers are passed as null).
    const node = await this.resolveDnaRedactionNode(ctx);
    const tenantEnabled =
      node === undefined
        ? this.resolveOne('dnaRedactionEnabled', { doctorRow: null, departmentRow: null, tenantRow, systemRow }).value
        : node !== null;

    // Doctor opt-in reuses the doctor's DNA toggle (redaction is part of DNA).
    const doctorToggle = doctorRow ? ((doctorRow.dnaStyleEnabled as boolean | null | undefined) ?? null) : null;
    const honoursDoctorOptIn = node == null || nodeConfigOf(node).requireDoctorOptIn !== false;
    const effective = tenantEnabled && (honoursDoctorOptIn ? (doctorToggle ?? true) : true);

    return { effective, tenantEnabled, doctorToggle };
  }

  /**
   * TASK-882 — effective re-visit CARRY-FORWARD decision for a consultation context: whether the
   * assigned consultation graph declares the `carryForward` binding on an ENABLED
   * prompt-composition node (`consultation.assemblePrompt`, or a `core.action` delegating to
   * it) or on a `core.agent`'s `overrides`.
   *
   * Fails SAFE toward OFF in every degraded case (unwired resolvers, no assignment, no graph,
   * a thrown lookup). That direction is deliberate: carrying a PRIOR VISIT's content into a new
   * note on the back of a failed governance read is a clinical-safety regression.
   */
  async resolveRevisitCarryForwardEnabled(ctx: ConfigResolutionContext): Promise<boolean> {
    const graph = await this.resolveGoverningGraph(ctx, 'carry-forward');
    if (!graph) return false;
    return graph.nodes.some(declaresCarryForward);
  }

  /**
   * The tenant's ACTIVE `agent.dna_redaction` node, or `null` when the governing graph declares
   * none, or `undefined` when the workflow resolvers are not wired at all.
   *
   * The three-way return is the whole point: `null` and `undefined` mean different things here
   * and collapsing them would either force redaction OFF in every positional-construction call
   * site, or let an unwired resolver look like a configured tenant. A THROWN lookup is reported
   * as `null` — fail-closed, per this feature's posture.
   */
  private async resolveDnaRedactionNode(ctx: ConfigResolutionContext): Promise<WorkflowGraphNode | null | undefined> {
    const graph = await this.resolveGoverningGraph(ctx, 'DNA-redaction');
    if (graph === undefined) return undefined;
    if (graph === null) return null;
    return graph.nodes.find((node) => node.type === DNA_REDACTION_NODE_TYPE && isEnabled(node)) ?? null;
  }

  /**
   * The PUBLISHED graph governing this consultation context, resolved through the shared
   * `department -> tenant -> platform default` assignment cascade (the same walk the realtime
   * executor, `LoopConfigService` and the prompt chain make, so all of them agree on which
   * graph governs).
   *
   * `undefined` = the workflow resolvers are not wired; `null` = wired, but no assignment, no
   * published definition, no graph — or a lookup that THREW, which is reported as `null` so
   * every caller fails closed.
   */
  private async resolveGoverningGraph(ctx: ConfigResolutionContext, purpose: string): Promise<WorkflowGraph | null | undefined> {
    if (!this.workflowAssignments || !this.workflowDefinitionRepository) return undefined;
    try {
      const assignment = await this.workflowAssignments.resolve(ctx.tenantId, CONSULTATION_PALETTE_KEY, ctx.departmentId ?? null);
      if (!assignment.workflowDefinitionSlug) return null;
      const definition = await this.workflowDefinitionRepository.findPublishedBySlug(ctx.tenantId, assignment.workflowDefinitionSlug);
      const graph = definition?.graph as unknown as WorkflowGraph | null | undefined;
      return graph && Array.isArray(graph.nodes) ? graph : null;
    } catch (error) {
      this.logger.warn({
        message: `Governing consultation graph lookup failed (${purpose}) — failing closed`,
        tenantId: ctx.tenantId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
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
