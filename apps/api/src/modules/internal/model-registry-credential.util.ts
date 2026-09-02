import { BadRequestException } from '@nestjs/common';
import type { IActiveUserContext, IProviderConnectionService, ResolvedProviderCredential } from '@arcaai/applications';
import type { ClsService } from 'nestjs-cls';

/**
 * Shared body behind `GET /internal/model-registry-credential`
 * (`ModelRegistryInternalController`, generic — every backend service) and
 * the superseded `GET /internal/stt/model-registry-credential`
 * (`SttInternalController.getModelRegistryCredential`, TASK-799, kept for
 * the STT worker). Both routes validate the caller and delegate here so the
 * resolution logic — and its tenant→SYSTEM/four-outcome contract — exists in
 * exactly one place.
 *
 * WHOSE credential is spent is decided by `tenantId` (the model row's OWNER),
 * never inferred from the caller. The connection model is tenant-scoped and
 * its Prisma extension fails closed without a tenant context, and a
 * service-to-service call carries none, so CLS is re-established here,
 * pinned to the requested tenant, before the resolve runs — same pattern as
 * `EffectiveConfigController` (pinned to SYSTEM) and the STT route's own
 * prior inline version (pinned to the caller-supplied tenant).
 */
export async function resolveModelRegistryCredential(
  providerConnections: IProviderConnectionService | undefined,
  cls: ClsService<IActiveUserContext> | undefined,
  provider: string | undefined,
  tenantId: string | undefined,
): Promise<ResolvedProviderCredential> {
  if (!provider?.trim()) {
    throw new BadRequestException('provider query parameter is required');
  }
  if (!tenantId?.trim()) {
    throw new BadRequestException('tenantId query parameter is required');
  }
  if (!providerConnections || !cls) {
    throw new BadRequestException('The provider-connection plane is not configured on this gateway');
  }

  const scopedTenantId = tenantId.trim();
  const scopedProvider = provider.trim();

  return cls.run(async () => {
    cls.set('tenantId', scopedTenantId);
    return providerConnections.resolveCredential('model-registry', scopedProvider, scopedTenantId);
  });
}
