import { STT_GATEWAY_DEFAULTS } from '@arcaai/applications';
import { Logger } from '@nestjs/common';
import { Subject } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SttWsGateway, WS_CLOSE_CODES } from '../stt-ws.gateway';

const build = (lockState: { locked: boolean; restoreId?: string } | Error) => {
  const sessionBinding = {
    lookupBinding: vi.fn().mockResolvedValue({ tenantId: 'tenant-abc', userId: 'user-123' }),
    lookupSessionMeta: vi.fn().mockResolvedValue(null),
    lookupMetadataMarks: vi.fn().mockResolvedValue({ spans: [], audioSec: 0 }),
  };
  const bridge = { subscribeToResults: vi.fn().mockReturnValue(new Subject().asObservable()), connect: vi.fn() };
  const tickets = {
    consumeTicket: vi.fn().mockResolvedValue({
      userId: 'user-123',
      tenantId: 'tenant-abc',
      scope: 'stt_session:sess-1',
      exp: Date.now() + 30_000,
      impersonatedBy: null,
    }),
  };
  const settings = {
    hasSetting: (key: string) => key in STT_GATEWAY_DEFAULTS,
    getValueWithDefault: (key: string, fallback: unknown) => (key in STT_GATEWAY_DEFAULTS ? (STT_GATEWAY_DEFAULTS as Record<string, unknown>)[key] : fallback),
  };
  const lock = {
    state: lockState instanceof Error ? vi.fn().mockRejectedValue(lockState) : vi.fn().mockResolvedValue(lockState),
    publishChange: vi.fn(),
  };
  const gateway = new SttWsGateway(
    { getSessionStatus: vi.fn(), removeSession: vi.fn() } as never,
    bridge as never,
    tickets as never,
    sessionBinding as never,
    { enqueue: vi.fn() } as never,
    undefined,
    undefined,
    settings as never,
    undefined,
    lock as never,
  );
  return { gateway, lock, sessionBinding, bridge };
};

const socket = () => ({ send: vi.fn(), close: vi.fn(), on: vi.fn(), readyState: 1, OPEN: 1 });
const req = { url: '/ws/stt/stream?sessionId=sess-1&ticket=t' };

describe('SttWsGateway — tenant lock on open', () => {
  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
  });

  it('closes with 4423 before any session state exists when the tenant is locked', async () => {
    const { gateway, lock, sessionBinding, bridge } = build({ locked: true, restoreId: 'R' });
    const client = socket();
    await gateway.handleConnection(client as never, req as never);
    expect(lock.state).toHaveBeenCalledWith('tenant-abc');
    expect(client.close).toHaveBeenCalledWith(4423, 'TENANT_RESTORE_IN_PROGRESS');
    expect(WS_CLOSE_CODES.TENANT_LOCKED).toBe(4423);
    expect(sessionBinding.lookupSessionMeta).not.toHaveBeenCalled();
    expect(bridge.subscribeToResults).not.toHaveBeenCalled();
  });

  it('admits an unlocked tenant', async () => {
    const { gateway } = build({ locked: false });
    const client = socket();
    await gateway.handleConnection(client as never, req as never);
    expect(client.close).not.toHaveBeenCalled();
  });

  it('refuses the open when the lock state cannot be read', async () => {
    const { gateway, bridge } = build(new Error('db down'));
    const client = socket();
    await gateway.handleConnection(client as never, req as never);
    expect(client.close).toHaveBeenCalledWith(1011, 'TENANT_LOCK_UNAVAILABLE');
    expect(bridge.subscribeToResults).not.toHaveBeenCalled();
  });
});
