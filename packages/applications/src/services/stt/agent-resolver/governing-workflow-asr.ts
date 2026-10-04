/**
 * TASK-1002 — tier 2 of ASR agent resolution: the consultation's GOVERNING WORKFLOW.
 *
 * A consultation governed by a tenant workflow (the ALaaS path) names its ASR agent on a
 * `core.agent` node. Until this ticket nothing on the STT entry path read it, so every
 * consultation-bound session was served by the tenant's untagged default assignment.
 *
 * What this module decides, and why:
 *
 * - **Which workflow version** — the one the consultation's governing RUN pinned
 *   (`governingEngine.workflowRunId` → `WorkflowRun.workflowVersionId` → that immutable
 *   `WorkflowDefinition` row), never "whatever is active now", so a workflow republished
 *   mid-consultation does not switch engines between recording cycles (D-1). With no governing
 *   run, the `workflowSelection` marker's slug is read at its ACTIVE published version. With
 *   neither, the workflow has no opinion and the caller falls through to the assignment cascade.
 * - **Which node** — by the referenced agent's TASK (`SPEECH_TO_TEXT`), never by node id: ids
 *   are free text, and the radiology graph puts its ASR agent on `n_summary` (D-2).
 * - **Tenant scope** — the consultation read is tenant-scoped and a foreign or unknown id is ONE
 *   404 (D-3), never a fall-through that could resolve another tenant's workflow.
 *
 * Reads go through the domain repositories only; the service layer never touches Prisma.
 */
import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { AgentRepository, AgentTask, ConsultationRepository, WorkflowDefinitionRepository, WorkflowRunRepository } from '@arcaai/domains';
import { DataNotFoundException } from '@arcaai/exceptions';
import { readGoverningEngineMarker } from '../../consultation/governing-engine';
import { readWorkflowSelectionMarker } from '../../consultation/consultation/workflow-selection';
import { readSpokenLanguageMode } from '../../consultation/consultation/summary-language';
import { normalizeLanguageMode } from '../../../common/language';
import { readAgentRef } from '../../consultation/live-documentation/realtime/realtime-node-registry';
import { consultationDispatchSessionId } from '../../workflow-run/workflow-run.service';

/** The named 409 a workflow-driven ASR selection fails with (owner OD-1 / OD-2). */
export const WORKFLOW_ASR_AGENT_UNAVAILABLE = 'WORKFLOW_ASR_AGENT_UNAVAILABLE';

/** `ambiguous` — more than one SPEECH_TO_TEXT node; `unavailable` — the one named agent does not resolve. */
export type WorkflowAsrUnavailableReason = 'ambiguous' | 'unavailable';

export function workflowAsrAgentUnavailable(input: {
  reason: WorkflowAsrUnavailableReason;
  workflowDefinitionSlug: string;
  agentSlug: string | null;
  agentSlugs?: readonly string[];
  cause?: string;
}): ConflictException {
  const message =
    input.reason === 'ambiguous'
      ? `Workflow '${input.workflowDefinitionSlug}' names more than one SPEECH_TO_TEXT agent (${(input.agentSlugs ?? []).join(', ')}); ` +
        `a consultation can transcribe with exactly one. Keep one ASR node and republish the workflow.`
      : `Workflow '${input.workflowDefinitionSlug}' names SPEECH_TO_TEXT agent '${input.agentSlug}', which cannot serve this session` +
        `${input.cause ? ` (${input.cause})` : ''}. Publish or re-enable that agent (and its connection), or point the workflow at another ASR agent.`;
  return new ConflictException({
    code: WORKFLOW_ASR_AGENT_UNAVAILABLE,
    message,
    reason: input.reason,
    workflowDefinitionSlug: input.workflowDefinitionSlug,
    agentSlug: input.agentSlug,
    ...(input.agentSlugs ? { agentSlugs: [...input.agentSlugs] } : {}),
  });
}

/** One `core.agent` node's agent reference, as authored. */
export interface WorkflowAgentNodeRef {
  nodeId: string;
  slug: string;
  versionNumber?: number;
}

interface CompiledNodeLike {
  nodeId?: unknown;
  type?: unknown;
  config?: unknown;
}
interface CompiledStageLike {
  nodes?: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

function stagesOf(value: unknown): CompiledStageLike[] {
  return Array.isArray(value) ? (value.filter(isRecord) as CompiledStageLike[]) : [];
}

/**
 * Every `core.agent` node of a compiled graph that names an agent by slug — the top-level stages
 * AND every `core.loop` body, since a loop body is scheduled like any other stage.
 */
export function workflowAgentNodes(compiled: unknown): WorkflowAgentNodeRef[] {
  if (!isRecord(compiled)) return [];
  const stages = [...stagesOf(compiled.stages)];
  if (Array.isArray(compiled.loops)) {
    for (const loop of compiled.loops) {
      if (isRecord(loop) && isRecord(loop.body)) stages.push(...stagesOf(loop.body.stages));
    }
  }

  const refs: WorkflowAgentNodeRef[] = [];
  for (const stage of stages) {
    for (const node of (Array.isArray(stage.nodes) ? stage.nodes : []) as CompiledNodeLike[]) {
      if (!isRecord(node) || node.type !== 'core.agent' || !isRecord(node.config)) continue;
      const ref = readAgentRef(node.config);
      // Discriminates the slug form; a task-only ref names no agent and so states no ASR opinion.
      if (!ref || !ref.slug) continue;
      refs.push({
        nodeId: typeof node.nodeId === 'string' ? node.nodeId : '',
        slug: ref.slug,
        ...('versionNumber' in ref && ref.versionNumber !== undefined ? { versionNumber: ref.versionNumber } : {}),
      });
    }
  }
  return refs;
}

/** The consultation fields ASR resolution needs. */
export interface ConsultationAsrContext {
  departmentId: string | null;
  metadata: unknown;
  /**
   * TASK-1004 — the consultation's declared spoken-language mode (typed column first, legacy
   * marker after it), normalized; `null` = undeclared. Carried out of the SAME read so a session
   * inherits it with no extra round trip. It is a decoding input only — never an agent selector.
   */
  spokenLanguageMode: string | null;
}

/** The workflow version a consultation is governed by. */
export interface GoverningWorkflow {
  slug: string;
  versionNumber: number | null;
  compiledConfig: unknown;
}

/** The single SPEECH_TO_TEXT agent a governing workflow names. */
export interface GoverningWorkflowAsrAgent {
  workflowDefinitionSlug: string;
  agentSlug: string;
  nodeId: string;
}

/**
 * The reads tier 2 needs, behind the domain repositories. Injected into
 * `AsrAgentResolverService` as ONE optional collaborator so every positional fixture of that
 * service keeps its arity.
 */
@Injectable()
export class GoverningWorkflowAsrReader {
  private readonly logger = new Logger(GoverningWorkflowAsrReader.name);

  constructor(
    private readonly consultations: ConsultationRepository,
    private readonly workflowRuns: WorkflowRunRepository,
    private readonly workflowDefinitions: WorkflowDefinitionRepository,
    private readonly agents: AgentRepository,
  ) {}

  /** The caller's consultation, or ONE 404 for an unknown or foreign id (404-over-403). */
  async readConsultation(tenantId: string, consultationId: string): Promise<ConsultationAsrContext> {
    const consultation = await tolerant(() => this.consultations.findById(consultationId));
    if (!consultation || consultation.tenantId !== tenantId) throw new NotFoundException('Consultation not found');
    return {
      departmentId: consultation.departmentId ?? null,
      metadata: consultation.metadata,
      spokenLanguageMode: normalizeLanguageMode(readSpokenLanguageMode(consultation)),
    };
  }

  /**
   * The workflow version governing a consultation, or `null` for "no workflow opinion".
   *
   * governing run's PINNED version → (run/version unreadable) the marker's slug at its active
   * version → `workflowSelection`'s slug at its active version → `null`.
   */
  async readGoverningWorkflow(tenantId: string, metadata: unknown): Promise<GoverningWorkflow | null> {
    const governing = readGoverningEngineMarker(metadata);
    if (governing) {
      const pinned = await this.readPinnedVersion(tenantId, governing.workflowRunId);
      if (pinned) return pinned;
      this.logger.warn({
        message: 'Governing workflow run or its pinned version could not be read — falling back to the workflow’s active version',
        workflowRunId: governing.workflowRunId,
        workflowDefinitionSlug: governing.workflowDefinitionSlug,
      });
    }

    const slug = governing?.workflowDefinitionSlug || readWorkflowSelectionMarker(metadata)?.workflowDefinitionSlug;
    if (!slug) return null;
    const definition = await this.workflowDefinitions.findPublishedBySlug(tenantId, slug);
    if (!definition) {
      this.logger.warn({
        message: 'Consultation names a workflow that is not published for this tenant — no workflow opinion on ASR',
        workflowDefinitionSlug: slug,
      });
      return null;
    }
    return { slug: definition.slug, versionNumber: definition.versionNumber ?? null, compiledConfig: definition.compiledConfig };
  }

  /**
   * The ONE SPEECH_TO_TEXT agent the workflow names, `null` when it names none, or a 409
   * (`ambiguous`) when it names more than one. Nodes are classified by the referenced agent's
   * TASK: its published row, else any row of its lineage (an agent unpublished after the
   * workflow was published is still recognisably an ASR agent — and is then `unavailable`,
   * not silently skipped).
   */
  async findAsrAgent(tenantId: string, workflow: GoverningWorkflow): Promise<GoverningWorkflowAsrAgent | null> {
    const asrNodes: WorkflowAgentNodeRef[] = [];
    for (const node of workflowAgentNodes(workflow.compiledConfig)) {
      if ((await this.agentTaskOf(tenantId, node)) === AgentTask.SPEECH_TO_TEXT) asrNodes.push(node);
    }
    if (asrNodes.length === 0) return null;
    if (asrNodes.length > 1) {
      throw workflowAsrAgentUnavailable({
        reason: 'ambiguous',
        workflowDefinitionSlug: workflow.slug,
        agentSlug: null,
        agentSlugs: asrNodes.map((node) => node.slug),
      });
    }
    const [node] = asrNodes;
    return { workflowDefinitionSlug: workflow.slug, agentSlug: node.slug, nodeId: node.nodeId };
  }

  private async readPinnedVersion(tenantId: string, workflowRunId: string): Promise<GoverningWorkflow | null> {
    // The marker carries the RUN's `runId`, not the WorkflowRun row id: consultation dispatch
    // keys the row `(tenantId, 'wf-' + runId, runId)`, the same key `WorkflowRunService` reads.
    const run = await tolerant(() => this.workflowRuns.findByRunKey(tenantId, consultationDispatchSessionId(workflowRunId), workflowRunId));
    // A local, so the narrowing survives into the closure (the column is nullable since TASK-1038 OD-26).
    const workflowVersionId = run?.workflowVersionId;
    if (!run || run.tenantId !== tenantId || !workflowVersionId) return null;
    const definition = await tolerant(() => this.workflowDefinitions.findById(workflowVersionId));
    if (!definition || definition.tenantId !== tenantId || !definition.compiledConfig) return null;
    return { slug: definition.slug, versionNumber: definition.versionNumber ?? null, compiledConfig: definition.compiledConfig };
  }

  private async agentTaskOf(tenantId: string, node: WorkflowAgentNodeRef): Promise<AgentTask | null> {
    const pinned = node.versionNumber ? await this.agents.findPublishedVisibleBySlugVersion(tenantId, node.slug, node.versionNumber) : null;
    if (pinned) return pinned.task as AgentTask;
    const active = await this.agents.findPublishedActiveBySlug(tenantId, node.slug);
    if (active) return active.task as AgentTask;
    const [latest] = await this.agents.findAllVersionsBySlug(tenantId, node.slug);
    return (latest?.task as AgentTask | undefined) ?? null;
  }
}

/** `findById` THROWS on a miss; here a miss is an expected answer, so it reads as `null`. */
async function tolerant<T>(read: () => Promise<T | null>): Promise<T | null> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof DataNotFoundException) return null;
    throw error;
  }
}
