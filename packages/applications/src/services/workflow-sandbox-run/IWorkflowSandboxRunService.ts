import { SandboxRunCancelResponse, SandboxRunResponse, SandboxRunStatusResponse, StartSandboxRunRequest } from './dto';

/**
 * The Workbench's sandbox-run application service.
 *
 * Distinct from `IWorkflowExposureService`: that surface invokes a tenant's
 * ACTIVE PUBLISHED version by `slug`, for API-key OR session-JWT callers, always
 * `sandbox: false`. This service is session-JWT-only (admin console), addresses ANY
 * non-deleted version of the tenant's own `WorkflowDefinition` by `id` — DRAFT and
 * VALIDATED included, per the Workbench's "DRAFT or published" requirement — and
 * ALWAYS starts with `sandbox: true`. It compiles the graph FRESH on every start (via
 * `IWorkflowDefinitionService.getCompiledConfigForSandboxRun`) rather than reading a
 * persisted `compiledConfig`, which only `publish()` ever stamps.
 *
 * `tenantId` is READ FROM CLS EXCLUSIVELY (same S-3 posture as the exposure plane). Every
 * method maps a foreign-tenant or unknown `definitionId`/`runId` to `NotFoundException`
 * (404-over-403, rule 04).
 */
export interface IWorkflowSandboxRunService {
  /**
   * Start a sandbox run of `definitionId`'s CURRENT graph. Cross-tenant/unknown `definitionId`
   * -> `NotFoundException`. An uncompilable graph -> `BadRequestException` (400, same predicate
   * `publish()` uses). A `fixtureId` naming a foreign-tenant fixture -> `NotFoundException`.
   */
  startRun(definitionId: string, dto: StartSandboxRunRequest): Promise<SandboxRunResponse>;

  /** Live run status + stages. Cross-tenant `runId`, or a `runId` that was not started against `definitionId` -> `NotFoundException`. */
  getRunStatus(definitionId: string, runId: string): Promise<SandboxRunStatusResponse>;

  /** Sends the interpreter's allow-listed `cancel` signal — never a caller-supplied signal name. Same 404 posture as {@link getRunStatus}. */
  cancelRun(definitionId: string, runId: string): Promise<SandboxRunCancelResponse>;
}

export const IWorkflowSandboxRunService = Symbol('IWorkflowSandboxRunService');
