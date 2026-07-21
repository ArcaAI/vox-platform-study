/**
 * Failed authentication attempts must leave an audit trail.
 *
 * Gap under test: `EventTypes.UserAuthenticated` is a SUCCESS-ONLY bracket
 * (noted at auth.controller.ts), so a rejected login produced structured warn
 * logs and nothing queryable. HIPAA §164.312(b) access auditing expects
 * rejected access to be reviewable alongside granted access — that is how
 * credential stuffing and post-termination access attempts get spotted.
 *
 * Contract pinned here: `handleUserAuthenticationFailedEvent` writes a LOGIN
 * row with `success: false` through the SAME sanctioned direct-write path as
 * the success handler (unscoped `baseClient`, because a failed login has no
 * CLS tenant context), carrying the failure reason, attempted identity, IP
 * and user agent.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AuditAction, ResourceType } from '@arcaai/domains';
import { AuditLogService } from '../auditLog.service';

const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';

const mockAuditLogRepository = { create: vi.fn(), findById: vi.fn(), findAll: vi.fn(), count: vi.fn() };
const mockEventEmitter = { emit: vi.fn() };
const mockUserRepository = { findById: vi.fn(), findAll: vi.fn() };

const auditLogCreate = vi.fn().mockResolvedValue({ id: 'audit-1' });
const mockDatabaseService = { baseClient: { auditLog: { create: auditLogCreate } } };

const clsStore: Record<string, unknown> = {};
const mockClsService = {
  get: vi.fn((key: string) => clsStore[key]),
  set: vi.fn((key: string, value: unknown) => {
    clsStore[key] = value;
  }),
};

function buildService(): AuditLogService {
  return new AuditLogService(
    mockAuditLogRepository as never,
    mockEventEmitter as never,
    mockClsService as never,
    mockDatabaseService as never,
    mockUserRepository as never,
  );
}

/** The single `data` object handed to Prisma on the most recent write. */
function lastWrittenRow(): Record<string, unknown> {
  const call = auditLogCreate.mock.calls.at(-1);
  return (call?.[0] as { data: Record<string, unknown> }).data;
}

describe('AuditLogService — TASK-541 B1 failed-authentication audit', () => {
  let service: AuditLogService;

  beforeEach(() => {
    vi.clearAllMocks();
    auditLogCreate.mockResolvedValue({ id: 'audit-1' });
    for (const key of Object.keys(clsStore)) delete clsStore[key];
    clsStore.requestIp = '192.168.1.1';
    service = buildService();
  });

  it('persists a LOGIN row with success=false', async () => {
    await service.handleUserAuthenticationFailedEvent({
      userId: 'user-123',
      reason: 'invalid_credentials',
      ip: '10.0.0.9',
      userAgent: 'Mozilla/5.0',
      endpoint: '/auth/login',
      method: 'POST',
    });

    expect(lastWrittenRow()).toMatchObject({
      action: AuditAction.LOGIN,
      eventType: 'AUTHENTICATION',
      success: false,
      responsibleUserId: 'user-123',
      responsibleIp: '10.0.0.9',
      resourceType: ResourceType.User,
    });
  });

  it('records the failure reason and attempted identity in the data payload', async () => {
    await service.handleUserAuthenticationFailedEvent({
      attemptedUsername: 'jdoe',
      reason: 'invalid_credentials',
      ip: '10.0.0.9',
      userAgent: 'curl/8.0',
    });

    const data = lastWrittenRow().data as Record<string, unknown>;
    expect(data).toMatchObject({
      reason: 'invalid_credentials',
      attemptedUsername: 'jdoe',
      userAgent: 'curl/8.0',
    });
  });

  it('writes a row even when the attempt never resolved to a real account', async () => {
    await service.handleUserAuthenticationFailedEvent({
      attemptedUsername: 'does-not-exist',
      reason: 'unknown_user',
      ip: '10.0.0.9',
    });

    expect(auditLogCreate).toHaveBeenCalledTimes(1);
    const row = lastWrittenRow();
    expect(row.success).toBe(false);
    expect((row.data as Record<string, unknown>).attemptedUsername).toBe('does-not-exist');
  });

  it('never carries a password or raw credential into the audit row', async () => {
    await service.handleUserAuthenticationFailedEvent({
      attemptedUsername: 'jdoe',
      reason: 'invalid_credentials',
      // A caller mistakenly widening the payload must not leak a secret.
      password: 'hunter2',
    } as never);

    expect(JSON.stringify(lastWrittenRow())).not.toContain('hunter2');
  });

  it('falls back to the SYSTEM tenant when no CLS tenant exists (pre-auth path)', async () => {
    await service.handleUserAuthenticationFailedEvent({
      attemptedUsername: 'jdoe',
      reason: 'invalid_credentials',
    });

    expect(lastWrittenRow().tenantId).toBe(SYSTEM_TENANT_ID);
  });

  it('uses the CLS request IP when the event carries none', async () => {
    await service.handleUserAuthenticationFailedEvent({
      userId: 'user-123',
      reason: 'token_revoked',
    });

    expect(lastWrittenRow().responsibleIp).toBe('192.168.1.1');
  });

  it('never lets an audit failure escape into the auth path', async () => {
    auditLogCreate.mockRejectedValueOnce(new Error('DB down'));

    await expect(
      service.handleUserAuthenticationFailedEvent({ attemptedUsername: 'jdoe', reason: 'invalid_credentials' }),
    ).resolves.toBeUndefined();
  });

  it('defaults an omitted reason to a stable slug rather than writing undefined', async () => {
    await service.handleUserAuthenticationFailedEvent({ attemptedUsername: 'jdoe' } as never);

    expect((lastWrittenRow().data as Record<string, unknown>).reason).toBe('unspecified');
  });
});
