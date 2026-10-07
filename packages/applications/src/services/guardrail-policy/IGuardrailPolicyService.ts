import type {
  GuardrailDryRunRequest,
  GuardrailDryRunResponse,
  GuardrailJudgeLanesResponse,
  GuardrailJudgeMetaResponse,
  GuardrailPolicyKeyResponse,
  GuardrailPolicyKeysResponse,
  GuardrailPolicyLaneResetResponse,
  GuardrailPolicyRevisionsResponse,
  UpdateGuardrailJudgeLanesRequest,
  UpdateGuardrailJudgeMetaRequest,
  UpdateGuardrailPolicyKeyRequest,
} from './dto';

export const IGuardrailPolicyService = Symbol('IGuardrailPolicyService');

/**
 * TASK-1050 W2h (README §11.3 B/C, §12.2) — the platform guardrail policy plane: the governed policy keys on the
 * SYSTEM guardrail model rows (current, default, revisions, reset, restore), the `_metadata.judge` mapping of a
 * natively-templated guard, lane → model selection, and the dry run.
 *
 * PLATFORM ADMIN ONLY on every method: SUPER_ADMIN in a tenant-less (or SYSTEM) context. The gate is
 * ROW-INDEPENDENT, so it runs FIRST (the promote-to-system ordering, rule 05): 403 for a tenant admin and for a
 * super admin with a customer working tenant selected. Unknown keys / ids are still 404 after it.
 */
export interface IGuardrailPolicyService {
  listPolicyKeys(): Promise<GuardrailPolicyKeysResponse>;
  /**
   * `taskKey` names the model row of a label threshold (`labelTaxonomy.threshold`,
   * `labelTaxonomy.tasks.<task>.cls_threshold`), which several rows carry; it is ignored for a catalogue key.
   */
  getPolicyKey(key: string, taskKey?: string): Promise<GuardrailPolicyKeyResponse>;
  /** CAS on the model row `_version` (`expectedVersion`); 412 on drift, refused without one. */
  updatePolicyKey(key: string, request: UpdateGuardrailPolicyKeyRequest, taskKey?: string): Promise<GuardrailPolicyKeyResponse>;
  /** Default → current (reason `reset`). No `If-Match`: "whatever it says now, put the default back". */
  resetPolicyKey(key: string, taskKey?: string): Promise<GuardrailPolicyKeyResponse>;
  /** Every editable key of one model row (a task key, or a judge lane id) → its default. */
  resetLane(lane: string): Promise<GuardrailPolicyLaneResetResponse>;
  listRevisions(key: string, limit?: number, taskKey?: string): Promise<GuardrailPolicyRevisionsResponse>;
  restoreRevision(key: string, revisionId: string, taskKey?: string): Promise<GuardrailPolicyKeyResponse>;
  updateJudgeMeta(modelId: string, request: UpdateGuardrailJudgeMetaRequest): Promise<GuardrailJudgeMetaResponse>;
  resetJudgeMeta(modelId: string): Promise<GuardrailJudgeMetaResponse>;
  getJudgeLanes(): Promise<GuardrailJudgeLanesResponse>;
  updateJudgeLanes(request: UpdateGuardrailJudgeLanesRequest): Promise<GuardrailJudgeLanesResponse>;
  dryRun(request: GuardrailDryRunRequest): Promise<GuardrailDryRunResponse>;
}
