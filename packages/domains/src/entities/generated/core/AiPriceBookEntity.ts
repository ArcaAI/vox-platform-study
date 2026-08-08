/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BusinessException } from '@arcaai/exceptions';
import { BaseTenantEntity, IBaseTenantEntity } from '../../../common';
import * as Enums from '../../../enums';

/**
 * One effective-dated price row, in one of the two planes (D10).
 *
 * SUPERSEDE-ONLY: a price is NEVER edited in place. Repricing closes the current
 * row (`effectiveTo`) and inserts a new one, so an invoice computed last month
 * stays reproducible. The application service resolves "the row whose
 * [effectiveFrom, effectiveTo) window contains the event's `occurredAt`",
 * most-specific dimensions winning.
 *
 * The SYSTEM-tenant rows are the platform rate card (SYSTEM-shared READ, writes
 * GLOBAL_ADMIN-only at the service layer). Unlike its append-only siblings in
 * this plane, this model IS admin-managed: standard soft-delete lifecycle,
 * sys-events on mutation (`ResourceType.AiPriceBook`).
 */
export interface IAiPriceBookEntity extends IBaseTenantEntity {
  plane: Enums.AiPriceBookPlane;
  rowKind?: Enums.AiPriceRowKind;

  // Dimensions — nullable because specificity varies by row kind (a PLAN_FEE row
  // is keyed by planTier alone, a COST row by capability/provider/model/unit).
  planTier?: Enums.TenantPlan | null;
  capability?: Enums.AiCapability | null;
  provider?: string | null;
  model?: string | null;
  unit?: Enums.AiUsageUnit | null;
  contextBand?: string | null;
  /**
   * Cache-write TTL band ("5m" / "1h") this row prices; null = the TTL-agnostic
   * wildcard every pre-existing CACHE_WRITE_TOKEN row keeps using. A TTL-keyed
   * row wins over the wildcard for events carrying `attributesJson.cacheTtl`.
   */
  cacheTtl?: string | null;

  currency?: string;
  /** Integer micros per ONE `unit` (or per period for a PLAN_FEE row). */
  unitPriceMicros: bigint;

  effectiveFrom: Date;
  /** null = still in force. */
  effectiveTo?: Date | null;
  bookVersion: string;
  // `resourceStatus*` comes from IBaseEntity — this model keeps the standard
  // soft-delete lifecycle (unlike its append-only siblings in this plane).
}

export class AiPriceBookEntity extends BaseTenantEntity {
  private _plane: IAiPriceBookEntity['plane'];
  private _rowKind?: IAiPriceBookEntity['rowKind'];
  private _planTier?: IAiPriceBookEntity['planTier'];
  private _capability?: IAiPriceBookEntity['capability'];
  private _provider?: IAiPriceBookEntity['provider'];
  private _model?: IAiPriceBookEntity['model'];
  private _unit?: IAiPriceBookEntity['unit'];
  private _contextBand?: IAiPriceBookEntity['contextBand'];
  private _cacheTtl?: IAiPriceBookEntity['cacheTtl'];
  private _currency?: IAiPriceBookEntity['currency'];
  private _unitPriceMicros: IAiPriceBookEntity['unitPriceMicros'];
  private _effectiveFrom: IAiPriceBookEntity['effectiveFrom'];
  private _effectiveTo?: IAiPriceBookEntity['effectiveTo'];
  private _bookVersion: IAiPriceBookEntity['bookVersion'];

  constructor(init: IAiPriceBookEntity) {
    super(init);
    this._plane = init.plane;
    this._rowKind = init.rowKind;
    this._planTier = init.planTier;
    this._capability = init.capability;
    this._provider = init.provider;
    this._model = init.model;
    this._unit = init.unit;
    this._contextBand = init.contextBand;
    this._cacheTtl = init.cacheTtl;
    this._currency = init.currency;
    this._unitPriceMicros = init.unitPriceMicros;
    this._effectiveFrom = init.effectiveFrom;
    this._effectiveTo = init.effectiveTo;
    this._bookVersion = init.bookVersion;
  }

  get plane(): IAiPriceBookEntity['plane'] {
    return this._plane;
  }

  set plane(value: IAiPriceBookEntity['plane']) {
    this.setProperty('plane', value);
  }

  get rowKind(): IAiPriceBookEntity['rowKind'] {
    return this._rowKind;
  }

  set rowKind(value: IAiPriceBookEntity['rowKind']) {
    this.setProperty('rowKind', value);
  }

  get planTier(): IAiPriceBookEntity['planTier'] {
    return this._planTier;
  }

  set planTier(value: IAiPriceBookEntity['planTier']) {
    this.setProperty('planTier', value);
  }

  get capability(): IAiPriceBookEntity['capability'] {
    return this._capability;
  }

  set capability(value: IAiPriceBookEntity['capability']) {
    this.setProperty('capability', value);
  }

  get provider(): IAiPriceBookEntity['provider'] {
    return this._provider;
  }

  set provider(value: IAiPriceBookEntity['provider']) {
    this.setProperty('provider', value);
  }

  get model(): IAiPriceBookEntity['model'] {
    return this._model;
  }

  set model(value: IAiPriceBookEntity['model']) {
    this.setProperty('model', value);
  }

  get unit(): IAiPriceBookEntity['unit'] {
    return this._unit;
  }

  set unit(value: IAiPriceBookEntity['unit']) {
    this.setProperty('unit', value);
  }

  get contextBand(): IAiPriceBookEntity['contextBand'] {
    return this._contextBand;
  }

  set contextBand(value: IAiPriceBookEntity['contextBand']) {
    this.setProperty('contextBand', value);
  }

  get cacheTtl(): IAiPriceBookEntity['cacheTtl'] {
    return this._cacheTtl;
  }

  set cacheTtl(value: IAiPriceBookEntity['cacheTtl']) {
    this.setProperty('cacheTtl', value);
  }

  get currency(): IAiPriceBookEntity['currency'] {
    return this._currency;
  }

  set currency(value: IAiPriceBookEntity['currency']) {
    this.setProperty('currency', value);
  }

  get unitPriceMicros(): IAiPriceBookEntity['unitPriceMicros'] {
    return this._unitPriceMicros;
  }

  set unitPriceMicros(value: IAiPriceBookEntity['unitPriceMicros']) {
    this.setProperty('unitPriceMicros', value);
  }

  get effectiveFrom(): IAiPriceBookEntity['effectiveFrom'] {
    return this._effectiveFrom;
  }

  set effectiveFrom(value: IAiPriceBookEntity['effectiveFrom']) {
    this.setProperty('effectiveFrom', value);
  }

  get effectiveTo(): IAiPriceBookEntity['effectiveTo'] {
    return this._effectiveTo;
  }

  set effectiveTo(value: IAiPriceBookEntity['effectiveTo']) {
    this.setProperty('effectiveTo', value);
  }

  get bookVersion(): IAiPriceBookEntity['bookVersion'] {
    return this._bookVersion;
  }

  set bookVersion(value: IAiPriceBookEntity['bookVersion']) {
    this.setProperty('bookVersion', value);
  }

  /**
   * Close this row's effective window — the supersede-only "edit". The caller
   * inserts the replacement row starting at the same instant, so the two windows
   * abut without a gap or an overlap.
   */
  public supersedeAt(effectiveTo: Date): void {
    if (this._effectiveTo) {
      throw new BusinessException('AiPriceBook row is already superseded — insert a new row instead of re-closing this one.');
    }
    if (effectiveTo.getTime() < this._effectiveFrom.getTime()) {
      throw new BusinessException('AiPriceBook effectiveTo cannot precede effectiveFrom.');
    }
    this.setProperty('effectiveTo', effectiveTo);
  }

  public override validate(): void {
    super.validate();
    if (this._plane === undefined || this._plane === null) {
      throw new BusinessException('AiPriceBook plane is required (COST or SELL).');
    }
    if (this._unitPriceMicros === undefined || this._unitPriceMicros === null) {
      throw new BusinessException('AiPriceBook unitPriceMicros is required.');
    }
    // A negative price is always a data-entry error; a zero price is legitimate
    // (a self-hosted capability the platform chooses not to charge for).
    if (this._unitPriceMicros < 0n) {
      throw new BusinessException('AiPriceBook unitPriceMicros cannot be negative.');
    }
    if (!this._effectiveFrom) {
      throw new BusinessException('AiPriceBook effectiveFrom is required.');
    }
    if (this._effectiveTo && this._effectiveTo.getTime() < this._effectiveFrom.getTime()) {
      throw new BusinessException('AiPriceBook effectiveTo cannot precede effectiveFrom.');
    }
    if (!this._bookVersion || this._bookVersion.trim().length === 0) {
      throw new BusinessException('AiPriceBook bookVersion is required — a rated row stamps it for reproducibility.');
    }
  }
}
