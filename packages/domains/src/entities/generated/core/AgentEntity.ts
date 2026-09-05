/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BusinessException } from '@arcaai/exceptions';
import { BaseTenantEntity, IBaseTenantEntity } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Entities from '../../../entities';

/**
 * TASK-863 — an Agent VERSION row (rows are versions; the `WorkflowDefinition`
 * precedent). One task, one model, task-typed instruction/parameters/I/O.
 * Tenant-scoped, soft-deletable, SYSTEM-shared-read.
 *
 * Structural invariants only (rule 03). The cross-aggregate rules — the
 * model's task type matches `task`, template approval, model availability,
 * capability gates — live in `AgentService` / `agentConfigProblems`.
 * PUBLISHED/DEPRECATED rows are immutable by service convention
 * (`assertMutable`) AND by the `agent_immutability_guard` DB trigger.
 */
export interface IAgentEntity extends IBaseTenantEntity {
  slug: string;
  name: string;
  description?: string | null;
  task: Enums.AgentTask;
  versionNumber: number;
  parentVersionId?: string | null;
  /** TASK-884 — cross-lineage provenance of a clone / cross-tenant sync; null on an ordinary create. */
  sourceAgentId?: string | null;
  sourceTenantId?: string | null;
  sourceSlug?: string | null;
  sourceVersionNumber?: number | null;
  status: Enums.WorkflowDefinitionStatus;
  isActive: boolean;
  modelId: string;
  instruction?: JsonValue | null;
  parameters?: JsonValue | null;
  inputSchema?: JsonValue | null;
  outputSchema?: JsonValue | null;
  tools?: JsonValue | null;
  compiledConfig?: JsonValue | null;
  compiledConfigChecksum?: string | null;
  validationReport?: JsonValue | null;
  validatedAt?: Date | null;
  publishedAt?: Date | null;
  deprecatedAt?: Date | null;
  tags?: string[];
}

/** Mirrors `WORKFLOW_DEFINITION_SLUG_PATTERN` (@arcaai/workflow-contract) — duplicated because
 *  the domain layer takes no dependency on the contract package. 2–80 chars. */
const AGENT_SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,78}[a-z0-9]$/;

function isJsonObject(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === 'object' && !Array.isArray(value));
}

export class AgentEntity extends BaseTenantEntity {
  private _slug: IAgentEntity['slug'];
  private _name: IAgentEntity['name'];
  private _description?: IAgentEntity['description'];
  private _task: IAgentEntity['task'];
  private _versionNumber: IAgentEntity['versionNumber'];
  private _parentVersionId?: IAgentEntity['parentVersionId'];
  private _sourceAgentId?: IAgentEntity['sourceAgentId'];
  private _sourceTenantId?: IAgentEntity['sourceTenantId'];
  private _sourceSlug?: IAgentEntity['sourceSlug'];
  private _sourceVersionNumber?: IAgentEntity['sourceVersionNumber'];
  private _status: IAgentEntity['status'];
  private _isActive: IAgentEntity['isActive'];
  private _modelId: IAgentEntity['modelId'];
  private _instruction?: IAgentEntity['instruction'];
  private _parameters?: IAgentEntity['parameters'];
  private _inputSchema?: IAgentEntity['inputSchema'];
  private _outputSchema?: IAgentEntity['outputSchema'];
  private _tools?: IAgentEntity['tools'];
  private _compiledConfig?: IAgentEntity['compiledConfig'];
  private _compiledConfigChecksum?: IAgentEntity['compiledConfigChecksum'];
  private _validationReport?: IAgentEntity['validationReport'];
  private _validatedAt?: IAgentEntity['validatedAt'];
  private _publishedAt?: IAgentEntity['publishedAt'];
  private _deprecatedAt?: IAgentEntity['deprecatedAt'];
  private _tags?: IAgentEntity['tags'];

  constructor(init: IAgentEntity) {
    super(init);
    this._slug = init.slug;
    this._name = init.name;
    this._description = init.description;
    this._task = init.task;
    this._versionNumber = init.versionNumber;
    this._parentVersionId = init.parentVersionId;
    this._sourceAgentId = init.sourceAgentId;
    this._sourceTenantId = init.sourceTenantId;
    this._sourceSlug = init.sourceSlug;
    this._sourceVersionNumber = init.sourceVersionNumber;
    this._status = init.status;
    this._isActive = init.isActive;
    this._modelId = init.modelId;
    this._instruction = init.instruction;
    this._parameters = init.parameters;
    this._inputSchema = init.inputSchema;
    this._outputSchema = init.outputSchema;
    this._tools = init.tools;
    this._compiledConfig = init.compiledConfig;
    this._compiledConfigChecksum = init.compiledConfigChecksum;
    this._validationReport = init.validationReport;
    this._validatedAt = init.validatedAt;
    this._publishedAt = init.publishedAt;
    this._deprecatedAt = init.deprecatedAt;
    this._tags = init.tags;
  }

  get slug(): IAgentEntity['slug'] {
    return this._slug;
  }

  set slug(value: IAgentEntity['slug']) {
    this.setProperty('slug', value);
  }

  get name(): IAgentEntity['name'] {
    return this._name;
  }

  set name(value: IAgentEntity['name']) {
    this.setProperty('name', value);
  }

  get description(): IAgentEntity['description'] {
    return this._description;
  }

  set description(value: IAgentEntity['description']) {
    this.setProperty('description', value);
  }

  get task(): IAgentEntity['task'] {
    return this._task;
  }

  set task(value: IAgentEntity['task']) {
    this.setProperty('task', value);
  }

  get versionNumber(): IAgentEntity['versionNumber'] {
    return this._versionNumber;
  }

  set versionNumber(value: IAgentEntity['versionNumber']) {
    this.setProperty('versionNumber', value);
  }

  get parentVersionId(): IAgentEntity['parentVersionId'] {
    return this._parentVersionId;
  }

  set parentVersionId(value: IAgentEntity['parentVersionId']) {
    this.setProperty('parentVersionId', value);
  }

  get sourceAgentId(): IAgentEntity['sourceAgentId'] {
    return this._sourceAgentId;
  }

  set sourceAgentId(value: IAgentEntity['sourceAgentId']) {
    this.setProperty('sourceAgentId', value);
  }

  get sourceTenantId(): IAgentEntity['sourceTenantId'] {
    return this._sourceTenantId;
  }

  set sourceTenantId(value: IAgentEntity['sourceTenantId']) {
    this.setProperty('sourceTenantId', value);
  }

  get sourceSlug(): IAgentEntity['sourceSlug'] {
    return this._sourceSlug;
  }

  set sourceSlug(value: IAgentEntity['sourceSlug']) {
    this.setProperty('sourceSlug', value);
  }

  get sourceVersionNumber(): IAgentEntity['sourceVersionNumber'] {
    return this._sourceVersionNumber;
  }

  set sourceVersionNumber(value: IAgentEntity['sourceVersionNumber']) {
    this.setProperty('sourceVersionNumber', value);
  }

  get status(): IAgentEntity['status'] {
    return this._status;
  }

  set status(value: IAgentEntity['status']) {
    this.setProperty('status', value);
  }

  get isActive(): IAgentEntity['isActive'] {
    return this._isActive;
  }

  set isActive(value: IAgentEntity['isActive']) {
    this.setProperty('isActive', value);
  }

  get modelId(): IAgentEntity['modelId'] {
    return this._modelId;
  }

  set modelId(value: IAgentEntity['modelId']) {
    this.setProperty('modelId', value);
  }

  get instruction(): IAgentEntity['instruction'] {
    return this._instruction;
  }

  set instruction(value: IAgentEntity['instruction']) {
    this.setProperty('instruction', value);
  }

  get parameters(): IAgentEntity['parameters'] {
    return this._parameters;
  }

  set parameters(value: IAgentEntity['parameters']) {
    this.setProperty('parameters', value);
  }

  get inputSchema(): IAgentEntity['inputSchema'] {
    return this._inputSchema;
  }

  set inputSchema(value: IAgentEntity['inputSchema']) {
    this.setProperty('inputSchema', value);
  }

  get outputSchema(): IAgentEntity['outputSchema'] {
    return this._outputSchema;
  }

  set outputSchema(value: IAgentEntity['outputSchema']) {
    this.setProperty('outputSchema', value);
  }

  get tools(): IAgentEntity['tools'] {
    return this._tools;
  }

  set tools(value: IAgentEntity['tools']) {
    this.setProperty('tools', value);
  }

  get compiledConfig(): IAgentEntity['compiledConfig'] {
    return this._compiledConfig;
  }

  set compiledConfig(value: IAgentEntity['compiledConfig']) {
    this.setProperty('compiledConfig', value);
  }

  get compiledConfigChecksum(): IAgentEntity['compiledConfigChecksum'] {
    return this._compiledConfigChecksum;
  }

  set compiledConfigChecksum(value: IAgentEntity['compiledConfigChecksum']) {
    this.setProperty('compiledConfigChecksum', value);
  }

  get validationReport(): IAgentEntity['validationReport'] {
    return this._validationReport;
  }

  set validationReport(value: IAgentEntity['validationReport']) {
    this.setProperty('validationReport', value);
  }

  get validatedAt(): IAgentEntity['validatedAt'] {
    return this._validatedAt;
  }

  set validatedAt(value: IAgentEntity['validatedAt']) {
    this.setProperty('validatedAt', value);
  }

  get publishedAt(): IAgentEntity['publishedAt'] {
    return this._publishedAt;
  }

  set publishedAt(value: IAgentEntity['publishedAt']) {
    this.setProperty('publishedAt', value);
  }

  get deprecatedAt(): IAgentEntity['deprecatedAt'] {
    return this._deprecatedAt;
  }

  set deprecatedAt(value: IAgentEntity['deprecatedAt']) {
    this.setProperty('deprecatedAt', value);
  }

  get tags(): IAgentEntity['tags'] {
    return this._tags;
  }

  set tags(value: IAgentEntity['tags']) {
    this.setProperty('tags', value);
  }

  public override validate(): void {
    super.validate();
    if (!this._slug || !AGENT_SLUG_PATTERN.test(this._slug)) {
      throw new BusinessException('Agent slug must be 2-80 lowercase alphanumeric/hyphen/underscore characters, not starting or ending with a separator.');
    }
    if (!this._name || this._name.trim().length === 0) {
      throw new BusinessException('Agent name is required.');
    }
    if (this._task === undefined || this._task === null) {
      throw new BusinessException('Agent task is required.');
    }
    if (!this._modelId || this._modelId.trim().length === 0) {
      throw new BusinessException('Agent modelId is required — an agent is always backed by one registered model.');
    }
    if (!Number.isInteger(this._versionNumber) || this._versionNumber < 1) {
      throw new BusinessException('Agent versionNumber must be a positive integer.');
    }
    if (this._status === undefined || this._status === null) {
      throw new BusinessException('Agent status is required.');
    }
    // TASK-884 — provenance is TWO pairs, and half a pair answers "where did
    // this come from?" with a shrug:
    //   (sourceAgentId, sourceTenantId)     — the exact ROW, which a CLONE/SYNC saw
    //   (sourceSlug, sourceVersionNumber)   — the LINEAGE, which an IMPORT also knows
    // An import reads a file that deliberately carries no row id and no tenant
    // id, so it sets the lineage pair alone; knowing the row without knowing
    // its lineage is not a state anything can produce.
    {
      const present = (value: unknown): boolean => value !== undefined && value !== null;
      const rowPair = [this._sourceAgentId, this._sourceTenantId];
      const lineagePair = [this._sourceSlug, this._sourceVersionNumber];
      const rowSet = rowPair.filter(present).length;
      const lineageSet = lineagePair.filter(present).length;
      if (rowSet === 1) {
        throw new BusinessException('Agent clone provenance: sourceAgentId and sourceTenantId are set together or not at all.');
      }
      if (lineageSet === 1) {
        throw new BusinessException('Agent clone provenance: sourceSlug and sourceVersionNumber are set together or not at all.');
      }
      if (rowSet === 2 && lineageSet === 0) {
        throw new BusinessException('Agent clone provenance: a source ROW is always accompanied by its sourceSlug / sourceVersionNumber.');
      }
      if (present(this._sourceVersionNumber) && (!Number.isInteger(this._sourceVersionNumber) || (this._sourceVersionNumber as number) < 1)) {
        throw new BusinessException('Agent sourceVersionNumber must be a positive integer.');
      }
    }
    for (const [column, value] of [
      ['instruction', this._instruction],
      ['parameters', this._parameters],
      ['inputSchema', this._inputSchema],
      ['outputSchema', this._outputSchema],
      ['compiledConfig', this._compiledConfig],
      ['validationReport', this._validationReport],
    ] as const) {
      if (!isJsonObject(value)) {
        throw new BusinessException(`Agent ${column} must be a JSON object.`);
      }
    }
    if (this._tools !== undefined && this._tools !== null && !Array.isArray(this._tools)) {
      throw new BusinessException('Agent tools must be a JSON array of (mcpServerId, toolName) references.');
    }
    if (Array.isArray(this._tools) && this._tools.length > 0 && this._task !== Enums.AgentTask.TEXT_GENERATION) {
      throw new BusinessException('Agent tools apply to TEXT_GENERATION agents only.');
    }
    if (this._status === Enums.WorkflowDefinitionStatus.PUBLISHED && !this._compiledConfig) {
      throw new BusinessException('A PUBLISHED Agent must carry a compiledConfig.');
    }
    if (this._isActive && this._status !== Enums.WorkflowDefinitionStatus.PUBLISHED) {
      throw new BusinessException('Agent isActive may only be set on a PUBLISHED version.');
    }
  }
}
