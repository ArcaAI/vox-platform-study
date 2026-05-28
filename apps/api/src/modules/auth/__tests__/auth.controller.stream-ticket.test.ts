/**
 * AuthController#issueStreamTicket — unit tests (TASK-263 W0-1)
 *
 * Verifies the new `POST /auth/stream-ticket` endpoint that issues a
 * single-use, 30-second SSE ticket scoped to a specific resource. The
 * caller is identified by the existing JWT context (ClsService).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { AuthController } from '../auth.controller';

function buildController(opts: {
  cls?: { get: (key: string) => unknown };
  streamTicketService?: {
    issueTicket: ReturnType<typeof vi.fn>;
    consumeTicket: ReturnType<typeof vi.fn>;
  };
  jwtRevocationService?: {
    revoke: ReturnType<typeof vi.fn>;
    isRevoked: ReturnType<typeof vi.fn>;
  };
} = {}) {
  const cls = opts.cls ?? { get: () => null };
  const streamTicketService =
    opts.streamTicketService ?? {
      issueTicket: vi.fn(),
      consumeTicket: vi.fn(),
    };
  const jwtRevocationService =
    opts.jwtRevocationService ?? {
      revoke: vi.fn(),
      isRevoked: vi.fn().mockResolvedValue(false),
    };

  return {
    controller: new AuthController(
      {} as never, // userService
      {} as never, // authService
      {} as never, // appSettingsService
      {} as never, // userRoleAssignmentService
      {} as never, // userRepository
      {} as never, // userRoleAssignmentRepository
      {} as never, // roleRepository
      {} as never, // tenantRepository
      cls as never, // clsService
      streamTicketService as never, // streamTicketService
      jwtRevocationService as never, // jwtRevocationService
      {} as never, // secretsService (TASK-307 W2.3; not exercised by stream-ticket paths)
    ),
    streamTicketService,
    jwtRevocationService,
  };
}

describe('AuthController.issueStreamTicket', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('issues a ticket scoped to the requested resource for the authenticated user', async () => {
    const issueTicket = vi.fn(async () => ({
      ticket: 'tkt-1',
      expiresAt: 1700000030000,
      scope: 'consultation_job:job-1',
    }));
    const { controller } = buildController({
      cls: { get: (key: string) => (key === 'user' ? { id: 'user-1', tenantId: 'tenant-1' } : null) },
      streamTicketService: { issueTicket, consumeTicket: vi.fn() },
    });

    const result = await controller.issueStreamTicket({ scope: 'consultation_job:job-1' });

    expect(issueTicket).toHaveBeenCalledWith({
      userId: 'user-1',
      tenantId: 'tenant-1',
      scope: 'consultation_job:job-1',
      impersonatedBy: null,
    });
    expect(result).toEqual({
      ticket: 'tkt-1',
      expiresAt: 1700000030000,
      scope: 'consultation_job:job-1',
    });
  });

  it('falls back to tenantId from CLS context when not on the user object', async () => {
    const issueTicket = vi.fn(async () => ({ ticket: 't', expiresAt: 1, scope: 's' }));
    const { controller } = buildController({
      cls: {
        get: (key: string) => {
          if (key === 'user') return { id: 'user-1' };
          if (key === 'tenantId') return 'tenant-from-cls';
          return null;
        },
      },
      streamTicketService: { issueTicket, consumeTicket: vi.fn() },
    });

    await controller.issueStreamTicket({ scope: 's' });

    expect(issueTicket).toHaveBeenCalledWith({
      userId: 'user-1',
      tenantId: 'tenant-from-cls',
      scope: 's',
      impersonatedBy: null,
    });
  });

  it('carries impersonatedBy through to the ticket payload (TASK-295 SEC-A5-6)', async () => {
    const issueTicket = vi.fn(async () => ({ ticket: 't', expiresAt: 1, scope: 's' }));
    const { controller } = buildController({
      cls: {
        get: (key: string) =>
          key === 'user'
            ? { id: 'doctor-001', tenantId: 'tenant-acme', impersonatedBy: 'admin-007' }
            : null,
      },
      streamTicketService: { issueTicket, consumeTicket: vi.fn() },
    });

    await controller.issueStreamTicket({ scope: 'consultation_job:job-1' });

    expect(issueTicket).toHaveBeenCalledWith({
      userId: 'doctor-001',
      tenantId: 'tenant-acme',
      scope: 'consultation_job:job-1',
      impersonatedBy: 'admin-007',
    });
  });

  it('throws UnauthorizedException when no user is present in the CLS context', async () => {
    const { controller } = buildController({
      cls: { get: () => null },
    });

    await expect(
      controller.issueStreamTicket({ scope: 'consultation_job:job-1' }),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('handler is bound to HTTP POST on path "stream-ticket"', () => {
    const path = Reflect.getMetadata(PATH_METADATA, AuthController.prototype.issueStreamTicket);
    const method = Reflect.getMetadata(METHOD_METADATA, AuthController.prototype.issueStreamTicket);
    expect(path).toBe('stream-ticket');
    expect(method).toBe(RequestMethod.POST);
  });
});
