import { AiPriceBookEntity, AiPriceBookPlane, AiPriceRowKind } from '@arcaai/domains';

import { SellRateResponse } from './dto';

/** Entity → response. Micros as decimal-integer strings; timestamps as ISO strings. */
export class SellRateDtoMapper {
  static toResponse(entity: AiPriceBookEntity): SellRateResponse {
    const response = new SellRateResponse();
    response.id = entity.id;
    response.tenantId = entity.tenantId;
    response.plane = entity.plane as AiPriceBookPlane;
    response.rowKind = (entity.rowKind ?? AiPriceRowKind.USAGE_UNIT) as AiPriceRowKind;
    response.planTier = entity.planTier ?? null;
    response.capability = entity.capability ?? null;
    response.provider = entity.provider ?? null;
    response.model = entity.model ?? null;
    response.unit = entity.unit ?? null;
    response.contextBand = entity.contextBand ?? null;
    response.currency = entity.currency ?? 'USD';
    response.unitPriceMicros = entity.unitPriceMicros.toString();
    response.effectiveFrom = entity.effectiveFrom.toISOString();
    response.effectiveTo = entity.effectiveTo ? entity.effectiveTo.toISOString() : null;
    response.bookVersion = entity.bookVersion;
    response.version = entity.version;
    response.createdAt = entity.createdAt.toISOString();
    response.updatedAt = entity.updatedAt.toISOString();
    return response;
  }
}
