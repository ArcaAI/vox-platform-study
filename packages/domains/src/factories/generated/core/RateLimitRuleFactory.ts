/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BaseEntityFactoryCreateProps } from '../../../common';
import { IRateLimitRuleEntity, RateLimitRuleEntity } from '../../../entities';
import { RateLimitMatchKind } from '../../../enums';
import { generateId } from '../../../utils';

export interface CreateRateLimitRuleProps extends BaseEntityFactoryCreateProps {
  tenantId: IRateLimitRuleEntity['tenantId'];
  routeMatch: IRateLimitRuleEntity['routeMatch'];
  limitValue: IRateLimitRuleEntity['limitValue'];
  windowMs: IRateLimitRuleEntity['windowMs'];
  matchKind?: IRateLimitRuleEntity['matchKind'];
  active?: IRateLimitRuleEntity['active'];
  description?: IRateLimitRuleEntity['description'];

  createdAt?: IRateLimitRuleEntity['createdAt'];
  updatedAt?: IRateLimitRuleEntity['updatedAt'];
  createdBy?: IRateLimitRuleEntity['createdBy'];
  updatedBy?: IRateLimitRuleEntity['updatedBy'];
}

export class RateLimitRuleFactory {
  static CreateRateLimitRule(props: CreateRateLimitRuleProps): RateLimitRuleEntity {
    const id = generateId();
    const now = new Date();

    return new RateLimitRuleEntity({
      id,

      createdAt: props.createdAt || now,
      updatedAt: props.updatedAt || now,
      createdBy: props.createdBy ?? null,
      updatedBy: props.updatedBy || null,

      tenantId: props.tenantId,
      routeMatch: props.routeMatch,
      // Mirrors the column default. EXACT is the safe default: a mistyped
      // pattern then governs one route rather than a whole subtree.
      matchKind: props.matchKind ?? RateLimitMatchKind.EXACT,
      limitValue: props.limitValue,
      windowMs: props.windowMs,
      active: props.active ?? true,
      description: props.description ?? null,
    });
  }
}
