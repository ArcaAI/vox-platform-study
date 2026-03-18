import { describe, it, expect, beforeEach, vi } from 'vitest';
import { of, throwError } from 'rxjs';
import { StreamingSessionService } from '../streamingSession.service';

describe('StreamingSessionService', () => {
    let httpService: any;

    const configWithSttV2Url = (url?: string): any => ({
        config: {
            STT_V2_URL: url,
        },
    });

    beforeEach(() => {
        vi.clearAllMocks();
        httpService = {
            get: vi.fn(),
            post: vi.fn(),
            delete: vi.fn(),
        };
    });

    it('uses STT_V2_URL when checking availability', async () => {
        httpService.get.mockReturnValue(of({
            data: {
                available: true,
                status: 'ready',
                maxConcurrent: 8,
                currentActive: 3,
                availableSlots: 5,
            },
        }));

        const service = new StreamingSessionService(
            httpService,
            configWithSttV2Url('http://stt-v2.internal:9000'),
        );

        await service.checkAvailability();

        expect(httpService.get).toHaveBeenCalledWith(
            'http://stt-v2.internal:9000/internal/streaming/availability',
            { timeout: 5000 },
        );
    });

    it('falls back to localhost when STT_V2_URL is missing', async () => {
        httpService.get.mockReturnValue(of({
            data: {
                available: true,
                status: 'ready',
                maxConcurrent: 8,
                currentActive: 3,
                availableSlots: 5,
            },
        }));

        const service = new StreamingSessionService(
            httpService,
            configWithSttV2Url(undefined),
        );

        await service.checkAvailability();

        expect(httpService.get).toHaveBeenCalledWith(
            'http://localhost:8861/internal/streaming/availability',
            { timeout: 5000 },
        );
    });

    it('returns null when createSession gets 503 at capacity', async () => {
        httpService.post.mockReturnValue(throwError(() => ({
            response: {
                status: 503,
                data: { detail: 'at_capacity' },
            },
        })));

        const service = new StreamingSessionService(
            httpService,
            configWithSttV2Url('http://stt-v2.internal:9000'),
        );

        const result = await service.createSession({
            sessionId: 's-1',
            tenantId: 'tenant-1',
            pipelineId: 'pipeline-1',
            sampleRate: 16000,
        });

        expect(result).toBeNull();
        expect(httpService.post).toHaveBeenCalledWith(
            'http://stt-v2.internal:9000/internal/streaming/sessions',
            expect.objectContaining({
                session_id: 's-1',
                tenant_id: 'tenant-1',
                pipeline_id: 'pipeline-1',
                sample_rate: 16000,
            }),
            { timeout: 10000 },
        );
    });

    it('maps snake_case fields when reading session status', async () => {
        httpService.get.mockReturnValue(of({
            data: {
                session_id: 's-2',
                status: 'active',
                max_concurrent: 4,
                current_active: 2,
            },
        }));

        const service = new StreamingSessionService(
            httpService,
            configWithSttV2Url('http://stt-v2.internal:9000'),
        );

        const result = await service.getSessionStatus('s-2');

        expect(httpService.get).toHaveBeenCalledWith(
            'http://stt-v2.internal:9000/internal/streaming/sessions/s-2',
            { timeout: 5000 },
        );
        expect(result).toEqual({
            sessionId: 's-2',
            status: 'active',
            reason: undefined,
            maxConcurrent: 4,
            currentActive: 2,
        });
    });
});
