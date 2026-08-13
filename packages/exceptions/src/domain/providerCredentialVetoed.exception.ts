import { PROVIDER_CREDENTIAL_VETOED, BaseDomainException } from '../common';

/**
 * Structured detail carried by a {@link ProviderCredentialVetoedException} so the
 * gateway can render a machine-readable 409 and the console can point at the
 * exact row the tenant must re-enable.
 */
export interface ProviderCredentialVetoedMetadata {
  /** The capability the call was for: `llm` | `stt` | `tts`. */
  service: string;
  /** The serving provider the tenant vetoed, e.g. `azure`, `sarvam`. */
  provider: string;
  /** The tenant whose row carries the veto. */
  tenantId?: string;
}

/**
 * The caller's tenant holds a DISABLED connection row for this
 * `(service, provider)` (option (a)).
 *
 * A disabled tenant row is a **veto**, not an absence: it fails CLOSED for that
 * provider — no tenant credential, no platform-default credential, and never a
 * silent fall-through to a different provider. It is the mechanism a tenant uses
 * to refuse a shared vendor account for PHI, so a platform entitlement must
 * never override it.
 *
 * Mapped to **409 Conflict**, deliberately distinct from the **403** a missing
 * `featurePlatformDefaultCredential` entitlement produces: this one a tenant
 * admin can fix themselves, that one they cannot.
*/
export class ProviderCredentialVetoedException extends BaseDomainException {
  static readonly code = PROVIDER_CREDENTIAL_VETOED;
  constructor(message: string, metadata?: ProviderCredentialVetoedMetadata, cause?: Error) {
    super(message, ProviderCredentialVetoedException.code, cause, metadata);
  }
}
