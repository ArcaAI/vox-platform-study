import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { UserProfileRepository, UserSettingsRepository, WorkflowDefinitionRepository } from '@arcaai/domains';
import type { WorkflowGraph, WorkflowGraphNode } from '@arcaai/workflow-contract';
import { CORE_PALETTE_KEY, classesOf } from '@arcaai/workflow-contract';
import { IWorkflowAssignmentService } from '../workflow-assignment/IWorkflowAssignmentService';
import { DNA_STYLE_PREFERENCE, parseDnaStylePreference } from './dna-style-preference';

/**
 * The graph-node config resolver (TASK-882).
 *
 * It used to walk the `PipelinePolicy` cascade (doctor → department → tenant → SYSTEM default →
 * code default) for five realtime toggles. That model is retired: settings exist for platform
 * admins to control platform behaviour, and every toggle it carried is either DEAD (shadowed by
 * a node's own `enabled`, or routed to a generator that no longer exists) or a property of the
 * WORKFLOW a consultation is assigned. So what this service resolves now is read off the
 * governing consultation graph — node presence + `enabled` — plus the ONE clinician-owned
 * preference (the doctor's DNA opt-out, a `UserSettings` row) and the doctor's preferred
 * prompt template (`UserProfile`). NO writes happen here.
 *
 * Every read is TOTAL: an unwired collaborator (this service is constructed positionally in
 * background job processors and a long tail of unit tests), a missing assignment or a thrown
 * lookup degrades to the safe end of the setting — DNA reads fail CLOSED (off), auto-summary
 * fails toward its code default (on), because losing a note silently is the worse failure.
 */

export interface ConfigResolutionContext {
  tenantId: string;
  departmentId?: string | null;
  doctorId?: string | null;
}

/**
 * The resolved per-consultation DNA decision.
 * `effective = tenantEnabled && (doctorToggle ?? true)`: the tenant gate is the graph node; the
 * doctor toggle is an explicit opt-out (or an implicit opt-in when unset).
 */
export interface ResolvedDnaStyle {
  /** Final decision: apply DNA style (or redaction) / learn from this doctor? */
  effective: boolean;
  /** Whether the assigned graph declares the enabled node — the tenant's gate. */
  tenantEnabled: boolean;
  /** The doctor's explicit preference, or null when unset (implicit opt-in). */
  doctorToggle: boolean | null;
  /** The preference row's OCC version (0 when no row exists) — `PUT dna-writing-styles/settings` echoes it. */
  doctorPreferenceVersion: number;
}

/** The doctor's stored DNA preference, as the write lane and the readers both see it. */
export interface DoctorDnaPreference {
  enabled: boolean | null;
  version: number;
}

/** The palette whose assigned definition governs a consultation (mirrors `PromptResolutionService`). */
// TASK-930 moved every consultation graph and assignment onto the CORE palette; a literal here
// silently answered the unwired default for every tenant (TASK-932 R-16a, the empty DNA handoff).
const CONSULTATION_PALETTE_KEY = CORE_PALETTE_KEY;

/** / DD-6 — the node type that carries the DNA-redaction pass. */
const DNA_REDACTION_NODE_TYPE = 'agent.dna_redaction';
/** TASK-882 — the node type that IS the tenant's DNA writing-style gate. */
const DNA_STYLE_NODE_TYPE = 'agent.dna_style';
/**
 * TASK-882 — the node types whose config may carry the re-visit `carryForward` binding: the
 * consultation palette's prompt-composition node (directly, or delegated through a
 * `core.action`) and the `core` vocabulary's agent node (`overrides.carryForward`).
 */
const CARRY_FORWARD_PROMPT_NODE_TYPE = 'consultation.assemblePrompt';
const CORE_AGENT_NODE_TYPE = 'core.agent';
const CORE_ACTION_NODE_TYPE = 'core.action';
/** The registry class that marks a node as generating a document — what auto-summary switches. */
const GENERATION_CLASS = 'generation';

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

/** An enabled node of the given effective type. */
function isActiveNodeOf(node: WorkflowGraphNode, type: string): boolean {
  return isEnabled(node) && effectiveTypeOf(node) === type;
}

/**
 * TASK-932 R-16a — a `core.agent` that DECLARES the DNA writing-style pass (`config.dna.enabled`).
 * The `core` vocabulary has no `agent.dna_style` / `agent.dna_redaction` node type; the workflow
 * names its DNA agent (TASK-891 OD-5) by flagging the finalizing agent instead.
 */
function declaresDna(node: WorkflowGraphNode): boolean {
  return isActiveNodeOf(node, CORE_AGENT_NODE_TYPE) && asRecord(asRecord(node.config).dna).enabled === true;
}

/**
 * A node that generates a document: a `core.agent`, or any `generation`-classed instance.
 *
 * TASK-893 — resolved through the contract's own `classesOf`, which answers for an INSTANCE
 * (`core.action` → its delegate's classes ∪ `{'action'}`). The previous form looked the effective
 * type up in `WORKFLOW_NODE_REGISTRY`, and for a `core.action` the effective type is an ACTION
 * key — which the retirement moved out of that registry into `ACTION_CATALOGUE`. The lookup could
 * therefore never hit, so a delegated generation node read as "not a generation node" and
 * auto-summary stayed ON for a graph that had switched it off.
 */
function isGenerationNode(node: WorkflowGraphNode): boolean {
  if (node.type === CORE_AGENT_NODE_TYPE) return true;
  return classesOf(node.type, nodeConfigOf(node)).includes(GENERATION_CLASS);
}

/** Whether one node declares the re-visit carry-forward binding. */
function declaresCarryForward(node: WorkflowGraphNode): boolean {
  if (!isEnabled(node)) return false;
  if (node.type === CORE_AGENT_NODE_TYPE) return asRecord(nodeConfigOf(node).overrides).carryForward === true;
  return effectiveTypeOf(node) === CARRY_FORWARD_PROMPT_NODE_TYPE && effectiveConfigOf(node).carryForward === true;
}

const NO_PREFERENCE: DoctorDnaPreference = Object.freeze({ enabled: null, version: 0 });

@Injectable()
export class ConfigResolver {
  private readonly logger = new Logger(ConfigResolver.name);

  constructor(
    // Every collaborator is optional + positional: this service is constructed positionally in
    // background job processors and a long tail of unit tests, and an unwired resolver must
    // degrade rather than throw on a clinical path. Production DI (`ConfigResolverModule`)
    // supplies all four.
    @Optional() @Inject(UserProfileRepository) private readonly userProfileRepository?: UserProfileRepository,
    @Optional() @Inject(IWorkflowAssignmentService) private readonly workflowAssignments?: IWorkflowAssignmentService,
    @Optional() @Inject(WorkflowDefinitionRepository) private readonly workflowDefinitionRepository?: WorkflowDefinitionRepository,
    @Optional() @Inject(UserSettingsRepository) private readonly userSettingsRepository?: UserSettingsRepository,
  ) {}

  /**
   * TASK-882 — whether a consultation auto-generates its note: the assigned graph's generation
   * node(s) are `enabled`. It replaces `pipeline.autoSummaryEnabled` (owner #5: the per-doctor
   * opt-out is dropped — a clinician does not switch note generation off for themselves).
   *
   * Total, and fail-safe toward ON: an unwired resolver, no assignment, a graph with no
   * generation node, or a thrown lookup all answer the code default (`true`) — the setting only
   * ever SWITCHES OFF a generation the graph actually declares, and losing a note silently on a
   * degraded read is the worse failure.
   */
  async resolveAutoSummaryEnabled(ctx: ConfigResolutionContext): Promise<boolean> {
    const graph = await this.resolveGoverningGraph(ctx, 'auto-summary');
    if (!graph) return true;
    const generationNodes = graph.nodes.filter(isGenerationNode);
    if (generationNodes.length === 0) return true;
    return generationNodes.some(isEnabled);
  }

  /**
   * TASK-882 — the doctor's own DNA writing-style preference (`UserSettings` `dna` /
   * `styleEnabled`). `enabled: null` = no row = no opinion; `version` is the row's OCC token
   * (0 without a row), which the self-service write lane preconditions on. Total: no doctor, no
   * repository, a malformed value or a failed read all read as no opinion.
   */
  async resolveDoctorDnaPreference(doctorId: string | null | undefined): Promise<DoctorDnaPreference> {
    if (!doctorId || !this.userSettingsRepository) return NO_PREFERENCE;
    try {
      const row = await this.userSettingsRepository.findByUserKeyNamespace(doctorId, DNA_STYLE_PREFERENCE.key, DNA_STYLE_PREFERENCE.namespace);
      if (!row) return NO_PREFERENCE;
      return { enabled: parseDnaStylePreference(row.value), version: row.version ?? 0 };
    } catch (error) {
      this.logger.warn({
        message: 'Doctor DNA preference lookup failed — treating as no opinion',
        doctorId,
        error: error instanceof Error ? error.message : String(error),
      });
      return NO_PREFERENCE;
    }
  }

  /**
   * Resolve the effective DNA-style decision for a consultation context:
   * `effective = tenantEnabled && (doctorToggle ?? true)`.
   *
   *  - `tenantEnabled` is TASK-882's node gate: the assigned consultation graph declares an
   *    enabled `agent.dna_style` node (directly or through a `core.action`).
   *  - `doctorToggle` is the doctor's own `UserSettings` preference, or null when they have not
   *    set it (an unset toggle is an implicit opt-in).
   *
   * Fail-CLOSED: unwired resolvers, no graph or any lookup failure ⇒ DNA off, so the realtime
   * path never styles/learns on a degraded config read.
   */
  async resolveEffectiveDnaStyleEnabled(ctx: ConfigResolutionContext): Promise<ResolvedDnaStyle> {
    const [graph, preference] = await Promise.all([this.resolveGoverningGraph(ctx, 'DNA-style'), this.resolveDoctorDnaPreference(ctx.doctorId)]);
    const tenantEnabled = graph !== null && graph.nodes.some((node) => isActiveNodeOf(node, DNA_STYLE_NODE_TYPE) || declaresDna(node));
    return {
      effective: tenantEnabled && (preference.enabled ?? true),
      tenantEnabled,
      doctorToggle: preference.enabled,
      doctorPreferenceVersion: preference.version,
    };
  }

  /**
   * Resolve the effective DNA REDACTION decision for a consultation context. A DOUBLE gate:
   *
   *  - `tenantEnabled` is the presence of an ACTIVE `agent.dna_redaction` node on the assigned
   *    graph (lane A item 2: *"DNA-Redaction must be configured as an agent node"*) — the tenant
   *    enables redaction by placing the node, not with a boolean that can disagree with its graph.
   *  - `doctorToggle` is the doctor's DNA opt-in (their `UserSettings` preference): redaction is
   *    a facet of the DNA feature, so a doctor who has turned DNA OFF gets no redaction. Unset ⇒
   *    implicit opt-in. The node declares whether it HONOURS that opt-in — `requireDoctorOptIn`,
   *    default true.
   *
   * The `DepartmentAgent.dnaStylePolicy` veto retired with `DepartmentAgent` and stays retired
   * (owner ruling: a consultation both surviving gates enable IS redacted). TASK-882 also
   * retired the legacy `dnaRedactionEnabled` cascade that answered for unwired resolvers: an
   * unwired resolver is now simply OFF.
   *
   * Fail-CLOSED: any lookup failure ⇒ redaction OFF (a note the doctor expected redacted must
   * never slip through on a degraded read).
   */
  async resolveEffectiveDnaRedactionEnabled(ctx: ConfigResolutionContext): Promise<ResolvedDnaStyle> {
    const [graph, preference] = await Promise.all([this.resolveGoverningGraph(ctx, 'DNA-redaction'), this.resolveDoctorDnaPreference(ctx.doctorId)]);
    const node = graph?.nodes.find((candidate) => isActiveNodeOf(candidate, DNA_REDACTION_NODE_TYPE) || declaresDna(candidate)) ?? null;
    const tenantEnabled = node !== null;
    const honoursDoctorOptIn = node === null || effectiveConfigOf(node).requireDoctorOptIn !== false;
    return {
      effective: tenantEnabled && (honoursDoctorOptIn ? (preference.enabled ?? true) : true),
      tenantEnabled,
      doctorToggle: preference.enabled,
      doctorPreferenceVersion: preference.version,
    };
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

  /**
   * The PUBLISHED graph governing this consultation context, resolved through the shared
   * `department -> tenant -> platform default` assignment cascade (the same walk the realtime
   * executor, `LoopConfigService` and the prompt chain make, so all of them agree on which
   * graph governs). `null` when the resolvers are unwired, nothing is assigned, no published
   * definition or graph exists — or the lookup THREW, which is reported as `null` so every
   * caller degrades to its safe end.
   */
  private async resolveGoverningGraph(ctx: ConfigResolutionContext, purpose: string): Promise<WorkflowGraph | null> {
    if (!this.workflowAssignments || !this.workflowDefinitionRepository) return null;
    try {
      const assignment = await this.workflowAssignments.resolve(ctx.tenantId, CONSULTATION_PALETTE_KEY, ctx.departmentId ?? null);
      if (!assignment.workflowDefinitionSlug) return null;
      const definition = await this.workflowDefinitionRepository.findPublishedBySlug(ctx.tenantId, assignment.workflowDefinitionSlug);
      const graph = definition?.graph as unknown as WorkflowGraph | null | undefined;
      return graph && Array.isArray(graph.nodes) ? graph : null;
    } catch (error) {
      this.logger.warn({
        message: `Governing consultation graph lookup failed (${purpose}) — degrading to the safe default`,
        tenantId: ctx.tenantId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }
}
