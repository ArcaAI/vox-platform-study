import { ApiProperty } from '@nestjs/swagger';
import { PROVIDER_SERVICES } from '../constants';
import { AiProviderConnectionResponse } from './ai-provider-connection.response';

/**
 * How the cascade would treat ONE platform (SYSTEM) cloud row for the scoped
 * tenant (TASK-954). Ordered the way the cascade decides: the tenant's own
 * facts first, then the entitlement, then the platform row's own state.
 *
 *   `overridden`     — the tenant brings its own ENABLED, keyed row; the platform default is not consulted.
 *   `vetoed`         — the tenant's own row is DISABLED: fail closed, the platform key is blocked too (R4).
 *   `not-entitled`   — the tenant holds no `platformDefaultCredential` grant (R6); no platform vendor account serves it.
 *   `not-configured` — the platform row is absent or keyless: nothing to inherit.
 *   `off`            — the platform row is disabled: the platform serves nobody with it.
 *   `inherited`      — an enabled, keyed platform row the tenant has no opinion on: this is what serves the tenant.
 */
export const PLATFORM_DEFAULT_RESOLUTIONS = ['inherited', 'overridden', 'vetoed', 'not-entitled', 'not-configured', 'off'] as const;
export type PlatformDefaultResolution = (typeof PLATFORM_DEFAULT_RESOLUTIONS)[number];

/**
 * One platform cloud row as a TENANT sees it: the masked projection (`hasKey`
 * only — the key never leaves the gateway) plus the cascade's verdict for
 * this tenant. Read-only by construction: there is no route that writes it
 * under a tenant scope.
 */
export class PlatformDefaultConnectionResponse extends AiProviderConnectionResponse {
  @ApiProperty({
    description:
      'What the cascade does with this platform row for the scoped tenant: overridden (tenant key wins) · vetoed (tenant ' +
      'row disabled) · not-entitled (no platform-default grant) · not-configured (absent or keyless) · off (platform row ' +
      'disabled) · inherited (this row serves the tenant).',
    enum: PLATFORM_DEFAULT_RESOLUTIONS,
  })
  resolution!: PlatformDefaultResolution;
}

/**
 * `GET admin/providers/:service/platform-defaults` — the platform fallback a
 * tenant inherits for one capability, read-only (TASK-954).
 */
export class PlatformDefaultConnectionsResponse {
  @ApiProperty({ description: 'Capability the connections serve.', enum: PROVIDER_SERVICES })
  service!: string;

  @ApiProperty({ description: 'The tenant the verdicts are computed for (the caller’s own tenant unless a platform admin scoped another).' })
  tenantId!: string;

  @ApiProperty({
    description:
      'Whether this tenant may draw on the platform’s VENDOR accounts at all (the `platformDefaultCredential` ' +
      'entitlement). When false every non-overridden, non-vetoed provider resolves `not-entitled`.',
  })
  entitled!: boolean;

  @ApiProperty({
    description:
      'One entry per CLOUD BYO provider of the service, in the platform’s declared order — a provider the platform never ' +
      'configured is a `version: 0` placeholder, never an omission. Platform-managed engines and the model registry are ' +
      'platform infrastructure and never listed here.',
    type: [PlatformDefaultConnectionResponse],
  })
  connections!: PlatformDefaultConnectionResponse[];
}
