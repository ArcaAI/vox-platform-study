/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BusinessException } from '@arcaai/exceptions';
import { BaseTenantEntity, IBaseTenantEntity } from '../../../common';
import * as Enums from '../../../enums';
import * as Entities from '../../../entities';

// TASK-658 — the MUTABLE head of a tenant's consultation context declaration.
// Carries identity (slug/name), governance (scope/status/isDefault), the
// MOVABLE `pinnedVersionNumber` naming which immutable
// `ConsultationContextSchemaVersion` discovery serves, and golden-library
// provenance. The declaration ITSELF lives on the version rows — this entity
// deliberately holds no `definition`, so "which bytes were served" is never a
// property of a mutable row.
//
// Structural invariants only (slug grammar, DEPARTMENT scope implies a
// department, a pin must be positive). Everything cross-aggregate —
// definition validity, the additive-vs-breaking classification, single-default
// enforcement — is application-service work.
export interface IConsultationContextSchemaEntity extends IBaseTenantEntity {
  slug: string;
  name: string;
  description?: string | null;
  scope: Enums.ConsultationContextSchemaScope;
  departmentId?: string | null;
  status: Enums.ConsultationContextSchemaStatus;
  pinnedVersionNumber?: number | null;
  isDefault: boolean;
  sourceTemplateSlug?: string | null;
  templateLocked: boolean;
  Department?: Entities.DepartmentEntity | null;
  Versions?: Entities.ConsultationContextSchemaVersionEntity[] | null;
}

/** `kinds[].key` / `outputs[].key` grammar, and the schema `slug` grammar. */
export const CONTEXT_SCHEMA_SLUG_PATTERN = /^[a-z0-9_]{2,48}$/;

export class ConsultationContextSchemaEntity extends BaseTenantEntity {
  private _slug: IConsultationContextSchemaEntity['slug'];
  private _name: IConsultationContextSchemaEntity['name'];
  private _description?: IConsultationContextSchemaEntity['description'];
  private _scope: IConsultationContextSchemaEntity['scope'];
  private _departmentId?: IConsultationContextSchemaEntity['departmentId'];
  private _status: IConsultationContextSchemaEntity['status'];
  private _pinnedVersionNumber?: IConsultationContextSchemaEntity['pinnedVersionNumber'];
  private _isDefault: IConsultationContextSchemaEntity['isDefault'];
  private _sourceTemplateSlug?: IConsultationContextSchemaEntity['sourceTemplateSlug'];
  private _templateLocked: IConsultationContextSchemaEntity['templateLocked'];
  private _Department?: IConsultationContextSchemaEntity['Department'];
  private _Versions?: IConsultationContextSchemaEntity['Versions'];

  constructor(init: IConsultationContextSchemaEntity) {
    super(init);
    this._slug = init.slug;
    this._name = init.name;
    this._description = init.description;
    this._scope = init.scope ?? Enums.ConsultationContextSchemaScope.TENANT;
    this._departmentId = init.departmentId;
    this._status = init.status ?? Enums.ConsultationContextSchemaStatus.DRAFT;
    this._pinnedVersionNumber = init.pinnedVersionNumber;
    this._isDefault = init.isDefault ?? false;
    this._sourceTemplateSlug = init.sourceTemplateSlug;
    this._templateLocked = init.templateLocked ?? false;
    this._Department = init.Department;
    this._Versions = init.Versions;
  }

  get slug(): IConsultationContextSchemaEntity['slug'] {
    return this._slug;
  }

  set slug(value: IConsultationContextSchemaEntity['slug']) {
    this.setProperty('slug', value);
  }

  get name(): IConsultationContextSchemaEntity['name'] {
    return this._name;
  }

  set name(value: IConsultationContextSchemaEntity['name']) {
    this.setProperty('name', value);
  }

  get description(): IConsultationContextSchemaEntity['description'] {
    return this._description;
  }

  set description(value: IConsultationContextSchemaEntity['description']) {
    this.setProperty('description', value);
  }

  get scope(): IConsultationContextSchemaEntity['scope'] {
    return this._scope;
  }

  set scope(value: IConsultationContextSchemaEntity['scope']) {
    this.setProperty('scope', value);
  }

  get departmentId(): IConsultationContextSchemaEntity['departmentId'] {
    return this._departmentId;
  }

  set departmentId(value: IConsultationContextSchemaEntity['departmentId']) {
    this.setProperty('departmentId', value);
  }

  get status(): IConsultationContextSchemaEntity['status'] {
    return this._status;
  }

  set status(value: IConsultationContextSchemaEntity['status']) {
    this.setProperty('status', value);
  }

  get pinnedVersionNumber(): IConsultationContextSchemaEntity['pinnedVersionNumber'] {
    return this._pinnedVersionNumber;
  }

  set pinnedVersionNumber(value: IConsultationContextSchemaEntity['pinnedVersionNumber']) {
    this.setProperty('pinnedVersionNumber', value);
  }

  get isDefault(): IConsultationContextSchemaEntity['isDefault'] {
    return this._isDefault;
  }

  set isDefault(value: IConsultationContextSchemaEntity['isDefault']) {
    this.setProperty('isDefault', value);
  }

  get sourceTemplateSlug(): IConsultationContextSchemaEntity['sourceTemplateSlug'] {
    return this._sourceTemplateSlug;
  }

  set sourceTemplateSlug(value: IConsultationContextSchemaEntity['sourceTemplateSlug']) {
    this.setProperty('sourceTemplateSlug', value);
  }

  get templateLocked(): IConsultationContextSchemaEntity['templateLocked'] {
    return this._templateLocked;
  }

  set templateLocked(value: IConsultationContextSchemaEntity['templateLocked']) {
    this.setProperty('templateLocked', value);
  }

  get Department(): IConsultationContextSchemaEntity['Department'] {
    return this._Department;
  }

  set Department(value: IConsultationContextSchemaEntity['Department']) {
    this.setProperty('Department', value);
  }

  get Versions(): IConsultationContextSchemaEntity['Versions'] {
    return this._Versions;
  }

  set Versions(value: IConsultationContextSchemaEntity['Versions']) {
    this.setProperty('Versions', value);
  }

  // ============================================
  // Custom Domain Methods
  // ============================================

  /**
   * A schema is only SERVED to a client once it has been published AND carries
   * a pin. A DRAFT with a pin (possible after an unpublish) is deliberately
   * not servable — the status is the gate, the pin is the target.
   */
  get isServable(): boolean {
    return (
      this._pinnedVersionNumber != null &&
      (this._status === Enums.ConsultationContextSchemaStatus.PUBLISHED || this._status === Enums.ConsultationContextSchemaStatus.APPROVED)
    );
  }

  public override validate(): void {
    super.validate();
    if (!this._slug || !CONTEXT_SCHEMA_SLUG_PATTERN.test(this._slug)) {
      throw new BusinessException('Context schema slug must match [a-z0-9_]{2,48}');
    }
    if (!this._name || this._name.trim().length === 0) {
      throw new BusinessException('Context schema name is required');
    }
    if (this._scope === Enums.ConsultationContextSchemaScope.DEPARTMENT && !this._departmentId) {
      throw new BusinessException('A DEPARTMENT-scoped context schema requires a departmentId');
    }
    if (this._scope === Enums.ConsultationContextSchemaScope.TENANT && this._departmentId) {
      throw new BusinessException('A TENANT-scoped context schema must not carry a departmentId');
    }
    if (this._pinnedVersionNumber != null && (!Number.isInteger(this._pinnedVersionNumber) || this._pinnedVersionNumber < 1)) {
      throw new BusinessException('pinnedVersionNumber must be a positive integer');
    }
  }
}
