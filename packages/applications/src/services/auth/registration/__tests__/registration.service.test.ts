import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RegistrationService } from '../registration.service';
import { ResourceStatusType } from '@arcaai/domains';

const mockClsService = { get: vi.fn(), set: vi.fn(), run: vi.fn((cb: () => unknown) => cb()) };
const mockEventEmitter = { emit: vi.fn() };

const mockUserRepository = { findFirst: vi.fn() };

const mockPasswordResetTokenRepository = {
  create: vi.fn(),
  findByTokenHash: vi.fn(),
  update: vi.fn(),
};

const mockUserService = { create: vi.fn(), update: vi.fn() };
const mockTenantOnboardingService = { provisionTenantWithAdmin: vi.fn() };
const mockMailer = { sendResetLink: vi.fn() };

vi.mock('@arcaai/domains', async () => {
  const actual = await vi.importActual('@arcaai/domains');
  return {
    ...actual,
    PasswordResetTokenFactory: {
      CreatePasswordResetToken: vi.fn((data) => ({
        ...data,
        id: 'token-1',
        toObject: vi.fn().mockReturnValue({ ...data }),
      })),
    },
  };
});

const createMockUser = (overrides: Partial<{ id: string; resourceStatus: ResourceStatusType }> = {}) => ({
  id: overrides.id ?? 'new-user-id',
  resourceStatus: overrides.resourceStatus ?? ResourceStatusType.SUSPENDED,
});

const activeTokenRecord = (overrides: Record<string, unknown> = {}) => ({
  id: 'token-1',
  userId: 'new-user-id',
  purpose: 'email_verification',
  metaData: { pendingTenantName: 'Acme Health' },
  isActive: vi.fn().mockReturnValue(true),
  markUsed: vi.fn(),
  ...overrides,
});

describe('RegistrationService (§3.4)', () => {
  let service: RegistrationService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockUserRepository.findFirst.mockResolvedValue(undefined);
    mockUserService.create.mockResolvedValue(createMockUser());
    mockMailer.sendResetLink.mockResolvedValue(true);

    service = new RegistrationService(
      mockUserRepository as any,
      mockPasswordResetTokenRepository as any,
      mockUserService as any,
      mockTenantOnboardingService as any,
      mockEventEmitter as any,
      mockClsService as any,
      mockMailer as any,
    );
  });

  describe('register', () => {
    it('creates a SUSPENDED user, issues a verification token, and emails it', async () => {
      await service.register({ email: 'Doctor@Example.com', password: 'S3cret!Pass', tenantName: 'Acme Health' });

      expect(mockUserService.create).toHaveBeenCalledWith(
        expect.objectContaining({
          username: 'doctor@example.com',
          password: 'S3cret!Pass',
          resourceStatus: ResourceStatusType.SUSPENDED,
        }),
      );
      expect(mockPasswordResetTokenRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'new-user-id',
          purpose: 'email_verification',
          metaData: { pendingTenantName: 'Acme Health' },
        }),
      );
      expect(mockMailer.sendResetLink).toHaveBeenCalledWith(expect.objectContaining({ email: 'doctor@example.com' }));
    });

    it('is a silent no-op for an email that already has an account (anti-enumeration)', async () => {
      mockUserRepository.findFirst.mockResolvedValue(createMockUser({ id: 'existing-id' }));

      await expect(service.register({ email: 'existing@example.com', password: 'S3cret!Pass', tenantName: 'Acme Health' })).resolves.toBeUndefined();

      expect(mockUserService.create).not.toHaveBeenCalled();
      expect(mockPasswordResetTokenRepository.create).not.toHaveBeenCalled();
      expect(mockMailer.sendResetLink).not.toHaveBeenCalled();
    });

    it('does not throw when mailer delivery fails', async () => {
      mockMailer.sendResetLink.mockRejectedValue(new Error('smtp down'));

      await expect(service.register({ email: 'doctor@example.com', password: 'S3cret!Pass', tenantName: 'Acme Health' })).resolves.toBeUndefined();
    });

    it('does not throw when no mailer is configured', async () => {
      const serviceNoMailer = new RegistrationService(
        mockUserRepository as any,
        mockPasswordResetTokenRepository as any,
        mockUserService as any,
        mockTenantOnboardingService as any,
        mockEventEmitter as any,
        mockClsService as any,
      );

      await expect(
        serviceNoMailer.register({ email: 'doctor@example.com', password: 'S3cret!Pass', tenantName: 'Acme Health' }),
      ).resolves.toBeUndefined();
    });
  });

  describe('verify', () => {
    beforeEach(() => {
      mockPasswordResetTokenRepository.findByTokenHash.mockResolvedValue(activeTokenRecord());
      mockUserService.update.mockResolvedValue(createMockUser({ resourceStatus: ResourceStatusType.ENABLED }));
      mockTenantOnboardingService.provisionTenantWithAdmin.mockResolvedValue({
        tenant: { id: 'new-tenant-id', key: 'acme-health' },
        adminUserId: 'new-user-id',
        tenantKey: 'acme-health',
      });
    });

    it('activates the user BEFORE provisioning (so TenantOnboardingService sees an active admin)', async () => {
      const callOrder: string[] = [];
      mockUserService.update.mockImplementation(async () => {
        callOrder.push('activate');
        return createMockUser({ resourceStatus: ResourceStatusType.ENABLED });
      });
      mockTenantOnboardingService.provisionTenantWithAdmin.mockImplementation(async () => {
        callOrder.push('provision');
        return { tenant: { id: 'new-tenant-id', key: 'acme-health' }, adminUserId: 'new-user-id', tenantKey: 'acme-health' };
      });

      await service.verify('raw-token');

      expect(callOrder).toEqual(['activate', 'provision']);
    });

    it('provisions the tenant from the token metaData and marks the token used', async () => {
      const result = await service.verify('raw-token');

      expect(mockUserService.update).toHaveBeenCalledWith('new-user-id', { resourceStatus: ResourceStatusType.ENABLED });
      expect(mockTenantOnboardingService.provisionTenantWithAdmin).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantName: 'Acme Health',
          admin: { kind: 'existing', userId: 'new-user-id' },
        }),
      );
      const record = mockPasswordResetTokenRepository.update.mock.calls[0][1];
      expect(record.markUsed).toHaveBeenCalled();
      expect(result).toEqual({ userId: 'new-user-id', tenantId: 'new-tenant-id', tenantKey: 'acme-health' });
    });

    it('rejects a missing/unknown token with a generic message', async () => {
      mockPasswordResetTokenRepository.findByTokenHash.mockResolvedValue(null);

      await expect(service.verify('bogus')).rejects.toThrow();
      expect(mockTenantOnboardingService.provisionTenantWithAdmin).not.toHaveBeenCalled();
    });

    it('rejects an expired/used/revoked token', async () => {
      mockPasswordResetTokenRepository.findByTokenHash.mockResolvedValue(activeTokenRecord({ isActive: vi.fn().mockReturnValue(false) }));

      await expect(service.verify('raw-token')).rejects.toThrow();
    });

    it('rejects a token whose purpose is not email_verification', async () => {
      mockPasswordResetTokenRepository.findByTokenHash.mockResolvedValue(activeTokenRecord({ purpose: 'password_reset' }));

      await expect(service.verify('raw-token')).rejects.toThrow();
    });
  });
});
