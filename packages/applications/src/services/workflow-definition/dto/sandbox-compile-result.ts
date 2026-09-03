import type { CompiledWorkflowConfig } from '@arcaai/workflow-contract';

/**
 * Internal, service-to-service return type of `getCompiledConfigForSandboxRun`
 * Workbench) — never a controller-facing Response DTO (rule 04's DTO-mapper rule applies to
 * PUBLIC service methods a controller calls directly; this is consumed only by
 * `WorkflowSandboxRunService`), so it is a plain interface, not an `@ApiProperty`-decorated
 * class, matching `HarnessGatewayService`'s own `StartWorkflowRunInput`/`Result` shapes.
 *
 * `compiledConfig` is produced FRESH on every call (never persisted) — the whole reason this
 * method exists rather than reading `WorkflowDefinitionEntity.compiledConfig`, which
 * `publish()` is the ONLY path that ever stamps (`workflow-definition.service.ts`). A
 * DRAFT/VALIDATED row (the Workbench's "DRAFT or published" requirement, has no
 * persisted `compiledConfig` at all.
 */
export interface SandboxCompileResult {
  compiledConfig: CompiledWorkflowConfig;
  workflowVersionId: string;
  workflowSlug: string;
  workflowVersionNumber: number;
  definitionName: string;
}
