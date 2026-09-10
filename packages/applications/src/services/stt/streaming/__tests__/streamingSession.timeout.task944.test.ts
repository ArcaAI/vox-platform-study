// TASK-944 lane A — `createSession`'s outbound budget is resolved, not compiled in.
//
// Measured 2026-09-10 on `hope-v2-dev`: the first session after an STT pod restart
// took 16 870 ms and STT answered 201 — 1 870 ms after the gateway had already
// aborted on its literal `timeout: 15000` and returned 503 to the clinician. A warm
// session is 0.1–0.5 s, so the literal failed on exactly one request per deploy and
// never in a test.
//
// These cases pin the PROPERTY, not the number: the budget comes from the settings
// control plane, so an operator can move it on a live platform without a redeploy.
// A future re-tune changes `STT_GATEWAY_DEFAULTS` and these still pass.

import { of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { STT_GATEWAY_DEFAULTS, STT_SESSION_CREATE_TIMEOUT_MS_KEY } from '../../../settings-registry/descriptors/stt-gateway.descriptors';
import { StreamingSessionService } from '../streamingSession.service';

describe('TASK-944 — StreamingSessionService session-create timeout', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let httpService: any;

  const config = { config: { STT_URL: 'http://stt.internal:9000' } } as never;

  const sessionOk = () => of({ data: { session_id: 's-1', status: 'active' } });

  const createRequest = {
    sessionId: 's-1',
    tenantId: 'tenant-1',
    sampleRate: 16000,
    userId: 'user-1',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    httpService = { get: vi.fn(), post: vi.fn(), delete: vi.fn() };
  });

  it('takes the budget from the settings control plane when one is wired', async () => {
    httpService.post.mockReturnValue(sessionOk());
    const appSettings = {
      getValueWithDefault: vi.fn().mockReturnValue(42_000),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    const service = new StreamingSessionService(httpService, config, undefined, undefined, undefined, undefined, appSettings);

    await service.createSession(createRequest);

    expect(appSettings.getValueWithDefault).toHaveBeenCalledWith(
      STT_SESSION_CREATE_TIMEOUT_MS_KEY,
      STT_GATEWAY_DEFAULTS[STT_SESSION_CREATE_TIMEOUT_MS_KEY],
    );
    expect(httpService.post).toHaveBeenCalledWith(expect.any(String), expect.any(Object), expect.objectContaining({ timeout: 42_000 }));
  });

  it('is re-read per call, so a live write governs the NEXT session open', async () => {
    httpService.post.mockReturnValue(sessionOk());
    const appSettings = {
      getValueWithDefault: vi.fn().mockReturnValueOnce(20_000).mockReturnValueOnce(90_000),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    const service = new StreamingSessionService(httpService, config, undefined, undefined, undefined, undefined, appSettings);

    await service.createSession(createRequest);
    await service.createSession(createRequest);

    expect(httpService.post.mock.calls[0][2]).toMatchObject({ timeout: 20_000 });
    expect(httpService.post.mock.calls[1][2]).toMatchObject({ timeout: 90_000 });
  });

  it('degrades to the descriptor default when no settings service is wired', async () => {
    httpService.post.mockReturnValue(sessionOk());

    const service = new StreamingSessionService(httpService, config);

    await service.createSession(createRequest);

    expect(httpService.post).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Object),
      expect.objectContaining({ timeout: STT_GATEWAY_DEFAULTS[STT_SESSION_CREATE_TIMEOUT_MS_KEY] }),
    );
  });

  it('does not send the pre-fix 15000 ms literal, which sat below the measured cold start', async () => {
    httpService.post.mockReturnValue(sessionOk());

    const service = new StreamingSessionService(httpService, config);

    await service.createSession(createRequest);

    expect(httpService.post.mock.calls[0][2].timeout).not.toBe(15_000);
    expect(httpService.post.mock.calls[0][2].timeout).toBeGreaterThan(16_870);
  });
});
