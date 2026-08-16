/**
 * ConsentInternalController Unit Tests (TASK-712, consent-abac Phase 4).
 *
 * The inbound `/internal/consent/assert` surface — the gateway-internal front
 * door of the non-HTTP consent choke point. Thin controller: it delegates to
 * `IConsultationConsentService.checkConsent` (non-throwing) and is
 * class-guarded by `HarnessServiceTokenGuard`, mirroring
 * `HarnessInternalController`.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { SKIP_AUTH_KEY } from '@arcaai/applications';
import { ConsentPurpose } from '@arcaai/domains';
import { ConsentInternalController } from '../consent-internal.controller';
import { HarnessServiceTokenGuard } from '../harness-service-token.guard';

const mockConsentService = {
  checkConsent: vi.fn(),
  assertConsent: vi.fn(),
};

describe('ConsentInternalController', () => {
  let controller: ConsentInternalController;

  beforeEach(() => {
    vi.clearAllMocks();
    controller = new ConsentInternalController(mockConsentService as any);
  });

  it('is class-guarded by HarnessServiceTokenGuard', () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, ConsentInternalController) as unknown[] | undefined;
    expect(guards).toContain(HarnessServiceTokenGuard);
  });

  it('is @Public() so the boot route-audit passes and the auth chain defers to the service-token guard', () => {
    const skipAuth = Reflect.getMetadata(SKIP_AUTH_KEY, ConsentInternalController) as boolean | undefined;
    expect(skipAuth).toBe(true);
  });

  it('calls checkConsent (never assertConsent — this endpoint must never throw) with a workflow actor', async () => {
    mockConsentService.checkConsent.mockResolvedValue({ allowed: true, grantId: 'grant-1', expiresAt: null });

    await controller.assert({
      tenantId: 'tenant-1',
      externalPatientId: 'PAT-1',
      purpose: ConsentPurpose.EXTERNAL_TOOL_LOOKUP,
      consultationId: 'consult-1',
      toolName: 'terminology.lookup',
    } as any);

    expect(mockConsentService.checkConsent).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      externalPatientId: 'PAT-1',
      purpose: ConsentPurpose.EXTERNAL_TOOL_LOOKUP,
      scope: undefined,
      actor: { kind: 'workflow' },
      context: { consultationId: 'consult-1', toolName: 'terminology.lookup' },
    });
    expect(mockConsentService.assertConsent).not.toHaveBeenCalled();
  });

  it('omits context entirely when neither consultationId nor toolName is supplied', async () => {
    mockConsentService.checkConsent.mockResolvedValue({ allowed: true });

    await controller.assert({
      tenantId: 'tenant-1',
      externalPatientId: 'PAT-1',
      purpose: ConsentPurpose.HISTORY_RETRIEVAL,
    } as any);

    expect(mockConsentService.checkConsent).toHaveBeenCalledWith(expect.objectContaining({ context: undefined }));
  });

  it('maps an allowed decision to the wire shape, ISO-stringifying expiresAt', async () => {
    const expiresAt = new Date('2027-01-01T00:00:00.000Z');
    mockConsentService.checkConsent.mockResolvedValue({ allowed: true, grantId: 'grant-1', expiresAt });

    const result = await controller.assert({
      tenantId: 'tenant-1',
      externalPatientId: 'PAT-1',
      purpose: ConsentPurpose.EXTERNAL_TOOL_LOOKUP,
    } as any);

    expect(result).toEqual({
      allowed: true,
      reason: undefined,
      unavailable: undefined,
      grantId: 'grant-1',
      expiresAt: '2027-01-01T00:00:00.000Z',
    });
  });

  it('maps a genuine denial WITHOUT the unavailable flag — R4: denied vs unavailable stay distinguishable on the wire', async () => {
    mockConsentService.checkConsent.mockResolvedValue({ allowed: false, reason: 'no_grant' });

    const result = await controller.assert({
      tenantId: 'tenant-1',
      externalPatientId: 'PAT-1',
      purpose: ConsentPurpose.EXTERNAL_TOOL_LOOKUP,
    } as any);

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('no_grant');
    expect(result.unavailable).toBeUndefined();
  });

  it('maps a lookup failure with unavailable=true and no reason — R4: never conflated with a denial', async () => {
    mockConsentService.checkConsent.mockResolvedValue({ allowed: false, unavailable: true });

    const result = await controller.assert({
      tenantId: 'tenant-1',
      externalPatientId: 'PAT-1',
      purpose: ConsentPurpose.EXTERNAL_TOOL_LOOKUP,
    } as any);

    expect(result.allowed).toBe(false);
    expect(result.unavailable).toBe(true);
    expect(result.reason).toBeUndefined();
  });
});
