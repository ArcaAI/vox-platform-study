/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BusinessException } from '@arcaai/exceptions';
import { BaseTenantEntity, IBaseTenantEntity } from '../../../common';
import { RateLimitMatchKind } from '../../../enums';

// One rate-limit rule (TASK-785). A SYSTEM-tenant row is a platform-wide
// per-route limit; a customer-tenant row overrides it for that tenant alone.
//
// `routeMatch` is a ROUTE KEY (`METHOD:/route/pattern`), never a raw URL — the
// pattern exactly as the router registered it. The reserved pattern `*` means
// "every route" and is how a tenant expresses a limit on all of its traffic.
//
// Only STRUCTURAL invariants live here. The precedence cascade, the
// "a SYSTEM rule may not use `*`" governance rule, and the per-scope rule cap
// are cross-aggregate concerns and belong to `RateLimitRuleService`.
export interface IRateLimitRuleEntity extends IBaseTenantEntity {
  routeMatch: string;
  matchKind: RateLimitMatchKind;
  limitValue: number;
  windowMs: number;
  active: boolean;
  description?: string | null;
}

export class RateLimitRuleEntity extends BaseTenantEntity {
  private _routeMatch: IRateLimitRuleEntity['routeMatch'];
  private _matchKind: IRateLimitRuleEntity['matchKind'];
  private _limitValue: IRateLimitRuleEntity['limitValue'];
  private _windowMs: IRateLimitRuleEntity['windowMs'];
  private _active: IRateLimitRuleEntity['active'];
  private _description?: IRateLimitRuleEntity['description'];

  constructor(init: IRateLimitRuleEntity) {
    super(init);
    this._routeMatch = init.routeMatch;
    this._matchKind = init.matchKind;
    this._limitValue = init.limitValue;
    this._windowMs = init.windowMs;
    this._active = init.active;
    this._description = init.description;
  }

  get routeMatch(): IRateLimitRuleEntity['routeMatch'] {
    return this._routeMatch;
  }

  set routeMatch(value: IRateLimitRuleEntity['routeMatch']) {
    this.setProperty('routeMatch', value);
  }

  get matchKind(): IRateLimitRuleEntity['matchKind'] {
    return this._matchKind;
  }

  set matchKind(value: IRateLimitRuleEntity['matchKind']) {
    this.setProperty('matchKind', value);
  }

  get limitValue(): IRateLimitRuleEntity['limitValue'] {
    return this._limitValue;
  }

  set limitValue(value: IRateLimitRuleEntity['limitValue']) {
    this.setProperty('limitValue', value);
  }

  get windowMs(): IRateLimitRuleEntity['windowMs'] {
    return this._windowMs;
  }

  set windowMs(value: IRateLimitRuleEntity['windowMs']) {
    this.setProperty('windowMs', value);
  }

  get active(): IRateLimitRuleEntity['active'] {
    return this._active;
  }

  set active(value: IRateLimitRuleEntity['active']) {
    this.setProperty('active', value);
  }

  get description(): IRateLimitRuleEntity['description'] {
    return this._description;
  }

  set description(value: IRateLimitRuleEntity['description']) {
    this.setProperty('description', value);
  }

  public override validate(): void {
    super.validate();
    if (!this._routeMatch || this._routeMatch.trim().length === 0) {
      throw new BusinessException('Route match is required');
    }
    // A limit of 0 would be an accidental total outage dressed up as a config
    // value; exempting a scope is what `active = false` is for.
    if (!Number.isInteger(this._limitValue) || this._limitValue < 1) {
      throw new BusinessException('Limit must be a positive integer');
    }
    if (!Number.isInteger(this._windowMs) || this._windowMs < 1) {
      throw new BusinessException('Window must be a positive integer in milliseconds');
    }
  }
}
