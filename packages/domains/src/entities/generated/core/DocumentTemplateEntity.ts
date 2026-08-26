/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BusinessException } from '@arcaai/exceptions';
import { BaseTenantEntity, IBaseTenantEntity } from '../../../common';
import * as Enums from '../../../enums';
import * as Entities from '../../../entities';

// The MUTABLE head of a tenant's clinical-document SHAPE (TASK-810).
// Carries identity (slug/name), governance (status/isDefault), the MOVABLE
// `pinnedVersionNumber` naming which immutable `DocumentTemplateVersion`
// generation resolves, and golden-library provenance. The shape ITSELF lives
// on the version rows — this entity deliberately holds no `shape`, so "which
// shape was generated against" is never a property of a mutable row.
//
// Structural invariants only (slug grammar, a pin must be positive).
// Everything cross-aggregate — shape validity, compilation, the
// additive-vs-breaking classification, single-default enforcement — is
// application-service work.
export interface IDocumentTemplateEntity extends IBaseTenantEntity {
  slug: string;
  name: string;
  description?: string | null;
  status: Enums.DocumentTemplateStatus;
  pinnedVersionNumber?: number | null;
  isDefault: boolean;
  sourceTemplateSlug?: string | null;
  templateLocked: boolean;
  Versions?: Entities.DocumentTemplateVersionEntity[] | null;
}

/** `slug` grammar, deliberately identical to `CONTEXT_SCHEMA_SLUG_PATTERN`. */
export const DOCUMENT_TEMPLATE_SLUG_PATTERN = /^[a-z0-9_]{2,48}$/;

export class DocumentTemplateEntity extends BaseTenantEntity {
  private _slug: IDocumentTemplateEntity['slug'];
  private _name: IDocumentTemplateEntity['name'];
  private _description?: IDocumentTemplateEntity['description'];
  private _status: IDocumentTemplateEntity['status'];
  private _pinnedVersionNumber?: IDocumentTemplateEntity['pinnedVersionNumber'];
  private _isDefault: IDocumentTemplateEntity['isDefault'];
  private _sourceTemplateSlug?: IDocumentTemplateEntity['sourceTemplateSlug'];
  private _templateLocked: IDocumentTemplateEntity['templateLocked'];
  private _Versions?: IDocumentTemplateEntity['Versions'];

  constructor(init: IDocumentTemplateEntity) {
    super(init);
    this._slug = init.slug;
    this._name = init.name;
    this._description = init.description;
    this._status = init.status ?? Enums.DocumentTemplateStatus.DRAFT;
    this._pinnedVersionNumber = init.pinnedVersionNumber;
    this._isDefault = init.isDefault ?? false;
    this._sourceTemplateSlug = init.sourceTemplateSlug;
    this._templateLocked = init.templateLocked ?? false;
    this._Versions = init.Versions;
  }

  get slug(): IDocumentTemplateEntity['slug'] {
    return this._slug;
  }

  set slug(value: IDocumentTemplateEntity['slug']) {
    this.setProperty('slug', value);
  }

  get name(): IDocumentTemplateEntity['name'] {
    return this._name;
  }

  set name(value: IDocumentTemplateEntity['name']) {
    this.setProperty('name', value);
  }

  get description(): IDocumentTemplateEntity['description'] {
    return this._description;
  }

  set description(value: IDocumentTemplateEntity['description']) {
    this.setProperty('description', value);
  }

  get status(): IDocumentTemplateEntity['status'] {
    return this._status;
  }

  set status(value: IDocumentTemplateEntity['status']) {
    this.setProperty('status', value);
  }

  get pinnedVersionNumber(): IDocumentTemplateEntity['pinnedVersionNumber'] {
    return this._pinnedVersionNumber;
  }

  set pinnedVersionNumber(value: IDocumentTemplateEntity['pinnedVersionNumber']) {
    this.setProperty('pinnedVersionNumber', value);
  }

  get isDefault(): IDocumentTemplateEntity['isDefault'] {
    return this._isDefault;
  }

  set isDefault(value: IDocumentTemplateEntity['isDefault']) {
    this.setProperty('isDefault', value);
  }

  get sourceTemplateSlug(): IDocumentTemplateEntity['sourceTemplateSlug'] {
    return this._sourceTemplateSlug;
  }

  set sourceTemplateSlug(value: IDocumentTemplateEntity['sourceTemplateSlug']) {
    this.setProperty('sourceTemplateSlug', value);
  }

  get templateLocked(): IDocumentTemplateEntity['templateLocked'] {
    return this._templateLocked;
  }

  set templateLocked(value: IDocumentTemplateEntity['templateLocked']) {
    this.setProperty('templateLocked', value);
  }

  get Versions(): IDocumentTemplateEntity['Versions'] {
    return this._Versions;
  }

  set Versions(value: IDocumentTemplateEntity['Versions']) {
    this.setProperty('Versions', value);
  }

  // ============================================
  // Custom Domain Methods
  // ============================================

  /**
   * A template is only SERVED to a generation node once it has been published
   * AND carries a pin. A DRAFT with a pin (possible after an unpublish) is
   * deliberately not servable — the status is the gate, the pin is the target.
   * Mirrors `ConsultationContextSchemaEntity.isServable`.
   */
  get isServable(): boolean {
    return (
      this._pinnedVersionNumber != null &&
      (this._status === Enums.DocumentTemplateStatus.PUBLISHED || this._status === Enums.DocumentTemplateStatus.APPROVED)
    );
  }

  public override validate(): void {
    super.validate();
    if (!this._slug || !DOCUMENT_TEMPLATE_SLUG_PATTERN.test(this._slug)) {
      throw new BusinessException('Document template slug must match [a-z0-9_]{2,48}');
    }
    if (!this._name || this._name.trim().length === 0) {
      throw new BusinessException('Document template name is required');
    }
    if (this._pinnedVersionNumber != null && (!Number.isInteger(this._pinnedVersionNumber) || this._pinnedVersionNumber < 1)) {
      throw new BusinessException('pinnedVersionNumber must be a positive integer');
    }
  }
}
