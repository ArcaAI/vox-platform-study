/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BaseEntityFactoryCreateProps } from '../../../common';
import { AiPriceBookEntity, IAiPriceBookEntity } from '../../../entities';
import { AiPriceRowKind } from '../../../enums';
import { generateId } from '../../../utils';

export interface CreateAiPriceBookProps extends BaseEntityFactoryCreateProps {
  tenantId: IAiPriceBookEntity['tenantId'];
  plane: IAiPriceBookEntity['plane'];
  rowKind?: IAiPriceBookEntity['rowKind'];

  planTier?: IAiPriceBookEntity['planTier'];
  capability?: IAiPriceBookEntity['capability'];
  provider?: IAiPriceBookEntity['provider'];
  model?: IAiPriceBookEntity['model'];
  unit?: IAiPriceBookEntity['unit'];
  contextBand?: IAiPriceBookEntity['contextBand'];
  cacheTtl?: IAiPriceBookEntity['cacheTtl'];

  currency?: IAiPriceBookEntity['currency'];
  unitPriceMicros: IAiPriceBookEntity['unitPriceMicros'];

  effectiveFrom: IAiPriceBookEntity['effectiveFrom'];
  effectiveTo?: IAiPriceBookEntity['effectiveTo'];
  bookVersion: IAiPriceBookEntity['bookVersion'];

  createdAt?: IAiPriceBookEntity['createdAt'];
  updatedAt?: IAiPriceBookEntity['updatedAt'];
  createdBy?: IAiPriceBookEntity['createdBy'];
  updatedBy?: IAiPriceBookEntity['updatedBy'];
}

export class AiPriceBookFactory {
  /**
   * Build one effective-dated price row.
   *
   * `effectiveTo` defaults to null — "in force until superseded" — which is what
   * makes the table supersede-only in practice: a new row is open-ended, and
   * repricing closes the PREVIOUS row via `supersedeAt()` rather than editing
   * any price in place.
   */
  static CreateAiPriceBook(props: CreateAiPriceBookProps): AiPriceBookEntity {
    const id = generateId();
    const now = new Date();

    return new AiPriceBookEntity({
      id,

      createdAt: props.createdAt || now,
      updatedAt: props.updatedAt || now,
      createdBy: props.createdBy ?? null,
      updatedBy: props.updatedBy || null,

      tenantId: props.tenantId,
      plane: props.plane,
      rowKind: props.rowKind ?? AiPriceRowKind.USAGE_UNIT,

      planTier: props.planTier ?? null,
      capability: props.capability ?? null,
      provider: props.provider ?? null,
      model: props.model ?? null,
      unit: props.unit ?? null,
      contextBand: props.contextBand ?? null,
      cacheTtl: props.cacheTtl ?? null,

      currency: props.currency ?? 'USD',
      unitPriceMicros: props.unitPriceMicros,

      effectiveFrom: props.effectiveFrom,
      effectiveTo: props.effectiveTo ?? null,
      bookVersion: props.bookVersion,
    });
  }
}
