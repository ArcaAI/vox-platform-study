/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BusinessException } from '@arcaai/exceptions';
import { BaseTenantEntity, IBaseTenantEntity } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Entities from '../../../entities';

/**
 * Editable, tenant-scoped realtime-pipeline policy.
 *
 * Polymorphic: ONE table covers the whole cascade tier set via the
 * `scope`/`scopeId` discriminator (TENANT default → DEPARTMENT override →
 * DOCTOR override). The reserved system tenant
 * `00000000-0000-0000-0000-000000000000` owns the platform-default TENANT row;
 * per-tenant / department / doctor rows OVERRIDE it. `_version` is the
 * optimistic-concurrency token (mutated only by `Repository.updateWithVersion`).
 *
 * The toggle columns are NULLABLE — a row overrides ONLY the toggles it sets
 * (null => inherit from the next tier up); the cascade walk + per-setting max
 * scope live in the `ConfigResolver` (packages/applications). `dnaStyleEnabled`
 * is the per-doctor DNA writing-style toggle: Phase 5 CREATES + READS it; Phase 6
 * WRITES it via the doctor self-service surface.
 */
export interface IPipelinePolicyEntity extends IBaseTenantEntity {
  scope: Enums.PipelinePolicyScope;
  scopeId?: string | null;
  autoSummaryEnabled?: boolean | null;
  autoNerEnabled?: boolean | null;
  harnessEnabled?: boolean | null;
  dnaStyleEnabled?: boolean | null;
  dnaRedactionEnabled?: boolean | null;
}

/** @deprecated TASK-861 — removed in R4. Its toggles become `enabled` flags on the nodes of the assigned workflow (`WorkflowAssignment`, TASK-864). */
export class PipelinePolicyEntity extends BaseTenantEntity {
  private _scope: IPipelinePolicyEntity['scope'];
  private _scopeId?: IPipelinePolicyEntity['scopeId'];
  private _autoSummaryEnabled?: IPipelinePolicyEntity['autoSummaryEnabled'];
  private _autoNerEnabled?: IPipelinePolicyEntity['autoNerEnabled'];
  private _harnessEnabled?: IPipelinePolicyEntity['harnessEnabled'];
  private _dnaStyleEnabled?: IPipelinePolicyEntity['dnaStyleEnabled'];
  private _dnaRedactionEnabled?: IPipelinePolicyEntity['dnaRedactionEnabled'];

  constructor(init: IPipelinePolicyEntity) {
    super(init);
    this._scope = init.scope;
    this._scopeId = init.scopeId;
    this._autoSummaryEnabled = init.autoSummaryEnabled;
    this._autoNerEnabled = init.autoNerEnabled;
    this._harnessEnabled = init.harnessEnabled;
    this._dnaStyleEnabled = init.dnaStyleEnabled;
    this._dnaRedactionEnabled = init.dnaRedactionEnabled;
  }

  get scope(): IPipelinePolicyEntity['scope'] {
    return this._scope;
  }

  set scope(value: IPipelinePolicyEntity['scope']) {
    this.setProperty('scope', value);
  }

  get scopeId(): IPipelinePolicyEntity['scopeId'] {
    return this._scopeId;
  }

  set scopeId(value: IPipelinePolicyEntity['scopeId']) {
    this.setProperty('scopeId', value);
  }

  get autoSummaryEnabled(): IPipelinePolicyEntity['autoSummaryEnabled'] {
    return this._autoSummaryEnabled;
  }

  set autoSummaryEnabled(value: IPipelinePolicyEntity['autoSummaryEnabled']) {
    this.setProperty('autoSummaryEnabled', value);
  }

  get autoNerEnabled(): IPipelinePolicyEntity['autoNerEnabled'] {
    return this._autoNerEnabled;
  }

  set autoNerEnabled(value: IPipelinePolicyEntity['autoNerEnabled']) {
    this.setProperty('autoNerEnabled', value);
  }

  get harnessEnabled(): IPipelinePolicyEntity['harnessEnabled'] {
    return this._harnessEnabled;
  }

  set harnessEnabled(value: IPipelinePolicyEntity['harnessEnabled']) {
    this.setProperty('harnessEnabled', value);
  }

  get dnaStyleEnabled(): IPipelinePolicyEntity['dnaStyleEnabled'] {
    return this._dnaStyleEnabled;
  }

  set dnaStyleEnabled(value: IPipelinePolicyEntity['dnaStyleEnabled']) {
    this.setProperty('dnaStyleEnabled', value);
  }

  get dnaRedactionEnabled(): IPipelinePolicyEntity['dnaRedactionEnabled'] {
    return this._dnaRedactionEnabled;
  }

  set dnaRedactionEnabled(value: IPipelinePolicyEntity['dnaRedactionEnabled']) {
    this.setProperty('dnaRedactionEnabled', value);
  }

  /**
   * Enforces the scope/scopeId invariant of the polymorphic table (defense in
   * depth on top of the DB unique index): a TENANT-default row carries NO
   * `scopeId`, while DEPARTMENT / DOCTOR override rows MUST carry the
   * department/user id they target. Subclass-mandated: calls `super.validate()`
   * so the tenant-context backstop still runs.
   */
  public override validate(): void {
    super.validate();
    if (this._scope === Enums.PipelinePolicyScope.TENANT) {
      if (this._scopeId !== null && this._scopeId !== undefined && this._scopeId !== '') {
        throw new BusinessException('PipelinePolicy TENANT scope must not set a scopeId.');
      }
    } else {
      if (!this._scopeId || this._scopeId.trim().length === 0) {
        throw new BusinessException(`PipelinePolicy ${this._scope} scope requires a scopeId.`);
      }
    }
  }
}
