/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BusinessException } from '@arcaai/exceptions';
import { BaseTenantEntity, IBaseTenantEntity } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Entities from '../../../entities';

/**
 * A single row IS a version (see the file header on `workflow-definition.prisma`
 * for why this deliberately diverges from the head+version governance triple
 * used by PromptTemplate/ConsultationContextSchema/DepartmentAgent). Standard
 * tenant-scoped, soft-deletable lifecycle — `WorkflowDefinition` is in
 * `TENANT_SCOPED_MODELS` and NOT in `MODELS_WITHOUT_SOFT_DELETE`.
 *
 * PUBLISHED/DEPRECATED rows are hard-immutable by SERVICE convention
 * (`assertMutable`, owned by authoring service — not enforced at
 * this layer, which only expresses structural invariants per rule 03).
 */
export interface IWorkflowDefinitionEntity extends IBaseTenantEntity {
  slug: string;
  name: string;
  description?: string | null;
  paletteKey: string;
  versionNumber: number;
  parentVersionId?: string | null;
  status: Enums.WorkflowDefinitionStatus;
  graph: JsonValue;
  graphChecksum: string;
  compiledConfig?: JsonValue | null;
  compiledConfigChecksum?: string | null;
  registryChecksum?: string | null;
  validationReport?: JsonValue | null;
  needsReview: boolean;
  validatedAt?: Date | null;
  publishedAt?: Date | null;
  deprecatedAt?: Date | null;
  isActive: boolean;
  tags?: string[];
}

export class WorkflowDefinitionEntity extends BaseTenantEntity {
  private _slug: IWorkflowDefinitionEntity['slug'];
  private _name: IWorkflowDefinitionEntity['name'];
  private _description?: IWorkflowDefinitionEntity['description'];
  private _paletteKey: IWorkflowDefinitionEntity['paletteKey'];
  private _versionNumber: IWorkflowDefinitionEntity['versionNumber'];
  private _parentVersionId?: IWorkflowDefinitionEntity['parentVersionId'];
  private _status: IWorkflowDefinitionEntity['status'];
  private _graph: IWorkflowDefinitionEntity['graph'];
  private _graphChecksum: IWorkflowDefinitionEntity['graphChecksum'];
  private _compiledConfig?: IWorkflowDefinitionEntity['compiledConfig'];
  private _compiledConfigChecksum?: IWorkflowDefinitionEntity['compiledConfigChecksum'];
  private _registryChecksum?: IWorkflowDefinitionEntity['registryChecksum'];
  private _validationReport?: IWorkflowDefinitionEntity['validationReport'];
  private _needsReview: IWorkflowDefinitionEntity['needsReview'];
  private _validatedAt?: IWorkflowDefinitionEntity['validatedAt'];
  private _publishedAt?: IWorkflowDefinitionEntity['publishedAt'];
  private _deprecatedAt?: IWorkflowDefinitionEntity['deprecatedAt'];
  private _isActive: IWorkflowDefinitionEntity['isActive'];
  private _tags?: IWorkflowDefinitionEntity['tags'];

  constructor(init: IWorkflowDefinitionEntity) {
    super(init);
    this._slug = init.slug;
    this._name = init.name;
    this._description = init.description;
    this._paletteKey = init.paletteKey;
    this._versionNumber = init.versionNumber;
    this._parentVersionId = init.parentVersionId;
    this._status = init.status;
    this._graph = init.graph;
    this._graphChecksum = init.graphChecksum;
    this._compiledConfig = init.compiledConfig;
    this._compiledConfigChecksum = init.compiledConfigChecksum;
    this._registryChecksum = init.registryChecksum;
    this._validationReport = init.validationReport;
    this._needsReview = init.needsReview;
    this._validatedAt = init.validatedAt;
    this._publishedAt = init.publishedAt;
    this._deprecatedAt = init.deprecatedAt;
    this._isActive = init.isActive;
    this._tags = init.tags;
  }

  get slug(): IWorkflowDefinitionEntity['slug'] {
    return this._slug;
  }

  set slug(value: IWorkflowDefinitionEntity['slug']) {
    this.setProperty('slug', value);
  }

  get name(): IWorkflowDefinitionEntity['name'] {
    return this._name;
  }

  set name(value: IWorkflowDefinitionEntity['name']) {
    this.setProperty('name', value);
  }

  get description(): IWorkflowDefinitionEntity['description'] {
    return this._description;
  }

  set description(value: IWorkflowDefinitionEntity['description']) {
    this.setProperty('description', value);
  }

  get paletteKey(): IWorkflowDefinitionEntity['paletteKey'] {
    return this._paletteKey;
  }

  set paletteKey(value: IWorkflowDefinitionEntity['paletteKey']) {
    this.setProperty('paletteKey', value);
  }

  get versionNumber(): IWorkflowDefinitionEntity['versionNumber'] {
    return this._versionNumber;
  }

  set versionNumber(value: IWorkflowDefinitionEntity['versionNumber']) {
    this.setProperty('versionNumber', value);
  }

  get parentVersionId(): IWorkflowDefinitionEntity['parentVersionId'] {
    return this._parentVersionId;
  }

  set parentVersionId(value: IWorkflowDefinitionEntity['parentVersionId']) {
    this.setProperty('parentVersionId', value);
  }

  get status(): IWorkflowDefinitionEntity['status'] {
    return this._status;
  }

  set status(value: IWorkflowDefinitionEntity['status']) {
    this.setProperty('status', value);
  }

  get graph(): IWorkflowDefinitionEntity['graph'] {
    return this._graph;
  }

  set graph(value: IWorkflowDefinitionEntity['graph']) {
    this.setProperty('graph', value);
  }

  get graphChecksum(): IWorkflowDefinitionEntity['graphChecksum'] {
    return this._graphChecksum;
  }

  set graphChecksum(value: IWorkflowDefinitionEntity['graphChecksum']) {
    this.setProperty('graphChecksum', value);
  }

  get compiledConfig(): IWorkflowDefinitionEntity['compiledConfig'] {
    return this._compiledConfig;
  }

  set compiledConfig(value: IWorkflowDefinitionEntity['compiledConfig']) {
    this.setProperty('compiledConfig', value);
  }

  get compiledConfigChecksum(): IWorkflowDefinitionEntity['compiledConfigChecksum'] {
    return this._compiledConfigChecksum;
  }

  set compiledConfigChecksum(value: IWorkflowDefinitionEntity['compiledConfigChecksum']) {
    this.setProperty('compiledConfigChecksum', value);
  }

  get registryChecksum(): IWorkflowDefinitionEntity['registryChecksum'] {
    return this._registryChecksum;
  }

  set registryChecksum(value: IWorkflowDefinitionEntity['registryChecksum']) {
    this.setProperty('registryChecksum', value);
  }

  get validationReport(): IWorkflowDefinitionEntity['validationReport'] {
    return this._validationReport;
  }

  set validationReport(value: IWorkflowDefinitionEntity['validationReport']) {
    this.setProperty('validationReport', value);
  }

  get needsReview(): IWorkflowDefinitionEntity['needsReview'] {
    return this._needsReview;
  }

  set needsReview(value: IWorkflowDefinitionEntity['needsReview']) {
    this.setProperty('needsReview', value);
  }

  get validatedAt(): IWorkflowDefinitionEntity['validatedAt'] {
    return this._validatedAt;
  }

  set validatedAt(value: IWorkflowDefinitionEntity['validatedAt']) {
    this.setProperty('validatedAt', value);
  }

  get publishedAt(): IWorkflowDefinitionEntity['publishedAt'] {
    return this._publishedAt;
  }

  set publishedAt(value: IWorkflowDefinitionEntity['publishedAt']) {
    this.setProperty('publishedAt', value);
  }

  get deprecatedAt(): IWorkflowDefinitionEntity['deprecatedAt'] {
    return this._deprecatedAt;
  }

  set deprecatedAt(value: IWorkflowDefinitionEntity['deprecatedAt']) {
    this.setProperty('deprecatedAt', value);
  }

  get isActive(): IWorkflowDefinitionEntity['isActive'] {
    return this._isActive;
  }

  set isActive(value: IWorkflowDefinitionEntity['isActive']) {
    this.setProperty('isActive', value);
  }

  get tags(): IWorkflowDefinitionEntity['tags'] {
    return this._tags;
  }

  set tags(value: IWorkflowDefinitionEntity['tags']) {
    this.setProperty('tags', value);
  }

  public override validate(): void {
    super.validate();
    if (!this._slug || this._slug.trim().length === 0) {
      throw new BusinessException('WorkflowDefinition slug is required.');
    }
    if (!/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/.test(this._slug)) {
      throw new BusinessException(
        'WorkflowDefinition slug must be 3-64 lowercase alphanumeric/hyphen characters, not starting or ending with a hyphen.',
      );
    }
    if (!this._name || this._name.trim().length === 0) {
      throw new BusinessException('WorkflowDefinition name is required.');
    }
    if (!this._paletteKey || this._paletteKey.trim().length === 0) {
      throw new BusinessException('WorkflowDefinition paletteKey is required.');
    }
    if (!Number.isInteger(this._versionNumber) || this._versionNumber < 1) {
      throw new BusinessException('WorkflowDefinition versionNumber must be a positive integer.');
    }
    if (this._graph == null || typeof this._graph !== 'object' || Array.isArray(this._graph)) {
      throw new BusinessException('WorkflowDefinition graph must be a JSON object.');
    }
    if (!this._graphChecksum || this._graphChecksum.trim().length === 0) {
      throw new BusinessException('WorkflowDefinition graphChecksum is required.');
    }
    if (this._status === undefined || this._status === null) {
      throw new BusinessException('WorkflowDefinition status is required.');
    }
    if (this._status === Enums.WorkflowDefinitionStatus.PUBLISHED && !this._compiledConfig) {
      throw new BusinessException('A PUBLISHED WorkflowDefinition must carry a compiledConfig.');
    }
  }
}
