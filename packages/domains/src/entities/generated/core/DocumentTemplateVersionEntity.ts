/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BusinessException } from '@arcaai/exceptions';
import { BaseTenantEntity, IBaseTenantEntity } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Entities from '../../../entities';

// An IMMUTABLE published snapshot of one clinical-document `shape` and the
// artifacts `compiled` from it (TASK-810). Written once by
// `DocumentTemplateService.publish` and never updated: a correction is a new
// version, exactly like `PromptVersion` / `ConsultationContextSchemaVersion`.
// That immutability is what lets a consultation pin a version at open and keep
// generating against it no matter what the tenant publishes afterwards — and
// unlike those precedents it is ALSO enforced one layer down, by the
// `document_template_version_immutability_guard` trigger (OD-13).
//
// The row carries no `resourceStatus` (see MODELS_WITHOUT_SOFT_DELETE) and no
// `updatedAt`/`updatedBy` — the mapper strips those, mirroring
// `ConsultationContextSchemaVersionEntityMapper`.
export interface IDocumentTemplateVersionEntity extends IBaseTenantEntity {
  templateId: string;
  versionNumber: number;
  shape: JsonValue;
  compiled: JsonValue;
  compilerVersion: string;
  checksum: string;
  changeReason?: string | null;
  Template?: Entities.DocumentTemplateEntity | null;
}

export class DocumentTemplateVersionEntity extends BaseTenantEntity {
  private _templateId: IDocumentTemplateVersionEntity['templateId'];
  private _versionNumber: IDocumentTemplateVersionEntity['versionNumber'];
  private _shape: IDocumentTemplateVersionEntity['shape'];
  private _compiled: IDocumentTemplateVersionEntity['compiled'];
  private _compilerVersion: IDocumentTemplateVersionEntity['compilerVersion'];
  private _checksum: IDocumentTemplateVersionEntity['checksum'];
  private _changeReason?: IDocumentTemplateVersionEntity['changeReason'];
  private _Template?: IDocumentTemplateVersionEntity['Template'];

  constructor(init: IDocumentTemplateVersionEntity) {
    super(init);
    this._templateId = init.templateId;
    this._versionNumber = init.versionNumber;
    this._shape = init.shape;
    this._compiled = init.compiled;
    this._compilerVersion = init.compilerVersion;
    this._checksum = init.checksum;
    this._changeReason = init.changeReason;
    this._Template = init.Template;
  }

  get templateId(): IDocumentTemplateVersionEntity['templateId'] {
    return this._templateId;
  }

  set templateId(value: IDocumentTemplateVersionEntity['templateId']) {
    this.setProperty('templateId', value);
  }

  get versionNumber(): IDocumentTemplateVersionEntity['versionNumber'] {
    return this._versionNumber;
  }

  set versionNumber(value: IDocumentTemplateVersionEntity['versionNumber']) {
    this.setProperty('versionNumber', value);
  }

  get shape(): IDocumentTemplateVersionEntity['shape'] {
    return this._shape;
  }

  set shape(value: IDocumentTemplateVersionEntity['shape']) {
    this.setProperty('shape', value);
  }

  get compiled(): IDocumentTemplateVersionEntity['compiled'] {
    return this._compiled;
  }

  set compiled(value: IDocumentTemplateVersionEntity['compiled']) {
    this.setProperty('compiled', value);
  }

  get compilerVersion(): IDocumentTemplateVersionEntity['compilerVersion'] {
    return this._compilerVersion;
  }

  set compilerVersion(value: IDocumentTemplateVersionEntity['compilerVersion']) {
    this.setProperty('compilerVersion', value);
  }

  get checksum(): IDocumentTemplateVersionEntity['checksum'] {
    return this._checksum;
  }

  set checksum(value: IDocumentTemplateVersionEntity['checksum']) {
    this.setProperty('checksum', value);
  }

  get changeReason(): IDocumentTemplateVersionEntity['changeReason'] {
    return this._changeReason;
  }

  set changeReason(value: IDocumentTemplateVersionEntity['changeReason']) {
    this.setProperty('changeReason', value);
  }

  get Template(): IDocumentTemplateVersionEntity['Template'] {
    return this._Template;
  }

  set Template(value: IDocumentTemplateVersionEntity['Template']) {
    this.setProperty('Template', value);
  }

  public override validate(): void {
    super.validate();
    if (!this._templateId) {
      throw new BusinessException('Template ID is required');
    }
    if (!Number.isInteger(this._versionNumber) || this._versionNumber < 1) {
      throw new BusinessException('versionNumber must be a positive integer');
    }
    if (this._shape == null || typeof this._shape !== 'object' || Array.isArray(this._shape)) {
      throw new BusinessException('shape must be a JSON object');
    }
    // `compiled` is DERIVED, never authored — but it is still structurally
    // required: a version row without its compiled artifacts is a template the
    // generation path cannot constrain a model with, which is the one thing
    // this catalog exists to guarantee.
    if (this._compiled == null || typeof this._compiled !== 'object' || Array.isArray(this._compiled)) {
      throw new BusinessException('compiled must be a JSON object');
    }
    if (!this._compilerVersion || this._compilerVersion.trim().length === 0) {
      throw new BusinessException('compilerVersion is required');
    }
    if (!this._checksum || this._checksum.trim().length === 0) {
      throw new BusinessException('checksum is required');
    }
  }
}
