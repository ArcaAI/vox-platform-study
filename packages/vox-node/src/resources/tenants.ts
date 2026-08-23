/**
 * `hope.tenants.*` — the caller's OWN tenant, served by the gateway's
 * `tenants/me/*` family. Read-only and business-plane: these are the reads an
 * integrator needs to build against a tenant's configuration, NOT the admin
 * surface for editing it (that is `hope.admin.*`).
 *
 * Only the context-schema discovery read is modelled today; the rest of the
 * family (`tenants/me`, `/config`, `/entitlements`, `/invoices`, `/spend`,
 * `/usage-summary`, `/usage-burndown`) is deliberately absent rather than
 * stubbed, and each carries its own API-key scope.
 */

import type { Transport } from '../core/transport';
import type { ConsultationSchemaBundle } from '../types/consultation-context-schema';

/** Options for {@link TenantsResource.contextSchema}. */
export interface ContextSchemaDiscoveryOptions {
  /**
   * Prefer the DEPARTMENT-scoped default for this department, falling back to
   * the tenant default. A department schema SHADOWS the tenant one.
   *
   * **Pass the department of the consultation you are about to write to.**
   * When `addContext` is called WITHOUT a pinned version, the server resolves
   * the schema using the consultation's own department; when it is called WITH
   * one, that version wins outright and no department resolution happens. So a
   * caller that discovers the TENANT default and pins it, then writes to a
   * consultation in a department that has its own vocabulary, validates against
   * a declaration that may not declare the kind at all — surfacing as
   * `does not declare a kind '<key>'`, not as a scope mismatch.
   */
  departmentId?: string;
  signal?: AbortSignal;
}

export class TenantsResource {
  constructor(private readonly transport: Transport) {}

  /**
   * `GET /api/v1/tenants/me/context-schema` — the caller tenant's RESOLVED,
   * PINNED consultation context schema.
   *
   * Resolution is `DEPARTMENT-scoped default → TENANT-scoped default`, and only
   * a SERVABLE schema participates (published or approved AND carrying a pin).
   * The result is never "the latest published version" — it is whatever the
   * tenant has pinned, which is the whole point of the pin.
   *
   * **An unconfigured tenant is a 200, not a 404**: every field is `null` and
   * `etag` is `"none"`. Branch on it (`bundle.schemaId !== null`); this method
   * does not throw for that case, because it is not an error.
   *
   * **Reachable by a user JWT and by an API key holding
   * `tenant:context-schema:read`.** A service account cannot reach it — the
   * route declares no `@RequiredSvcScopes`, and an absent scope declaration is
   * a deny-by-default 403 for the machine classes. Under API-key auth, `me`
   * resolves to the KEY'S TENANT (not to the key's bound user, the way
   * `users/me/*` does).
   *
   * Note the PLURAL path. `tenant/me/context-schema` (singular) still exists as
   * a 308 redirect shim and is not what this SDK calls.
   *
   * @example
   * const bundle = await hope.tenants.contextSchema({ departmentId });
   * if (bundle.contextSchemaVersionId) {
   *   await hope.consultations.addContext(
   *     consultationId,
   *     { type: 'STRUCTURED', kindKey: 'vitals', payload },
   *     { contextSchemaVersionId: bundle.contextSchemaVersionId },
   *   );
   * }
   */
  async contextSchema(options: ContextSchemaDiscoveryOptions = {}): Promise<ConsultationSchemaBundle> {
    return this.transport.request<ConsultationSchemaBundle>({
      path: 'tenants/me/context-schema',
      query: { departmentId: options.departmentId },
      signal: options.signal,
    });
  }
}
