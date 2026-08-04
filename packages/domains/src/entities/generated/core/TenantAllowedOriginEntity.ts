/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BusinessException } from '@arcaai/exceptions';
import { BaseTenantEntity, IBaseTenantEntity } from '../../../common';

// DB-backed, global-admin-editable registry of browser origins permitted to
// call the gateway (TASK-610 CORS control plane). `tenantId` is the OWNING
// tenant; the reserved SYSTEM tenant owns platform-operated origins (e.g. the
// admin console, which serves every tenant from one origin) and is treated as
// valid for every tenant — that fan-out rule lives in the application-layer
// `OriginRegistryService` / `OriginTenantBindingGuard`, not here.
//
// `origin` is stored PRE-NORMALIZED. Origin grammar (scheme allow-list,
// default-port stripping, wildcard/path/userinfo rejection, non-loopback
// `http://` refusal) is owned EXCLUSIVELY by `normalizeOrigin`
// (`packages/applications/src/services/origin-registry/origin-normalizer.ts`)
// — duplicating that grammar here would create two sources of truth that
// drift. `validate()` below only checks that a value made it through that
// normalizer: non-empty, no surrounding whitespace, no trailing slash.
export interface ITenantAllowedOriginEntity extends IBaseTenantEntity {
  origin: string;
  label: string;
  description?: string | null;
}

export class TenantAllowedOriginEntity extends BaseTenantEntity {
  private _origin: ITenantAllowedOriginEntity['origin'];
  private _label: ITenantAllowedOriginEntity['label'];
  private _description?: ITenantAllowedOriginEntity['description'];

  constructor(init: ITenantAllowedOriginEntity) {
    super(init);
    this._origin = init.origin;
    this._label = init.label;
    this._description = init.description;
  }

  get origin(): ITenantAllowedOriginEntity['origin'] {
    return this._origin;
  }

  set origin(value: ITenantAllowedOriginEntity['origin']) {
    this.setProperty('origin', value);
  }

  get label(): ITenantAllowedOriginEntity['label'] {
    return this._label;
  }

  set label(value: ITenantAllowedOriginEntity['label']) {
    this.setProperty('label', value);
  }

  get description(): ITenantAllowedOriginEntity['description'] {
    return this._description;
  }

  set description(value: ITenantAllowedOriginEntity['description']) {
    this.setProperty('description', value);
  }

  public override validate(): void {
    super.validate();
    if (!this._origin || this._origin.trim().length === 0) {
      throw new BusinessException('Origin is required');
    }
    // Structural backstop only — NOT origin grammar. `normalizeOrigin` is the
    // single source of truth for what a valid origin looks like (scheme,
    // host, default-port stripping, wildcard/path rejection, etc.); this just
    // catches a value that plainly never went through it.
    if (this._origin !== this._origin.trim()) {
      throw new BusinessException('Origin must not have leading/trailing whitespace');
    }
    if (this._origin.endsWith('/')) {
      throw new BusinessException('Origin must not have a trailing slash');
    }
    if (!this._label || this._label.trim().length === 0) {
      throw new BusinessException('Label is required');
    }
  }
}
