/**
 * Gateway → `apps/stt` internal-call contract ( + / owner D-D).
 *
 * `apps/stt` used to have NO inbound authentication: every `/internal/*` route
 * was open. `ServiceAuthMiddleware` closed that, with a dev bypass while no
 * token is configured and FAIL-CLOSED behaviour once one is. The gateway,
 * however, never presented a token to stt — so the break is invisible locally
 * and every streaming session, voice-profile enrolment and pipeline validation
 * 401s the moment `INTERNAL_ACCESS_TOKEN` is set in a deployed environment.
 *
 * These tests pin BOTH halves of the internal-call contract on every
 * non-exempt gateway→stt hop:
 *   1. `X-Service-Token` — the ONE shared `INTERNAL_ACCESS_TOKEN` (D-D).
 *   2. `X-Tenant-Id` — always present; tenant-less work DECLARES itself
 *                          with the `tenantless:<reason>` sentinel rather than
 * omitting the header.
 *
 * stt's own `EXEMPT_PATHS` (`apps/stt/src/stt/core/middleware/auth.py`) covers
 * `/metrics`, the docs routes and the health/live/ready probes ONLY — every
 * path exercised below is outside it.
 */
import { of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PipelineService } from '../pipeline/pipeline.service';
import { StreamingSessionService } from '../streaming/streamingSession.service';
import { VoiceProfileService } from '../../user/voiceProfile/voiceProfile.service';
import { TENANTLESS, isTenantlessMarker } from '../../../common';

const SHARED_TOKEN = 'shared-internal-token';

/** A secrets service that resolves only the shared `INTERNAL_ACCESS_TOKEN`. */
const secretsWithSharedToken = () => ({
  getSecretOptional: vi.fn(async (key: string) => (key === 'INTERNAL_ACCESS_TOKEN' ? SHARED_TOKEN : undefined)),
});

const configWithSttUrl = (url = 'http://stt.internal:9000'): any => ({ config: { STT_URL: url } });

/** Pull the headers object out of an axios-style mock call. */
const headersOf = (call: unknown[]): Record<string, string> => (call[call.length - 1] as { headers: Record<string, string> }).headers;

describe('gateway → apps/stt carries the shared token AND the tenant', () => {
  let httpService: any;

  beforeEach(() => {
    vi.clearAllMocks();
    httpService = { get: vi.fn(), post: vi.fn(), delete: vi.fn() };
  });

  // =========================================================================
  // StreamingSessionService — /internal/streaming/*
  // =========================================================================
  describe('StreamingSessionService', () => {
    const build = () => new StreamingSessionService(httpService, configWithSttUrl(), undefined, secretsWithSharedToken() as any);

    it('createSession sends the token and the session tenant', async () => {
      httpService.post.mockReturnValue(of({ data: { session_id: 's-1', status: 'active' } }));

      await build().createSession({ sessionId: 's-1', tenantId: 'tenant-1', pipelineId: 'p-1' });

      const headers = headersOf(httpService.post.mock.calls[0]);
      expect(headers['X-Service-Token']).toBe(SHARED_TOKEN);
      expect(headers['X-Tenant-Id']).toBe('tenant-1');
    });

    it('getSessionStatus sends the token and the threaded tenant', async () => {
      httpService.get.mockReturnValue(of({ data: { session_id: 's-2', status: 'active' } }));

      await build().getSessionStatus('s-2', 'tenant-2');

      const headers = headersOf(httpService.get.mock.calls[0]);
      expect(headers['X-Service-Token']).toBe(SHARED_TOKEN);
      expect(headers['X-Tenant-Id']).toBe('tenant-2');
    });

    it('switchProvider sends the token and the threaded tenant', async () => {
      httpService.post.mockReturnValue(of({ data: {} }));

      await build().switchProvider('s-3', 'fallback', 'tenant-3');

      const headers = headersOf(httpService.post.mock.calls[0]);
      expect(headers['X-Service-Token']).toBe(SHARED_TOKEN);
      expect(headers['X-Tenant-Id']).toBe('tenant-3');
    });

    it('removeSession sends the token and the threaded tenant', async () => {
      httpService.delete.mockReturnValue(of({ status: 204, data: undefined }));

      await build().removeSession('s-4', false, 'tenant-4');

      const headers = headersOf(httpService.delete.mock.calls[0]);
      expect(headers['X-Service-Token']).toBe(SHARED_TOKEN);
      expect(headers['X-Tenant-Id']).toBe('tenant-4');
    });

    it('removeSession DECLARES tenant-less-ness rather than omitting the header', async () => {
      // Background teardown (SIGTERM sweep / removal-retry) genuinely holds no
      // tenant. An ABSENT header would be indistinguishable from one dropped in
      // transit — the exact ambiguity the sentinel removes.
      httpService.delete.mockReturnValue(of({ status: 204, data: undefined }));

      await build().removeSession('s-5');

      const headers = headersOf(httpService.delete.mock.calls[0]);
      expect(headers['X-Service-Token']).toBe(SHARED_TOKEN);
      expect(isTenantlessMarker(headers['X-Tenant-Id'])).toBe(true);
    });

    it('checkAvailability and getLanguageModes are platform capability reads — token + declared tenant-less', async () => {
      httpService.get.mockReturnValue(of({ data: { modes: [] } }));

      const service = build();
      await service.checkAvailability();
      await service.getLanguageModes();

      for (const call of httpService.get.mock.calls) {
        const headers = headersOf(call);
        expect(headers['X-Service-Token']).toBe(SHARED_TOKEN);
        expect(headers['X-Tenant-Id']).toBe(TENANTLESS.CONTROL_PLANE);
      }
    });
  });

  // =========================================================================
  // VoiceProfileService — /internal/voice-profile/extract
  // =========================================================================
  describe('VoiceProfileService', () => {
    it('extract sends the token and the CLS tenant, and never stamps a JSON Content-Type', async () => {
      const cls = { get: vi.fn((key: string) => (key === 'tenantId' ? 'tenant-voice' : undefined)), set: vi.fn() };
      const repository = {
        createWithEmbedding: vi.fn().mockResolvedValue({ id: 'vp-1', toObject: () => ({}) }),
        findActiveByUserId: vi.fn().mockResolvedValue(null),
        activateById: vi.fn().mockResolvedValue(undefined),
      };
      const post = vi.fn().mockReturnValue(of({ data: { embedding: new Array(256).fill(0.1), model_id: 'm-1', model_slug: 'wespeaker-voxceleb-resnet34' } }));
      // TASK-887 — enrollment resolves the agent first; the model it names is pushed with the samples.
      const asrResolver = {
        resolve: vi.fn().mockResolvedValue({
          spec: {
            agent: { slug: 'platform-transcription' },
            models: { embedding: { slug: 'wespeaker-voxceleb-resnet34', sourceUri: 'pyannote/wespeaker-voxceleb-resnet34-LM' } },
            audioFrontEnd: { diarization: { enabled: true } },
          },
        }),
      };

      const service = new VoiceProfileService(
        repository as any,
        { post } as any,
        { emit: vi.fn() } as any,
        cls as any,
        configWithSttUrl(),
        secretsWithSharedToken() as any,
        asrResolver as any,
      );

      await service.enroll({ userId: 'user-1', audioBuffers: [Buffer.from('audio')] } as any);

      const headers = headersOf(post.mock.calls[0]);
      expect(headers['X-Service-Token']).toBe(SHARED_TOKEN);
      expect(headers['X-Tenant-Id']).toBe('tenant-voice');
      // multipart/form-data: axios must derive the boundary itself.
      expect(headers['Content-Type']).toBeUndefined();
    });
  });

  // =========================================================================
  // PipelineService — /api/v1/pipelines/validate
  // =========================================================================
  describe('PipelineService', () => {
    it('remote YAML validation sends the token and the CLS tenant', async () => {
      const cls = { get: vi.fn((key: string) => (key === 'tenantId' ? 'tenant-pipe' : undefined)), set: vi.fn() };
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ valid: true }) });
      vi.stubGlobal('fetch', fetchMock);

      const service = new PipelineService(
        {} as any,
        { emit: vi.fn() } as any,
        cls as any,
        {} as any,
        undefined,
        secretsWithSharedToken() as any,
      );

      await service.validateYaml('models:\n  asr: whisper::base\n');

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const headers = (fetchMock.mock.calls[0][1] as { headers: Record<string, string> }).headers;
      expect(headers['X-Service-Token']).toBe(SHARED_TOKEN);
      expect(headers['X-Tenant-Id']).toBe('tenant-pipe');

      vi.unstubAllGlobals();
    });
  });
});
