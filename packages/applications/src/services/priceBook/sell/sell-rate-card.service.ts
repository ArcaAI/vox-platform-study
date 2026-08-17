import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { ArgumentInvalidException, BusinessException, DataNotFoundException } from '@arcaai/exceptions';
import {
  AiPriceBookEntity,
  AiPriceBookFactory,
  AiPriceBookPlane,
  AiPriceBookRepository,
  AiPriceRowKind,
  CoreUnitOfWorkService,
  ResourceType,
  SYSTEM_TENANT_ID,
  SysEventType,
} from '@arcaai/domains';

import { BaseService, isSuperAdmin } from '../../../common';
import { IActiveUserContext } from '../../../interfaces';
import { CreateSellRateRequest, SellRateResponse, SellRateSupersedeResponse, SupersedeSellRateRequest } from './dto';
import { ISellRateCardService, ListSellRatesQuery } from './ISellRateCardService';
import { SellRateDtoMapper } from './sell-rate-card.dto.mapper';

/**
 * SELL rate-card administration (D10/D12).
 *
 * SUPERSEDE-ONLY BY CONSTRUCTION: the service exposes create, list and
 * supersede — no update method exists, so "mutating an effective row" is not a
 * forbidden call, it is an impossible one. Superseding closes the old row's
 * half-open window at the successor's `effectiveFrom` and inserts the
 * successor in ONE transaction, so resolution never sees a gap or an overlap
 * and an already-computed invoice remains reproducible from its
 * `priceBookVersion` stamp.
 *
 * // AUTH-NOTE: rate-card mutation is SUPER_ADMIN-ONLY, enforced imperatively
 * // here (`isSuperAdmin`) because the permission decorators cannot express
 * // "super admins only" — the `AiTaskDefault` precedent (rule 05). This is a
 * // deliberate 403 privilege boundary, NOT the 404-over-403 tenancy posture.
 *
 * The COST plane is refused outright: it is ops-owned (seeds + the future
 * pinned-SHA LiteLLM import), and a SELL surface that could quietly reprice
 * COGS would let one mistake move both sides of the margin at once.
 */
@Injectable()
export class SellRateCardService extends BaseService implements ISellRateCardService {
  constructor(
    eventEmitter: EventEmitter2,
    clsService: ClsService<IActiveUserContext>,
    private readonly priceBookRepository: AiPriceBookRepository,
    private readonly unitOfWork: CoreUnitOfWorkService,
  ) {
    super(eventEmitter, clsService, ResourceType.AiPriceBook);
  }

  async listSellRates(query: ListSellRatesQuery): Promise<SellRateResponse[]> {
    const filters: Record<string, unknown> = {
      tenantId: query.tenantId ?? SYSTEM_TENANT_ID,
      plane: AiPriceBookPlane.SELL,
    };
    if (query.rowKind) filters.rowKind = query.rowKind;
    if (query.capability) filters.capability = query.capability;
    if (query.unit) filters.unit = query.unit;
    if (query.planTier) filters.planTier = query.planTier;

    const rows = await this.priceBookRepository.findAll({
      filters,
      sort: [{ effectiveFrom: 'desc' }],
    } as never);
    return rows.map((row) => SellRateDtoMapper.toResponse(row));
  }

  async createSellRate(request: CreateSellRateRequest): Promise<SellRateResponse> {
    this.assertSuperAdmin();
    this.assertRowShape(request);

    const entity = AiPriceBookFactory.CreateAiPriceBook({
      tenantId: request.tenantId ?? SYSTEM_TENANT_ID,
      plane: AiPriceBookPlane.SELL, // pinned — this surface manages the SELL card only
      rowKind: request.rowKind,
      planTier: request.planTier ?? null,
      capability: request.capability ?? null,
      provider: request.provider ?? null,
      model: request.model ?? null,
      unit: request.unit ?? null,
      contextBand: request.contextBand ?? null,
      currency: request.currency ?? 'USD',
      unitPriceMicros: BigInt(request.unitPriceMicros),
      effectiveFrom: new Date(request.effectiveFrom),
      bookVersion: request.bookVersion,
      createdBy: this.requestUserId ?? undefined,
    });
    entity.validate();

    const saved = await this.priceBookRepository.create(entity);

    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceId: saved.id,
      metaData: { plane: AiPriceBookPlane.SELL, rowKind: request.rowKind, bookVersion: request.bookVersion },
    });
    return SellRateDtoMapper.toResponse(saved);
  }

  async supersedeSellRate(id: string, request: SupersedeSellRateRequest, expectedVersion: number): Promise<SellRateSupersedeResponse> {
    this.assertSuperAdmin();

    const current = await this.findSellRow(id);
    const successorFrom = new Date(request.effectiveFrom);

    // Entity guards: an already-closed row throws; a window inversion throws.
    current.supersedeAt(successorFrom);
    current.updatedBy = this.requestUserId ?? undefined;

    const successor = AiPriceBookFactory.CreateAiPriceBook({
      tenantId: current.tenantId,
      plane: AiPriceBookPlane.SELL,
      rowKind: current.rowKind,
      // Dimensions are INHERITED — a supersede reprices, it never re-shapes.
      planTier: current.planTier ?? null,
      capability: current.capability ?? null,
      provider: current.provider ?? null,
      model: current.model ?? null,
      unit: current.unit ?? null,
      contextBand: current.contextBand ?? null,
      currency: current.currency ?? 'USD',
      unitPriceMicros: BigInt(request.unitPriceMicros),
      effectiveFrom: successorFrom,
      bookVersion: request.bookVersion,
      createdBy: this.requestUserId ?? undefined,
    });
    successor.validate();

    // Close + insert atomically: a close without its successor would leave the
    // dimension UNPRICED from `effectiveFrom` on, which the invoice engine
    // treats as fail-closed — exactly the outage this transaction prevents.
    const [closed, created] = await this.unitOfWork.runInTransaction(async (tx) => {
      const closedRow = await this.priceBookRepository.updateWithVersion(id, current, expectedVersion, tx);
      const createdRow = await this.priceBookRepository.create(successor, tx);
      return [closedRow, createdRow] as const;
    });

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: closed.id,
      metaData: { superseded: true, effectiveTo: successorFrom.toISOString(), successorId: created.id, previousVersion: expectedVersion },
    });
    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceId: created.id,
      metaData: { plane: AiPriceBookPlane.SELL, supersedes: closed.id, bookVersion: request.bookVersion },
    });

    return { closed: SellRateDtoMapper.toResponse(closed), successor: SellRateDtoMapper.toResponse(created) };
  }

  // ---------------------------------------------------------------------------

  private async findSellRow(id: string): Promise<AiPriceBookEntity> {
    let row: AiPriceBookEntity;
    try {
      row = await this.priceBookRepository.findById(id);
    } catch (err) {
      if (err instanceof DataNotFoundException) throw new NotFoundException(`Rate row ${id} not found`);
      throw err;
    }
    if (row.plane !== AiPriceBookPlane.SELL) {
      throw new BusinessException('This surface manages the SELL card only — COST rows are ops-owned and are never edited here.');
    }
    return row;
  }

  /** PLAN_FEE is keyed by tier alone; USAGE_UNIT is keyed by capability + unit. */
  private assertRowShape(request: CreateSellRateRequest): void {
    if (request.rowKind === AiPriceRowKind.PLAN_FEE) {
      if (!request.planTier) {
        throw new ArgumentInvalidException('A PLAN_FEE row requires planTier.');
      }
      if (request.capability || request.unit || request.provider || request.model || request.contextBand) {
        throw new ArgumentInvalidException('A PLAN_FEE row is keyed by planTier alone — capability/unit/provider/model/contextBand are forbidden.');
      }
      return;
    }
    if (!request.capability || !request.unit) {
      throw new ArgumentInvalidException('A USAGE_UNIT row requires capability and unit.');
    }
  }

  private assertSuperAdmin(): void {
    if (!isSuperAdmin(this.requestUser)) {
      throw new ForbiddenException('Rate-card mutation is restricted to super administrators.');
    }
  }
}
