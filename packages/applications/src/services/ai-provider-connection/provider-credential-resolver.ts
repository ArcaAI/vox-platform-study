import { Injectable } from '@nestjs/common';
import { QuotaExceededException } from '@arcaai/exceptions';
import { AiProviderConnectionService } from './ai-provider-connection.service';
import { PLATFORM_DEFAULT_CAPABILITY } from './assert-provider-available';
import { ProviderService, isCloudByoProvider } from './constants';
import { ProviderFunding, ProviderOverride } from './IProviderConnectionService';
import { ProviderVetoedException } from './provider-vetoed.exception';

/**
 * ONE resolved credential, with the identity of the row that supplied it.
 *
 * `override` is the wire-shaped entry the Python adapters consume (plaintext
 * key material — gateway-side only, never serialised to a client).
 * `fundingTier` is DERIVED from the row (`tenant` = the caller's BYO row,
 * `platform` = the SYSTEM default) and is what the usage ledger stamps
 * `AiDeploymentKind` / `AiCostBasis` from. `connectionId` lets a consumer
 * record WHICH connection served (an agent invocation, a workflow run) without
 * ever holding the row.
 */
export interface ResolvedProviderBinding {
  override: ProviderOverride;
  fundingTier: ProviderFunding;
  connectionId: string;
}

/**
 * TASK-862 — THE provider credential resolver.
 *
 * The single entry point for "give me the credential that serves
 * `(service, provider)` for tenant T": the request fold (text/tts), the STT
 * pull, the harness per-activity route and — after TASK-863 — the
 * `AgentResolverService` all resolve through this contract, so tenant-vs-SYSTEM
 * precedence, the veto, the entitlement gate and derived funding are decided in
 * exactly one place.
 *
 * Contract (`resolve`):
 *   - the tenant's ENABLED + keyed row wins; the SYSTEM tier is not consulted;
 *   - ABSENCE (no tenant row, or an enabled-but-keyless one) widens to the
 *     SYSTEM row — subject to the platform-default entitlement for CLOUD
 *     providers; a self-host SYSTEM row is platform infrastructure and always
 *     resolves;
 *   - a DISABLED tenant row throws `ProviderVetoedException` (409) — fail
 *     closed, never another tier, never another provider;
 *   - a cloud provider whose SYSTEM tier the entitlement gate suppressed throws
 *     `QuotaExceededException` (403, `featurePlatformDefaultCredential`);
 *   - `null` = no row at either tier holds a credential. What that means is
 *     the CALLER's decision (a public model hub proceeds unauthenticated; an
 *     LLM agent fails closed).
 *
 * The tier reads and the decrypt stay on `AiProviderConnectionService`
 * (`cascadeRows` / `toOverrideEntry`) — this class owns only the
 * one-credential precedence rule on top of them, so the request fold and this
 * resolver cannot disagree about who wins.
 */
@Injectable()
export class ProviderCredentialResolver {
  constructor(private readonly connections: AiProviderConnectionService) {}

  async resolve(service: ProviderService, provider: string, tenantId: string): Promise<ResolvedProviderBinding | null> {
    this.connections.assertResolvable(service, provider, tenantId);

    const { tenantRows, systemRows, vetoed, platformDefault } = await this.connections.cascadeRows(service, tenantId, provider);

    // R4 — the veto fails CLOSED before anything is decrypted.
    if (vetoed.has(provider)) {
      throw new ProviderVetoedException(service, provider, tenantId);
    }

    const isCloud = isCloudByoProvider(service, provider);
    for (const [tier, rows] of [
      ['tenant', tenantRows],
      ['system', systemRows],
    ] as const) {
      for (const row of rows) {
        // A keyless or disabled row carries nothing to inject — treated as
        // ABSENT at both tiers (an enabled-but-keyless tenant row is an
        // incomplete setup, not a veto).
        if (!row.enabled || !row.encryptedApiKey) continue;
        // C5 — a tenant may only ever OWN a cloud BYO row. Enforced at read
        // time as well as at the write guard, so a row that predates the guard
        // cannot become a credential.
        if (tier === 'tenant' && !isCloud) continue;
        const entry = await this.connections.toOverrideEntry(row, service);
        // A decrypt failure is a FAULT on that one credential (logged by the
        // service, never a veto): keep walking so the next tier may serve.
        if (!entry) continue;
        return { override: entry, fundingTier: entry.funding, connectionId: row.id };
      }
    }

    // R6 — the gate governs platform SPEND on a VENDOR account, so it denies a
    // CLOUD provider only; a self-host SYSTEM row was never suppressed.
    if (platformDefault?.entitlementSuppressed && isCloud) {
      throw new QuotaExceededException(
        `This tenant is not entitled to the platform-provided credential for '${provider}' (${service}). ` +
          'Bring your own credential for this provider, or ask your account owner to enable the platform-default entitlement.',
        { capability: PLATFORM_DEFAULT_CAPABILITY, limit: 0, used: 0, requested: 1 },
      );
    }

    return null;
  }
}
